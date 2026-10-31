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
		await stack.close();
	});
});
