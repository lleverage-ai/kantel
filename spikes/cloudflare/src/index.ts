/**
 * harbour-m0-cf1: the M0-CF1 Cloudflare spike Worker. Every route needs `Authorization: Bearer <HARBOUR_SPIKE_TOKEN>`.
 *
 *   POST /sessions/:id/setup     { workspaceId?, scenario?, isolateGeneration? }
 *   POST /sessions/:id/prompt    { content, requestId }            -> { submissionId }
 *   GET  /sessions/:id/state?submission=
 *   POST /sessions/:id/kill      { afterExec }                     crash the DO after the next Nth exec commits
 *   POST /sessions/:id/exec      { command, tier?, containerName?, isolateGeneration? }
 *   POST /sessions/:id/release   { containerName? }
 *   GET  /sessions/:id/file?path=
 *   GET  /sessions/:id/fixture
 *   GET  /sessions/:id/vault                                       vault audit for the session
 *   POST /bench/isolate-ready    { workspaceId }                   one cold "isolate session ready, workspace listed"
 */
export { HarbourContainer } from "./container-tier.ts";
export { SessionDO } from "./session.ts";
export { VaultDO, VaultGateway } from "./vault.ts";
export { WorkspaceGateway } from "./workspace-gateway.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

function authorised(request: Request, env: Env): boolean {
	const header = request.headers.get("authorization") ?? "";
	const expected = `Bearer ${env.HARBOUR_SPIKE_TOKEN}`;
	if (env.HARBOUR_SPIKE_TOKEN === undefined || env.HARBOUR_SPIKE_TOKEN === "" || header.length !== expected.length)
		return false;
	let diff = 0;
	for (let i = 0; i < header.length; i += 1) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") return json({ ok: true, service: "harbour-m0-cf1" });
		if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);

		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "sessions" && parts[1] !== undefined) {
			const sessionId = decodeURIComponent(parts[1]);
			if (!/^[A-Za-z0-9._-]{1,80}$/.test(sessionId)) return json({ error: "bad session id" }, 400);
			if (parts[2] === "vault" && request.method === "GET") {
				return json(await env.VAULT.getByName("spike").uses(sessionId));
			}
			const stub = env.SESSION.getByName(sessionId);
			if (parts[2] === "setup") {
				const body = (await request.json()) as Record<string, unknown>;
				return stub.fetch(new Request(request.url, { method: "POST", body: JSON.stringify({ ...body, sessionId }) }));
			}
			return stub.fetch(request);
		}

		if (url.pathname === "/bench/isolate-ready" && request.method === "POST") {
			// Session ready, workspace listed: a new SessionDO opens Pi Durable on empty storage, then a Dynamic Worker never
			// loaded before lists an existing workspace. Timed here, around both calls, from the Worker that routes them.
			const { workspaceId } = (await request.json()) as { workspaceId: string };
			const sessionId = `bench-iso-${crypto.randomUUID()}`;
			const stub = env.SESSION.getByName(sessionId);
			const started = Date.now();
			// First contact with a Durable Object that has never existed: placement and creation, no storage work.
			const ping = await stub.fetch(new Request(`https://do/sessions/${sessionId}/ping`));
			if (!ping.ok) return json({ error: "ping failed", detail: await ping.text() }, 500);
			const created = Date.now();
			const setup = await stub.fetch(
				new Request(`https://do/sessions/${sessionId}/setup`, {
					method: "POST",
					body: JSON.stringify({ sessionId, workspaceId, isolateGeneration: crypto.randomUUID() }),
				}),
			);
			if (!setup.ok) return json({ error: "setup failed", detail: await setup.text() }, 500);
			const ready = Date.now();
			const exec = await stub.fetch(
				new Request(`https://do/sessions/${sessionId}/exec`, {
					method: "POST",
					body: JSON.stringify({ command: "ls -1R /workspace | wc -l", tier: "isolate" }),
				}),
			);
			if (!exec.ok) return json({ error: "exec failed", detail: await exec.text() }, 500);
			const listed = Date.now();
			const setupBody = (await setup.json()) as { timings: Record<string, number> };
			const execBody = (await exec.json()) as { stdout: string; timings: Record<string, number> };
			return json({
				sessionId,
				totalMs: listed - started,
				sessionReadyMs: ready - started,
				doCreateMs: created - started,
				setupMs: ready - created,
				listMs: listed - ready,
				entries: execBody.stdout.trim(),
				setup: setupBody.timings,
				exec: execBody.timings,
			});
		}

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
