/**
 * harbour-ready-spike: measures #17 option (a), a pre-loaded isolate per SessionDO, against today's cold path. Every
 * route needs `Authorization: Bearer <READY_SPIKE_TOKEN>` except `GET /health`. Ready is timed here, in the Worker that
 * routes the calls, as M0-CF1 timed it (Workers clocks advance on I/O, and every phase is a call out of this Worker).
 *
 *   POST /seed           { workspaceId, files }                 one workspace version in R2 and in its WorkspaceDO
 *   POST /bench/cold     { workspaceId }                        new SessionDO, setup, list in a new isolate
 *   POST /bench/warm     { batch, slot, keepAlive?, keepAliveMs? } warm one pool object and add it to batch's pool
 *   POST /bench/handout  { batch, workspaceId, manifestFrom? }  claim a warmed object and list the workspace in it
 *   POST /where          { batch, workspaceId }                where the batch's pool directory and the WorkspaceDO run
 *   POST /cleanup                                               delete everything the spike wrote to R2
 */
import type { KeepAlive } from "./session.ts";
import { clearBucket, seedWorkspace } from "./workspace.ts";

export { PoolDO } from "./pool.ts";
export { SessionDO } from "./session.ts";
export { Blobs, Egress, WorkspaceDO } from "./workspace.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const NAME = /^[A-Za-z0-9._-]{1,80}$/;

function authorised(request: Request, env: Env): boolean {
	const header = request.headers.get("authorization") ?? "";
	const expected = `Bearer ${env.READY_SPIKE_TOKEN}`;
	if (env.READY_SPIKE_TOKEN === undefined || env.READY_SPIKE_TOKEN === "" || header.length !== expected.length)
		return false;
	let diff = 0;
	for (let i = 0; i < header.length; i += 1) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}

function name(value: unknown, what: string): string {
	if (typeof value !== "string" || !NAME.test(value)) throw new Error(`bad ${what}`);
	return value;
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
	const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
	const colo = (request.cf as { colo?: string } | undefined)?.colo;

	if (url.pathname === "/seed") {
		const workspaceId = name(body.workspaceId, "workspaceId");
		const manifest = await seedWorkspace(env.WORKSPACES, workspaceId, Number(body.files ?? 61));
		await env.WORKSPACE.getByName(workspaceId).seed(manifest);
		return json({ workspaceId, entries: Object.keys(manifest).length });
	}

	if (url.pathname === "/bench/cold") {
		// M0-CF1's "isolate session ready, workspace listed": three calls to a SessionDO that has never existed.
		const workspaceId = name(body.workspaceId, "workspaceId");
		const sessionId = `cold-${crypto.randomUUID()}`;
		const stub = env.SESSION.getByName(sessionId);
		const started = Date.now();
		await stub.ping();
		const created = Date.now();
		const setup = await stub.setup(sessionId, workspaceId);
		const setUp = Date.now();
		const listed = await stub.coldList();
		const done = Date.now();
		const where = await stub.where();
		return json({
			sessionId,
			colo,
			doColo: where.colo,
			readyMs: done - started,
			phases: { firstContactMs: created - started, setupMs: setUp - created, listMs: done - setUp },
			setup: setup.timings,
			list: listed.timings,
			lines: listed.lines,
			isolate: listed.isolate,
			who: listed.who,
		});
	}

	if (url.pathname === "/bench/warm") {
		const batch = name(body.batch, "batch");
		const slot = name(body.slot, "slot");
		const keepAlive = (body.keepAlive ?? "none") as KeepAlive;
		if (!["none", "timer", "alarm"].includes(keepAlive)) throw new Error("bad keepAlive");
		const stub = env.SESSION.getByName(slot);
		const started = Date.now();
		const warmed = await stub.warm(slot, keepAlive, Number(body.keepAliveMs ?? 0));
		const warmMs = Date.now() - started;
		const where = await stub.where();
		await env.POOL.getByName(batch).add(slot);
		return json({ slot, colo, doColo: where.colo, warmMs, ...warmed });
	}

	if (url.pathname === "/bench/handout") {
		// Option (a)'s ready: claim a warmed SessionDO from the pool, then list the workspace in its isolate.
		const batch = name(body.batch, "batch");
		const workspaceId = name(body.workspaceId, "workspaceId");
		const manifestFrom = body.manifestFrom === "r2" ? "r2" : "workspace-do";
		const sessionId = `sess-${crypto.randomUUID()}`;
		const started = Date.now();
		const slot = await env.POOL.getByName(batch).claim();
		if (slot === undefined) return json({ error: "pool empty" }, 409);
		const claimed = Date.now();
		const session = env.SESSION.getByName(slot);
		const handed = await session.handout(sessionId, workspaceId, manifestFrom);
		const done = Date.now();
		// After ready, not part of it: a bare round trip to each object, so the hand-out's own work can be told from the
		// network between this Worker and the objects.
		await session.ping();
		const sessionRtt = Date.now();
		await env.POOL.getByName(batch).size();
		const poolRtt = Date.now();
		return json({
			sessionId,
			slot,
			colo,
			manifestFrom,
			readyMs: done - started,
			phases: { claimMs: claimed - started, handoutCallMs: done - claimed },
			rtt: { sessionMs: sessionRtt - done, poolMs: poolRtt - sessionRtt },
			...handed,
		});
	}

	if (url.pathname === "/where") {
		const pool = await env.POOL.getByName(name(body.batch, "batch")).where();
		const workspace = await env.WORKSPACE.getByName(name(body.workspaceId, "workspaceId")).where();
		return json({ colo, poolColo: pool.colo, workspaceColo: workspace.colo });
	}

	if (url.pathname === "/cleanup") return json({ deleted: await clearBucket(env.WORKSPACES) });

	return json({ error: "not found" }, 404);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") return json({ ok: true, service: "harbour-ready-spike" });
		if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
		if (request.method !== "POST") return json({ error: "not found" }, 404);
		try {
			return await route(request, env, url);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
