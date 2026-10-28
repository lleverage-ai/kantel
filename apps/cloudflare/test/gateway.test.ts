// The gateway over the in-memory stack, in Node: who gets in (Access tokens for the team domain and AUD, API keys),
// and that the session, workspace read and audit APIs are each mounted where the console and host apps call them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isHarbourError } from "@harbour/contracts";
import { createMockAccess } from "@harbour/identity/testing";
import { describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { routeRequest, STACK_NAME, WORKSPACE_BODY_LIMIT } from "../src/route.ts";
import { createStack, DEFAULT_AGENT_ID } from "../src/stack.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const BASE = "https://harbour.test";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** Stands in for GitHub: every ref is COMMIT, and its tarball is an empty archive. Records what was asked. */
function fakeGitHub() {
	const calls: string[] = [];
	const fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		if (url.startsWith("https://api.github.com/repos/")) return new Response(COMMIT);
		const empty = new Blob([new Uint8Array(1024)]).stream().pipeThrough(new CompressionStream("gzip"));
		return new Response(empty);
	}) as typeof globalThis.fetch;
	return { calls, fetch };
}

async function setup(options: { access?: boolean } = {}) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		...(options.access === false ? {} : { HARBOUR_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, HARBOUR_ACCESS_AUD: AUD }),
		HARBOUR_ADMIN_EMAIL: ADMIN,
	});
	const github = fakeGitHub();
	const stack = await createStack({ config, accessFetch: mock.fetch, gitFetch: github.fetch });
	const gateway = createGateway(stack);
	const service = await stack.identity.createServiceIdentity(stack.admin, { name: "host" });
	const key = await stack.identity.issueApiKey(stack.admin, {
		serviceId: service.id,
		projectIds: [stack.project.id],
		role: "operator",
	});
	const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
		gateway.fetch(new Request(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }));
	const signedIn = async (claims: Record<string, unknown> = {}) => ({
		"cf-access-jwt-assertion": await mock.sign({ sub: "access-subject-1", email: ADMIN, ...claims }),
	});
	const withKey = { authorization: `Bearer ${key.secret}` };
	return { mock, stack, gateway, call, signedIn, withKey, github };
}

