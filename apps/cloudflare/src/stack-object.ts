/**
 * `KantelStack`: the Durable Object that hosts the stack and its gateway. Its state is durable:
 *
 * - the identity directory and the audit store in D1 (`DB`);
 * - audit events queued in this object's own SQLite before they drain to D1 (`src/audit-outbox.ts`);
 * - what the bootstrap made, in this object's storage, so a restart finds the same organisation;
 * - the compute API's records (`src/compute.ts`), in this object's own SQLite, table `compute_api_records`;
 * - with email-code sign-in on (KANTEL_PUBLIC_URL), each UTC day's count of mail sent (`src/mail.ts`), in its storage,
 *   so the daily cap holds across restarts. Codes and sessions are in D1 with the directory.
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
import type { MailCounts, SendEmailBinding } from "./mail.ts";
import type { PlacementVars } from "./route.ts";
import type { SignUpRecord } from "./sign-up.ts";
import { type BootstrapRecord, createStack, type Stack, type StackOptions, type StackStorage } from "./stack.ts";
import { startOnce } from "./start.ts";

export { STACK_NAME } from "./route.ts";

export interface Env extends GatewayVars, PlacementVars {
	readonly STACK: DurableObjectNamespace;
	readonly ASSETS: Fetcher;
	readonly DB: D1Database;
	/** The `send_email` binding sign-in codes and invites go through, limited to KANTEL_SIGN_IN_FROM. */
	readonly SIGN_IN_MAIL?: SendEmailBinding;
}

/** The key the bootstrap record is kept under in this object's storage. */
const BOOTSTRAP_KEY = "harbour.bootstrap";
/** Each UTC day's mail count is kept under this prefix and the day. */
const MAIL_COUNT_PREFIX = "kantel.mail.";
/** Each open sign-up's record is kept under this prefix and the user's ID. */
const SIGN_UP_PREFIX = "kantel.sign-up.";

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
		const binding = this.env.SIGN_IN_MAIL;
		return binding === undefined
			? {}
			: { mail: { binding, counts: this.mailCounts(), defer: (work) => this.ctx.waitUntil(work) } };
	}

	/** Each day's mail count, in this object's storage. */
	protected mailCounts(): MailCounts {
		const storage = this.ctx.storage;
		return {
			get: (day) => storage.get<number>(`${MAIL_COUNT_PREFIX}${day}`),
			put: (day, count) => storage.put(`${MAIL_COUNT_PREFIX}${day}`, count),
			async prune(day) {
				const kept = await storage.list<number>({ prefix: MAIL_COUNT_PREFIX });
				const old = [...kept.keys()].filter((key) => key < `${MAIL_COUNT_PREFIX}${day}`);
				if (old.length > 0) await storage.delete(old);
			},
		};
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
			signUps: {
				load: (userId) => storage.get<SignUpRecord>(`${SIGN_UP_PREFIX}${userId}`),
				save: (userId, record) => storage.put(`${SIGN_UP_PREFIX}${userId}`, record),
			},
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
