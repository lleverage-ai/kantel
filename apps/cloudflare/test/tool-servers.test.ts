// Tool servers on Cloudflare (docs/site/src/content/docs/api/tool-servers.md), in Node: the Worker's routing
// (src/route.ts), the stack's registry and gateway (src/stack.ts, src/gateway.ts), and each server's tunnel object's
// logic (src/tunnel.ts), with stand-ins for the Durable Object namespaces, the hibernation API's sockets and the
// object's storage. The test plays the server's side of the tunnel itself, answering initialize, tools/list and
// tools/call. Every RPC between the objects is structured-cloned, as Cloudflare's is.
//
// Not exercised here: the `KantelTunnel` class itself (src/tunnel-object.ts, which needs `cloudflare:workers`), the
// real `WebSocketPair` and 101 answer, and the runtime's ping auto-response. Hibernation is played by building a new
// holder over the same storage and sockets.
import type {
	AgentProfile,
	CreatedToolServer,
	IssuedToolServerToken,
	SessionId,
	ToolServer,
	ToolServerTools,
} from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import type { ToolServerRef } from "@kantel/tools/links";
import type { TunnelGrant } from "@kantel/tools/service";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { routeRequest } from "../src/route.ts";
import { createStack, type Stack } from "../src/stack.ts";
import { stackTunnelRpc, type TunnelCallInput, type TunnelObjectRpc, toolServersOn } from "../src/tool-servers.ts";
import {
	type HeldSockets,
	TUNNEL_GRANT_HEADER,
	TUNNEL_STORAGE_KEY,
	TunnelHolder,
	tunnelGrantFrom,
	tunnelGrantHeader,
} from "../src/tunnel.ts";
import type { SyncKvLike } from "../src/workspace-heads.ts";

const BASE = "https://harbour.test";
const ADMIN = "tom@harbour.test";

const rpc = <T>(value: T): T => structuredClone(value);

/** The object's end of a tunnel socket, recording what it sent and how it was closed. */
class FakeSocket {
	readonly sent: string[] = [];
	closedWith: { code: number; reason: string } | undefined;
	onSend: ((text: string) => void) | undefined;
	send(text: string): void {
		if (this.closedWith !== undefined) throw new Error("The socket is closed");
		this.sent.push(text);
		this.onSend?.(text);
	}
	close(code: number, reason: string): void {
		if (this.closedWith !== undefined) throw new Error("The socket is closed");
		this.closedWith = { code, reason };
	}
}

/** `ctx.getWebSockets` and friends: the sockets an object holds, by tag, outliving any one instance of it. */
function heldSockets(): HeldSockets<FakeSocket> & { readonly all: Map<FakeSocket, string[]> } {
	const all = new Map<FakeSocket, string[]>();
	return {
		all,
		accept: (socket, tags) => {
			all.set(socket, tags);
		},
		get: (tag) =>
			[...all]
				.filter(([socket, tags]) => socket.closedWith === undefined && (tag === undefined || tags.includes(tag)))
				.map(([socket]) => socket),
		tags: (socket) => all.get(socket) ?? [],
	};
}

function memoryKv(): SyncKvLike & { readonly map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	return {
		map,
		get: <T>(key: string) => (map.has(key) ? (structuredClone(map.get(key)) as T) : undefined),
		put: (key, value) => {
			map.set(key, structuredClone(value));
		},
		delete: (key) => map.delete(key),
	};
}

/** The server's side of the tunnel: an MCP server with one tool, `echo`, answering over the socket. */
function serveMcp(holder: () => TunnelHolder<FakeSocket>, socket: FakeSocket) {
	const counts = { initialize: 0, call: 0 };
	socket.onSend = (text) => {
		if (text === "pong") return;
		const message = JSON.parse(text) as { id?: number; method?: string; params?: { [key: string]: unknown } };
		if (message.id === undefined) return;
		const answer = (result: unknown) =>
			setTimeout(() => holder().message(socket, JSON.stringify({ jsonrpc: "2.0", id: message.id, result })), 0);
		if (message.method === "initialize") {
			counts.initialize += 1;
			answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo-server" } });
		} else if (message.method === "tools/list") {
			answer({
				tools: [
					{
						name: "echo",
						description: "Answers with what it was given",
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
						annotations: { readOnlyHint: true },
					},
				],
			});
		} else if (message.method === "tools/call") {
			counts.call += 1;
			const got = { arguments: message.params?.arguments, meta: message.params?._meta };
			answer({ content: [{ type: "text", text: JSON.stringify(got) }] });
		}
	};
	return counts;
}

