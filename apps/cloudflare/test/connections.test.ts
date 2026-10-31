// Connections on the stack (epic #322), in Node over a fake remote MCP server: an admin connects it through the
// gateway (connect, the provider's sign-in, the callback), then a session lists and calls its tools with the token
// added on the way out and never shown to the model, and the use is recorded against the session.
import { memoryCredentials } from "@kantel/connections/memory";
import { fakeProvider } from "@kantel/connections/testing";
import { createMockAccess } from "@kantel/identity/testing";
import type { ToolItem } from "@kantel/protocol";
import { createScriptedModel } from "@kantel/runtime/testing";
import { describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { stackConnectionsFrom } from "../src/connections.ts";
import { createGateway } from "../src/gateway.ts";
import { createStack, DEFAULT_AGENT_ID } from "../src/stack.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const ANA = "ana@harbour.test";
const BASE = "https://harbour.test";

async function setup() {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const provider = fakeProvider();
	const credentials = memoryCredentials();
	const scripted = createScriptedModel();
	const stack = await createStack({
		config: gatewayConfig({
			KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
			KANTEL_ACCESS_AUD: AUD,
			KANTEL_ADMIN_EMAIL: ADMIN,
		}),
		accessFetch: mock.fetch,
		models: () => ({ models: scripted.models }),
		connections: {
			credentials,
			deployment: { origin: BASE, clientMetadataPublic: false },
			fetch: provider.fetch,
		},
	});
	const gateway = createGateway(stack);
	const call = async (method: string, path: string, body?: unknown, email = ADMIN) =>
		gateway.fetch(
			new Request(`${BASE}${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { "content-type": "application/json" }),
					"cf-access-jwt-assertion": await mock.sign({ sub: `sub-${email}`, email }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	return { stack, gateway, provider, credentials, scripted, call };
}

describe("connections on the stack", () => {
	it("is on only with a hostname, and off when asked", () => {
		const vault = () => ({
			connectionSecret: async () => ({}),
			connectionApproval: async () => ({ outcome: "released" as const }),
		});
		expect(stackConnectionsFrom({}, vault)).toBeUndefined();
		expect(
			stackConnectionsFrom({ KANTEL_HOSTNAME: "harbour.myslop.app", KANTEL_CONNECTIONS: "off" }, vault),
		).toBeUndefined();
		expect(stackConnectionsFrom({ KANTEL_HOSTNAME: "harbour.myslop.app" }, vault)?.deployment).toEqual({
			origin: "https://harbour.myslop.app",
			clientMetadataPublic: false,
		});
		expect(stackConnectionsFrom({ KANTEL_HOSTNAME: "harbour.myslop.app" }, vault)?.personal).toBeUndefined();
		const personal = stackConnectionsFrom(
			{ KANTEL_HOSTNAME: "harbour.myslop.app", KANTEL_CONNECTIONS_PERSONAL: "On" },
			vault,
		);
		expect(personal?.personal).toBe(true);
		expect(personal?.deployment.personal).toBe(true);
		expect(stackConnectionsFrom({ KANTEL_HOSTNAME: "harbour.myslop.app" }, vault)?.approvals).toBeDefined();
	});

	it("says whether personal connections work in every session", async () => {
		const { call } = await setup();
		const settings = await call("GET", "/v1/connections/settings");
		expect(settings.status).toBe(200);
		expect(await settings.json()).toEqual({ personal: false });
	});

	it("connects a remote MCP server through the gateway and lets a session call its tools", async () => {
		const { stack, provider, scripted, call } = await setup();
		const organisationId = stack.organisation.id;

		// The catalogue answers, and anonymous requests are refused.
		const catalogue = await call("GET", "/v1/connections/catalogue?q=linear");
		expect(catalogue.status).toBe(200);
		expect((await catalogue.json()).items.some((entry: { id: string }) => entry.id === "linear")).toBe(true);
		expect((await stack.runtime.profiles.get(stack.admin, DEFAULT_AGENT_ID)).tools).toEqual(
			expect.arrayContaining(["connections_list", "connection_call"]),
		);

		const started = await call("POST", "/v1/connections/connect", {
			owner: { kind: "organisation", organisationId },
			mcpUrl: provider.mcpUrl,
			name: "Fake MCP",
			usage: { unattended: false, visibility: "shared" },
		});
		expect(started.status).toBe(201);
		const attempt = await started.json();
		expect(attempt).toMatchObject({
			status: "pending",
			connectUrl: expect.stringContaining("/v1/connections/authorize/"),
		});

		const authorize = await call("GET", new URL(attempt.connectUrl).pathname);
		expect(authorize.status).toBe(302);
		const location = authorize.headers.get("location")!;
		expect(location.startsWith("https://mcp.example.com/authorize?")).toBe(true);
		const state = new URL(location).searchParams.get("state")!;
		const code = provider.codeFor(location);

		const callback = await call("GET", `/v1/connections/callback?state=${encodeURIComponent(state)}&code=${code}`);
		expect(callback.status).toBe(200);
		expect(await callback.text()).toContain("Connected");

		const finished = await (await call("GET", `/v1/connections/connect/${attempt.id}`)).json();
		expect(finished.status).toBe("completed");
		const connection = await (await call("GET", `/v1/connections/${finished.connectionId}`)).json();
		expect(connection).toMatchObject({ name: "Fake MCP", kind: "mcp", auth: "oauth2", credential: { set: true } });
		expect(JSON.stringify(connection)).not.toContain(provider.issued.access[0]);

		// A session uses it: the agent lists what it may use, then calls a tool.
		provider.echoToken = true;
		const session = await stack.runtime.runtime.create(stack.admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			title: "Use a connection",
		});
		scripted.script.reply(
			{ toolCalls: [{ name: "connections_list", args: {} }] },
			{
				toolCalls: [{ name: "connection_call", args: { connectionId: connection.id, tool: "whoami", arguments: {} } }],
			},
			{ text: "Done." },
		);
		const prompt = await stack.runtime.runtime.prompt(stack.admin, session.id, { text: "Who am I there?" });
		expect(await stack.runtime.runtime.wait(stack.admin, session.id, prompt.id)).toMatchObject({ answer: "Done." });
		const items = (await stack.runtime.runtime.snapshot(stack.admin, session.id)).items.filter(
			(item): item is ToolItem => item.kind === "tool",
		);
		const listed = items.find((item) => item.name === "connections_list");
		expect(listed?.output).toContain(connection.id);
		const called = items.find((item) => item.name === "connection_call");
		expect(called?.output).toContain("you are [redacted]");
		// The server got the token; nothing the session holds shows it.
		expect(provider.mcpAuthorizations.at(-1)).toBe(`Bearer ${provider.issued.access[0]}`);
		expect(JSON.stringify(items)).not.toContain(provider.issued.access[0]);

		const uses = await (await call("GET", `/v1/connections/uses?sessionId=${session.id}`)).json();
		expect(uses.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "mcp_call", tool: "whoami", outcome: "allowed", sessionId: session.id }),
			]),
		);

		// A rule through the API (#332): the dry run and the session's next call agree, and the use names the rule.
		const before = await (await call("GET", `/v1/connections/${connection.id}/rules`)).json();
		expect(before).toEqual({ connectionId: connection.id, rules: [], unmatched: "allow", version: 0 });
		const created = await call("POST", `/v1/connections/${connection.id}/rules`, {
			who: { kind: "agent", agentId: DEFAULT_AGENT_ID },
			what: { kind: "tool", tool: "whoami" },
			action: "deny",
		});
		expect(created.status).toBe(201);
		const rule = await created.json();
		const dry = await call("POST", `/v1/connections/${connection.id}/rules/dry-run`, {
			method: "POST",
			tool: "whoami",
			agentId: DEFAULT_AGENT_ID,
			projectId: stack.project.id,
			audience: "shared",
		});
		expect(dry.status).toBe(200);
		expect(await dry.json()).toMatchObject({ action: "deny", by: { kind: "rule", ruleId: rule.id }, rulesVersion: 1 });
		scripted.script.reply(
			{
				toolCalls: [{ name: "connection_call", args: { connectionId: connection.id, tool: "whoami", arguments: {} } }],
			},
			{ text: "Refused." },
		);
		const again = await stack.runtime.runtime.prompt(stack.admin, session.id, { text: "Again?" });
		await stack.runtime.runtime.wait(stack.admin, session.id, again.id);
		const after = await (await call("GET", `/v1/connections/uses?sessionId=${session.id}`)).json();
		expect(after.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ outcome: "denied", decision: "deny", decidedBy: "rule", ruleId: rule.id }),
			]),
		);
		expect((await call("DELETE", `/v1/connections/${connection.id}/rules/${rule.id}`)).status).toBe(204);
		// The stack has no ceiling store in tests: rules are unbounded, and setting one is refused.
		expect(await (await call("GET", "/v1/connections/ceiling")).json()).toEqual({ set: false, routes: [] });

		// Disconnecting (#329) answers what happened at the provider: this one names no revocation endpoint.
		const removed = await call("DELETE", `/v1/connections/${connection.id}`);
		expect(removed.status).toBe(200);
		const removal = await removed.json();
		expect(removal).toMatchObject({
			connectionId: connection.id,
			revocation: { outcome: "unsupported" },
			rulesRemoved: 0,
			approvalsWithdrawn: 0,
		});
		expect(JSON.stringify(removal)).not.toContain(provider.issued.access[0]);
		expect((await call("GET", `/v1/connections/${connection.id}`)).status).toBe(404);
		await stack.close();
	});

	it("keeps a person's connection out of a session others can see until it is private or shared (#335)", async () => {
		const { stack, provider, scripted, call } = await setup();
		const admin = stack.admin.actor;
		if (admin.kind !== "human") throw new Error("The stack's admin is a person");
		const owner = { kind: "user", organisationId: stack.organisation.id, userId: admin.userId };
		const attempt = await (await call("POST", "/v1/connections/connect", { owner, mcpUrl: provider.mcpUrl })).json();
		const location = (await call("GET", new URL(attempt.connectUrl).pathname)).headers.get("location")!;
		const state = new URL(location).searchParams.get("state")!;
		await call("GET", `/v1/connections/callback?state=${encodeURIComponent(state)}&code=${provider.codeFor(location)}`);
		const connectionId = (await (await call("GET", `/v1/connections/connect/${attempt.id}`)).json()).connectionId;

		const created = await call("POST", "/v1/sessions", { projectId: stack.project.id, agentId: DEFAULT_AGENT_ID });
		expect(created.status).toBe(201);
		const session = await created.json();
		const eligible = async (query = "") =>
			(await (await call("GET", `/v1/connections/eligible?sessionId=${session.id}${query}`)).json()).items;
		expect(await eligible()).toEqual([
			expect.objectContaining({ connection: expect.objectContaining({ id: connectionId }), usable: false }),
		]);
		expect(await eligible("&visibility=private")).toEqual([expect.objectContaining({ usable: true })]);

		const callIt = async () => {
			scripted.script.reply(
				{ toolCalls: [{ name: "connection_call", args: { connectionId, tool: "whoami", arguments: {} } }] },
				{ text: "Done." },
			);
			const prompt = await stack.runtime.runtime.prompt(stack.admin, session.id, { text: "Who am I?" });
			await stack.runtime.runtime.wait(stack.admin, session.id, prompt.id);
			return (await (await call("GET", `/v1/connections/uses?sessionId=${session.id}`)).json()).items[0];
		};
		// Shared: refused and recorded.
		expect(await callIt()).toMatchObject({ outcome: "denied", audience: { kind: "shared" } });
		// Made private: its next call goes out, the tools reading the session as it is now.
		const patched = await call("PATCH", `/v1/sessions/${session.id}`, { visibility: "private" });
		expect(patched.status).toBe(200);
		expect(await callIt()).toMatchObject({ outcome: "allowed", audience: { kind: "private", userId: admin.userId } });
		// Shared again, then the connection shared with the project: allowed, as a use through the share.
		await call("PATCH", `/v1/sessions/${session.id}`, { visibility: "shared" });
		const shared = await call("POST", `/v1/connections/${connectionId}/shares`, { projectId: stack.project.id });
		expect(shared.status).toBe(200);
		expect((await shared.json()).shares).toEqual([expect.objectContaining({ projectId: stack.project.id })]);
		expect(await callIt()).toMatchObject({ outcome: "allowed", viaShare: true });
		const unshared = await call("DELETE", `/v1/connections/${connectionId}/shares/${stack.project.id}`);
		expect(unshared.status).toBe(200);
		expect(await callIt()).toMatchObject({ outcome: "denied" });
		await stack.close();
	});

	it("lists a use in someone's private session only to them, not to an organisation admin (#335)", async () => {
		const { stack, provider, scripted, call } = await setup();
		const admin = stack.admin.actor;
		if (admin.kind !== "human") throw new Error("The stack's admin is a person");
		const ana = await stack.identity.createUser(stack.admin, { name: "Ana", email: ANA });
		await stack.identity.grantRole(stack.admin, { principal: { kind: "user", userId: ana.id }, role: "admin" });
		const owner = { kind: "user", organisationId: stack.organisation.id, userId: admin.userId };
		const attempt = await (await call("POST", "/v1/connections/connect", { owner, mcpUrl: provider.mcpUrl })).json();
		const location = (await call("GET", new URL(attempt.connectUrl).pathname)).headers.get("location")!;
		const state = new URL(location).searchParams.get("state")!;
		await call("GET", `/v1/connections/callback?state=${encodeURIComponent(state)}&code=${provider.codeFor(location)}`);
		const connectionId = (await (await call("GET", `/v1/connections/connect/${attempt.id}`)).json()).connectionId;

		// One private session and one others can see, each calling the connection once.
		const open = async (visibility: "private" | "shared") => {
			const created = await call("POST", "/v1/sessions", {
				projectId: stack.project.id,
				agentId: DEFAULT_AGENT_ID,
				visibility,
			});
			expect(created.status).toBe(201);
			const session = await created.json();
			scripted.script.reply(
				{ toolCalls: [{ name: "connection_call", args: { connectionId, tool: "whoami", arguments: {} } }] },
				{ text: "Done." },
			);
			const prompt = await stack.runtime.runtime.prompt(stack.admin, session.id, { text: "Who am I?" });
			await stack.runtime.runtime.wait(stack.admin, session.id, prompt.id);
			return session.id as string;
		};
		const mine = await open("private");
		const seen = await open("shared");
		const uses = async (query: string, email = ADMIN) => {
			const response = await call("GET", `/v1/connections/uses${query}`, undefined, email);
			return { status: response.status, body: await response.json() };
		};
		const sessionsOf = (body: { items: { sessionId: string }[] }) => body.items.map((use) => use.sessionId).sort();

		// The owner sees both.
		const own = await uses(`?connectionId=${connectionId}`);
		expect(own.body.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId: mine,
					outcome: "allowed",
					audience: { kind: "private", userId: admin.userId },
				}),
				expect.objectContaining({ sessionId: seen, outcome: "denied", audience: { kind: "shared" } }),
			]),
		);
		// An organisation admin sees the connection, and its use in the session others can see, but not the private one:
		// not by connection, not unfiltered, and not by naming the session.
		expect((await call("GET", `/v1/connections/${connectionId}`, undefined, ANA)).status).toBe(200);
		expect(sessionsOf((await uses(`?connectionId=${connectionId}`, ANA)).body)).toEqual([seen]);
		const everything = await uses("", ANA);
		expect(everything.status).toBe(200);
		expect(JSON.stringify(everything.body)).not.toContain(mine);
		expect(sessionsOf(everything.body)).toContain(seen);
		expect((await uses(`?sessionId=${mine}`, ANA)).status).toBe(403);
		await stack.close();
	});

	it("gives an organisation-level agent the organisation's connections, plus its project's, and nothing else (#335)", async () => {
		const { stack, scripted, call } = await setup();
		const admin = stack.admin.actor;
		if (admin.kind !== "human") throw new Error("The stack's admin is a person");
		const organisationId = stack.organisation.id;
		const other = await stack.identity.createProject(stack.admin, { name: "Other" });
		const key = async (name: string, owner: unknown, usage?: unknown) => {
			const made = await call("POST", "/v1/connections/keys", {
				owner,
				name,
				custom: { kind: "http", hosts: [`${name}.example.com`], injection: { kind: "bearer" } },
				value: `sk-${name}-abcdefghijklmnop`,
				...(usage === undefined ? {} : { usage }),
			});
			expect(made.status).toBe(201);
			return (await made.json()).id as string;
		};
		const organisation = { kind: "organisation", organisationId };
		const ids: Record<string, string> = {
			org: await key("org", organisation, { unattended: false, visibility: "shared" }),
			orgInProject: await key("org-in-project", organisation, {
				projects: [stack.project.id],
				unattended: false,
				visibility: "shared",
			}),
			project: await key("project", { kind: "project", organisationId, projectId: stack.project.id }),
			other: await key("other", { kind: "project", organisationId, projectId: other.id }),
			personal: await key("personal", { kind: "user", organisationId, userId: admin.userId }),
		};
		const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]));

		// The stack's default agent is organisation-wide: it runs in an organisation session and in a project's.
		const start = async (body: Record<string, unknown>) => {
			const created = await call("POST", "/v1/sessions", { agentId: DEFAULT_AGENT_ID, ...body });
			expect(created.status).toBe(201);
			return (await created.json()) as { id: string; projectId?: string };
		};
		const listed = async (sessionId: string) => {
			scripted.script.reply({ toolCalls: [{ name: "connections_list", args: {} }] }, { text: "Done." });
			const prompt = await stack.runtime.runtime.prompt(stack.admin, sessionId, { text: "What can I use?" });
			await stack.runtime.runtime.wait(stack.admin, sessionId, prompt.id);
			const items = (await stack.runtime.runtime.snapshot(stack.admin, sessionId)).items.filter(
				(item): item is ToolItem => item.kind === "tool" && item.name === "connections_list",
			);
			return [...names.entries()]
				.filter(([id]) => items.at(-1)?.output?.includes(id) === true)
				.map(([, name]) => name)
				.sort();
		};
		const eligible = async (sessionId: string, query = "") =>
			Object.fromEntries(
				(
					(await (await call("GET", `/v1/connections/eligible?sessionId=${sessionId}${query}`)).json()).items as {
						connection: { id: string };
						usable: boolean;
					}[]
				).map((entry) => [names.get(entry.connection.id), entry.usable]),
			);

		// In an organisation session: the organisation's own, not one kept to a project, no project's, no person's.
		const inOrganisation = await start({ scope: "organisation" });
		expect(inOrganisation.projectId).toBeUndefined();
		expect(await listed(inOrganisation.id)).toEqual(["org"]);
		expect(await eligible(inOrganisation.id)).toEqual({ org: true, orgInProject: false, personal: false });
		// Its person's own only if nobody else could see the session.
		expect((await eligible(inOrganisation.id, "&visibility=private")).personal).toBe(true);
		// A project's connection is refused there, and the refusal is recorded against the session.
		scripted.script.reply(
			{
				toolCalls: [
					{
						name: "connection_request",
						args: { connectionId: ids.project, method: "GET", url: "https://project.example.com/" },
					},
				],
			},
			{ text: "Refused." },
		);
		const refused = await stack.runtime.runtime.prompt(stack.admin, inOrganisation.id, { text: "Use it" });
		await stack.runtime.runtime.wait(stack.admin, inOrganisation.id, refused.id);
		const uses = (await (await call("GET", `/v1/connections/uses?sessionId=${inOrganisation.id}`)).json()).items;
		expect(uses[0]).toMatchObject({
			connectionId: ids.project,
			outcome: "denied",
			reason: expect.stringContaining("It belongs to a project, and this is an organisation session"),
		});
		expect(uses[0].projectId).toBeUndefined();

		// The same agent in a project session: the organisation's and that project's.
		const inProject = await start({ projectId: stack.project.id });
		expect(await listed(inProject.id)).toEqual(["org", "orgInProject", "project"]);
		const inOther = await start({ projectId: other.id });
		expect(await listed(inOther.id)).toEqual(["org", "other"]);
		await stack.close();
	});
});
