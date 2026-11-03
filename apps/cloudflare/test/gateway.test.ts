// The gateway over the in-memory stack, in Node: who gets in (Access tokens for the team domain and AUD, API keys),
// that the identity and audit APIs are mounted where the console and host apps call them, and that the agent plane's
// routes are gone.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isKantelError } from "@kantel/contracts";
import { API_KEY_BODY_LIMIT } from "@kantel/identity/http";
import { createMockAccess } from "@kantel/identity/testing";
import { describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { routeRequest, STACK_NAME } from "../src/route.ts";
import { createStack } from "../src/stack.ts";

const TEAM_DOMAIN = "kantel-test.cloudflareaccess.com";
const AUD = "aud-kantel-test";
const ADMIN = "tom@kantel.test";
const BASE = "https://kantel.test";

async function setup(options: { access?: boolean; adminName?: string } = {}) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		...(options.access === false ? {} : { KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, KANTEL_ACCESS_AUD: AUD }),
		KANTEL_ADMIN_EMAIL: ADMIN,
		...(options.adminName === undefined ? {} : { KANTEL_ADMIN_NAME: options.adminName }),
	});
	const stack = await createStack({ config, accessFetch: mock.fetch });
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
	return { mock, stack, gateway, call, signedIn, withKey, key };
}

