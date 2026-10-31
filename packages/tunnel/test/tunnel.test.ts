import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOL_SERVER_META } from "@kantel/contracts";
import { isRequest, type JsonRpcMessage, type JsonRpcRequest, parseMessage } from "@kantel/tools/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpEndpoint } from "../src/http.ts";
import { stdioEndpoint } from "../src/stdio.ts";
import { openTunnel, type TunnelEndpoint, type TunnelStatus, type TunnelTiming, tunnelUrl } from "../src/tunnel.ts";
import { startHttpMcpServer } from "./fixtures/http-server.ts";
import { type FakeKantelOptions, startKantel } from "./harbour.ts";

const ECHO_SERVER = fileURLToPath(new URL("./fixtures/echo-server.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SERVER_ID = "ts_1";
const TOKEN = "hbt_good";
const FAST: Partial<TunnelTiming> = { pingIntervalMs: 50, backoffInitialMs: 20, backoffMaxMs: 100 };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
	options: {
		harbour?: Partial<FakeKantelOptions>;
		token?: string;
		endpoint?: TunnelEndpoint;
		timing?: Partial<TunnelTiming>;
		headers?: { readonly [name: string]: string };
	} = {},
) {
	const harbour = await startKantel({ serverId: SERVER_ID, token: TOKEN, ...options.harbour });
	cleanups.push(harbour.close);
	const endpoint = options.endpoint ?? stdioEndpoint([process.execPath, ECHO_SERVER]);
	const statuses: TunnelStatus[] = [];
	const tunnel = openTunnel({
		harbour: harbour.origin,
		serverId: SERVER_ID,
		token: options.token ?? TOKEN,
		endpoint,
		onStatus: (status) => statuses.push(status),
		timing: { ...FAST, ...options.timing },
		...(options.headers === undefined ? {} : { headers: options.headers }),
	});
	cleanups.push(tunnel.close);
	return { harbour, tunnel, statuses, endpoint };
}

const META = {
	[TOOL_SERVER_META.sessionId]: "ses_1",
	[TOOL_SERVER_META.organisationId]: "org_1",
	[TOOL_SERVER_META.agentId]: "agt_1",
	[TOOL_SERVER_META.callId]: "call_1",
};

describe("openTunnel with a stdio server", () => {
	it("dials the connect route with the token, and Kantel lists the tools and takes a snapshot", async () => {
		const { harbour, statuses } = await setup();
		const ready = await (await harbour.side(0)).ready;
		expect(ready.serverInfo).toEqual({ name: "echo-server", version: "1.0.0" });
		expect(ready.snapshot.tools.map((tool) => [tool.name, tool.replay])).toEqual([
			["echo", "safe"],
			["change", "unsafe"],
		]);
		expect(ready.snapshot.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(statuses.map((status) => status.state)).toEqual(["connecting", "connected"]);
	});

	it("carries a call there and back, with its _meta reaching the server", async () => {
		const { harbour } = await setup();
		const side = await harbour.side(0);
		await side.ready;
		const result = await side.connection.callTool({ name: "echo", args: { text: "hi" }, meta: META });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.output)).toMatchObject({ arguments: { text: "hi" }, meta: META });
		expect(result.structured).toMatchObject({ meta: META });
	});

	it("gives a new snapshot hash when the server's tools change", async () => {
		const { harbour } = await setup();
		const side = await harbour.side(0);
		const ready = await side.ready;
		expect(await side.connection.callTool({ name: "change" })).toEqual({ output: "changed" });
		await vi.waitFor(() => expect(side.snapshots).toHaveLength(1));
		expect(side.snapshots[0]?.hash).not.toBe(ready.snapshot.hash);
		expect(side.snapshots[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "change", "added2"]);
	});

	it("pings, and Kantel answers pong", async () => {
		const { harbour, tunnel } = await setup({ timing: { pongTimeoutMs: 200 } });
		const side = await harbour.side(0);
		await vi.waitFor(() => expect(side.frames.filter((frame) => frame === "ping").length).toBeGreaterThanOrEqual(6));
		// Past the pong timeout, still on the first socket: the pongs kept it alive.
		expect(harbour.sides).toHaveLength(1);
		expect(tunnel.status).toEqual({ state: "connected" });
	});

	it("takes a socket that gets no pong for dead, and reconnects", async () => {
		const { harbour, statuses } = await setup({ harbour: { answerPings: false }, timing: { pongTimeoutMs: 150 } });
		await (await harbour.side(1)).ready;
		expect(statuses).toContainEqual(
			expect.objectContaining({ state: "reconnecting", reason: expect.stringMatching(/^no pong for /) }),
		);
	});

	it("reconnects after Kantel closes the socket, answering initialize from the child's first answer", async () => {
		const { harbour, statuses } = await setup();
		const first = await harbour.side(0);
		const before = await first.ready;
		first.ws.close(1001, "going away");

		const second = await harbour.side(1);
		const after = await second.ready;
		expect(after.serverInfo).toEqual(before.serverInfo);
		expect(after.snapshot.hash).toBe(before.snapshot.hash);
		expect(statuses).toContainEqual(
			expect.objectContaining({ state: "reconnecting", reason: "closed 1001: going away" }),
		);

		// The child was initialised once: the second initialize and its initialized never reached it.
		const result = await second.connection.callTool({ name: "echo", args: {} });
		expect(JSON.parse(result.output)).toMatchObject({ initializes: 1, initialized: 1 });
	});

	it("stops for good when Kantel closes with 4003, and stops the server", async () => {
		const { harbour, tunnel, endpoint } = await setup();
		const side = await harbour.side(0);
		await side.ready;
		side.ws.close(4003, "The token was revoked");
		await vi.waitFor(() => expect(tunnel.status.state).toBe("stopped"));
		expect(tunnel.status).toEqual({ state: "stopped", reason: "token revoked", fatal: true });
		await (endpoint as ReturnType<typeof stdioEndpoint>).exited;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(harbour.sides).toHaveLength(1);
	});

	it("sends more headers with the upgrade, such as Access's, but never in place of the token", async () => {
		const { harbour, tunnel } = await setup({
			harbour: { requireHeaders: { "cf-access-client-id": "id.access" } },
			headers: { "CF-Access-Client-Id": "id.access", Authorization: "Bearer hbt_wrong" },
		});
		await (await harbour.side(0)).ready;
		expect(tunnel.status.state).toBe("connected");
	});

	it("stops for good when Kantel refuses the token at the upgrade", async () => {
		const { harbour, tunnel } = await setup({ token: "hbt_wrong" });
		await vi.waitFor(() => expect(tunnel.status.state).toBe("stopped"));
		expect(tunnel.status).toEqual({ state: "stopped", reason: "token refused (HTTP 401)", fatal: true });
		expect(harbour.sides).toHaveLength(0);
	});
});