/** One `KantelTunnel` object as the namespace has it: its storage and sockets outlive its holder (hibernation). */
interface TunnelObject {
	readonly kv: ReturnType<typeof memoryKv>;
	readonly sockets: ReturnType<typeof heldSockets>;
	holder: TunnelHolder<FakeSocket>;
	/** The sockets its upgrades opened, oldest first, each with the server the test plays on it. */
	readonly opened: { readonly socket: FakeSocket; readonly counts: ReturnType<typeof serveMcp> }[];
	/** The upgrades the Worker forwarded to it. */
	readonly upgrades: Request[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function setup(options: { toolServers?: boolean } = {}) {
	const on = options.toolServers !== false;
	const scripted = createScriptedModel();
	let stack: Stack | undefined;
	const stackRpc = () => stackTunnelRpc(stack?.toolServers);
	const objects = new Map<string, TunnelObject>();
	const holderFor = (object: Pick<TunnelObject, "kv" | "sockets">) =>
		new TunnelHolder<FakeSocket>({
			sockets: object.sockets,
			kv: object.kv,
			stack: () => ({
				tunnelConnected: (grant, info) => stackRpc().tunnelConnected(rpc(grant), rpc(info)),
				tunnelSnapshotChanged: (ref, snapshot) => stackRpc().tunnelSnapshotChanged(rpc(ref), rpc(snapshot)),
				tunnelDisconnected: (ref, at) => stackRpc().tunnelDisconnected(rpc(ref), at),
			}),
		});
	const objectOf = (serverId: string): TunnelObject => {
		let object = objects.get(serverId);
		if (object === undefined) {
			const kv = memoryKv();
			const sockets = heldSockets();
			object = { kv, sockets, holder: holderFor({ kv, sockets }), opened: [], upgrades: [] };
			objects.set(serverId, object);
		}
		return object;
	};
	/** The object leaves memory: everything but its storage and sockets is gone. */
	const hibernate = (serverId: string) => {
		const object = objectOf(serverId);
		object.holder = holderFor(object);
	};
	const tunnelStub = (serverId: string): TunnelObjectRpc & { fetch(request: Request): Promise<Response> } => {
		const object = objectOf(serverId);
		return {
			fetch: async (request) => {
				object.upgrades.push(request);
				return object.holder.upgrade(request, () => {
					const socket = new FakeSocket();
					object.opened.push({ socket, counts: serveMcp(() => object.holder, socket) });
					// Node can't answer 101; the object's own answer is the socket pair's.
					return { socket, response: new Response(null, { status: 200 }) };
				});
			},
			call: async (ref: ToolServerRef, input: TunnelCallInput) => rpc(await object.holder.call(rpc(ref), rpc(input))),
			close: async (code, reason, tokenId) => object.holder.close(code, reason, tokenId),
		};
	};

	stack = await createStack({
		config: gatewayConfig({ KANTEL_ADMIN_EMAIL: ADMIN }),
		models: () => ({ models: scripted.models }),
		...(on ? { toolServers: { tunnels: tunnelStub } } : {}),
	});
	const built = stack;
	cleanups.push(() => built.close());
	const gateway = createGateway(stack);
	const stackAsked: string[] = [];
	const tunnelsAsked: string[] = [];
	const env = {
		STACK: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: (request: Request) => {
					stackAsked.push(new URL(request.url).pathname);
					return gateway.fetch(request);
				},
				authenticateTunnel: async (serverId: string, secret: string) =>
					rpc(await stackRpc().authenticateTunnel(serverId, secret)),
			}),
		},
		VAULTS: {
			idFromName: (name: string) => name,
			get: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
		},
		ASSETS: { fetch: async () => new Response("console", { status: 200 }) },
		TUNNELS: {
			idFromName: (name: string) => name,
			get: (id: string) => {
				tunnelsAsked.push(id);
				return tunnelStub(id);
			},
		},
		...(on ? { KANTEL_TOOL_SERVERS: "experimental" } : {}),
	};
	const service = await stack.identity.createServiceIdentity(stack.admin, { name: "tool-admin" });
	const key = await stack.identity.issueApiKey(stack.admin, {
		serviceId: service.id,
		projectIds: [stack.project.id],
		role: "admin",
	});
	const api = async (method: string, path: string, body?: unknown) => {
		const response = await routeRequest(
			new Request(`${BASE}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${key.secret}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
			env,
		);
		return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
	};
	const upgrade = (serverId: string, headers: { [name: string]: string }) =>
		routeRequest(
			new Request(`${BASE}/v1/tool-servers/${serverId}/connect`, { headers: { upgrade: "websocket", ...headers } }),
			env,
		);
	const connected = (serverId: string) =>
		vi.waitFor(async () => {
			const got = (await api("GET", `/v1/tool-servers/${serverId}`)).body as ToolServer;
			expect(got.connection).toMatchObject({ status: "connected", serverInfo: { name: "echo-server" } });
		});
	/** Opens a tunnel with `secret` and plays the server on it; resolves once the registry says it is connected. */
	const connect = async (serverId: string, secret: string) => {
		const response = await upgrade(serverId, { authorization: `Bearer ${secret}` });
		expect(response.status).toBe(200);
		const opened = objectOf(serverId).opened.at(-1)!;
		await connected(serverId);
		return opened;
	};
	const run = async (sessionId: SessionId, text: string) => {
		const prompt = await built.runtime.runtime.prompt(built.admin, sessionId, { text });
		return built.runtime.runtime.wait(built.admin, sessionId, prompt.id);
	};
	const profile = async (tools: string[]) => {
		const tooled: AgentProfile = {
			id: "tools",
			organisationId: built.organisation.id,
			projectId: built.project.id,
			name: "Tools",
			model: { route: "default" },
			promptLayers: [],
			tools,
			skills: [],
			sandbox: { tiers: ["isolate"] },
			memoryScopes: [],
		};
		await built.runtime.profiles.put(built.admin, tooled);
	};
	const register = async (name: string) => {
		const created = await api("POST", "/v1/tool-servers", { projectId: built.project.id, name, transport: "tunnel" });
		expect(created.status).toBe(201);
		return created.body as CreatedToolServer;
	};
	return {
		stack: built,
		scripted,
		api,
		upgrade,
		connected,
		connect,
		run,
		profile,
		register,
		objectOf,
		hibernate,
		stackAsked,
		tunnelsAsked,
	};
}

describe("tool servers on Cloudflare", () => {
	it("are on only with KANTEL_TOOL_SERVERS=experimental", () => {
		expect(toolServersOn({})).toBe(false);
		expect(toolServersOn({ KANTEL_TOOL_SERVERS: "" })).toBe(false);
		expect(toolServersOn({ KANTEL_TOOL_SERVERS: "on" })).toBe(false);
		expect(toolServersOn({ KANTEL_TOOL_SERVERS: " Experimental " })).toBe(true);
	});

	it("have no routes and no upgrade when off, and the stack is never asked", async () => {
		const { stack, api, upgrade, stackAsked, tunnelsAsked } = await setup({ toolServers: false });
		expect(stack.toolServers).toBeUndefined();
		expect((await api("GET", "/v1/tool-servers")).status).toBe(404);
		expect((await api("POST", "/v1/tool-servers", { name: "atlas", transport: "tunnel" })).status).toBe(404);
		expect((await upgrade("ts_1", { authorization: "Bearer hbt_any" })).status).toBe(404);
		expect(stackAsked).toEqual([]);
		expect(tunnelsAsked).toEqual([]);
	});

	it("have no routes in a gateway whose stack has none", async () => {
		const { stack } = await setup({ toolServers: false });
		const gateway = createGateway(stack);
		const service = await stack.identity.createServiceIdentity(stack.admin, { name: "host" });
		const key = await stack.identity.issueApiKey(stack.admin, {
			serviceId: service.id,
			projectIds: [stack.project.id],
			role: "admin",
		});
		const response = await gateway.fetch(
			new Request(`${BASE}/v1/tool-servers`, { headers: { authorization: `Bearer ${key.secret}` } }),
		);
		expect(response.status).toBe(404);
	});

	it("serve a session a tunnelled server's tools, through hibernation, until its token is revoked", async () => {
		const { stack, scripted, api, upgrade, connected, connect, run, profile, register, objectOf, hibernate } =
			await setup();
		const { server, token } = await register("atlas");
		expect(server.connection.status).toBe("offline");
		expect((await api("GET", "/v1/tool-servers")).body).toMatchObject({ items: [{ id: server.id, name: "atlas" }] });

		// The upgrade reaches the server's own object with the stack's grant, never the client's token or its own grant.
		const forged = tunnelGrantHeader({ organisationId: "org_other", toolServerId: server.id, tokenId: "tst_forged" });
		const opened = await upgrade(server.id, {
			authorization: `Bearer ${token?.secret}`,
			[TUNNEL_GRANT_HEADER]: forged,
		});
		expect(opened.status).toBe(200);
		const object = objectOf(server.id);
		const forwarded = object.upgrades.at(-1)!;
		expect(tunnelGrantFrom(forwarded)).toEqual({
			organisationId: stack.organisation.id,
			toolServerId: server.id,
			tokenId: token?.token.id,
		});
		expect(forwarded.headers.get("authorization")).toBeNull();
		const { socket: first, counts } = object.opened.at(-1)!;
		await connected(server.id);
		const tools = (await api("GET", `/v1/tool-servers/${server.id}/tools`)).body as ToolServerTools;
		expect(tools.tools.map((tool) => [tool.modelName, tool.replay, tool.enabled])).toEqual([
			["atlas__echo", "safe", true],
		]);

		// A liveness ping that reaches the object is answered (deployed, the runtime answers it without waking the object).
		object.holder.message(first, "ping");
		expect(first.sent.at(-1)).toBe("pong");

		await profile(["atlas/*"]);
		const session = await stack.runtime.runtime.create(stack.admin, { projectId: stack.project.id, agentId: "tools" });
		scripted.script.reply({ toolCalls: [{ name: "atlas__echo", args: { text: "hi" } }] }, { text: "Echoed" });
		expect(await run(session.id, "Echo hi")).toMatchObject({ status: "answered", answer: "Echoed" });
		expect((scripted.script.requests[0]?.tools ?? []).map((tool) => tool.name)).toContain("atlas__echo");
		const echoed = JSON.parse(scripted.script.requests[1]?.messages.at(-1)?.text ?? "{}") as {
			arguments: unknown;
			meta: { [key: string]: string };
		};
		expect(echoed.arguments).toEqual({ text: "hi" });
		expect(echoed.meta).toMatchObject({
			"harbour/sessionId": session.id,
			"harbour/organisationId": stack.organisation.id,
			"harbour/projectId": stack.project.id,
			"harbour/agentId": "tools",
		});

		// The object leaves memory and wakes for the next call: same socket, no second initialize, no reused request ID.
		hibernate(server.id);
		scripted.script.reply({ toolCalls: [{ name: "atlas__echo", args: { text: "again" } }] }, { text: "Again" });
		expect(await run(session.id, "Echo again")).toMatchObject({ status: "answered", answer: "Again" });
		expect(scripted.script.requests.at(-1)?.messages.at(-1)?.text).toContain('"again"');
		expect(counts).toEqual({ initialize: 1, call: 2 });
		const ids = first.sent
			.filter((text) => text.startsWith("{"))
			.map((text) => (JSON.parse(text) as { id?: number }).id)
			.filter((id) => id !== undefined);
		expect(new Set(ids).size).toBe(ids.length);

		// A second token's tunnel takes over: the first closes with 4008, and its close leaves the server connected.
		const second = (await api("POST", `/v1/tool-servers/${server.id}/tokens`)).body as IssuedToolServerToken;
		const { socket: newer } = await connect(server.id, second.secret);
		expect(first.closedWith?.code).toBe(4008);
		object.holder.closed(first, 4008, "");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(((await api("GET", `/v1/tool-servers/${server.id}`)).body as ToolServer).connection.status).toBe(
			"connected",
		);

		// Revoking the first token leaves the newer tunnel; revoking its own closes it with 4003, and the server is offline.
		expect((await api("DELETE", `/v1/tool-servers/${server.id}/tokens/${token?.token.id}`)).status).toBe(204);
		expect(newer.closedWith).toBeUndefined();
		expect((await api("DELETE", `/v1/tool-servers/${server.id}/tokens/${second.token.id}`)).status).toBe(204);
		expect(newer.closedWith?.code).toBe(4003);
		await vi.waitFor(async () => {
			const got = (await api("GET", `/v1/tool-servers/${server.id}`)).body as ToolServer;
			expect(got.connection.status).toBe("offline");
		});
		expect(object.kv.map.has(TUNNEL_STORAGE_KEY)).toBe(false);
	});

	it("show the server offline when its socket closes, and a call answers an error result", async () => {
		const { stack, scripted, api, connect, run, profile, register, objectOf } = await setup();
		const { server, token } = await register("atlas");
		const { socket } = await connect(server.id, token?.secret ?? "");
		await profile(["atlas/echo"]);
		const session = await stack.runtime.runtime.create(stack.admin, { projectId: stack.project.id, agentId: "tools" });

		objectOf(server.id).holder.closed(socket, 1000, "The client stopped");
		await vi.waitFor(async () => {
			const got = (await api("GET", `/v1/tool-servers/${server.id}`)).body as ToolServer;
			expect(got.connection.status).toBe("offline");
		});
		scripted.script.reply({ toolCalls: [{ name: "atlas__echo", args: { text: "anyone?" } }] }, { text: "Offline" });
		expect(await run(session.id, "Echo")).toMatchObject({ status: "answered", answer: "Offline" });
		expect(scripted.script.requests.at(-1)?.messages.at(-1)).toEqual({
			role: "tool",
			text: "Tool server atlas is offline",
		});
	});

	it("refuse a tunnel without a token or with a bad one 401, another server's 403 and an unknown server 404", async () => {
		const { upgrade, register, tunnelsAsked } = await setup();
		const atlas = await register("atlas");
		const other = await register("other");
		const status = async (serverId: string, headers: { [name: string]: string }) =>
			(await upgrade(serverId, headers)).status;
		expect(await status(atlas.server.id, {})).toBe(401);
		expect(await status(atlas.server.id, { authorization: "Bearer hbt_wrong" })).toBe(401);
		expect(await status(atlas.server.id, { authorization: "Bearer not-a-tunnel-token" })).toBe(401);
		expect(await status(atlas.server.id, { authorization: `Bearer ${other.token?.secret}` })).toBe(403);
		expect(await status("ts_unknown", { authorization: `Bearer ${atlas.token?.secret}` })).toBe(404);
		// No object was asked to hold a socket for any of them.
		expect(tunnelsAsked).toEqual([]);
	});

	it("leave the tunnel's path to the API when it isn't an upgrade, which has no route for it", async () => {
		const { api, register } = await setup();
		const { server } = await register("atlas");
		expect((await api("GET", `/v1/tool-servers/${server.id}/connect`)).status).toBe(404);
	});
});

describe("a tunnel object", () => {
	const grant: TunnelGrant = { organisationId: "org_1", toolServerId: "ts_1", tokenId: "tst_1" };
	const ref = { organisationId: "org_1", toolServerId: "ts_1" };
	const reports = () => {
		const seen: string[] = [];
		return {
			seen,
			stack: () => ({
				tunnelConnected: async () => {
					seen.push("connected");
				},
				tunnelSnapshotChanged: async () => {
					seen.push("snapshot");
				},
				tunnelDisconnected: async () => {
					seen.push("disconnected");
				},
			}),
		};
	};

	it("takes only an upgrade the Worker forwarded with a grant", () => {
		const holder = new TunnelHolder<FakeSocket>({ sockets: heldSockets(), kv: memoryKv(), stack: reports().stack });
		const open = () => ({ socket: new FakeSocket(), response: new Response(null, { status: 200 }) });
		const request = (headers: { [name: string]: string }) => new Request(`${BASE}/connect`, { headers });
		expect(holder.upgrade(request({ upgrade: "websocket" }), open).status).toBe(400);
		expect(
			holder.upgrade(request({ upgrade: "websocket", [TUNNEL_GRANT_HEADER]: '{"organisationId":1}' }), open).status,
		).toBe(400);
		expect(holder.upgrade(request({ [TUNNEL_GRANT_HEADER]: tunnelGrantHeader(grant) }), open).status).toBe(426);
	});

	it("answers a call with no socket as offline, and a call for another organisation's server too", async () => {
		const holder = new TunnelHolder<FakeSocket>({ sockets: heldSockets(), kv: memoryKv(), stack: reports().stack });
		expect(await holder.call(ref, { name: "echo" })).toEqual({ offline: true });
		const socket = new FakeSocket();
		serveMcp(() => holder, socket);
		holder.accept(grant, socket);
		await vi.waitFor(() => expect(socket.sent.some((text) => text.includes("tools/list"))).toBe(true));
		expect(await holder.call({ organisationId: "org_2", toolServerId: "ts_1" }, { name: "echo" })).toEqual({
			offline: true,
		});
		expect(await holder.call(ref, { name: "echo", args: { text: "x" } })).toMatchObject({
			result: { output: JSON.stringify({ arguments: { text: "x" } }) },
		});
	});

	it("forgets a socket that went while it was away, and reports the server offline", async () => {
		const sockets = heldSockets();
		const kv = memoryKv();
		const { seen, stack } = reports();
		const holder = new TunnelHolder<FakeSocket>({ sockets, kv, stack });
		const socket = new FakeSocket();
		serveMcp(() => holder, socket);
		holder.accept(grant, socket);
		await vi.waitFor(() => expect(seen).toEqual(["connected"]));
		// A restart drops held sockets without a close event; the next instance finds none for what its storage names.
		sockets.all.clear();
		const woken = new TunnelHolder<FakeSocket>({ sockets, kv, stack });
		expect(await woken.call(ref, { name: "echo" })).toEqual({ offline: true });
		await vi.waitFor(() => expect(seen).toEqual(["connected", "disconnected"]));
		expect(kv.map.has(TUNNEL_STORAGE_KEY)).toBe(false);
	});
});
