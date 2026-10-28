/**
 * `HarbourStack`: the Durable Object that hosts the stack and its gateway. Its state is durable (#17, step 2):
 *
 * - the identity directory and the audit store in D1 (`DB`);
 * - workspaces in R2 (`WORKSPACES`);
 * - the session runtime (`SessionRuntimeDurableObjectCore` from `@harbour/runtime-cloudflare`): its directory,
 *   profiles, host registrations and each session's Pi storage in this object's own SQLite, and its alarm;
 * - what the bootstrap made, in this object's storage, so a restart finds the same organisation;
 * - the model gateway (`src/models.ts`), calling CLIProxyAPI through the `MODELS` VPC service with the key the vault
 *   object keeps, when the Worker has both; the echo model otherwise;
 * - the sandboxes (`src/sandboxes.ts`), the isolate tier on the backend `HARBOUR_ISOLATE_BACKEND` names: `in-process`
 *   in this object, or `dynamic-worker` (`src/dynamic-worker.ts`) through the `LOADER` binding, whose isolates read
 *   the workspace through a port this object passes them as an RPC target;
 * - the vault approval API's vault: the VaultDO (`HarbourVault`), over RPC.
 *
 * One object serves every session in M1: see the README's "Decisions".
 */

import { DurableObject, RpcTarget } from "cloudflare:workers";
import { createR2WorkspaceStore } from "@harbour/cloudflare-workspace";
import type { ConnectorCredential, ConnectorCredentialRequest, SystemContext } from "@harbour/contracts";
import type { WorkspacePort } from "@harbour/sandbox/isolate";
import { d1Driver } from "@harbour/sql/sqlite";
import ISOLATE_BUNDLE from "../generated/isolate.bundle.txt";
import type { GatewayVars } from "./config.ts";
import { gatewayConfig } from "./config.ts";
import { bundleId, createDynamicWorkerIsolateBackend, workerLoaderIsolates } from "./dynamic-worker.ts";
import { createGateway, type Gateway } from "./gateway.ts";
import type { Placement } from "./measure.ts";
import { cpaKey, createGatewayModels, defaultModel, type ModelsVars } from "./models.ts";
import { VAULT_NAME } from "./route.ts";
import { isolateBackendName, type SandboxVars } from "./sandboxes.ts";
import { type BootstrapRecord, createStack, type Stack, type StackOptions, type StackStorage } from "./stack.ts";
import { startOnce } from "./start.ts";
import { approvalVaultOver, type VaultVars } from "./vault.ts";
import type { HarbourVault } from "./vault-object.ts";

export { STACK_NAME } from "./route.ts";

export interface Env extends GatewayVars, VaultVars, ModelsVars, SandboxVars {
	readonly STACK: DurableObjectNamespace;
	/** The VaultDO (`HarbourVault`, `src/vault-object.ts`). */
	readonly VAULTS: DurableObjectNamespace<HarbourVault>;
	/** The Workers VPC service to CLIProxyAPI on Sal's host. Absent in `wrangler dev`. */
	readonly MODELS?: Fetcher;
	readonly ASSETS: Fetcher;
	readonly DB: D1Database;
	readonly WORKSPACES: R2Bucket;
	/** The Worker Loader, for the `dynamic-worker` isolate backend. */
	readonly LOADER?: WorkerLoader;
}

/**
 * A command's workspace port as an RPC target, so the Dynamic Worker isolate can call it: each call runs here, in the
 * stack object, with the caller's context, which the isolate never sees.
 */
class WorkspacePortTarget extends RpcTarget implements WorkspacePort {
	readonly #port: WorkspacePort;
	constructor(port: WorkspacePort) {
		super();
		this.#port = port;
	}
	entries(version: number) {
		return this.#port.entries(version);
	}
	mountEntries(path: string) {
		return this.#port.mountEntries(path);
	}
	readBlob(digest: string) {
		return this.#port.readBlob(digest);
	}
	readMount(path: string) {
		return this.#port.readMount(path);
	}
}

