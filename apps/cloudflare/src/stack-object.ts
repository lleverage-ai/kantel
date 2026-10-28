/**
 * `HarbourStack`: the Durable Object that hosts the stack and its gateway. Its state is durable (#17, step 2):
 *
 * - the identity directory and the audit store in D1 (`DB`);
 * - workspaces in R2 (`WORKSPACES`);
 * - the session runtime (`SessionRuntimeDurableObjectCore` from `@harbour/runtime-cloudflare`): its directory,
 *   profiles, host registrations and each session's Pi storage in this object's own SQLite, and its alarm;
 * - what the bootstrap made, in this object's storage, so a restart finds the same organisation;
 * - the model gateway (`src/models.ts`), calling CLIProxyAPI through the `MODELS` VPC service with the key the vault
 *   object keeps, when the Worker has both; the echo model otherwise.
 *
 * One object serves every session for now; a SessionDO per session is the next step.
 */

import { DurableObject } from "cloudflare:workers";
import { createR2WorkspaceStore } from "@harbour/cloudflare-workspace";
import type { ConnectorCredential, ConnectorCredentialRequest, SystemContext } from "@harbour/contracts";
import { d1Driver } from "@harbour/sql/sqlite";
import type { GatewayVars } from "./config.ts";
import { gatewayConfig } from "./config.ts";
import { createGateway, type Gateway } from "./gateway.ts";
import { cpaKey, createGatewayModels, defaultModel, type ModelsVars } from "./models.ts";
import { VAULT_NAME } from "./route.ts";
import { type BootstrapRecord, createStack, type Stack, type StackOptions, type StackStorage } from "./stack.ts";
import { startOnce } from "./start.ts";
import type { VaultVars } from "./vault.ts";

export { STACK_NAME } from "./route.ts";

export interface Env extends GatewayVars, VaultVars, ModelsVars {
	readonly STACK: DurableObjectNamespace;
	/** The VaultDO (`HarbourVault`, `src/vault-object.ts`). */
	readonly VAULTS: DurableObjectNamespace;
	/** The Workers VPC service to CLIProxyAPI on Sal's host. Absent in `wrangler dev`. */
	readonly MODELS?: Fetcher;
	readonly ASSETS: Fetcher;
	readonly DB: D1Database;
	readonly WORKSPACES: R2Bucket;
}

/** The vault object's RPC methods the model gateway calls (`HarbourVault`). */
interface VaultRpc {
	cpaItem(): Promise<string>;
	readConnectorCredential(ctx: SystemContext, request: ConnectorCredentialRequest): Promise<ConnectorCredential>;
}

/** The key the bootstrap record is kept under in this object's storage. */
const BOOTSTRAP_KEY = "harbour.bootstrap";
/** Workspace objects live under this prefix in the bucket. */
const WORKSPACE_PREFIX = "workspaces";

export abstract class HarbourStackBase extends DurableObject<Env> {
	/** Starts the stack once; see `startOnce` for what a failed configuration or start does. */
	readonly #ready = startOnce({
		// The models are configuration too: a bad HARBOUR_DEFAULT_MODEL is answered and retried, not a reset.
		configure: () => ({ config: gatewayConfig(this.env), models: this.stackModels() }),
		start: async ({ config, models }) => {
			const stack = await createStack({
				...(models === undefined ? {} : { models }),
				...this.stackOptions(),
				config,
				storage: this.stackStorage(),
			});
			return { stack, gateway: createGateway(stack) };
		},
		reset: (reason) => this.ctx.abort(reason),
		onStartError: (error) => console.error("harbour: the stack did not start; resetting the object", error),
	});

	/** How the stack is built; the dev entry point adds a mock Access issuer. */
	protected stackOptions(): Omit<StackOptions, "config" | "storage"> {
		return {};
	}

	/**
	 * Sessions on the model gateway when the Worker has the `MODELS` binding and CPA's key; `undefined` (the echo model)
	 * otherwise. Throws (`invalid`) on a bad `HARBOUR_DEFAULT_MODEL`.
	 */
	protected stackModels(): StackOptions["models"] {
		const upstream = this.env.MODELS;
		if (upstream === undefined || cpaKey(this.env) === undefined) {
			console.warn("harbour: no MODELS binding or HARBOUR_CPA_API_KEY; sessions run on the echo model");
			return undefined;
		}
		const modelId = defaultModel(this.env);
		const vault = this.env.VAULTS.get(this.env.VAULTS.idFromName(VAULT_NAME)) as unknown as VaultRpc;
		return ({ audit, clock }) =>
			createGatewayModels({
				upstream: (request) => upstream.fetch(request),
				vault: {
					cpaItem: () => vault.cpaItem(),
					// An AbortSignal can't cross RPC, so the read goes without one: it is one call to the vault object.
					readConnectorCredential: ({ signal: _signal, ...ctx }, request) =>
						vault.readConnectorCredential(ctx, request),
				},
				audit,
				clock,
				modelId,
			});
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
		return this.#ready();
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
