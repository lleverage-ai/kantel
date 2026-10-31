/**
 * `HarbourStack`: the Durable Object that hosts the stack and its gateway. Its state is durable (#17, step 2):
 *
 * - the identity directory, the audit store, skills and memory in D1 (`DB`);
 * - workspaces in R2 (`WORKSPACES`), and skill files' bodies beside them under `skills/`;
 * - the session runtime (`SessionRuntimeDurableObjectCore` from `@harbour/runtime-cloudflare`): its directory,
 *   profiles, host registrations and each session's Pi storage in this object's own SQLite, and its alarm;
 * - what the bootstrap made, in this object's storage, so a restart finds the same organisation;
 * - the model gateway (`src/models.ts`), calling CLIProxyAPI through the `MODELS` VPC service with the key the vault
 *   object keeps, when the Worker has both; the echo model otherwise;
 * - the sandboxes (`src/sandboxes.ts`), the isolate tier on the backend `HARBOUR_ISOLATE_BACKEND` names: `in-process`
 *   in this object, or `dynamic-worker` (`src/dynamic-worker.ts`) through the `LOADER` binding, whose isolates read
 *   the workspace through a port this object passes them as an RPC target;
 * - the vault approval API's vault: the VaultDO (`HarbourVault`), over RPC;
 * - the browser (`src/browser.ts`): the broker over brwsr, with the `HARBOUR_BRWSR_API_KEY` Worker secret, when the
 *   Worker has it; sessions have no browser tools otherwise.
 *
 * One object serves every session in M1: see the README's "Decisions".
 */

import { DurableObject, RpcTarget } from "cloudflare:workers";
import { createR2WorkspaceStore } from "@harbour/cloudflare-workspace";
import type {
	ConnectorCredential,
	ConnectorCredentialRequest,
	ModelCallScope,
	SystemContext,
} from "@harbour/contracts";
import type { AcceptWebSocket } from "@harbour/runtime/http";
import { r2ObjectBucket } from "@harbour/skills/sql";
import { d1Driver } from "@harbour/sql/sqlite";
import CODEMODE_BUNDLE from "../generated/codemode.bundle.txt";
import ISOLATE_BUNDLE from "../generated/isolate.bundle.txt";
import QUICKJS_WASM from "../generated/quickjs.wasm.bin";
import QUICKJS_NODE from "../generated/quickjs-node.wasm";
import { objectSqlDriver } from "./audit-outbox.ts";
import { type BrowserObjects, type BrowserVars, browserProviderFrom } from "./browser.ts";
import { type CodemodeVars, codemodeEnabled, workerLoaderCodemode } from "./codemode.ts";
import type { GatewayVars } from "./config.ts";
import { gatewayConfig } from "./config.ts";
import { type ConnectionsVars, stackConnectionsFrom } from "./connections.ts";
import type { SandboxContainer } from "./container-backend.ts";
import { bundleId, createDynamicWorkerIsolateBackend, workerLoaderIsolates } from "./dynamic-worker.ts";
import { createGateway, type Gateway } from "./gateway.ts";
import type { IsolatePort } from "./isolate/runner.ts";
import type { Placement } from "./measure.ts";
import {
	cpaKey,
	createGatewayModels,
	defaultModel,
	imageModel,
	type ModelsVars,
	modelsConfigWarning,
} from "./models.ts";
import { type RecallVars, recallRendererFrom } from "./recall-renderer.ts";
import { locationHint, namedObject, type PlacementVars, VAULT_NAME } from "./route.ts";
import { isolateBackendName, type SandboxVars } from "./sandboxes.ts";
import { type BootstrapRecord, createStack, type Stack, type StackOptions, type StackStorage } from "./stack.ts";
import { startOnce } from "./start.ts";
import { type SubagentVars, subagentsEnabled } from "./subagent.ts";
import { approvalVaultOver, type VaultVars } from "./vault.ts";
import type { HarbourVault } from "./vault-object.ts";
import { durableHeadCache } from "./workspace-heads.ts";