describe("gateway config", () => {
	it("takes the Access team domain and AUD as a pair", () => {
		expect(gatewayConfig({})).toEqual({});
		expect(gatewayConfig({ KANTEL_ACCESS_TEAM_DOMAIN: " t.cloudflareaccess.com ", KANTEL_ACCESS_AUD: "a" })).toEqual({
			access: { teamDomain: "t.cloudflareaccess.com", audience: "a" },
		});
		for (const vars of [{ KANTEL_ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com" }, { KANTEL_ACCESS_AUD: "a" }]) {
			expect(() => gatewayConfig(vars)).toThrow(/both/);
		}
	});

	it("refuses an admin email that is not one", () => {
		expect(gatewayConfig({ KANTEL_ADMIN_EMAIL: "tom@example.com" })).toEqual({ adminEmail: "tom@example.com" });
		let error: unknown;
		try {
			gatewayConfig({ KANTEL_ADMIN_EMAIL: "tom" });
		} catch (caught) {
			error = caught;
		}
		expect(isKantelError(error, "invalid")).toBe(true);
	});
});

describe("the gateway", () => {
	it("answers an anonymous call to the identity and audit APIs with 401 and a challenge", async () => {
		const { call, stack } = await setup();
		for (const path of [`/v1/audit/events?projectId=${stack.project.id}`, "/v1/me", "/v1/projects", "/v1/keys"]) {
			const response = await call(path);
			expect(response.status, path).toBe(401);
			expect(response.headers.get("www-authenticate"), path).toMatch(/^Bearer/);
		}
	});

	it("refuses Access tokens for another AUD, another team domain, an expired one and an uninvited email", async () => {
		const { call, signedIn } = await setup();
		const other = createMockAccess({ teamDomain: "someone-else.cloudflareaccess.com", audience: AUD });
		expect((await call("/v1/me", await signedIn())).status).toBe(200);
		const refused = {
			"another AUD": await signedIn({ aud: ["another-app"] }),
			"another team domain": { "cf-access-jwt-assertion": await other.sign({ sub: "s", email: ADMIN }) },
			expired: await signedIn({ exp: Math.floor(Date.now() / 1000) - 60 }),
			uninvited: await signedIn({ sub: "access-subject-2", email: "someone@kantel.test" }),
			"a service token": await signedIn({ email: undefined }),
		};
		for (const [why, headers] of Object.entries(refused)) {
			expect((await call("/v1/me", headers)).status, why).toBe(401);
		}
	});

	it("ignores the Access header when Access is not configured, and still takes API keys", async () => {
		const { call, signedIn, withKey } = await setup({ access: false });
		expect((await call("/v1/projects", await signedIn())).status).toBe(401);
		expect((await call("/v1/projects", withKey)).status).toBe(200);
	});

	it("takes a host app's API key on the identity and audit APIs", async () => {
		const { call, withKey, stack } = await setup();
		expect((await call("/v1/me", withKey)).status).toBe(200);
		expect((await call("/v1/projects", withKey)).status).toBe(200);
		expect((await call(`/v1/audit/events?projectId=${stack.project.id}`, withKey)).status).toBe(200);
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
			preferences: {},
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
		expect((await call("/v1/projects", asApp)).status).toBe(200);

		const listed = await call("/v1/keys", headers);
		const text = await listed.text();
		expect(listed.status).toBe(200);
		expect(text).not.toContain(issued.secret);
		const keys = (JSON.parse(text) as { items: { id: string; lastUsedAt?: number }[] }).items;
		expect(keys.find((key) => key.id === issued.key.id)?.lastUsedAt).toBeTypeOf("number");

		const revoked = await call(`/v1/keys/${issued.key.id}/revoke`, headers, { method: "POST", body: "{}" });
		expect(revoked.status).toBe(204);
		const after = await call("/v1/projects", asApp);
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

	it("lets the admin mint an organisation key that creates projects, in its organisation only", async () => {
		const { call, signedIn, stack, withKey } = await setup();
		const json = { "content-type": "application/json" };
		const admin = { ...(await signedIn()), ...json };
		const mint = (headers: Record<string, string>, body: unknown) =>
			call("/v1/keys", headers, { method: "POST", body: JSON.stringify(body) });
		const orgKey = { name: "Host app", scope: "organisation", role: "operator", permissions: ["create_projects"] };

		// Capped at operator, and no key mints one, not even the bootstrap's.
		expect((await mint(admin, { ...orgKey, role: "admin" })).status).toBe(400);
		expect((await mint({ ...withKey, ...json }, orgKey)).status).toBe(403);
		const minted = await mint(admin, orgKey);
		expect(minted.status).toBe(201);
		const issued = (await minted.json()) as {
			key: { id: string; scope?: string; projectIds: string[] };
			secret: string;
		};
		expect(issued.key).toMatchObject({ scope: "organisation", projectIds: [] });
		const asHost = { authorization: `Bearer ${issued.secret}`, ...json };

		const created = await call("/v1/projects", asHost, {
			method: "POST",
			body: JSON.stringify({ name: " Customer 42 " }),
		});
		expect(created.status).toBe(201);
		const project = (await created.json()) as { id: string; name: string; organisationId: string };
		expect(project).toMatchObject({ name: "Customer 42", organisationId: stack.organisation.id });
		const listed = (await (await call("/v1/projects", asHost)).json()) as { items: { id: string }[] };
		expect(listed.items.map((item) => item.id).sort()).toEqual([stack.project.id, project.id].sort());

		// Audited as the key that made it.
		const audited = await stack.audit.query(stack.admin, { type: "identity.project.created" });
		expect(audited.items.at(-1)?.actor).toEqual({
			kind: "service",
			serviceId: expect.any(String),
			keyId: issued.key.id,
		});

		// A project key, and a bad body, make none; the organisation key still manages no keys.
		const byProjectKey = await call("/v1/projects", { ...withKey, ...json }, { method: "POST", body: '{"name":"No"}' });
		expect(byProjectKey.status).toBe(403);
		expect((await call("/v1/projects", asHost, { method: "POST", body: '{"name":" "}' })).status).toBe(400);
		expect((await call("/v1/projects", asHost, { method: "POST", body: '{"name":"A","x":1}' })).status).toBe(400);
		expect((await mint(asHost, { name: "More", projectIds: [project.id], role: "viewer" })).status).toBe(403);
		const revoke = `/v1/keys/${encodeURIComponent(issued.key.id)}/revoke`;
		expect((await call(revoke, admin, { method: "POST", body: "{}" })).status).toBe(204);
		const late = await call("/v1/projects", asHost, { method: "POST", body: '{"name":"Late"}' });
		expect(late.status).toBe(401);
	});

	it("answers 404 for the agent plane's routes and any path under no API, signed in or not", async () => {
		const { call, signedIn, stack, withKey } = await setup();
		const headers = await signedIn();
		for (const path of [
			`/v1/sessions?projectId=${stack.project.id}`,
			"/v1/profiles",
			"/v1/workspaces/ws-1/files",
			"/v1/connections",
			"/v1/approvals",
			"/v1/skills",
			"/v1/memory/spaces",
			"/v1/schedules",
			"/v1/shares",
			"/v1/tool-servers",
			"/v1/passkeys",
			"/v1/compute/sandboxes",
			"/v2/sessions",
		]) {
			expect((await call(path, withKey)).status, path).toBe(404);
			expect((await call(path, headers)).status, path).toBe(404);
		}
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
		const env = { STACK: stack, ASSETS: { fetch: async () => new Response(null) } };
		const post = (path: string, body: string) =>
			routeRequest(new Request(`${BASE}${path}`, { method: "POST", body }), env);
		expect((await post("/v1/keys", '{"name":"a"}')).status).toBe(204);
		expect((await post("/v1/keys/key_1/revoke", "{}")).status).toBe(204);
		expect(seen).toEqual([`${STACK_NAME} POST /v1/keys {"name":"a"}`, `${STACK_NAME} POST /v1/keys/key_1/revoke {}`]);
		expect((await post("/v1/keys", "x".repeat(API_KEY_BODY_LIMIT + 1))).status).toBe(413);
		expect(seen).toHaveLength(2);
	});

	it("answers /healthz itself and sends every other /v1 path to the stack object", async () => {
		const seen: string[] = [];
		const stack = {
			idFromName: (name: string) => name,
			get: (name: string) => ({
				fetch: async (request: Request) => {
					seen.push(`${name} ${new URL(request.url).pathname}`);
					return new Response(null, { status: 404 });
				},
			}),
		};
		const env = { STACK: stack, ASSETS: { fetch: async () => new Response("page") } };
		const health = await routeRequest(new Request(`${BASE}/healthz`), env);
		expect(await health.json()).toEqual({ ok: true, service: "kantel" });
		expect((await routeRequest(new Request(`${BASE}/v1/sessions`), env)).status).toBe(404);
		expect(seen).toEqual([`${STACK_NAME} /v1/sessions`]);
	});
});

describe("the deployed entry point", () => {
	it("never reaches the dev routes or the mock Access issuer", () => {
		const src = join(import.meta.dirname, "../src");
		for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
			if (!file.endsWith(".ts")) continue;
			if (file === "dev.ts") continue;
			const text = readFileSync(join(src, file), "utf8");
			expect(text, file).not.toMatch(/@kantel\/identity\/testing|\.\/dev(-[a-z-]+)?(\.ts)?["']|__dev/);
		}
	});
});
