// The tunnels held in process (`createTunnelHub`) and the runtime's port over them (`sessionToolServers`): a socket
// accepted with a grant initialises its server and reports it, calls reach the current socket with `_meta`, a newer
// socket takes over with 4008, a revocation closes only its token's socket, and every failure a session can meet is
// an error result.
import { type HostToolCall, type SessionRecord, TOOL_SERVER_META } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { createTunnelHub } from "../src/hub.ts";
import { TUNNEL_CLOSE_REPLACED, TUNNEL_CLOSE_TOKEN_REVOKED } from "../src/protocol.ts";
import { createMemoryToolServerRepository } from "../src/repository.ts";
import { createToolServers, type TunnelGrant } from "../src/service.ts";
import { sessionToolServers } from "../src/session.ts";
import { echoHandler, type FakeHandler } from "./fake-server.ts";
import { fakeSocket, ORG, person, recordingAudit, roleAccess, settle } from "./registry.ts";

const ada = person("ada");

async function setUp() {
	const audit = recordingAudit();
	let hub: ReturnType<typeof createTunnelHub> | undefined;
	const service = createToolServers({
		repository: createMemoryToolServerRepository(),
		access: () => roleAccess({ ada: { "*": "admin" } }),
		audit,
		links: () => hub,
	});
	hub = createTunnelHub({ service });
	const { server, token } = await service.create(ada, { projectId: "proj", name: "sal", transport: "tunnel" });
	const grant = await service.authenticateTunnel(server.id, token?.secret ?? "");
	if (grant === undefined) throw new Error("no grant");
	const open = async (handler?: FakeHandler, using: TunnelGrant = grant) => {
		const socket = fakeSocket(handler);
		socket.attach(hub.accept(using, socket.socket));
		await settle();
		return socket;
	};
	const session = sessionToolServers({ service, links: () => hub });
	return { service, hub, audit, server, grant, open, session };
}

const record: SessionRecord = {
	id: "s1",
	organisationId: ORG,
	projectId: "proj",
	agentId: "worker",
	status: "running",
	labels: {},
	createdBy: { kind: "service", serviceId: "test" },
	createdAt: 1,
	updatedAt: 1,
};

const call = (tool: string, args: HostToolCall["args"] = {}): HostToolCall => ({
	hostId: "tool-server:ts",
	sessionId: record.id,
	organisationId: ORG,
	projectId: "proj",
	agentId: "worker",
	callId: "call-1",
	tool,
	args,
});

describe("tunnels held in process", () => {
	it("initialises an accepted socket's server and keeps it connected with its tools", async () => {
		const { service, server, open, audit } = await setUp();
		await open();
		const connected = await service.get(ada, server.id);
		expect(connected.connection).toMatchObject({ status: "connected", serverInfo: { name: "fake", version: "1" } });
		expect(connected.snapshot?.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(audit.events.map((event) => event.type)).toContain("tool_server.tools.changed");
	});

	it("calls a tool with the session's _meta, and answers the session's errors as error results", async () => {
		const { service, session, open } = await setUp();
		await open();
		const [server] = await session.servers(record, ["sal", "missing"]);
		if (server === undefined) throw new Error("no server");
		expect(server).toMatchObject({ name: "sal", transport: "tunnel", disabledTools: [] });

		const result = await session.call(server, call("echo", { text: "hi" }), new AbortController().signal);
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({
			name: "echo",
			arguments: { text: "hi" },
			_meta: {
				[TOOL_SERVER_META.sessionId]: "s1",
				[TOOL_SERVER_META.organisationId]: ORG,
				[TOOL_SERVER_META.projectId]: "proj",
				[TOOL_SERVER_META.agentId]: "worker",
				[TOOL_SERVER_META.callId]: "call-1",
			},
		});

		await service.update(ada, server.id, { disabledTools: ["echo"] });
		expect(await session.call(server, call("echo"), new AbortController().signal)).toEqual({
			output: "Tool echo of tool server sal is disabled",
			isError: true,
		});

		await service.remove(ada, server.id);
		expect(await session.call(server, call("echo"), new AbortController().signal)).toEqual({
			output: "Tool server sal was removed",
			isError: true,
		});
	});

	it("marks the server offline when its socket closes, and a call then says it is offline", async () => {
		const { service, server, session, open, audit } = await setUp();
		const socket = await open();
		const [sessionServer] = await session.servers(record, ["sal"]);
		if (sessionServer === undefined) throw new Error("no server");
		socket.hangUp(1001, "going away");
		await settle();
		expect((await service.get(ada, server.id)).connection.status).toBe("offline");
		expect(audit.events.at(-1)?.type).toBe("tool_server.disconnected");
		expect(await session.call(sessionServer, call("echo"), new AbortController().signal)).toEqual({
			output: "Tool server sal is offline",
			isError: true,
		});
	});

	it("answers a call cut off by its socket closing as an error result", async () => {
		const { session, open } = await setUp();
		const socket = await open((request) => (request.method === "tools/call" ? "hold" : echoHandler(request)));
		const [server] = await session.servers(record, ["sal"]);
		if (server === undefined) throw new Error("no server");
		const pending = session.call(server, call("echo"), new AbortController().signal);
		await settle();
		socket.hangUp(1006, "");
		expect(await pending).toMatchObject({ isError: true, output: expect.stringContaining("tunnel closed") });
	});

	it("rethrows a call aborted by the session, which has stopped listening", async () => {
		const { session, open } = await setUp();
		await open((request) => (request.method === "tools/call" ? "hold" : echoHandler(request)));
		const [server] = await session.servers(record, ["sal"]);
		if (server === undefined) throw new Error("no server");
		const abort = new AbortController();
		const pending = session.call(server, call("echo"), abort.signal);
		await settle();
		abort.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
	});

	it("lets a newer socket take over with 4008 without marking the server offline", async () => {
		const { service, server, session, open } = await setUp();
		const older = await open();
		const newer = await open();
		expect(older.closes).toEqual([{ code: TUNNEL_CLOSE_REPLACED, reason: expect.any(String) }]);
		expect(newer.closes).toEqual([]);
		expect((await service.get(ada, server.id)).connection.status).toBe("connected");
		const [sessionServer] = await session.servers(record, ["sal"]);
		if (sessionServer === undefined) throw new Error("no server");
		const result = await session.call(sessionServer, call("echo"), new AbortController().signal);
		expect(result.isError).toBeUndefined();
		expect(older.server.requests("tools/call")).toHaveLength(0);
		expect(newer.server.requests("tools/call")).toHaveLength(1);
	});

	it("closes only the revoked token's socket", async () => {
		const { service, server, grant, open } = await setUp();
		const other = await service.createToken(ada, server.id);
		const socket = await open();
		await service.revokeToken(ada, server.id, other.token.id);
		expect(socket.closes).toEqual([]);
		await service.revokeToken(ada, server.id, grant.tokenId);
		expect(socket.closes).toEqual([{ code: TUNNEL_CLOSE_TOKEN_REVOKED, reason: "The tunnel token was revoked" }]);
		await settle();
		expect((await service.get(ada, server.id)).connection.status).toBe("offline");
	});
});
