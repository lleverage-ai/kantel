// The measurement host: images/isolate-host/src/loader.ts unchanged, plus
// /bench/* routes that model the alternatives to one Dynamic Worker per session.
// Built by run.ts into harness/dist/ and served by harness/config.capnp.
//
//   POST /list                  today's path, loader.ts's own handler (variant a)
//   POST /bench/per-workspace   LOADER.get keyed by workspace (variant b)
//   POST /bench/pool            hand a pre-loaded isolate to a new session, refill after
//                               the response (variant c) or at once ({ refill: "now" }, variant g)
//   POST /bench/pool/fill       load the pool ahead of time; waits until it is full
//   POST /bench/split           today's load, timed in phases (variant d)
//   POST /bench/trivial         load a tiny Dynamic Worker, for the fixed cost of a new isolate (variant e)
//   POST /bench/lazy            a new Dynamic Worker per session that loads just-bash on first exec (variant f)
//   POST /bench/lazy/exec       that session's first command
//
// Every route takes { sessionId, workspaceId, version } and reads the manifest
// from MinIO exactly as loader.ts does, so the variants differ only in how the
// isolate is found.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";
import lazySource from "harbour-lazy-sandbox-bundle";
import pooledSource from "harbour-pooled-sandbox-bundle";
import sandboxSource from "harbour-sandbox-bundle";
import trivialSource from "harbour-trivial-bundle";
import loaderHost, { Egress, Workspace } from "../../../../images/isolate-host/src/loader.ts";
import type { ExecRequest, ExecResponse, Manifest } from "../../../../images/isolate-host/src/sandbox.ts";

// ctx.exports resolves against this module's exports, so loader.ts's handler
// gets the same Workspace and Egress it gets in the image.
export { Egress, Workspace };

interface Env {
	LOADER: {
		get(id: string, factory: () => Promise<unknown>): { getEntrypoint(name?: string): unknown };
	};
	VAULT: Fetcher;
	S3_ENDPOINT: string;
	S3_BUCKET: string;
	S3_ACCESS_KEY: string;
	S3_SECRET_KEY: string;
	VAULT_ISOLATE_KEY: string;
	COMPATIBILITY_DATE: string;
}

interface Body {
	sessionId: string;
	workspaceId: string;
	version: string;
	size?: number;
	refill?: "after-response" | "now";
	command?: string;
}

type ListResult = { entries: number; bytes: number };
type SandboxStub = {
	list(manifest: Manifest): Promise<ListResult>;
	exec(request: ExecRequest): Promise<ExecResponse>;
};
type PooledStub = { list(manifest: Manifest, scope: WorkspaceScope): Promise<ListResult> };

type BenchContext = ExecutionContext & {
	exports: {
		Workspace(options: { props: { workspaceId: string } }): unknown;
		Egress(options: { props: { sessionId: string } }): unknown;
		PooledEgress(options: { props: { slot: string } }): unknown;
	};
};

/** The same manifest read as loader.ts's loadManifest. */
async function loadManifest(env: Env, workspaceId: string, version: string): Promise<Manifest> {
	const client = new AwsClient({
		accessKeyId: env.S3_ACCESS_KEY,
		secretAccessKey: env.S3_SECRET_KEY,
		service: "s3",
		region: "us-east-1",
	});
	const url = `${env.S3_ENDPOINT}/${env.S3_BUCKET}/workspaces/${encodeURIComponent(workspaceId)}/manifests/${version}.json`;
	const response = await client.fetch(url);
	if (!response.ok) throw new Error(`manifest ${workspaceId}@${version}: ${response.status}`);
	return (await response.json()) as Manifest;
}

// --- Variant b: one isolate per workspace -----------------------------------
// Props are fixed at load, so egress can only be tagged with the workspace,
// not the session that made the request.

function workspaceSandbox(env: Env, ctx: BenchContext, workspaceId: string): SandboxStub {
	return env.LOADER.get(`workspace:${workspaceId}`, async () => ({
		compatibilityDate: env.COMPATIBILITY_DATE,
		mainModule: "sandbox.js",
		modules: { "sandbox.js": sandboxSource },
		env: { WS: ctx.exports.Workspace({ props: { workspaceId } }) },
		globalOutbound: ctx.exports.Egress({ props: { sessionId: `workspace:${workspaceId}` } }),
	})).getEntrypoint() as SandboxStub;
}

// --- Variant c: a pre-loaded pool -------------------------------------------
// A pooled isolate is loaded before anyone owns it, so it gets no WS binding
// and its egress carries only its slot. The host maps slot to session when it
// hands the isolate out, and passes the workspace scope with every call.

/** Slots loaded and not yet handed out. */
const idle: string[] = [];
/** Slot to the session that owns it, read by PooledEgress on every request. */
const owners = new Map<string, string>();
let nextSlot = 0;
let poolTarget = 0;
/** The one refill loop in flight, if any. */
let refilling: Promise<void> | undefined;

function pooledSandbox(env: Env, ctx: BenchContext, slot: string): PooledStub {
	return env.LOADER.get(slot, async () => ({
		compatibilityDate: env.COMPATIBILITY_DATE,
		mainModule: "pooled-sandbox.js",
		modules: { "pooled-sandbox.js": pooledSource },
		env: {},
		globalOutbound: ctx.exports.PooledEgress({ props: { slot } }),
	})).getEntrypoint() as PooledStub;
}

/** Load one slot: create it and make one call, so workerd compiles and runs the bundle now. */
async function preload(env: Env, ctx: BenchContext): Promise<void> {
	const slot = `pool:${nextSlot++}`;
	await pooledSandbox(env, ctx, slot).list({}, new WorkspaceScope(ctx, ""));
	idle.push(slot);
}

