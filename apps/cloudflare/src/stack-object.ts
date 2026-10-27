/**
 * `HarbourStack`: the Durable Object that hosts the stack and its gateway. Its state is durable (#17, step 2):
 *
 * - the identity directory and the audit store in D1 (`DB`);
 * - workspaces in R2 (`WORKSPACES`);
 * - the session runtime (`SessionRuntimeDurableObjectCore` from `@harbour/runtime-cloudflare`): its directory,
 *   profiles, host registrations and each session's Pi storage in this object's own SQLite, and its alarm;
 * - what the bootstrap made, in this object's storage, so a restart finds the same organisation.
 *
 * One object serves every session for now; a SessionDO per session is the next step.
 */

import { DurableObject } from "cloudflare:workers";
import { createR2WorkspaceStore } from "@harbour/cloudflare-workspace";
import { d1Driver } from "@harbour/sql/sqlite";
import type { GatewayVars } from "./config.ts";
import { gatewayConfig } from "./config.ts";
import { createGateway, type Gateway } from "./gateway.ts";
import { type BootstrapRecord, createStack, type Stack, type StackOptions, type StackStorage } from "./stack.ts";
import type { VaultVars } from "./vault.ts";

export { STACK_NAME } from "./route.ts";

export interface Env extends GatewayVars, VaultVars {
	readonly STACK: DurableObjectNamespace;
	/** The VaultDO (`HarbourVault`, `src/vault-object.ts`). */
	readonly VAULTS: DurableObjectNamespace;
	readonly ASSETS: Fetcher;
	readonly DB: D1Database;
	readonly WORKSPACES: R2Bucket;
}

/** The key the bootstrap record is kept under in this object's storage. */
const BOOTSTRAP_KEY = "harbour.bootstrap";
/** Workspace objects live under this prefix in the bucket. */
const WORKSPACE_PREFIX = "workspaces";

export abstract class HarbourStackBase extends DurableObject<Env> {
	#ready: Promise<{ stack: Stack; gateway: Gateway }> | undefined;

	/** How the stack is built; the dev entry point adds a mock Access issuer. */
	protected stackOptions(): Omit<StackOptions, "config" | "storage"> {
		return {};
	}

	/** The stack's storage over this object's bindings and its own SQLite. */
	protected stackStorage(): StackStorage {
		const storage = this.ctx.storage;
		return {
			sql: d1Driver(this.env.DB),
			// The runtime lane's session core: its transactions go through the object's async `transaction`, and its
			// alarm resumes a session this object left mid-run when it was evicted.
			sessions: {
				sql: storage.sql,
				transaction: (work) => storage.transaction(() => work()),
				setAlarm: (at) => storage.setAlarm(at),
				getAlarm: () => storage.getAlarm(),
			},
			workspaces: createR2WorkspaceStore({ bucket: this.env.WORKSPACES, prefix: WORKSPACE_PREFIX }),
			bootstrap: {
				load: async () => (await storage.get<BootstrapRecord>(BOOTSTRAP_KEY)) ?? {},
				save: (record) => storage.put(BOOTSTRAP_KEY, record),
			},
		};
	}

	protected ready(): Promise<{ stack: Stack; gateway: Gateway }> {
		this.#ready ??= (async () => {
			const stack = await createStack({
				...this.stackOptions(),
				config: gatewayConfig(this.env),
				storage: this.stackStorage(),
			});
			return { stack, gateway: createGateway(stack) };
		})();
		// A failed start is retried by the next request rather than remembered.
		this.#ready.catch(() => {
			this.#ready = undefined;
		});
		return this.#ready;
	}

	/** Resumes every session whose wake is due (a run cut off by eviction, a retry backoff), then arms the next. */
	override async alarm(): Promise<void> {
		const { stack } = await this.ready();
		await stack.alarm();
	}

	override async fetch(request: Request): Promise<Response> {
		let gateway: Gateway;
		try {
			({ gateway } = await this.ready());
		} catch (error) {
			console.error("harbour: the stack did not start", error);
			return Response.json(
				{ error: { code: "unavailable", message: "Harbour is not configured correctly" } },
				{ status: 503 },
			);
		}
		return gateway.fetch(request);
	}
}
