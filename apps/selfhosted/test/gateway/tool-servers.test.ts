// Tool servers on the self-hosted gateway (docs/site/src/content/docs/api/tool-servers.md), end to end through a
// real HTTP server: a server registered with an API key, the `@kantel/tunnel` client bridging a stdio MCP server to
// it, a session calling `<server>__echo`, a changed tool list reaching new sessions only, and the tunnel stopping. Off
// unless KANTEL_TOOL_SERVERS=experimental, and then there are no routes and no upgrade.
import { fileURLToPath } from "node:url";
import {
	type AgentProfile,
	type CallContext,
	type CreatedToolServer,
	type SessionId,
	systemContext,
	type ToolServer,
	type ToolServerTools,
} from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import { stdioEndpoint } from "@kantel/tunnel/stdio";
import { openTunnel, type Tunnel, type TunnelTiming } from "@kantel/tunnel/tunnel";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents, type GatewayComponents } from "../../src/gateway/components.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { listen } from "../../src/gateway/node-http.ts";
import { toolServersConfig, toolServerUpgrades, withToolServerUpgrades } from "../../src/gateway/tool-servers.ts";
import { waitFor } from "./wait.ts";

const ECHO_SERVER = fileURLToPath(new URL("../../../../packages/tunnel/test/fixtures/echo-server.ts", import.meta.url));
const FAST: Partial<TunnelTiming> = { pingIntervalMs: 50, backoffInitialMs: 20, backoffMaxMs: 100 };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function serve(toolServers: boolean) {
	const { models, script } = createScriptedModel();
	const components: GatewayComponents = createGatewayComponents({
		models: { models },
		...(toolServers ? { toolServers: true } : {}),
	});
	cleanups.push(() => components.close());
	const seeded = await bootstrap(components, { organisation: "Tools", project: "tools" });
	const gateway = createGateway({ components });
	cleanups.push(() => gateway.close());
	const tunnels = components.toolServers === undefined ? undefined : toolServerUpgrades(components.toolServers);
	const onUpgrade = withToolServerUpgrades(tunnels, undefined);
	const server = await listen(gateway.fetch, 0, {
		host: "127.0.0.1",
		...(onUpgrade === undefined ? {} : { onUpgrade }),
	});
	cleanups.push(async () => {
		tunnels?.close();
		await server.close();
	});
	const system: CallContext = { ...systemContext("tool-servers-test"), organisationId: seeded.organisationId };
	// A project admin's key: registering a server is admin on its owner.
	const service = await components.identity.createServiceIdentity(system, { name: "tool-admin" });
	const admin = await components.identity.issueApiKey(system, {
		serviceId: service.id,
		projectIds: [seeded.projectId],
		role: "admin",
	});
	const api = async (method: string, path: string, body?: unknown) => {
		const response = await fetch(`${server.url}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${admin.secret}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
	};
	const tunnel = (serverId: string, token: string): Tunnel => {
		const opened = openTunnel({
			kantel: server.url,
			serverId,
			token,
			endpoint: stdioEndpoint([process.execPath, ECHO_SERVER]),
			timing: FAST,
		});
		cleanups.push(() => opened.close());
		return opened;
	};
	const inProject: CallContext = { ...system, projectId: seeded.projectId };
	const run = async (sessionId: SessionId, text: string) => {
		const prompt = await components.runtime.runtime.prompt(inProject, sessionId, { text });
		return components.runtime.runtime.wait(inProject, sessionId, prompt.id);
	};
	return { components, seeded, script, server, api, tunnel, inProject, run };
}

const profile = (organisationId: string, projectId: string, tools: string[]): AgentProfile => ({
	id: "tools",
	organisationId,
	projectId,
	name: "Tools",
	model: { route: "echo" },
	promptLayers: [],
	tools,
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
});

/**
 * Bun's `ws` has no `unexpected-response` event, so a tunnel there can't read the status of a refused upgrade: it
 * retries a refusal with backoff instead of stopping on it. The gateway still refuses; only the tunnel's report of why
 * differs, so the tests that read it run under vitest (Node) and not `test:stack`.
 */
const readsRefusals = !("Bun" in globalThis);

describe("tool servers on the self-hosted gateway", () => {
	it("are on only with KANTEL_TOOL_SERVERS=experimental", () => {
		expect(toolServersConfig({})).toBe(false);
		expect(toolServersConfig({ KANTEL_TOOL_SERVERS: "on" })).toBe(false);
		expect(toolServersConfig({ KANTEL_TOOL_SERVERS: "experimental" })).toBe(true);
	});

	it.skipIf(!readsRefusals)("have no routes, no binding and no upgrade when off", async () => {
		const { components, api, server } = await serve(false);
		expect(components.toolServers).toBeUndefined();
		expect(components.bindings.toolServers).toBeUndefined();
		expect((await api("GET", "/v1/tool-servers")).status).toBe(404);
		expect((await api("POST", "/v1/tool-servers", { name: "atlas", transport: "tunnel" })).status).toBe(404);
		const opened = openTunnel({
			kantel: server.url,
			serverId: "ts_1",
			token: "ktt_any",
			endpoint: { send() {}, onMessage() {} },
			timing: FAST,
		});
		cleanups.push(() => opened.close());
		await waitFor(() => expect(opened.status).toMatchObject({ state: "stopped", fatal: true }));
		expect(opened.status).toMatchObject({ reason: "no such tool server (HTTP 404)" });
	});

	it("serve a session a tunnelled server's tools, audit the calls, and keep a session's tools when they change", async () => {
		const { components, seeded, script, api, tunnel, inProject, run } = await serve(true);
		expect(components.bindings.toolServers).toBe("memory (experimental)");

		const created = await api("POST", "/v1/tool-servers", {
			projectId: seeded.projectId,
			name: "atlas",
			transport: "tunnel",
		});
		expect(created.status).toBe(201);
		const { server, token } = created.body as CreatedToolServer;
		expect(server.connection.status).toBe("offline");
		expect((await api("GET", "/v1/tool-servers")).body).toMatchObject({ items: [{ id: server.id, name: "atlas" }] });
		const opened = tunnel(server.id, token?.secret ?? "");

		await waitFor(async () => {
			const got = (await api("GET", `/v1/tool-servers/${server.id}`)).body as ToolServer;
			expect(got.connection).toMatchObject({ status: "connected", serverInfo: { name: "echo-server" } });
		});
		expect(opened.status.state).toBe("connected");
		const tools = (await api("GET", `/v1/tool-servers/${server.id}/tools`)).body as ToolServerTools;
		expect(tools.tools.map((tool) => [tool.modelName, tool.replay, tool.enabled])).toEqual([
			["atlas__echo", "safe", true],
			["atlas__change", "unsafe", true],
		]);
		const firstHash = tools.hash;

		await components.runtime.profiles.put(inProject, profile(seeded.organisationId, seeded.projectId, ["atlas/*"]));
		const first = await components.runtime.runtime.create(inProject, { projectId: seeded.projectId, agentId: "tools" });
		script.reply({ toolCalls: [{ name: "atlas__echo", args: { text: "hi" } }] }, { text: "Echoed" });
		expect(await run(first.id, "Echo hi")).toMatchObject({ status: "answered", answer: "Echoed" });
		const offered = (index: number) => (script.requests[index]?.tools ?? []).map((tool) => tool.name);
		expect(offered(0)).toEqual(["atlas__echo", "atlas__change"]);
		const echoed = JSON.parse(script.requests[1]?.messages.at(-1)?.text ?? "{}") as {
			arguments: unknown;
			meta: { [key: string]: string };
		};
		expect(echoed.arguments).toEqual({ text: "hi" });
		expect(echoed.meta).toMatchObject({
			"harbour/sessionId": first.id,
			"harbour/organisationId": seeded.organisationId,
			"harbour/projectId": seeded.projectId,
			"harbour/agentId": "tools",
			"harbour/callId": expect.any(String),
		});

		const finished = await components.audit.query(inProject, {
			type: "session.tool.finished",
			sessionId: first.id,
		});
		expect(finished.items[0]?.data).toMatchObject({
			hostId: `tool-server:${server.id}`,
			tool: "atlas__echo",
			toolServerId: server.id,
			transport: "tunnel",
			outcome: "done",
			durationMs: expect.any(Number),
		});

		// The server adds a tool and says its list changed: audited with both hashes, offered to a new session only.
		script.reply({ toolCalls: [{ name: "atlas__change", args: {} }] }, { text: "Changed" });
		await run(first.id, "Change it");
		await waitFor(async () => {
			const changed = await components.audit.query(inProject, { type: "tool_server.tools.changed" });
			expect(changed.items.map((event) => event.data)).toContainEqual({
				oldHash: firstHash,
				newHash: expect.not.stringMatching(firstHash ?? ""),
				tools: 3,
			});
		});
		script.reply({ text: "Still two" });
		await run(first.id, "Again");
		expect(offered(4)).toEqual(["atlas__echo", "atlas__change"]);
		const second = await components.runtime.runtime.create(inProject, {
			projectId: seeded.projectId,
			agentId: "tools",
		});
		script.reply({ text: "Three" });
		await run(second.id, "Hello");
		expect(offered(5)).toEqual(["atlas__echo", "atlas__change", "atlas__added2"]);

		const events = await components.audit.query(inProject, { source: "tool_server" }, { limit: 100 });
		expect(new Set(events.items.map((event) => event.type))).toEqual(
			new Set([
				"tool_server.created",
				"tool_server.token.created",
				"tool_server.connected",
				"tool_server.tools.changed",
			]),
		);
		expect(JSON.stringify(events.items)).not.toContain(token?.secret);

		// The tunnel stops: the server shows offline, and a call answers an error result.
		await opened.close();
		await waitFor(async () => {
			const got = (await api("GET", `/v1/tool-servers/${server.id}`)).body as ToolServer;
			expect(got.connection.status).toBe("offline");
		});
		script.reply({ toolCalls: [{ name: "atlas__echo", args: { text: "anyone?" } }] }, { text: "Offline" });
		expect(await run(first.id, "Echo again")).toMatchObject({ status: "answered", answer: "Offline" });
		expect(script.requests.at(-1)?.messages.at(-1)).toEqual({ role: "tool", text: "Tool server atlas is offline" });
	});

	it.skipIf(!readsRefusals)(
		"refuse a bad token with 401 and an unknown server with 404 before the upgrade",
		async () => {
			const { seeded, api, server } = await serve(true);
			const created = (await api("POST", "/v1/tool-servers", {
				projectId: seeded.projectId,
				name: "atlas",
				transport: "tunnel",
			})) as { body: CreatedToolServer };
			const refused = async (serverId: string, token: string) => {
				const opened = openTunnel({
					kantel: server.url,
					serverId,
					token,
					endpoint: { send() {}, onMessage() {} },
					timing: FAST,
				});
				cleanups.push(() => opened.close());
				await waitFor(() => expect(opened.status).toMatchObject({ state: "stopped", fatal: true }));
				return opened.status;
			};
			expect(await refused(created.body.server.id, "ktt_wrong")).toMatchObject({ reason: "token refused (HTTP 401)" });
			expect(await refused("ts_unknown", created.body.token?.secret ?? "")).toMatchObject({
				reason: "no such tool server (HTTP 404)",
			});
			// The JSON routes never answer the tunnel's path.
			expect((await api("GET", `/v1/tool-servers/${created.body.server.id}/connect`)).status).toBe(404);
		},
	);
});