/** Top the pool up to poolTarget, one load at a time, as background work after a hand-out. */
function refill(env: Env, ctx: BenchContext): Promise<void> {
	refilling ??= (async () => {
		while (idle.length < poolTarget) await preload(env, ctx);
	})().finally(() => {
		refilling = undefined;
	});
	return refilling;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The per-call workspace scope for a pooled isolate. An RPC stub to this object
 * is what the isolate gets instead of a WS binding with props: the host decides
 * the workspace, the isolate can only use what it is handed for that call.
 */
class WorkspaceScope extends RpcTarget {
	readonly #ws: Workspace;
	constructor(ctx: BenchContext, workspaceId: string) {
		super();
		this.#ws = ctx.exports.Workspace({ props: { workspaceId } }) as Workspace;
	}
	read(sha: string): Promise<Uint8Array> {
		return this.#ws.read(sha);
	}
	put(bytes: Uint8Array): Promise<string> {
		return this.#ws.put(bytes);
	}
}

/** Egress for a pooled isolate: the session comes from the host's slot map, not from props. */
export class PooledEgress extends WorkerEntrypoint<Env, { slot: string }> {
	async fetch(request: Request): Promise<Response> {
		const sessionId = owners.get(this.ctx.props.slot);
		if (!sessionId) return new Response("isolate not handed out", { status: 403 });
		const headers = new Headers(request.headers);
		headers.set("x-harbour-session", sessionId);
		headers.set("x-harbour-tier", "isolate");
		headers.set("x-harbour-host-key", this.env.VAULT_ISOLATE_KEY);
		return this.env.VAULT.fetch(new Request(request, { headers }));
	}
}

// --- Variants d, e and f: a new Dynamic Worker per session ------------------

function sessionSandbox(
	env: Env,
	ctx: BenchContext,
	body: Body,
	kind: string,
	mainModule: string,
	modules: Record<string, string>,
): SandboxStub {
	return env.LOADER.get(`${kind}:${body.sessionId}`, async () => ({
		compatibilityDate: env.COMPATIBILITY_DATE,
		mainModule,
		modules,
		env: { WS: ctx.exports.Workspace({ props: { workspaceId: body.workspaceId } }) },
		globalOutbound: ctx.exports.Egress({ props: { sessionId: body.sessionId } }),
	})).getEntrypoint() as SandboxStub;
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function bench(path: string, body: Body, env: Env, ctx: BenchContext): Promise<Response> {
	const started = Date.now();
	if (path === "/bench/pool/fill") {
		poolTarget = body.size ?? 4;
		// A refill started by an earlier request belongs to that request; wait for
		// it to finish rather than await its promise from this one, then top up here.
		while (refilling) await sleep(2);
		await refill(env, ctx);
		return json({ idle: idle.length, timings: { loadMs: Date.now() - started } });
	}
	if (path === "/bench/trivial") {
		const trivial = sessionSandbox(env, ctx, body, "trivial", "sandbox.js", { "sandbox.js": trivialSource });
		const listed = await trivial.list({});
		return json({ ...listed, timings: { loadMs: Date.now() - started, totalMs: Date.now() - started } });
	}
	const manifest = await loadManifest(env, body.workspaceId, body.version);
	const manifestMs = Date.now() - started;
	if (path === "/bench/per-workspace") {
		const listed = await workspaceSandbox(env, ctx, body.workspaceId).list(manifest);
		return json({ ...listed, timings: { manifestMs, totalMs: Date.now() - started } });
	}
	if (path === "/bench/pool") {
		const handedOut = idle.shift();
		const slot = handedOut ?? `pool:${nextSlot++}`;
		owners.set(slot, body.sessionId);
		const listed = await pooledSandbox(env, ctx, slot).list(manifest, new WorkspaceScope(ctx, body.workspaceId));
		const totalMs = Date.now() - started;
		// Loading an isolate holds workerd's thread, so a refill begun before the
		// response is written delays the response by a whole load.
		ctx.waitUntil(body.refill === "now" ? refill(env, ctx) : sleep(20).then(() => refill(env, ctx)));
		return json({ ...listed, poolHit: handedOut !== undefined, timings: { manifestMs, totalMs } });
	}
	if (path === "/bench/split") {
		const sandbox = sessionSandbox(env, ctx, body, "split", "sandbox.js", { "sandbox.js": sandboxSource });
		await sandbox.list({});
		const loaded = Date.now();
		const listed = await sandbox.list(manifest);
		const done = Date.now();
		return json({
			...listed,
			timings: { manifestMs, loadMs: loaded - started - manifestMs, listMs: done - loaded, totalMs: done - started },
		});
	}
	if (path === "/bench/lazy" || path === "/bench/lazy/exec") {
		const sandbox = sessionSandbox(env, ctx, body, "lazy", "lazy-sandbox.js", {
			"lazy-sandbox.js": lazySource,
			"sandbox.js": sandboxSource,
		});
		if (path === "/bench/lazy") {
			const listed = await sandbox.list(manifest);
			return json({ ...listed, timings: { manifestMs, totalMs: Date.now() - started } });
		}
		const result = await sandbox.exec({ command: body.command ?? "ls -R | wc -l", manifest });
		return json({ ...result, timings: { ...result.timings, manifestMs, totalMs: Date.now() - started } });
	}
	return json({ error: "not found" }, 404);
}

export default {
	async fetch(request: Request, env: Env, ctx: BenchContext): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/bench/")) return loaderHost.fetch(request, env as never, ctx as never);
		try {
			return await bench(url.pathname, (await request.json()) as Body, env, ctx);
		} catch (error) {
			return json({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, 500);
		}
	},
};