export { STACK_NAME } from "./route.ts";

export interface Env
	extends GatewayVars,
		VaultVars,
		ModelsVars,
		SandboxVars,
		PlacementVars,
		BrowserVars,
		CodemodeVars,
		SubagentVars,
		RecallVars,
		ConnectionsVars {
	/**
	 * `off` stops serving a session's events over a WebSocket: the console then reads them as server-sent events, as it
	 * did before. Anything else (the default) serves both.
	 */
	readonly HARBOUR_SESSION_WEBSOCKET?: string;
	/**
	 * `off` takes the experimental `present_files` tool away (`@harbour/sandbox/present-files`). Anything else (the
	 * default) offers it, and the console shows the files it presents as cards that open a viewer.
	 */
	readonly HARBOUR_PRESENT_FILES?: string;
	/**
	 * `off` stops writing a usage row per model call (`src/usage.ts`, docs/usage-analytics.md). Anything else (the
	 * default) writes them to the object's ledger and ships them to `usage_calls` in D1.
	 */
	readonly HARBOUR_USAGE?: string;
	readonly STACK: DurableObjectNamespace;
	/** The VaultDO (`HarbourVault`, `src/vault-object.ts`). */
	readonly VAULTS: DurableObjectNamespace<HarbourVault>;
	/** The Workers VPC service to CLIProxyAPI on Sal's host. Absent in `wrangler dev`. */
	readonly MODELS?: Fetcher;
	readonly ASSETS: Fetcher;
	readonly DB: D1Database;
	readonly WORKSPACES: R2Bucket;
	/** Harbour's own browsers (`HarbourBrowser`, `src/browser-object.ts`), for `HARBOUR_BROWSER_PROVIDER=harbour`. */
	readonly BROWSERS?: DurableObjectNamespace;
	readonly HARBOUR_BROWSER_SEAL_KEY?: string;
	readonly HARBOUR_BROWSER_RECORDING_DAYS?: string;
	/** The Worker Loader, for the `dynamic-worker` isolate backend and code mode's isolates. */
	readonly LOADER?: WorkerLoader;
	/** The sessions' container tier (`HarbourSandbox`, `src/sandbox-object.ts`), one object per session. */
	readonly SANDBOXES?: DurableObjectNamespace;
	/**
	 * `on` when the deploy runs the sandbox containers (`HARBOUR_SANDBOX_CONTAINERS`, scripts/deploy-config.ts): only then
	 * do commands escalate to a container. Anything else refuses them `unavailable`, as before.
	 */
	readonly HARBOUR_SANDBOX_CONTAINERS?: string;
}

/**
 * A command's workspace port as an RPC target, so the Dynamic Worker isolate can call it: each call runs here, in the
 * stack object, with the caller's context, which the isolate never sees.
 */