describe("gateway config", () => {
	it("takes the Access team domain and AUD as a pair", () => {
		expect(gatewayConfig({})).toEqual({});
		expect(gatewayConfig({ HARBOUR_ACCESS_TEAM_DOMAIN: " t.cloudflareaccess.com ", HARBOUR_ACCESS_AUD: "a" })).toEqual({
			access: { teamDomain: "t.cloudflareaccess.com", audience: "a" },
		});
		for (const vars of [{ HARBOUR_ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com" }, { HARBOUR_ACCESS_AUD: "a" }]) {
			expect(() => gatewayConfig(vars)).toThrow(/both/);
		}
	});

	it("refuses an admin email that is not one", () => {
		expect(gatewayConfig({ HARBOUR_ADMIN_EMAIL: "tom@example.com" })).toEqual({ adminEmail: "tom@example.com" });
		let error: unknown;
		try {
			gatewayConfig({ HARBOUR_ADMIN_EMAIL: "tom" });
		} catch (caught) {
			error = caught;
		}
		expect(isHarbourError(error, "invalid")).toBe(true);
	});
});

describe("the gateway", () => {
	it("answers an anonymous call to any API with 401 and a challenge", async () => {
		const { call, stack } = await setup();
		for (const path of [
			`/v1/sessions?projectId=${stack.project.id}`,
			"/v1/workspaces/ws-1/files",
			"/v1/audit/events",
		]) {
			const response = await call(path);
			expect(response.status, path).toBe(401);
			expect(response.headers.get("www-authenticate"), path).toMatch(/^Bearer/);
		}
	});

	it("signs in the invited person with an Access token for the team domain and AUD, and runs a session", async () => {
		const { call, signedIn, stack } = await setup();
		const headers = { ...(await signedIn()), "content-type": "application/json" };
		const created = await call("/v1/sessions", headers, {
			method: "POST",
			body: JSON.stringify({ projectId: stack.project.id, agentId: DEFAULT_AGENT_ID, title: "Hello" }),
		});
		expect(created.status).toBe(201);
		const session = (await created.json()) as { id: string; createdBy: { kind: string } };
		expect(session.createdBy.kind).toBe("human");

		const prompted = await call(`/v1/sessions/${session.id}/prompt`, headers, {
			method: "POST",
			body: JSON.stringify({ text: "ping" }),
		});
		expect(prompted.status).toBe(202);
		const submission = (await prompted.json()) as { id: string };
		const result = await call(
			`/v1/sessions/${session.id}/result?submission=${encodeURIComponent(submission.id)}&timeoutMs=5000`,
			headers,
		);
		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({ status: "answered", answer: "Echo: ping" });

		const listed = await call(`/v1/sessions?projectId=${stack.project.id}`, headers);
		expect(listed.status).toBe(200);
		expect(((await listed.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([session.id]);
	});

	it("refuses Access tokens for another AUD, another team domain, an expired one and an uninvited email", async () => {
		const { call, signedIn, stack } = await setup();
		const other = createMockAccess({ teamDomain: "someone-else.cloudflareaccess.com", audience: AUD });
		const path = `/v1/sessions?projectId=${stack.project.id}`;
		const refused = {
			"another AUD": await signedIn({ aud: ["another-app"] }),
			"another team domain": { "cf-access-jwt-assertion": await other.sign({ sub: "s", email: ADMIN }) },
			expired: await signedIn({ exp: Math.floor(Date.now() / 1000) - 60 }),
			uninvited: await signedIn({ sub: "access-subject-2", email: "someone@harbour.test" }),
			"a service token": await signedIn({ email: undefined }),
		};
		for (const [why, headers] of Object.entries(refused)) {
			expect((await call(path, headers)).status, why).toBe(401);
		}
	});

	it("ignores the Access header when Access is not configured, and still takes API keys", async () => {
		const { call, signedIn, stack, withKey } = await setup({ access: false });
		const path = `/v1/sessions?projectId=${stack.project.id}`;
		expect((await call(path, await signedIn())).status).toBe(401);
		expect((await call(path, withKey)).status).toBe(200);
	});

	it("takes a host app's API key on every API, limited to its project", async () => {
		const { call, withKey, stack } = await setup();
		expect((await call(`/v1/sessions?projectId=${stack.project.id}`, withKey)).status).toBe(200);
		expect((await call("/v1/profiles", withKey)).status).toBe(200);
		// Authenticated, so the read API answers for the workspace itself: there is none by that ID.
		expect((await call("/v1/workspaces/ws-missing", withKey)).status).toBe(404);
		expect((await call(`/v1/audit/events?projectId=${stack.project.id}`, withKey)).status).toBe(200);
	});

	it("mounts the workspace read API, reading through project access", async () => {
		const { call, signedIn, stack } = await setup();
		const workspace = await stack.workspaces.create(stack.admin, {
			owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
		});
		await stack.workspaces.commit(stack.admin, workspace.id, {
			baseVersion: workspace.head,
			changes: [{ op: "put", path: "notes/hello.md", content: "# Hello" }],
		});
		const headers = await signedIn();
		const files = await call(`/v1/workspaces/${workspace.id}/files?path=notes`, headers);
		expect(files.status).toBe(200);
		expect(((await files.json()) as { items: { path: string }[] }).items.map((entry) => entry.path)).toEqual([
			"notes/hello.md",
		]);
		const content = await call(`/v1/workspaces/${workspace.id}/content?path=notes/hello.md`, headers);
		expect(await content.text()).toBe("# Hello");
	});

	it("mounts POST /v1/workspaces: a host seeds a workspace from a git ref and files, then runs a session on it", async () => {
		const { call, withKey, stack, github } = await setup();
		const json = { ...withKey, "content-type": "application/json" };
		const created = await call("/v1/workspaces", json, {
			method: "POST",
			body: JSON.stringify({
				projectId: stack.project.id,
				seed: {
					name: "hello",
					sources: [
						{ kind: "git", repo: "octocat/Hello-World", ref: "master", into: "repo" },
						{ kind: "files", files: { "notes/plan.md": "# Plan" } },
					],
				},
			}),
		});
		expect(created.status).toBe(201);
		const workspace = (await created.json()) as { id: string; seedReadiness: string; seedReport?: unknown };
		expect(workspace.seedReadiness).toBe("files");
		expect(workspace.seedReport).toMatchObject({ sources: [{ kind: "git", commit: COMMIT }, { kind: "files" }] });
		expect(github.calls).toEqual([
			"https://api.github.com/repos/octocat/Hello-World/commits/master",
			`https://codeload.github.com/octocat/Hello-World/tar.gz/${COMMIT}`,
		]);

		const session = await call("/v1/sessions", json, {
			method: "POST",
			body: JSON.stringify({ projectId: stack.project.id, agentId: DEFAULT_AGENT_ID, workspaceId: workspace.id }),
		});
		expect(session.status).toBe(201);
		expect(await session.json()).toMatchObject({ workspaceId: workspace.id });

		const note = await call(`/v1/workspaces/${workspace.id}/content?path=notes/plan.md`, withKey);
		expect(await note.text()).toBe("# Plan");
		const audit = await call(`/v1/audit/events?projectId=${stack.project.id}`, withKey);
		const types = ((await audit.json()) as { items: { type: string }[] }).items.map((event) => event.type);
		expect(types.filter((type) => type.startsWith("sandbox."))).toEqual([]);
	});

	it("refuses POST /v1/workspaces without operator rights", async () => {
		const { call, stack, github } = await setup();
		const service = await stack.identity.createServiceIdentity(stack.admin, { name: "reader" });
		const viewer = await stack.identity.issueApiKey(stack.admin, {
			serviceId: service.id,
			projectIds: [stack.project.id],
			role: "viewer",
		});
		const body = JSON.stringify({
			projectId: stack.project.id,
			seed: { name: "x", sources: [{ kind: "git", repo: "octocat/Hello-World", ref: "master" }] },
		});
		const asViewer = await call(
			"/v1/workspaces",
			{ authorization: `Bearer ${viewer.secret}` },
			{ method: "POST", body },
		);
		expect(asViewer.status).toBe(403);
		expect(await asViewer.json()).toMatchObject({ error: { code: "forbidden" } });
		const anonymous = await call("/v1/workspaces", {}, { method: "POST", body });
		expect(anonymous.status).toBe(401);
		expect(github.calls).toEqual([]);
	});

	it("mounts the audit query API, showing the admin the bootstrap's own events", async () => {
		const { call, signedIn } = await setup();
		const response = await call("/v1/audit/events?type=identity.project.created", await signedIn());
		expect(response.status).toBe(200);
		const body = (await response.json()) as { items: { type: string }[] };
		expect(body.items.map((event) => event.type)).toEqual(["identity.project.created"]);
	});

	it("answers 404 for a path under no API", async () => {
		const { call, withKey } = await setup();
		expect((await call("/v2/sessions", withKey)).status).toBe(404);
	});
});

describe("routing POST /v1/workspaces", () => {
	it("reads the seed before the stack sees it, and refuses one past the limit", async () => {
		const seen: string[] = [];
		const stack = {
			idFromName: (name: string) => name,
			get: (name: string) => ({
				fetch: async (request: Request) => {
					seen.push(`${name} ${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
					return new Response(null, { status: 204 });
				},
			}),
		};
		const unused = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null) }) };
		const env = { STACK: stack, VAULTS: unused, ASSETS: { fetch: async () => new Response(null) } };
		const post = (body: string) => routeRequest(new Request(`${BASE}/v1/workspaces`, { method: "POST", body }), env);
		expect((await post('{"projectId":"p"}')).status).toBe(204);
		expect(seen).toEqual([`${STACK_NAME} POST /v1/workspaces {"projectId":"p"}`]);
		const refused = await post("x".repeat(WORKSPACE_BODY_LIMIT + 1));
		expect(refused.status).toBe(413);
		expect(seen).toHaveLength(1);
	});
});

describe("the deployed entry point", () => {
	it("never reaches the dev routes or the mock Access issuer", () => {
		const src = join(import.meta.dirname, "../src");
		for (const file of readdirSync(src)) {
			if (file === "dev.ts") continue;
			const text = readFileSync(join(src, file), "utf8");
			expect(text, file).not.toMatch(/@harbour\/identity\/testing|\.\/dev(\.ts)?["']|__dev/);
		}
	});
});
