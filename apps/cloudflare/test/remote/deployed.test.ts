// Checks against the deployed stack (#17's definition of done: "the conformance suite passes against the deployed
// stack"). The shared suites in @kantel/testing take in-process implementations with fakes (a scripted model, a manual
// clock, failure injection), so they run on the Cloudflare implementations in targets/cloudflare. This file checks
// the deployed hostname from outside, through the contracts' own HTTP clients: what a host app sees. It runs only when all three are set, and is skipped otherwise (as in CI):
//
//   KANTEL_URL=https://harbour.myslop.app KANTEL_API_KEY=hbr_… KANTEL_ACCESS_COOKIE='CF_Authorization=…' \
//     pnpm --filter @kantel/cloudflare exec vitest run test/remote/deployed.test.ts
//
// Access stands in front of the whole hostname, and host apps aren't let through it yet (#17: "a service-token policy is
// added when #14 needs it"), so each call carries a signed-in browser's Access cookie as well as the project API key.
// The gateway takes the API key over the Access identity when both are there. KANTEL_REMOTE_SESSION=1 also runs one
// session to a real model answer and closes it: one labelled session in the deployed project per run.
import { createAuditClient } from "@kantel/audit/http";
import type { CallContext } from "@kantel/contracts";
import { createIdentityClient } from "@kantel/identity/http";
import { createSessionApiClient } from "@kantel/runtime/http";
import { createWorkspaceReadClient } from "@kantel/workspace/read-api";
import { describe, expect, it } from "vitest";

// A skipped `describe` still builds its clients, so they get a placeholder origin when the variables are unset.
const url = process.env.KANTEL_URL?.replace(/\/+$/, "") ?? "https://harbour.invalid";
const apiKey = process.env.KANTEL_API_KEY;
const cookie = process.env.KANTEL_ACCESS_COOKIE;
const enabled = process.env.KANTEL_URL !== undefined && apiKey !== undefined && cookie !== undefined;
const withSession = process.env.KANTEL_REMOTE_SESSION === "1";

/** Passes Access with the browser's cookie; the API key (or its absence) is up to the caller. */
const throughAccess: typeof fetch = (input, init) => {
	const request = new Request(input, init);
	const headers = new Headers(request.headers);
	headers.set("cookie", cookie ?? "");
	return fetch(new Request(request, { headers, redirect: "manual" }));
};
const key = { authorization: `Bearer ${apiKey}` };
// The clients take the caller from the API key; a context only carries a request id and a signal to them.
const ctx = { requestId: `remote-${Date.now()}` } as unknown as CallContext;

describe.skipIf(!enabled)("the deployed stack", () => {
	const sessions = createSessionApiClient({ baseUrl: `${url}/v1`, credentials: () => key, fetch: throughAccess });
	const audit = createAuditClient({ baseUrl: url, headers: () => key, fetch: throughAccess });
	const identity = createIdentityClient({ baseUrl: url, headers: () => key, fetch: throughAccess });
	const workspaces = createWorkspaceReadClient({ baseUrl: `${url}/v1/workspaces`, headers: key, fetch: throughAccess });

	it("sends an anonymous request to Access sign-in", async () => {
		const response = await fetch(`${url}/`, { redirect: "manual" });
		expect(response.status).toBe(302);
		expect(new URL(response.headers.get("location") ?? "").hostname).toMatch(/\.cloudflareaccess\.com$/);
	});

	it("refuses a bad API key even with a signed-in Access cookie", async () => {
		const response = await throughAccess(`${url}/v1/profiles`, { headers: { authorization: "Bearer hbr_not-a-key" } });
		expect(response.status).toBe(401);
	});

	it("lists the key's projects, profiles and sessions", async () => {
		const projects = await identity.listProjects();
		expect(projects.items.length).toBeGreaterThan(0);
		const profiles = await sessions.profiles.list(ctx);
		expect(profiles.items.length).toBeGreaterThan(0);
		const page = await sessions.directory.list(ctx, { projectId: projects.items[0]!.id }, { limit: 5 });
		for (const session of page.items) expect(session.projectId).toBe(projects.items[0]!.id);
	});

	it("reads a session's workspace through the workspace read API", async () => {
		const page = await sessions.directory.list(ctx, { labels: { measurement: "isolate-ready" } }, { limit: 1 });
		const workspaceId = page.items[0]?.workspaceId;
		expect(workspaceId, "no measurement session to take a workspace from").toBeDefined();
		const record = await workspaces.get(workspaceId!);
		expect(record.id).toBe(workspaceId);
		const files = await workspaces.list(workspaceId!, { recursive: true });
		expect(files.items.length).toBeGreaterThan(0);
		const file = files.items.find((entry) => entry.kind === "file");
		if (file !== undefined) expect((await workspaces.read(workspaceId!, file.path)).path).toBe(file.path);
	});

	it("answers the audit query API, newest first", async () => {
		const page = await audit.query({ newestFirst: true }, { limit: 5 });
		expect(page.items.length).toBeGreaterThan(0);
		// Newest first is by `seq`, the store's order, not by `at`.
		const seqs = page.items.map((event) => event.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
		expect((await audit.get(page.items[0]!.id)).id).toBe(page.items[0]!.id);
	});

	it.skipIf(!withSession)(
		"runs a session to a real model answer, audits it, and closes it",
		async () => {
			const [project] = (await identity.listProjects()).items;
			const [profile] = (await sessions.profiles.list(ctx)).items;
			const session = await sessions.runtime.create(ctx, {
				projectId: project!.id,
				agentId: profile!.id,
				title: "Deployed-stack check",
				labels: { check: "deployed-stack" },
			});
			// The model calls give up well before the test's own timeout, so the close below always runs.
			const run = { ...ctx, signal: AbortSignal.timeout(90_000) } as CallContext;
			try {
				const submission = await sessions.runtime.prompt(run, session.id, {
					text: "Reply with one short sentence that contains the word harbour.",
				});
				const result = await sessions.runtime.wait(run, session.id, submission.id);
				expect(result.status).toBe("answered");
				expect(result.answer?.toLowerCase()).toContain("harbour");
				const snapshot = await sessions.runtime.snapshot(ctx, session.id);
				expect(snapshot.sessionId).toBe(session.id);
				const events = await audit.query({ sessionId: session.id }, { limit: 50 });
				expect(events.items.length).toBeGreaterThan(0);
			} finally {
				await sessions.runtime.close({ ...ctx, signal: AbortSignal.timeout(20_000) } as CallContext, session.id);
			}
			expect((await sessions.directory.get(ctx, session.id)).status).toBe("done");
		},
		120_000,
	);
});
