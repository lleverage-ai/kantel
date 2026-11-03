/**
 * `KantelStack`: the Durable Object that hosts the stack and its gateway. Its state is durable:
 *
 * - the identity directory and the audit store in D1 (`DB`);
 * - audit events queued in this object's own SQLite before they drain to D1 (`src/audit-outbox.ts`);
 * - what the bootstrap made, in this object's storage, so a restart finds the same organisation;
 * - the compute API's records (`src/compute.ts`), in this object's own SQLite, table `compute_api_records`.
 *
 * Its SQLite still holds what the agent plane kept there (the session runtime's directory, profiles and each session's
 * Pi storage, the session homes table); nothing reads it now, and nothing deletes it. The alarm the runtime used to arm
 * is answered and not armed again.
 */
import { DurableObject } from "cloudflare:workers";
import { withKantelEnv } from "@kantel/contracts/env";
import { d1Driver } from "@kantel/sql/sqlite";
import { objectSqlDriver } from "./audit-outbox.ts";
import type { GatewayVars } from "./config.ts";
import { gatewayConfig } from "./config.ts";
import { createGateway, type Gateway } from "./gateway.ts";
import type { PlacementVars } from "./route.ts";
import { type BootstrapRecord, createStack, type Stack, type StackOptions, type StackStorage } from "./stack.ts";
import { startOnce } from "./start.ts";

export { STACK_NAME } from "./route.ts";

export interface Env extends GatewayVars, PlacementVars {
	readonly STACK: DurableObjectNamespace;
	readonly ASSETS: Fetcher;
	readonly DB: D1Database;
}

/** The key the bootstrap record is kept under in this object's storage. */
const BOOTSTRAP_KEY = "harbour.bootstrap";

export abstract class KantelStackBase extends DurableObject<Env> {
	// A deployment's HARBOUR_* vars and secrets from before the rename still count: every KANTEL_* left unset takes its
	// old name's value.
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, withKantelEnv(env));
	}

	/** Starts the stack once; see `startOnce` for what a failed configuration or start does. */
	readonly #ready = startOnce({
		configure: () => ({ config: gatewayConfig(this.env) }),
		start: async ({ config }) => {
			const started = performance.now();
			const stack = await createStack({ ...this.stackOptions(), config, storage: this.stackStorage() });
			console.log(
				`kantel: the stack object started in ${Math.round(performance.now() - started)} ms`,
				JSON.stringify(stack.startedIn),
			);
			return { stack, gateway: createGateway(stack) };
		},
		reset: (reason) => this.ctx.abort(reason),
		onStartError: (error) => console.error("kantel: the stack did not start; resetting the object", error),
	});

	/** How the stack is built beyond its config and storage; the dev entry point adds a mock Access issuer. */
	protected stackOptions(): Omit<StackOptions, "config" | "storage"> {
		return {};
	}

	/** The stack's storage over this object's bindings and its own SQLite. */
	protected stackStorage(): StackStorage {
		const storage = this.ctx.storage;
		const own = objectSqlDriver(storage.sql, (work) => storage.transactionSync(work));
		return {
			sql: d1Driver(this.env.DB),
			// Audit events queue in this object's SQLite and drain to D1 after the answer (src/audit-outbox.ts).
			auditOutbox: {
				driver: own,
				background: (work) => this.ctx.waitUntil(work),
			},
			bootstrap: {
				load: async () => (await storage.get<BootstrapRecord>(BOOTSTRAP_KEY)) ?? {},
				save: (record) => storage.put(BOOTSTRAP_KEY, record),
			},
			compute: own,
		};
	}

	protected ready(): Promise<{ stack: Stack; gateway: Gateway }> {
		return this.#ready();
	}

	/**
	 * An alarm an older version armed (a session's wake, a schedule) fires once more after the upgrade: there is nothing
	 * left to run, so it is answered and not armed again.
	 */
	override async alarm(): Promise<void> {}

	override async fetch(request: Request): Promise<Response> {
		let gateway: Gateway;
		try {
			({ gateway } = await this.ready());
		} catch (error) {
			console.error("kantel: the stack did not start", error);
			return Response.json(
				{ error: { code: "unavailable", message: "Kantel is not configured correctly" } },
				{ status: 503 },
			);
		}
		return gateway.fetch(request);
	}
}