/** The isolate code's digest, part of every isolate's loader ID. */
const ISOLATE_BUNDLE_ID = bundleId(ISOLATE_BUNDLE);
/** `SELECT 1` queries the placement probe times. */
const PLACEMENT_QUERIES = 5;

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
		configure: () => ({
			config: gatewayConfig(this.env),
			models: this.stackModels(),
			isolateBackend: isolateBackendName(this.env),
		}),
		start: async ({ config, models, isolateBackend }) => {
			const stack = await createStack({
				...(models === undefined ? {} : { models }),
				isolateBackend,
				...this.stackOptions(),
				config,
				storage: this.stackStorage(),
			});
			return { stack, gateway: createGateway(stack, { placement: (request) => this.placement(request) }) };
		},
		reset: (reason) => this.ctx.abort(reason),
		onStartError: (error) => console.error("harbour: the stack did not start; resetting the object", error),
	});

	/** How the stack is built; the dev entry point adds a mock Access issuer. */
	protected stackOptions(): Omit<StackOptions, "config" | "storage"> {
		// The approval API's vault: each call goes to the one VaultDO over RPC, as the person the gateway signed in.
		const vaults = this.env.VAULTS;
		const loader = this.env.LOADER;
		return {
			vault: approvalVaultOver((method, ctx, args) =>
				vaults.get(vaults.idFromName(VAULT_NAME)).approvalCall(method, ctx, args),
			),
			// The dynamic-worker backend, when the Worker has the loader: the measurement can run on it whichever backend
			// sessions use.
			...(loader === undefined
				? {}
				: {
						extraIsolateBackends: (workspaces) => ({
							"dynamic-worker": createDynamicWorkerIsolateBackend(workspaces, {
								load: workerLoaderIsolates(loader, ISOLATE_BUNDLE),
								bundleId: ISOLATE_BUNDLE_ID,
								expose: (port) => new WorkspacePortTarget(port),
							}),
						}),
					}),
		};
	}

	#objectColo: Promise<string | undefined> | undefined;

	/**
	 * Where this object runs and how far D1 is from it (the measurement's `placement`). The object's colo is the one its
	 * own subrequest reaches Cloudflare at, read once per object start; D1's comes from its queries' `meta`. Whatever
	 * can't be read is left out.
	 */
	protected async placement(request: Request): Promise<Placement> {
		this.#objectColo ??= fetch("https://www.cloudflare.com/cdn-cgi/trace")
			.then(async (response) => /^colo=(\w+)$/m.exec(await response.text())?.[1])
			.catch(() => undefined);
		const queries: { roundTripMs: number; sqlMs?: number }[] = [];
		let meta: D1Meta | undefined;
		try {
			for (let i = 0; i < PLACEMENT_QUERIES; i += 1) {
				const started = performance.now();
				const result = await this.env.DB.prepare("SELECT 1").run();
				const roundTripMs = Math.round((performance.now() - started) * 10) / 10;
				meta = result.meta;
				const sqlMs = meta.timings?.sql_duration_ms;
				queries.push(sqlMs === undefined ? { roundTripMs } : { roundTripMs, sqlMs });
			}
		} catch (error) {
			console.warn("harbour: the D1 placement probe failed", error);
		}
		const objectColo = await this.#objectColo;
		const edgeColo = (request.cf as { colo?: unknown } | undefined)?.colo;
		return {
			...(objectColo === undefined ? {} : { objectColo }),
			...(typeof edgeColo === "string" ? { edgeColo } : {}),
			d1: {
				...(meta?.served_by_region === undefined ? {} : { region: meta.served_by_region }),
				...(meta?.served_by_colo === undefined ? {} : { colo: meta.served_by_colo }),
				...(meta?.served_by_primary === undefined ? {} : { primary: meta.served_by_primary }),
				queries,
			},
		};
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
