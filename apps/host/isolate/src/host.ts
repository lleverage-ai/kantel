// The isolate tier's worker, run by workerd inside an isolate VM (one VM per account on a host). Each isolate
// sandbox gets its own Dynamic Worker running just-bash (images/isolate-host/src/sandbox.ts) over its files.
//
// kantel-host owns the sandbox's state: a manifest (path → content digest) it sends with each command, and the
// blobs, which this worker reads and writes through STORE (the host, over vsock; the host answers only for this
// VM's account). A command returns the new manifest; the host keeps it. Snapshots and forks are copies of a
// manifest, so they cost almost nothing.
//
// Fast acquisition: isolates are pre-loaded into a pool (images/isolate-host/src/pool.ts) with no sandbox; a new
// sandbox takes one. The VM itself is restored from a snapshot taken once workerd and the pool were up.
//
// Egress: a sandbox's fetch() (curl, wget) goes to its globalOutbound, which names the sandbox from the pool's
// slot → sandbox map and sends the request on to the host's egress proxy (EGRESS, over vsock). The sandbox can't
// reach EGRESS or STORE itself, and the host proxy accepts a sandbox name only for this VM's account.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import sandboxSource from "kantel-sandbox-bundle";
import { Pool } from "../../../../images/isolate-host/src/pool.ts";
import type { ExecRequest, Manifest } from "../../../../images/isolate-host/src/sandbox.ts";

interface Env {
	LOADER: {
		get(id: string, factory: () => Promise<unknown>): { getEntrypoint(name?: string): SandboxEntrypoint };
	};
	STORE: Fetcher;
	EGRESS: Fetcher;
	COMPATIBILITY_DATE: string;
}

type SandboxEntrypoint = {
	list(manifest: Manifest, scope?: BlobScope): Promise<{ entries: number; bytes: number }>;
	exec(request: ExecRequest, scope?: BlobScope): Promise<Record<string, unknown>>;
};

type LoaderContext = ExecutionContext & {
	exports: { Egress(options: { props: { slot: string } }): unknown };
};

const DIGEST = /^[0-9a-f]{64}$/;