describe("openTunnel with an in-process server", () => {
	/** A server that answers initialize and tools/list at once and holds each tools/call until told to answer. */
	function heldEndpoint() {
		const received: JsonRpcMessage[] = [];
		const calls: JsonRpcRequest[] = [];
		let listener: (message: string) => void = () => {};
		const answer = (id: JsonRpcRequest["id"], result: unknown): void => {
			listener(JSON.stringify({ jsonrpc: "2.0", id, result }));
		};
		const endpoint: TunnelEndpoint = {
			send(text) {
				const message = parseMessage(text)!;
				received.push(message);
				if (!isRequest(message)) return;
				if (message.method === "initialize") answer(message.id, { protocolVersion: "2025-06-18", capabilities: {} });
				else if (message.method === "tools/list") answer(message.id, { tools: [{ name: "slow" }] });
				else calls.push(message);
			},
			onMessage(next) {
				listener = next;
			},
		};
		return { endpoint, received, calls, answer };
	}

	it("cancels what the server hadn't answered when the socket goes, and drops the answer that comes later", async () => {
		const server = heldEndpoint();
		const { harbour } = await setup({ endpoint: server.endpoint });
		const first = await harbour.side(0);
		await first.ready;
		const lost = first.connection.callTool({ name: "slow", args: { n: 1 } }).catch((caught: unknown) => caught);
		await vi.waitFor(() => expect(server.calls).toHaveLength(1));
		first.ws.close(1001, "going away");
		expect(await lost).toBeInstanceOf(Error);
		const oldId = server.calls[0]!.id;
		await vi.waitFor(() =>
			expect(server.received).toContainEqual(
				expect.objectContaining({
					method: "notifications/cancelled",
					params: expect.objectContaining({ requestId: oldId }),
				}),
			),
		);

		// Kantel counts from 1 again on the new socket, so its next call has the ID the lost one had there.
		const second = await harbour.side(1);
		await second.ready;
		const call = second.connection.callTool({ name: "slow", args: { n: 2 } });
		await vi.waitFor(() => expect(server.calls).toHaveLength(2));
		server.answer(oldId, { content: [{ type: "text", text: "late" }] });
		server.answer(server.calls[1]!.id, { content: [{ type: "text", text: "on time" }] });
		expect(await call).toEqual({ output: "on time" });
	});

	it("passes Kantel's cancellation on under the ID the server knows the request by", async () => {
		const server = heldEndpoint();
		const { harbour } = await setup({ endpoint: server.endpoint });
		const side = await harbour.side(0);
		await side.ready;
		const controller = new AbortController();
		const call = side.connection.callTool({ name: "slow", signal: controller.signal }).catch(() => undefined);
		await vi.waitFor(() => expect(server.calls).toHaveLength(1));
		controller.abort();
		await call;
		await vi.waitFor(() =>
			expect(server.received.at(-1)).toEqual({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: server.calls[0]!.id, reason: "The caller stopped waiting" },
			}),
		);
	});
});

