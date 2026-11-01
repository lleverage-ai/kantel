// The SDK's side of tool servers on the self-hosted gateway (docs/site/src/content/docs/api/tool-servers.md): the
// session API client serving a host's tools in-process through a tunnel (`hostTransport: "tunnel"`), and
// `toolServers.serve()` for a server made through the API, end to end through a real HTTP server and `@kantel/tunnel`.
import {
	type CallContext,
	type HostToolCall,
	type HostToolDefinition,
	systemContext,
	type ToolServer,
} from "@kantel/contracts";
import {
	bearer,
	createSessionApiClient,
	IN_PROCESS_MCP_CANCELLED,
	IN_PROCESS_MCP_PROTOCOL_VERSION,
	type SessionApiClient,
	type ToolServerTunnelOpener,
} from "@kantel/runtime/http";
import { createScriptedModel } from "@kantel/runtime/testing";
import { MCP_CANCELLED, MCP_PROTOCOL_VERSION } from "@kantel/tools/protocol";
import { openTunnel, type TunnelTiming } from "@kantel/tunnel/tunnel";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { listen } from "../../src/gateway/node-http.ts";
import { toolServerUpgrades, withToolServerUpgrades } from "../../src/gateway/tool-servers.ts";
import { waitFor } from "./wait.ts";

const FAST: Partial<TunnelTiming> = { pingIntervalMs: 50, backoffInitialMs: 20, backoffMaxMs: 100 };
// `openTunnel` is what the client is given, with the test's shorter timings.
const tunnels: ToolServerTunnelOpener = (options) => openTunnel({ ...options, timing: FAST });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

const echo: HostToolDefinition = {
	name: "echo",
	description: "Answers with what it was given",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
	replay: "safe",
};

