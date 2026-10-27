// The self-hosted isolate host: a workerd Worker that gives each session its
// own Dynamic Worker with the workerLoader binding, the same primitive the
// Cloudflare target uses.
//
// Two ways to get a session its isolate, chosen by ISOLATE_POOL_SIZE
// (docs/design/isolate-readiness.md):
//
// - Pool (the default, 4): isolates are loaded ahead of time with no workspace
//   and no session. A new session takes one; it is that session's alone and
//   never goes back to the pool. The workspace is passed with every call as a
//   WorkspaceScope, revoked when the call ends, and egress learns the session
//   from this host's slot-to-session map, written once at hand-out.
// - Off (ISOLATE_POOL_SIZE=0): one Dynamic Worker loaded per session, with the
//   workspace and session fixed in props at load (the M0 behaviour).
//
// - Workspace: reads and writes content-addressed blobs in MinIO (S3 API). The
//   sandbox never sees the S3 credentials, and only names blobs by SHA-256.
// - Egress: the sandbox's globalOutbound. It tags each request with the
//   session and forwards it to the vault proxy, an external service in HTTP
//   proxy style. Nothing else is reachable from the sandbox.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";
// Bundled just-bash sandbox, embedded as a text module by config.capnp.
import sandboxSource from "harbour-sandbox-bundle";
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
	headers.set("x-harbour-session", sessionId);
	headers.set("x-harbour-tier", "isolate");
	headers.set("x-harbour-host-key", env.VAULT_ISOLATE_KEY);
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

const DEFAULT_POOL_SIZE = 4;
const MAX_POOL_SIZE = 64;
/** A session idle this long gives up its slot; its next call gets a fresh isolate. Calls carry no state between them. */
const SESSION_IDLE_MS = 30 * 60_000;
/**
 * A load holds workerd's only thread for about 125 ms, so a refill loads only when no /list or /exec has been in
 * flight for this long: the refill fills the gaps (a model call between tool calls) instead of stalling a command.
 */
const QUIET_MS = 25;
/** A refill that finds no quiet spell for this long stops; the next hand-out or health check starts another. */
const REFILL_PATIENCE_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let warnedSize = false;
/** ISOLATE_POOL_SIZE: unset or empty is the default; anything but an integer from 0 to 64 turns the pool off. */
export function poolSize(env: Pick<Env, "ISOLATE_POOL_SIZE">): number {
	const raw = env.ISOLATE_POOL_SIZE?.trim();
	if (raw === undefined || raw === "") return DEFAULT_POOL_SIZE;
	const size = Number(raw);
	if (/^\d+$/.test(raw) && size <= MAX_POOL_SIZE) return size;
	if (!warnedSize)
		console.warn(`ISOLATE_POOL_SIZE=${raw} is not an integer from 0 to ${MAX_POOL_SIZE}; the pool is off`);
	warnedSize = true;
	return 0;
}

interface Assignment {
	slot: string;
	lastUsed: number;
	inFlight: number;
}

/**
 * Pre-loaded isolates and who owns them. A slot is loaded with no workspace and no session; handing it out
 * writes slot → session once. A slot is never handed out twice: when its session goes idle the mapping is
 * dropped, and the isolate's egress is refused from then on.
 */
class Pool {
	/** Loaded, not yet handed out. */
	readonly #idle: string[] = [];
	readonly #owners = new Map<string, string>();
	readonly #sessions = new Map<string, Assignment>();
	#next = 0;
	#refilling: Promise<void> | undefined;
	/** /list and /exec calls in flight, and when the last one started or ended. */
	#active = 0;
	#lastActive = 0;

	owner(slot: string): string | undefined {
		return this.#owners.get(slot);
	}

	begin(now: number): void {
		this.#active += 1;
		this.#lastActive = now;
	}

	end(now: number): void {
		this.#active -= 1;
		this.#lastActive = now;
	}

	/** The session's slot, handing out a pre-loaded one (or a fresh one when none is ready) on its first call. */
	assign(sessionId: string, now: number): { assignment: Assignment; hit: boolean | undefined } {
		this.#expire(now);
		const existing = this.#sessions.get(sessionId);
		if (existing) return { assignment: existing, hit: undefined };
		const ready = this.#idle.shift();
		const slot = ready ?? this.#newSlot();
		const assignment = { slot, lastUsed: now, inFlight: 0 };
		this.#owners.set(slot, sessionId);
		this.#sessions.set(sessionId, assignment);
		return { assignment, hit: ready !== undefined };
	}

	/** Top the pool up to `size`, one load at a time, each in a quiet spell. */
	refill(load: (slot: string) => Promise<unknown>, size: number): Promise<void> {
		this.#refilling ??= (async () => {
			// After a turn, so `#refilling` is set before the `finally` below clears it.
			await undefined;
			const giveUp = Date.now() + REFILL_PATIENCE_MS;
			try {
				while (this.#idle.length < size) {
					if (!(await this.#quiet(giveUp))) return;
					const slot = this.#newSlot();
					await load(slot);
					this.#idle.push(slot);
				}
			} catch (error) {
				console.error("isolate pool refill failed:", error);
			} finally {
				this.#refilling = undefined;
			}
		})();
		return this.#refilling;
	}

	stats() {
		return { idle: this.#idle.length, sessions: this.#sessions.size };
	}

	/** Until nothing has been in flight for QUIET_MS; false once `giveUp` passes first. */
	async #quiet(giveUp: number): Promise<boolean> {
		for (;;) {
			const now = Date.now();
			if (this.#active === 0 && now - this.#lastActive >= QUIET_MS) return true;
			if (now >= giveUp) return false;
			await sleep(QUIET_MS);
		}
	}

	#newSlot(): string {
		// Never reused, and apart from the `session:` IDs of the unpooled path.
		return `pool:${this.#next++}`;
	}

	#expire(now: number): void {
		for (const [sessionId, assignment] of this.#sessions) {
			if (assignment.inFlight > 0 || now - assignment.lastUsed < SESSION_IDLE_MS) continue;
			this.#sessions.delete(sessionId);
			this.#owners.delete(assignment.slot);
		}
	}
}

const pool = new Pool();

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
			...(isolate === undefined ? {} : { "x-harbour-isolate": isolate }),
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
		pool.begin(Date.now());
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
				const assigned = pool.assign(body.sessionId, Date.now());
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
			pool.end(Date.now());
			for (const scope of scopes) scope.revoke();
			if (assignment) {
				assignment.inFlight -= 1;
				assignment.lastUsed = Date.now();
			}
		}
	},
};
