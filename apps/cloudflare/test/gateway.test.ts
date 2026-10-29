// The gateway over the in-memory stack, in Node: who gets in (Access tokens for the team domain and AUD, API keys),
// and that the session, workspace read and audit APIs are each mounted where the console and host apps call them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isHarbourError } from "@harbour/contracts";
import { API_KEY_BODY_LIMIT } from "@harbour/identity/http";
import { createMockAccess } from "@harbour/identity/testing";
import { MEMORY_BODY_LIMIT } from "@harbour/memory/http";
import { SKILL_IMPORT_BODY_LIMIT } from "@harbour/skills/http";
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

async function setup(options: { access?: boolean; adminName?: string } = {}) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		...(options.access === false ? {} : { HARBOUR_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, HARBOUR_ACCESS_AUD: AUD }),
		HARBOUR_ADMIN_EMAIL: ADMIN,
		...(options.adminName === undefined ? {} : { HARBOUR_ADMIN_NAME: options.adminName }),
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
	return { mock, stack, gateway, call, signedIn, withKey, github, key };
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
			"/v1/me",
			"/v1/projects",
			"/v1/keys",
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

	it("mounts a session's history: the latest turns first, and a cursor pages back", async () => {
		const { call, signedIn, stack, withKey } = await setup();
		const headers = { ...(await signedIn()), "content-type": "application/json" };
		const created = await call("/v1/sessions", headers, {
			method: "POST",
			body: JSON.stringify({ projectId: stack.project.id, agentId: DEFAULT_AGENT_ID }),
		});
		const session = (await created.json()) as { id: string };
		for (const text of ["one", "two", "three"]) {
			const prompted = await call(`/v1/sessions/${session.id}/prompt`, headers, {
				method: "POST",
				body: JSON.stringify({ text }),
			});
			const submission = (await prompted.json()) as { id: string };
			await call(
				`/v1/sessions/${session.id}/result?submission=${encodeURIComponent(submission.id)}&timeoutMs=5000`,
				headers,
			);
		}
		type Page = { items: { text: string }[]; nextCursor?: string };
		const latest = await call(`/v1/sessions/${session.id}/history?limit=2`, headers);
		expect(latest.status).toBe(200);
		const first = (await latest.json()) as Page;
		expect(first.items.map((item) => item.text)).toEqual(["Echo: three", "three"]);
		const older = await call(
			`/v1/sessions/${session.id}/history?limit=10&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
			withKey,
		);
		const rest = (await older.json()) as Page;
		expect(rest.items.map((item) => item.text)).toEqual(["Echo: two", "two", "Echo: one", "one"]);
		expect(rest.nextCursor).toBeUndefined();
		expect((await call(`/v1/sessions/${session.id}/history`)).status).toBe(401);
		expect((await call(`/v1/sessions/${session.id}/history?limit=0`, headers)).status).toBe(400);
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

	it("mounts the skills API: the admin imports a skill, and a host's key reads it but cannot import", async () => {
		const { call, signedIn, withKey, stack } = await setup();
		const admin = { ...(await signedIn()), "content-type": "application/json" };
		const body = JSON.stringify({
			owner: { kind: "organisation", organisationId: stack.organisation.id },
			name: "hello",
			description: "Say hello.",
			files: [{ path: "SKILL.md", content: "---\nname: hello\ndescription: Say hello.\n---\n\nHello.\n" }],
			source: { sourceId: "test", ref: "r1" },
		});
		const imported = await call("/v1/skills/import", admin, { method: "POST", body });
		expect(imported.status).toBe(200);
		const revision = (await imported.json()) as { skillId: string; revision: number };
		expect(revision.revision).toBe(1);

		const listed = await call("/v1/skills", withKey);
		expect(((await listed.json()) as { items: { name: string }[] }).items.map((item) => item.name)).toEqual(["hello"]);
		const file = await call(`/v1/skills/${revision.skillId}/revisions/1/file?path=SKILL.md`, withKey);
		expect(((await file.json()) as { content: string }).content).toContain("Hello.");
		const json = { ...withKey, "content-type": "application/json" };
		expect((await call("/v1/skills/import", json, { method: "POST", body })).status).toBe(403);
		const anonymous = await call("/v1/skills");
		expect(anonymous.status).toBe(401);
		expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
	});

	it("mounts the memory API: the admin loads a snapshot, then a host's key lists, searches and recalls it", async () => {
		const { call, signedIn, withKey, stack } = await setup();
		const admin = { ...(await signedIn()), "content-type": "application/json" };
		const created = await call("/v1/memory/spaces", admin, {
			method: "POST",
			body: JSON.stringify({ owner: { kind: "organisation", organisationId: stack.organisation.id }, name: "Team" }),
		});
		expect(created.status).toBe(201);
		const space = (await created.json()) as { id: string };
		const concept = {
			id: "projects/harbour/region",
			title: "Harbour runs in weur",
			statement: "New D1 and R2 resources go in the weur region.",
			scope: { kind: "global" },
			sources: ["tvdavies/harbour#12"],
			setBy: "owner",
			status: "active",
			updatedAt: 1,
		};
		const snapshot = JSON.stringify({ sourceId: "test", ref: "r1", concepts: [concept] });
		const loaded = await call(`/v1/memory/spaces/${space.id}/snapshot`, admin, { method: "POST", body: snapshot });
		expect(loaded.status).toBe(200);

		const spaces = await call("/v1/memory/spaces", withKey);
		expect(((await spaces.json()) as { items: { name: string }[] }).items.map((item) => item.name)).toEqual(["Team"]);
		const one = await call(`/v1/memory/spaces/${space.id}/concepts/${encodeURIComponent(concept.id)}`, withKey);
		expect(await one.json()).toMatchObject({ id: concept.id, title: concept.title });
		const json = { ...withKey, "content-type": "application/json" };
		const query = JSON.stringify({ spaceIds: [space.id], query: "which region for D1" });
		const search = await call("/v1/memory/search", json, { method: "POST", body: query });
		expect(((await search.json()) as { hits: { concept: { id: string } }[] }).hits[0]?.concept.id).toBe(concept.id);
		const recall = await call("/v1/memory/recall", json, { method: "POST", body: query });
		expect(((await recall.json()) as { text: string }).text).toContain("weur");
		const refused = await call(`/v1/memory/spaces/${space.id}/snapshot`, json, { method: "POST", body: snapshot });
		expect(refused.status).toBe(403);
	});

	it("lets a key with the import permission import skills and snapshots, and reach no other admin route", async () => {
		const { call, signedIn, stack, key } = await setup();
		const admin = { ...(await signedIn()), "content-type": "application/json" };
		const organisation = { kind: "organisation", organisationId: stack.organisation.id };
		// The space is made once by the admin; the key loads it from then on.
		const created = await call("/v1/memory/spaces", admin, {
			method: "POST",
			body: JSON.stringify({ owner: organisation, name: "Team" }),
		});
		const space = (await created.json()) as { id: string };
		const importer = await stack.identity.issueApiKey(stack.admin, {
			serviceId: (await stack.identity.createServiceIdentity(stack.admin, { name: "importer" })).id,
			projectIds: [stack.project.id],
			role: "operator",
			permissions: ["import"],
		});
		const asImporter = { authorization: `Bearer ${importer.secret}`, "content-type": "application/json" };
		const asPlainKey = { authorization: `Bearer ${key.secret}`, "content-type": "application/json" };

		const skill = (owner: unknown) =>
			JSON.stringify({
				owner,
				name: "hello",
				description: "Say hello.",
				files: [{ path: "SKILL.md", content: "---\nname: hello\ndescription: Say hello.\n---\n\nHello.\n" }],
				source: { sourceId: "test", ref: "r1" },
			});
		const concept = {
			id: "projects/harbour/region",
			title: "Harbour runs in weur",
			statement: "New D1 and R2 resources go in the weur region.",
			scope: { kind: "global" },
			sources: ["tvdavies/harbour#12"],
			setBy: "owner",
			status: "active",
			updatedAt: 1,
		};
		const snapshot = JSON.stringify({ sourceId: "test", ref: "r1", concepts: [concept] });
		const snapshotPath = `/v1/memory/spaces/${space.id}/snapshot`;

		// A key without the permission is refused both imports, as before.
		expect((await call("/v1/skills/import", asPlainKey, { method: "POST", body: skill(organisation) })).status).toBe(
			403,
		);
		expect((await call(snapshotPath, asPlainKey, { method: "POST", body: snapshot })).status).toBe(403);

		const imported = await call("/v1/skills/import", asImporter, { method: "POST", body: skill(organisation) });
		expect(imported.status).toBe(200);
		expect(await imported.json()).toMatchObject({ revision: 1 });
		const loaded = await call(snapshotPath, asImporter, { method: "POST", body: snapshot });
		expect(loaded.status).toBe(200);
		const one = await call(`/v1/memory/spaces/${space.id}/concepts/${encodeURIComponent(concept.id)}`, asImporter);
		expect(await one.json()).toMatchObject({ id: concept.id });
		// Audited as the key that imported, not as an admin.
		const published = await stack.audit.query(stack.admin, { type: "skills.revision.published" });
		expect(published.items.map((event) => event.actor)).toEqual([
			{ kind: "service", serviceId: importer.key.serviceId, keyId: importer.key.id },
		]);

		// Every other admin route is still the admin's.
		const refusals: [string, RequestInit][] = [
			["/v1/memory/spaces", { method: "POST", body: JSON.stringify({ owner: organisation, name: "Other" }) }],
			[
				"/v1/keys",
				{
					method: "POST",
					body: JSON.stringify({
						name: "More",
						projectIds: [stack.project.id],
						role: "admin",
						permissions: ["import"],
					}),
				},
			],
			[`/v1/keys/${encodeURIComponent(key.key.id)}/revoke`, { method: "POST", body: "{}" }],
		];
		for (const [path, init] of refusals) {
			const response = await call(path, asImporter, init);
			expect(response.status, path).toBe(403);
		}
		const platform = await call("/v1/skills/import", asImporter, { method: "POST", body: skill({ kind: "platform" }) });
		expect(platform.status).toBe(403);
		const keys = await stack.identity.listApiKeys(stack.admin);
		expect(keys.find((listed) => listed.id === key.key.id)?.revokedAt).toBeUndefined();
	});

	it("mounts the audit query API, showing the admin the bootstrap's own events", async () => {
		const { call, signedIn } = await setup();
		const response = await call("/v1/audit/events?type=identity.project.created", await signedIn());
		expect(response.status).toBe(200);
		const body = (await response.json()) as { items: { type: string }[] };
		expect(body.items.map((event) => event.type)).toEqual(["identity.project.created"]);
	});

	it("mounts who is signed in and their projects, with the admin's name and the project names", async () => {
		const { call, signedIn, stack } = await setup({ adminName: "Tom Davies" });
		const headers = await signedIn();
		const me = await call("/v1/me", headers);
		expect(me.status).toBe(200);
		expect(await me.json()).toEqual({
			actor: stack.admin.actor,
			organisationId: stack.organisation.id,
			method: "cloudflare_access",
			name: "Tom Davies",
			email: ADMIN,
			roles: [{ role: "admin" }],
		});
		await stack.identity.createProject(stack.admin, { name: "Website" });
		const projects = await call("/v1/projects", headers);
		expect(((await projects.json()) as { items: { name: string }[] }).items.map((project) => project.name)).toEqual([
			"Default",
			"Website",
		]);
	});

	it("names Access as the way to sign in on a 401 from /v1/me, and no way when Access is off", async () => {
		const withAccess = await setup();
		const refused = (await (await withAccess.call("/v1/me")).json()) as { error: { signIn?: string[] } };
		expect(refused.error.signIn).toEqual(["cloudflare_access"]);
		const withoutAccess = await setup({ access: false });
		const bare = (await (await withoutAccess.call("/v1/me")).json()) as { error: { signIn?: string[] } };
		expect(bare.error.signIn).toEqual([]);
		expect((await withoutAccess.call("/v1/me", withoutAccess.withKey)).status).toBe(200);
	});

	it("names the admin by their email when the deployment gives no name", async () => {
		const { call, signedIn } = await setup();
		expect(((await (await call("/v1/me", await signedIn())).json()) as { name: string }).name).toBe(ADMIN);
	});

	it("mounts the API key routes: the admin issues a key, a host app uses it, and once revoked its next call is a 401", async () => {
		const { call, signedIn, stack } = await setup();
		const headers = { ...(await signedIn()), "content-type": "application/json" };
		const created = await call("/v1/keys", headers, {
			method: "POST",
			body: JSON.stringify({ name: "GitHub app", projectIds: [stack.project.id], role: "operator" }),
		});
		expect(created.status).toBe(201);
		const issued = (await created.json()) as { key: { id: string; name: string }; secret: string };
		expect(issued.key.name).toBe("GitHub app");
		const asApp = { authorization: `Bearer ${issued.secret}` };
		expect((await call(`/v1/sessions?projectId=${stack.project.id}`, asApp)).status).toBe(200);

		const listed = await call("/v1/keys", headers);
		const text = await listed.text();
		expect(listed.status).toBe(200);
		expect(text).not.toContain(issued.secret);
		const keys = (JSON.parse(text) as { items: { id: string; lastUsedAt?: number }[] }).items;
		expect(keys.find((key) => key.id === issued.key.id)?.lastUsedAt).toBeTypeOf("number");

		const revoked = await call(`/v1/keys/${issued.key.id}/revoke`, headers, { method: "POST", body: "{}" });
		expect(revoked.status).toBe(204);
		const after = await call(`/v1/sessions?projectId=${stack.project.id}`, asApp);
		expect(after.status).toBe(401);
		expect(after.headers.get("www-authenticate")).toMatch(/^Bearer/);
	});

	it("refuses the key routes to a viewer with 403, and lets an operator key through to an empty list and a 403 on revoke", async () => {
		const { call, stack, withKey, key } = await setup();
		const service = await stack.identity.createServiceIdentity(stack.admin, { name: "reader" });
		const viewer = await stack.identity.issueApiKey(stack.admin, {
			serviceId: service.id,
			projectIds: [stack.project.id],
			role: "viewer",
		});
		const asViewer = { authorization: `Bearer ${viewer.secret}` };
		const listed = await call("/v1/keys", asViewer);
		expect(listed.status).toBe(403);
		expect(await listed.json()).toMatchObject({ error: { code: "forbidden" } });
		const json = { "content-type": "application/json" };
		expect(
			(await call(`/v1/keys/${key.key.id}/revoke`, { ...asViewer, ...json }, { method: "POST", body: "{}" })).status,
		).toBe(403);

		// The operator key reaches the routes; the directory shows it no key and refuses it each change.
		const asOperator = await call("/v1/keys", withKey);
		expect(asOperator.status).toBe(200);
		expect(await asOperator.json()).toEqual({ items: [] });
		const revoke = await call(
			`/v1/keys/${viewer.key.id}/revoke`,
			{ ...withKey, ...json },
			{ method: "POST", body: "{}" },
		);
		expect(revoke.status).toBe(403);
		const create = await call(
			"/v1/keys",
			{ ...withKey, ...json },
			{ method: "POST", body: JSON.stringify({ name: "x", projectIds: [stack.project.id], role: "viewer" }) },
		);
		expect(create.status).toBe(403);
		expect(
			(await stack.identity.listApiKeys(stack.admin)).find((k) => k.id === viewer.key.id)?.revokedAt,
		).toBeUndefined();
	});

	it("starts a session with an operator's API key, and refuses a viewer's with 403", async () => {
		const { call, stack, withKey } = await setup();
		const json = { "content-type": "application/json" };
		const body = JSON.stringify({ projectId: stack.project.id, agentId: DEFAULT_AGENT_ID, title: "From a key" });
		const created = await call("/v1/sessions", { ...withKey, ...json }, { method: "POST", body });
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({ title: "From a key", createdBy: { kind: "service" } });

		const service = await stack.identity.createServiceIdentity(stack.admin, { name: "watcher" });
		const viewer = await stack.identity.issueApiKey(stack.admin, {
			serviceId: service.id,
			projectIds: [stack.project.id],
			role: "viewer",
		});
		const asViewer = { authorization: `Bearer ${viewer.secret}`, ...json };
		const refused = await call("/v1/sessions", asViewer, { method: "POST", body });
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ error: { code: "forbidden" } });
		// The viewer still watches: the operator's session is listed for them.
		const listed = await call(`/v1/sessions?projectId=${stack.project.id}`, asViewer);
		expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1);
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

describe("routing POST /v1/keys", () => {
	it("reads a key's body before the stack sees it, and refuses one past the limit", async () => {
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
		const post = (path: string, body: string) =>
			routeRequest(new Request(`${BASE}${path}`, { method: "POST", body }), env);
		expect((await post("/v1/keys", '{"name":"a"}')).status).toBe(204);
		expect((await post("/v1/keys/key_1/revoke", "{}")).status).toBe(204);
		expect(seen).toEqual([`${STACK_NAME} POST /v1/keys {"name":"a"}`, `${STACK_NAME} POST /v1/keys/key_1/revoke {}`]);
		expect((await post("/v1/keys", "x".repeat(API_KEY_BODY_LIMIT + 1))).status).toBe(413);
		expect(seen).toHaveLength(2);

		// And a skill import or a memory snapshot, each up to its own limit.
		expect((await post("/v1/skills/import", "{}")).status).toBe(204);
		expect((await post("/v1/memory/spaces/s/snapshot", "{}")).status).toBe(204);
		expect(seen.slice(2)).toEqual([
			`${STACK_NAME} POST /v1/skills/import {}`,
			`${STACK_NAME} POST /v1/memory/spaces/s/snapshot {}`,
		]);
		expect((await post("/v1/skills/import", "x".repeat(SKILL_IMPORT_BODY_LIMIT + 1))).status).toBe(413);
		expect((await post("/v1/memory/recall", "x".repeat(MEMORY_BODY_LIMIT + 1))).status).toBe(413);
		expect(seen).toHaveLength(4);
	});
});

describe("the deployed entry point", () => {
	it("never reaches the dev routes or the mock Access issuer", () => {
		const src = join(import.meta.dirname, "../src");
		for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
			if (!file.endsWith(".ts")) continue;
			// The dev entry point and the dev-only modules only it imports (dev-vault-seed.ts).
			if (file === "dev.ts" || file.startsWith("dev-")) continue;
			const text = readFileSync(join(src, file), "utf8");
			expect(text, file).not.toMatch(/@harbour\/identity\/testing|\.\/dev(-[a-z-]+)?(\.ts)?["']|__dev/);
		}
	});
});