describe("httpEndpoint", () => {
	it("bridges a loopback Streamable HTTP server, keeping its session", async () => {
		const server = await startHttpMcpServer();
		cleanups.push(server.close);
		const { harbour } = await setup({ endpoint: httpEndpoint(server.url) });
		const side = await harbour.side(0);
		const ready = await side.ready;
		expect(ready.serverInfo).toEqual({ name: "http-server", version: "1.0.0" });
		expect(ready.snapshot.tools.map((tool) => [tool.name, tool.replay])).toEqual([["echo", "safe"]]);

		const result = await side.connection.callTool({ name: "echo", args: { text: "hi" }, meta: META });
		expect(JSON.parse(result.output)).toEqual({ arguments: { text: "hi" }, meta: META, sessionId: "session-1" });

		await vi.waitFor(() => expect(server.seen.some((request) => request.httpMethod === "GET")).toBe(true));
		const after = server.seen.filter((request) => request.rpcMethod !== "initialize");
		expect(after.every((request) => request.sessionId === "session-1")).toBe(true);
		expect(
			after
				.filter((request) => request.httpMethod === "POST")
				.every((request) => request.protocolVersion === "2025-06-18"),
		).toBe(true);
		expect(server.seen.map((request) => request.rpcMethod ?? request.httpMethod)).toEqual(
			expect.arrayContaining(["initialize", "notifications/initialized", "tools/list", "tools/call", "GET"]),
		);
	});

	it("takes only loopback URLs unless told otherwise", () => {
		expect(() => httpEndpoint("http://example.com/mcp")).toThrow("isn't on loopback");
		expect(() => httpEndpoint("http://10.0.0.1:8123/mcp")).toThrow("isn't on loopback");
		expect(() => httpEndpoint("file:///tmp/mcp")).toThrow("isn't an http(s) URL");
		expect(() => httpEndpoint("http://localhost:8123/mcp")).not.toThrow();
		expect(() => httpEndpoint("http://[::1]:8123/mcp")).not.toThrow();
		expect(() => httpEndpoint("https://mcp.example.com/mcp", { allowRemote: true })).not.toThrow();
	});
});

describe("tunnelUrl", () => {
	it("is wss for an https origin and ws for http", () => {
		expect(tunnelUrl("https://harbour.example.com", "ts_1")).toBe(
			"wss://harbour.example.com/v1/tool-servers/ts_1/connect",
		);
		expect(tunnelUrl("http://127.0.0.1:8080/", "ts_1")).toBe("ws://127.0.0.1:8080/v1/tool-servers/ts_1/connect");
		expect(() => tunnelUrl("ftp://harbour.example.com", "ts_1")).toThrow();
	});
});

describe("harbour-tunnel", () => {
	function run(args: string[], env: NodeJS.ProcessEnv = {}) {
		const child = spawn(process.execPath, [CLI, ...args], {
			env: { ...process.env, KANTEL_URL: "", KANTEL_TUNNEL_TOKEN: "", ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
		return { child, exited, stderr: () => stderr };
	}

	it("says how to use it when something is missing", async () => {
		const cli = run(["--server", "ts_1"]);
		expect(await cli.exited).toBe(2);
		expect(cli.stderr()).toContain("--harbour (or KANTEL_URL) is needed");
		expect(cli.stderr()).toContain("Usage: harbour-tunnel");
	});

	it("serves a stdio server with the token from the environment, and closes cleanly on SIGTERM", async () => {
		const harbour = await startKantel({ serverId: SERVER_ID, token: TOKEN });
		cleanups.push(harbour.close);
		const cli = run(["--server", SERVER_ID, "--", process.execPath, ECHO_SERVER], {
			KANTEL_URL: harbour.origin,
			KANTEL_TUNNEL_TOKEN: TOKEN,
		});
		const ready = await (await harbour.side(0)).ready;
		expect(ready.snapshot.tools.map((tool) => tool.name)).toEqual(["echo", "change"]);
		await vi.waitFor(() => expect(cli.stderr()).toContain(`connected to ${harbour.origin} as ${SERVER_ID}`));
		cli.child.kill("SIGTERM");
		expect(await cli.exited).toBe(0);
	});

	it("exits non-zero when Kantel revokes the token", async () => {
		const harbour = await startKantel({ serverId: SERVER_ID, token: TOKEN });
		cleanups.push(harbour.close);
		const cli = run(["--harbour", harbour.origin, "--server", SERVER_ID, "--", process.execPath, ECHO_SERVER], {
			KANTEL_TUNNEL_TOKEN: TOKEN,
		});
		const side = await harbour.side(0);
		await side.ready;
		side.ws.close(4003, "revoked");
		expect(await cli.exited).toBe(1);
		expect(cli.stderr()).toContain("stopped: token revoked");
	});
});
