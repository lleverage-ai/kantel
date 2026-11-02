// The self-hosted isolate host: a workerd Worker that gives each session its
// own Dynamic Worker with the workerLoader binding, the same primitive the
// Cloudflare target uses.
//
// Two ways to get a session its isolate, chosen by ISOLATE_POOL_SIZE:
//
// - Pool (the default, 4): isolates are loaded ahead of time with no workspace
//   and no session. A new session takes one; it is that session's alone and
//   never goes back to the pool. The workspace is passed with every call as a
//   WorkspaceScope, revoked when the call ends, and egress learns the session
//   from this host's slot-to-session map, written once at hand-out.
// - Off (ISOLATE_POOL_SIZE=0): one Dynamic Worker loaded per session, with the
//   workspace and session fixed in props at load (the spike's behaviour).
//
// - Workspace: reads and writes content-addressed blobs in MinIO (S3 API). The
//   sandbox never sees the S3 credentials, and only names blobs by SHA-256.
// - Egress: the sandbox's globalOutbound. It tags each request with the
//   session and forwards it to the vault proxy, an external service in HTTP
//   proxy style. Nothing else is reachable from the sandbox.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";
// Bundled just-bash sandbox, embedded as a text module by config.capnp.
import sandboxSource from "kantel-sandbox-bundle";
import { type Assignment, Pool, parsePoolSize } from "./pool.ts";
import type { ExecRequest, Manifest, default as Sandbox } from "./sandbox.ts";

interface Env {
	LOADER: {
		get(id: string, factory: () => Promise<unknown>): { getEntrypoint(name?: string): SandboxEntrypoint };
	};
	VAULT: Fetcher;
	S3_ENDPOINT: string;
	S3_BUCKET: string;
	S3_ACCESS_KEY: string;
	S3_SECRET_KEY: string;
	/** Proves to the vault that a request's session header was set by this host, not by a sandbox. */
	VAULT_ISOLATE_KEY: string;
	COMPATIBILITY_DATE: string;
	/** Pre-loaded isolates to keep ready: unset means 4, 0 turns the pool off. */
	ISOLATE_POOL_SIZE?: string;
}

/** The Dynamic Worker's RPC surface (sandbox.ts); a pooled isolate takes the workspace with each call. */
type SandboxEntrypoint = {
	list(manifest: Manifest, scope?: WorkspaceScope): ReturnType<Sandbox["list"]>;
	exec(request: ExecRequest, scope?: WorkspaceScope): ReturnType<Sandbox["exec"]>;
};

/** Loopback bindings to this Worker's own entrypoints, with props (`ctx.exports`). */
type LoaderContext = ExecutionContext & {
	exports: {
		Workspace(options: { props: WorkspaceProps }): unknown;
		Egress(options: { props: EgressProps }): unknown;
		PooledEgress(options: { props: PooledEgressProps }): unknown;
	};
};

interface WorkspaceProps {
	workspaceId: string;
}

interface EgressProps {
	sessionId: string;
}

interface PooledEgressProps {
	slot: string;
}

const s3 = (env: Env) =>
	new AwsClient({
		accessKeyId: env.S3_ACCESS_KEY,
		secretAccessKey: env.S3_SECRET_KEY,
		service: "s3",
		region: "us-east-1",
	});

const blobUrl = (env: Env, workspaceId: string, sha: string) =>
	`${env.S3_ENDPOINT}/${env.S3_BUCKET}/workspaces/${encodeURIComponent(workspaceId)}/blobs/${sha}`;
const manifestUrl = (env: Env, workspaceId: string, version: string) =>
	`${env.S3_ENDPOINT}/${env.S3_BUCKET}/workspaces/${encodeURIComponent(workspaceId)}/manifests/${version}.json`;

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A blob is named by its SHA-256 and nothing else: no path segments can reach another workspace's keys. */
const DIGEST = /^[0-9a-f]{64}$/;