class IsolatePortTarget extends RpcTarget implements IsolatePort {
	readonly #port: IsolatePort;
	constructor(port: IsolatePort) {
		super();
		this.#port = port;
	}
	cancelled() {
		return this.#port.cancelled();
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
/** The code mode isolate's digest: its code and QuickJS's size, part of every code mode isolate's loader ID. */
const CODEMODE_BUNDLE_ID = `${bundleId(CODEMODE_BUNDLE)}${QUICKJS_WASM.byteLength.toString(36)}`;
/** `SELECT 1` queries (and R2 `head`s) the placement probe times. */
const PLACEMENT_QUERIES = 5;
/** The key the R2 probe heads: outside the workspace prefix, and never written. */
const PLACEMENT_R2_KEY = "placement-probe/none";

/** The vault object's RPC methods the model gateway calls (`HarbourVault`). */
interface VaultRpc {
	cpaItem(): Promise<string>;
	readConnectorCredential(ctx: SystemContext, request: ConnectorCredentialRequest): Promise<ConnectorCredential>;
	assertSessionOpen(ctx: SystemContext, scope: ModelCallScope): Promise<void>;
}

/**
 * Accepts a session's event socket in this object. Not hibernatable: the socket is fed by a live watch in this object,
 * as the event stream is. The response has no `Sec-WebSocket-Extensions`, so the runtime negotiates `permessage-deflate`
 * with the client itself (the `web_socket_compression` flag, on by this Worker's compatibility date).
 */
const acceptWebSocket: AcceptWebSocket = () => {
	const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
	server.accept();
	return { socket: server, response: new Response(null, { status: 101, webSocket: client }) };
};

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
			recallRenderer: recallRendererFrom(this.env),
		}),
		start: async ({ config, models, isolateBackend, recallRenderer }) => {
			const stack = await createStack({
				...(models === undefined ? {} : { models }),
				isolateBackend,
				recallRenderer,
				...this.stackOptions(),
				config,
				storage: this.stackStorage(),
			});
			const sockets = (this.env.HARBOUR_SESSION_WEBSOCKET ?? "").trim() !== "off";
			return {
				stack,
				gateway: createGateway(stack, {
					placement: (request) => this.placement(request),
					...(sockets ? { acceptWebSocket } : {}),
				}),
			};
		},
		reset: (reason) => this.ctx.abort(reason),
		onStartError: (error) => console.error("harbour: the stack did not start; resetting the object", error),
	});

	/** How the stack is built; the dev entry point adds a mock Access issuer. */
	protected stackOptions(): Omit<StackOptions, "config" | "storage"> {
		// The approval API's vault: each call goes to the one VaultDO over RPC, as the person the gateway signed in.
		const env = this.env;
		const loader = this.env.LOADER;
		const browserProvider = browserProviderFrom(env, {
			...(env.BROWSERS === undefined ? {} : { browsers: env.BROWSERS as unknown as BrowserObjects }),
			locationHint: locationHint(env),
		});
		if (browserProvider === undefined) {
			console.warn("harbour: the browser provider has no key (HARBOUR_BROWSER_PROVIDER); sessions have no browser");
		}
		// Connections (epic #322): their secrets in the one VaultDO, over RPC.
		const connections = stackConnectionsFrom(env, () => namedObject(env.VAULTS, VAULT_NAME, env));
		const sandboxObjects = env.SANDBOXES;
		const containersOn = (env.HARBOUR_SANDBOX_CONTAINERS ?? "").trim() === "on" && sandboxObjects !== undefined;
		return {
			...(browserProvider === undefined ? {} : { browserProvider }),
			...(connections === undefined ? {} : { connections }),
			presentFiles: (env.HARBOUR_PRESENT_FILES ?? "").trim() !== "off",
			// One container object per session, beside the stack (the container app's regions place the container itself).
			...(containersOn
				? {
						sandboxContainers: (sessionId: string) =>
							namedObject(sandboxObjects, `sandbox:${sessionId}`, env) as unknown as SandboxContainer,
					}
				: {}),
			// Code mode, when the Worker has the loader and HARBOUR_CODEMODE isn't `off`: each session's scripts run in its own
			// isolate, with no bindings and no network, loaded by its first script (`src/codemode.ts`).
			...(loader === undefined || !codemodeEnabled(env)
				? {}
				: {
						codemode: {
							load: workerLoaderCodemode(loader, CODEMODE_BUNDLE, QUICKJS_WASM),
							bundleId: CODEMODE_BUNDLE_ID,
						},
					}),
			// Subagents, when HARBOUR_SUBAGENTS is `on` (experimental, `src/subagent.ts`).
			...(subagentsEnabled(env) ? { subagents: true } : {}),
			// QuickJS, compiled by wrangler's CompiledWasm rule: `node` runs plain JavaScript in the in-process isolate.
			nodeEngine: QUICKJS_NODE,
			vault: approvalVaultOver((method, ctx, args) =>
				namedObject(env.VAULTS, VAULT_NAME, env).approvalCall(method, ctx, args),
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
								expose: (port) => new IsolatePortTarget(port),
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
		// R2 says nothing of where a bucket lives, so only its round trip: a `head` of a key no workspace uses.
		const r2: { roundTripMs: number }[] = [];
		try {
			for (let i = 0; i < PLACEMENT_QUERIES; i += 1) {
				const started = performance.now();
				await this.env.WORKSPACES.head(PLACEMENT_R2_KEY);
				r2.push({ roundTripMs: Math.round((performance.now() - started) * 10) / 10 });
			}
		} catch (error) {
			console.warn("harbour: the R2 placement probe failed", error);
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
			r2: { queries: r2 },
		};
	}

	/**
	 * Sessions on the model gateway when the Worker has the `MODELS` binding and CPA's key; `undefined` (the echo model)
	 * otherwise. Throws (`invalid`) on a bad `HARBOUR_DEFAULT_MODEL` or
	 * `HARBOUR_IMAGE_MODEL`.
	 */
	/** How the gateway reaches CPA: the `MODELS` VPC service. The dev entry point can stand a fake in. */
	protected modelsUpstream(): ((request: Request) => Promise<Response>) | undefined {
		const upstream = this.env.MODELS;
		return upstream === undefined ? undefined : (request) => upstream.fetch(request);
	}

	protected stackModels(): StackOptions["models"] {
		const upstream = this.modelsUpstream();
		const ignored = modelsConfigWarning(this.env);
		if (ignored !== undefined) console.warn(ignored);
		if (upstream === undefined || cpaKey(this.env) === undefined) {
			console.warn("harbour: no MODELS binding or HARBOUR_CPA_API_KEY; sessions run on the echo model");
			return undefined;
		}
		const modelId = defaultModel(this.env);
		const imageModelId = imageModel(this.env);
		const vault = namedObject(this.env.VAULTS, VAULT_NAME, this.env) as unknown as VaultRpc;
		return ({ audit, clock, usage }) =>
			createGatewayModels({
				...(usage === undefined ? {} : { usage }),
				upstream,
				vault: {
					cpaItem: () => vault.cpaItem(),
					// An AbortSignal can't cross RPC, so the read goes without one: it is one call to the vault object.
					readConnectorCredential: ({ signal: _signal, ...ctx }, request) =>
						vault.readConnectorCredential(ctx, request),
					assertSessionOpen: ({ signal: _signal, ...ctx }, scope) => vault.assertSessionOpen(ctx, scope),
				},
				audit,
				clock,
				modelId,
				...(imageModelId === undefined ? {} : { imageModelId }),
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
			// Heads kept in this object's storage, in front of R2 (src/workspace-heads.ts): every write goes through here.
			workspaces: createR2WorkspaceStore({
				bucket: this.env.WORKSPACES,
				prefix: WORKSPACE_PREFIX,
				headCache: durableHeadCache(storage.kv),
			}),
			// The skills store keys every body `skills/…`, so it shares the workspaces' bucket (and its placement) apart.
			skillObjects: r2ObjectBucket(this.env.WORKSPACES),
			// Prompt attachments too, keyed `attachments/…` (src/attachments.ts).
			attachmentObjects: r2ObjectBucket(this.env.WORKSPACES),
			bootstrap: {
				load: async () => (await storage.get<BootstrapRecord>(BOOTSTRAP_KEY)) ?? {},
				save: (record) => storage.put(BOOTSTRAP_KEY, record),
			},
			// Audit events queue in this object's SQLite and drain to D1 after the answer (src/audit-outbox.ts).
			auditOutbox: {
				driver: objectSqlDriver(storage.sql, (work) => storage.transactionSync(work)),
				background: (work) => this.ctx.waitUntil(work),
			},
			// One usage row per model call, in this object's SQLite, shipped to D1 after the answer (src/usage.ts).
			...(this.env.HARBOUR_USAGE?.trim() === "off"
				? {}
				: {
						usageLedger: {
							driver: objectSqlDriver(storage.sql, (work) => storage.transactionSync(work)),
							background: (work: Promise<unknown>) => this.ctx.waitUntil(work),
						},
					}),
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