/** One call's access to the account's blobs, revoked when the call ends. */
export class BlobScope extends RpcTarget {
	readonly #env: Env;
	#revoked = false;
	constructor(env: Env) {
		super();
		this.#env = env;
	}
	async read(sha: string): Promise<Uint8Array> {
		if (this.#revoked) throw new Error("scope revoked");
		if (typeof sha !== "string" || !DIGEST.test(sha)) throw new Error("blob: not a SHA-256 digest");
		const response = await this.#env.STORE.fetch(`http://store/blobs/${sha}`);
		if (!response.ok) throw new Error(`blob ${sha}: ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}
	async put(bytes: Uint8Array): Promise<string> {
		if (this.#revoked) throw new Error("scope revoked");
		const response = await this.#env.STORE.fetch("http://store/blobs", { method: "PUT", body: bytes });
		if (!response.ok) throw new Error(`put blob: ${response.status}`);
		return ((await response.json()) as { sha: string }).sha;
	}
	revoke(): void {
		this.#revoked = true;
	}
}

const pool = new Pool({
	// The host tells us when a sandbox stops; an idle sandbox keeps its isolate for a while so its next command is
	// as fast as its last.
	sessionIdleMs: 15 * 60_000,
	quietMs: 5,
	refillPatienceMs: 30_000,
	onRefillError: (error) => console.error("isolate pool refill failed:", error),
});

/**
 * The memory each sandbox asked for, by its isolate's slot, as kantel-host sends it with /load. Recorded, not
 * enforced: workerd 1.20261027.1's WorkerLoaderWorkerCode.limits has only cpuMs and subRequests, so there is no
 * per-isolate memory limit to set. The isolate VM's memory is the ceiling its account's isolates share.
 */
const requestedMemory = new Map<string, { sandboxId: string; memoryMiB: number }>();

function recordMemory(slot: string, sandboxId: string, memoryMiB: number): void {
	// Forget the slots whose sandbox has gone idle and given them up, so the map is no bigger than the pool's.
	for (const [kept, record] of requestedMemory) {
		if (pool.owner(kept) !== record.sandboxId) requestedMemory.delete(kept);
	}
	requestedMemory.set(slot, { sandboxId, memoryMiB });
}

/** A sandbox's egress: names the sandbox to the host's proxy. The sandbox never sees this. */
export class Egress extends WorkerEntrypoint<Env, { slot: string }> {
	async fetch(request: Request): Promise<Response> {
		const sandboxId = pool.owner(this.ctx.props.slot);
		if (sandboxId === undefined) return new Response("kantel egress: isolate not assigned", { status: 403 });
		const headers = new Headers(request.headers);
		for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith("kantel-")) headers.delete(name);
		headers.set("kantel-isolate-sandbox", sandboxId);
		return this.env.EGRESS.fetch(new Request(request, { headers }));
	}
}

function isolate(env: Env, ctx: LoaderContext, slot: string): SandboxEntrypoint {
	return env.LOADER.get(slot, async () => ({
		compatibilityDate: env.COMPATIBILITY_DATE,
		mainModule: "sandbox.js",
		modules: { "sandbox.js": sandboxSource },
		env: {},
		globalOutbound: ctx.exports.Egress({ props: { slot } }),
	})).getEntrypoint();
}

function preload(env: Env, ctx: LoaderContext) {
	return async (slot: string) => {
		const scope = new BlobScope(env);
		scope.revoke();
		await isolate(env, ctx, slot).list({}, scope);
	};
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

let want = 0;

export default {
	async fetch(request: Request, env: Env, ctx: LoaderContext): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/healthz") return json({ ok: true, want, ...pool.stats() });
			if (request.method !== "POST") return json({ error: "not found" }, 404);
			const body = (await request.json()) as Record<string, unknown>;
			if (url.pathname === "/warm") {
				want = Number(body.size ?? 0);
				await pool.refill(preload(env, ctx), want);
				return json({ ok: true, ...pool.stats() });
			}
			const sandboxId = body.sandboxId;
			if (typeof sandboxId !== "string" || sandboxId === "") return json({ error: "sandboxId required" }, 400);
			// Optional: the memory the sandbox asked for (requestedMemory).
			const memoryMiB = body.memoryMiB;
			if (
				url.pathname === "/load" &&
				memoryMiB !== undefined &&
				(typeof memoryMiB !== "number" || !Number.isInteger(memoryMiB) || memoryMiB <= 0)
			)
				return json({ error: "memoryMiB must be a positive integer" }, 400);
			const started = performance.now();
			pool.begin();
			const { assignment, hit } = pool.assign(sandboxId);
			assignment.inFlight += 1;
			const scope = new BlobScope(env);
			try {
				const sandbox = isolate(env, ctx, assignment.slot);
				if (url.pathname === "/load") {
					if (typeof memoryMiB === "number") recordMemory(assignment.slot, sandboxId, memoryMiB);
					// Make sure the isolate is loaded (a miss loads one now).
					await sandbox.list({}, scope);
					return json({
						ok: true,
						hit: hit ?? "assigned",
						ms: performance.now() - started,
						memoryMiB: requestedMemory.get(assignment.slot)?.memoryMiB,
					});
				}
				if (url.pathname === "/exec") {
					const result = await sandbox.exec(
						{
							command: String(body.command),
							cwd: body.cwd as string | undefined,
							env: body.env as Record<string, string> | undefined,
							manifest: (body.manifest ?? {}) as Manifest,
							timeoutMs: body.timeoutMs as number | undefined,
						},
						scope,
					);
					return json({ ...result, hit: hit ?? "assigned", ms: performance.now() - started });
				}
				return json({ error: "not found" }, 404);
			} finally {
				scope.revoke();
				assignment.inFlight -= 1;
				assignment.lastUsed = Date.now();
				pool.end();
				if (hit !== undefined && want > 0) ctx.waitUntil(pool.refill(preload(env, ctx), want));
			}
		} catch (error) {
			return json({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, 500);
		}
	},
};