async function readBlob(env: Env, workspaceId: string, sha: string): Promise<Uint8Array> {
	if (typeof sha !== "string" || !DIGEST.test(sha)) throw new Error("blob: not a SHA-256 digest");
	const response = await s3(env).fetch(blobUrl(env, workspaceId, sha));
	if (!response.ok) throw new Error(`blob ${sha}: ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

async function putBlob(env: Env, workspaceId: string, bytes: Uint8Array): Promise<string> {
	const sha = await sha256(bytes);
	const response = await s3(env).fetch(blobUrl(env, workspaceId, sha), { method: "PUT", body: bytes });
	if (!response.ok) throw new Error(`put blob ${sha}: ${response.status}`);
	return sha;
}

export class Workspace extends WorkerEntrypoint<Env, WorkspaceProps> {
	read(sha: string): Promise<Uint8Array> {
		return readBlob(this.env, this.ctx.props.workspaceId, sha);
	}

	put(bytes: Uint8Array): Promise<string> {
		return putBlob(this.env, this.ctx.props.workspaceId, bytes);
	}
}

/**
 * A pooled isolate's workspace for one call. The host builds it for the session's workspace and passes it with
 * the call; once the call ends it is revoked, so a stub the isolate kept is worth nothing afterwards.
 */
export class WorkspaceScope extends RpcTarget {
	readonly #env: Env;
	readonly #workspaceId: string;
	#revoked = false;
	constructor(env: Env, workspaceId: string) {
		super();
		this.#env = env;
		this.#workspaceId = workspaceId;
	}
	read(sha: string): Promise<Uint8Array> {
		if (this.#revoked) return Promise.reject(new Error("workspace scope revoked"));
		return readBlob(this.#env, this.#workspaceId, sha);
	}
	put(bytes: Uint8Array): Promise<string> {
		if (this.#revoked) return Promise.reject(new Error("workspace scope revoked"));
		return putBlob(this.#env, this.#workspaceId, bytes);
	}
	revoke(): void {
		this.#revoked = true;
	}
}

function toVault(env: Env, request: Request, sessionId: string): Promise<Response> {
	const headers = new Headers(request.headers);
	// The vault decides per session; the sandbox cannot forge this header,
	// because the host sets it after the sandbox's request leaves the isolate.
	headers.set("x-kantel-session", sessionId);
	headers.set("x-kantel-tier", "isolate");
	headers.set("x-kantel-host-key", env.VAULT_ISOLATE_KEY);
	// The same under their names before the rename, for a vault proxy built before it; set here, so never the sandbox's.
	headers.set("x-harbour-session", sessionId); // before the rename
	headers.set("x-harbour-tier", "isolate"); // before the rename
	headers.set("x-harbour-host-key", env.VAULT_ISOLATE_KEY); // before the rename
	return env.VAULT.fetch(new Request(request, { headers }));
}

export class Egress extends WorkerEntrypoint<Env, EgressProps> {
	async fetch(request: Request): Promise<Response> {
		return toVault(this.env, request, this.ctx.props.sessionId);
	}
}

/** A pooled isolate's globalOutbound: its props name only the slot, and the session comes from the pool's map. */
export class PooledEgress extends WorkerEntrypoint<Env, PooledEgressProps> {
	async fetch(request: Request): Promise<Response> {
		const sessionId = pool.owner(this.ctx.props.slot);
		if (sessionId === undefined) return new Response("isolate not handed out", { status: 403 });
		return toVault(this.env, request, sessionId);
	}
}

// --- The pool ----------------------------------------------------------------

let warnedSize = false;
function poolSize(env: Pick<Env, "ISOLATE_POOL_SIZE">): number {
	const { size, invalid } = parsePoolSize(env.ISOLATE_POOL_SIZE);
	if (invalid && !warnedSize) {
		console.warn(`ISOLATE_POOL_SIZE=${env.ISOLATE_POOL_SIZE} is not an integer from 0 to 64; the pool is off`);
		warnedSize = true;
	}
	return size;
}

const pool = new Pool({
	// Calls carry no state between them, so an idle session can lose its isolate.
	sessionIdleMs: 30 * 60_000,
	// A load holds workerd's only thread for about 125 ms, so a refill loads only in a quiet spell: it fills the
	// gaps (a model call between tool calls) instead of stalling a command.
	quietMs: 25,
	refillPatienceMs: 10_000,
	onRefillError: (error) => console.error("isolate pool refill failed:", error),
});

function pooledSandbox(env: Env, ctx: LoaderContext, slot: string): SandboxEntrypoint {
	return env.LOADER.get(slot, async () => ({
		compatibilityDate: env.COMPATIBILITY_DATE,
		mainModule: "sandbox.js",
		modules: { "sandbox.js": sandboxSource },
		// No WS binding: the workspace comes with each call.
		env: {},
		globalOutbound: ctx.exports.PooledEgress({ props: { slot } }),
	})).getEntrypoint();
}

/** Load a slot now: one call makes workerd compile and run the bundle. */
function preload(env: Env, ctx: LoaderContext) {
	return async (slot: string) => {
		const scope = new WorkspaceScope(env, "");
		scope.revoke();
		await pooledSandbox(env, ctx, slot).list({}, scope);
	};
}

function scheduleRefill(env: Env, ctx: LoaderContext, size: number): void {
	ctx.waitUntil(pool.refill(preload(env, ctx), size));
}

interface LoadBody {
	sessionId: string;
	workspaceId: string;
	version: string;
	/** Optional: skip the manifest fetch when the caller already has it. */
	manifest?: Manifest;
}

function sandboxFor(env: Env, ctx: LoaderContext, body: LoadBody) {
	return env.LOADER.get(`session:${body.sessionId}`, async () => ({
		compatibilityDate: env.COMPATIBILITY_DATE,
		mainModule: "sandbox.js",
		modules: { "sandbox.js": sandboxSource },
		env: { WS: ctx.exports.Workspace({ props: { workspaceId: body.workspaceId } }) },
		globalOutbound: ctx.exports.Egress({ props: { sessionId: body.sessionId } }),
	})).getEntrypoint();
}

async function loadManifest(env: Env, workspaceId: string, version: string): Promise<Manifest> {
	if (version === "empty") return {};
	const response = await s3(env).fetch(manifestUrl(env, workspaceId, version));
	if (!response.ok) throw new Error(`manifest ${workspaceId}@${version}: ${response.status}`);
	return (await response.json()) as Manifest;
}

const json = (value: unknown, status = 200, isolate?: string) =>
	new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json",
			// How the call found its isolate: per-session, or pool-hit, pool-miss or pool-assigned (a later call).
			...(isolate === undefined ? {} : { "x-kantel-isolate": isolate }),
		},
	});

export default {
	async fetch(request: Request, env: Env, ctx: LoaderContext): Promise<Response> {
		const url = new URL(request.url);
		const size = poolSize(env);
		if (url.pathname === "/healthz") {
			// The first health check after start fills the pool.
			if (size > 0) scheduleRefill(env, ctx, size);
			return json({ ok: true, pool: { size, ...pool.stats() } });
		}
		if (request.method !== "POST" || (url.pathname !== "/list" && url.pathname !== "/exec")) {
			return json({ error: "not found" }, 404);
		}
		let assignment: Assignment | undefined;
		const scopes: WorkspaceScope[] = [];
		pool.begin();
		try {
			const started = Date.now();
			const body = (await request.json()) as LoadBody & Partial<ExecRequest>;
			const manifest = body.manifest ?? (await loadManifest(env, body.workspaceId, body.version));
			const manifestMs = Date.now() - started;
			let sandbox: SandboxEntrypoint;
			let scope: WorkspaceScope | undefined;
			let isolate = "per-session";
			if (size > 0) {
				if (typeof body.sessionId !== "string" || body.sessionId === "")
					return json({ error: "sessionId required" }, 400);
				const assigned = pool.assign(body.sessionId);
				assignment = assigned.assignment;
				assignment.inFlight += 1;
				if (assigned.hit !== undefined) scheduleRefill(env, ctx, size);
				isolate = assigned.hit === undefined ? "pool-assigned" : assigned.hit ? "pool-hit" : "pool-miss";
				sandbox = pooledSandbox(env, ctx, assignment.slot);
				scope = new WorkspaceScope(env, body.workspaceId);
				scopes.push(scope);
			} else {
				sandbox = sandboxFor(env, ctx, body);
			}
			if (url.pathname === "/list") {
				const listed = await sandbox.list(manifest, scope);
				return json({ ...listed, timings: { manifestMs, totalMs: Date.now() - started } }, 200, isolate);
			}
			const result = await sandbox.exec(
				{
					command: body.command!,
					cwd: body.cwd,
					env: body.env,
					manifest,
					timeoutMs: body.timeoutMs,
				},
				scope,
			);
			return json(
				{ ...result, timings: { ...result.timings, manifestMs, totalMs: Date.now() - started } },
				200,
				isolate,
			);
		} catch (error) {
			return json({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, 500);
		} finally {
			pool.end();
			for (const scope of scopes) scope.revoke();
			if (assignment) {
				assignment.inFlight -= 1;
				assignment.lastUsed = Date.now();
			}
		}
	},
};