async function serve() {
	const { models, script } = createScriptedModel();
	const components = createGatewayComponents({ models: { models }, toolServers: true });
	cleanups.push(() => components.close());
	const seeded = await bootstrap(components, { organisation: "Tools", project: "tools" });
	const gateway = createGateway({ components });
	cleanups.push(() => gateway.close());
	const upgrades = components.toolServers === undefined ? undefined : toolServerUpgrades(components.toolServers);
	const onUpgrade = withToolServerUpgrades(upgrades, undefined);
	const server = await listen(gateway.fetch, 0, {
		host: "127.0.0.1",
		...(onUpgrade === undefined ? {} : { onUpgrade }),
	});
	cleanups.push(async () => {
		upgrades?.close();
		await server.close();
	});
	const system: CallContext = { ...systemContext("tool-servers-sdk-test"), organisationId: seeded.organisationId };
	const key = async (role: "admin" | "operator") => {
		const service = await components.identity.createServiceIdentity(system, { name: `atlas-${role}` });
		return (
			await components.identity.issueApiKey(system, { serviceId: service.id, projectIds: [seeded.projectId], role })
		).secret;
	};
	const client = (secret: string): SessionApiClient => {
		const made = createSessionApiClient({
			baseUrl: `${server.url}/v1`,
			credentials: bearer(secret),
			hostTransport: "tunnel",
			tunnels,
			resultPollMs: 1000,
		});
		return made;
	};
	const ctx: CallContext = {
		actor: { kind: "service", serviceId: "atlas" },
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	const profile = (tools: string[]) => ({
		id: "atlas-worker",
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
		name: "Atlas worker",
		model: { route: "echo" },
		promptLayers: [],
		tools,
		skills: [],
		sandbox: { tiers: ["isolate" as const] },
		memoryScopes: [],
	});
	return { components, seeded, script, key, client, ctx, profile };
}

describe("the SDK's tool servers on the self-hosted gateway", () => {
	it("keep the in-process server's protocol constants equal to the tunnel protocol's", () => {
		expect(IN_PROCESS_MCP_PROTOCOL_VERSION).toBe(MCP_PROTOCOL_VERSION);
		expect(IN_PROCESS_MCP_CANCELLED).toBe(MCP_CANCELLED);
	});

	it("serve a host's tools through a tunnel: a session calls them, and closing removes the server", async () => {
		const { components, script, key, client, ctx, profile } = await serve();
		const atlas = client(await key("admin"));
		const calls: HostToolCall[] = [];
		const registration = await atlas.hostTools.register(ctx, "atlas-run-1", [echo], async (call) => {
			calls.push(call);
			return { output: `echo: ${JSON.stringify(call.args)}` };
		});
		cleanups.push(() => registration.close());

		// Registered means connected, with the tools taken, so a session made now is offered them.
		const servers = await atlas.toolServers.list(ctx, { projectId: ctx.projectId as string });
		const server = servers.items.find((each) => each.name === "atlas-run-1") as ToolServer;
		expect(server).toMatchObject({ transport: "tunnel", connection: { status: "connected" } });
		expect(await atlas.hostTools.list(ctx, "atlas-run-1")).toEqual([
			{ name: "echo", description: echo.description, inputSchema: echo.inputSchema, replay: "safe" },
		]);

		await atlas.profiles.put(ctx, profile(["atlas-run-1/*"]));
		const session = await atlas.runtime.create(ctx, { projectId: ctx.projectId as string, agentId: "atlas-worker" });
		script.reply({ toolCalls: [{ name: "atlas-run-1__echo", args: { text: "hi" } }] }, { text: "Echoed" });
		const prompt = await atlas.runtime.prompt(ctx, session.id, { text: "Echo hi" });
		expect(await atlas.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({
			status: "answered",
			answer: "Echoed",
		});
		expect((script.requests[0]?.tools ?? []).map((tool) => tool.name)).toEqual(["atlas-run-1__echo"]);
		expect(script.requests[1]?.messages.at(-1)).toEqual({ role: "tool", text: 'echo: {"text":"hi"}' });
		expect(calls).toEqual([
			{
				hostId: "atlas-run-1",
				sessionId: session.id,
				organisationId: ctx.organisationId,
				projectId: ctx.projectId,
				agentId: "atlas-worker",
				callId: expect.any(String),
				tool: "echo",
				args: { text: "hi" },
			},
		]);
		const finished = await components.audit.query(
			{ ...systemContext("t"), organisationId: ctx.organisationId, projectId: ctx.projectId as string },
			{ type: "session.tool.finished", sessionId: session.id },
		);
		expect(finished.items[0]?.data).toMatchObject({ toolServerId: server.id, transport: "tunnel", outcome: "done" });

		// Closing stops the tunnel and removes the server this registration made; the pinned tool answers an error.
		await registration.close();
		await expect(atlas.toolServers.get(ctx, server.id)).rejects.toMatchObject({ code: "not_found" });
		script.reply({ toolCalls: [{ name: "atlas-run-1__echo", args: { text: "anyone?" } }] }, { text: "Gone" });
		const again = await atlas.runtime.prompt(ctx, session.id, { text: "Echo again" });
		expect(await atlas.runtime.wait(ctx, session.id, again.id)).toMatchObject({ status: "answered", answer: "Gone" });
		expect(script.requests.at(-1)?.messages.at(-1)).toMatchObject({ role: "tool" });
		expect(calls).toHaveLength(1);
	});

	it("register again in the same client without the two tunnels fighting, and keep the server", async () => {
		const { key, client, ctx } = await serve();
		const atlas = client(await key("admin"));
		const first = await atlas.hostTools.register(ctx, "atlas-run-2", [echo], async () => ({ output: "first" }));
		const second = await atlas.hostTools.register(ctx, "atlas-run-2", [echo], async () => ({ output: "second" }));
		cleanups.push(() => second.close());
		const [server] = (await atlas.toolServers.list(ctx)).items.filter((each) => each.name === "atlas-run-2");
		expect(server?.connection.status).toBe("connected");
		// The first registration's close revoked its own token only.
		await first.close();
		expect((await atlas.toolServers.get(ctx, server?.id as string)).connection.status).toBe("connected");
		expect(await atlas.toolServers.listTokens(ctx, server?.id as string)).toHaveLength(1);
		await second.close();
		await expect(atlas.toolServers.get(ctx, server?.id as string)).rejects.toMatchObject({ code: "not_found" });
	});

	it("let an operator's key serve a server an admin made, and say why when there is none", async () => {
		const { key, client, ctx } = await serve();
		const operator = client(await key("operator"));
		await expect(
			operator.hostTools.register(ctx, "atlas-fixed", [echo], async () => ({ output: "" })),
		).rejects.toMatchObject({
			code: "forbidden",
			message: expect.stringContaining("There is no tool server atlas-fixed yet"),
		});
		const admin = client(await key("admin"));
		const created = await admin.toolServers.create(ctx, {
			projectId: ctx.projectId as string,
			name: "atlas-fixed",
			transport: "tunnel",
		});
		const registration = await operator.hostTools.register(ctx, "atlas-fixed", [echo], async () => ({ output: "" }));
		expect((await admin.toolServers.get(ctx, created.server.id)).connection.status).toBe("connected");
		// Not made by this registration, so closing it leaves the server and revokes only its own token.
		await registration.close();
		await waitFor(async () =>
			expect((await admin.toolServers.get(ctx, created.server.id)).connection.status).toBe("offline"),
		);
		expect((await admin.toolServers.listTokens(ctx, created.server.id)).map((token) => token.id)).toEqual([
			created.token?.token.id,
		]);
	});

	it("serve() an MCP server object on a server made through the API, and fail cleanly on a removed server", async () => {
		const { key, client, ctx } = await serve();
		const atlas = client(await key("admin"));
		const created = await atlas.toolServers.create(ctx, {
			projectId: ctx.projectId as string,
			name: "mcp-object",
			transport: "tunnel",
		});
		// The shape the MCP SDK's `McpServer` has: `connect(transport)`, answering on the transport.
		const mcpServer = {
			async connect(transport: {
				start(): Promise<void>;
				send(message: unknown): Promise<void>;
				onmessage?: (message: never) => void;
			}) {
				(transport as { onmessage?: (message: { id?: number; method: string }) => void }).onmessage = (message) => {
					if (message.id === undefined) return;
					const result =
						message.method === "initialize"
							? { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "object" } }
							: message.method === "tools/list"
								? { tools: [{ name: "hello", description: "Says hello", inputSchema: { type: "object" } }] }
								: {};
					void transport.send({ jsonrpc: "2.0", id: message.id, result });
				};
				await transport.start();
			},
		};
		const served = await atlas.toolServers.serve(ctx, created.server.id, mcpServer);
		expect(served.server.connection).toMatchObject({ status: "connected", serverInfo: { name: "object" } });
		expect((await atlas.toolServers.tools(ctx, created.server.id)).tools.map((tool) => tool.modelName)).toEqual([
			"mcp-object__hello",
		]);
		// serve() made its own token, and revokes it on close.
		expect(await atlas.toolServers.listTokens(ctx, created.server.id)).toHaveLength(2);
		await served.close();
		expect(await atlas.toolServers.listTokens(ctx, created.server.id)).toHaveLength(1);

		await atlas.toolServers.remove(ctx, created.server.id);
		await expect(atlas.toolServers.serve(ctx, created.server.id, mcpServer)).rejects.toMatchObject({
			code: "not_found",
		});
	});
});
