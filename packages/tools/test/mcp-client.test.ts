import { isKantelError, KantelError, TOOL_SERVER_META } from "@kantel/contracts";
import { describe, expect, it, vi } from "vitest";
import { MCP_TOOLS_PAGES_MAX, type McpClientState, McpTunnelClient } from "../src/mcp-client.ts";
import { echoHandler, type FakeHandler, fakeServer } from "./fake-server.ts";

function connect(handler?: FakeHandler, options: { state?: McpClientState; onToolsChanged?: () => void } = {}) {
	const server = fakeServer(handler);
	const client = new McpTunnelClient({ send: server.send, ...options });
	server.attach((text) => client.receive(text));
	return { server, client };
}

describe("McpTunnelClient", () => {
	it("initialises, then says so, and takes the revision the server answers with", async () => {
		const { server, client } = connect();
		expect(await client.initialize()).toEqual({
			protocolVersion: "2025-03-26",
			serverInfo: { name: "fake", version: "1" },
		});
		expect(server.received[0]).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harbour", version: "0.0.0" } },
		});
		expect(server.received[1]).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
		expect(client.state()).toEqual({
			initialized: true,
			protocolVersion: "2025-03-26",
			serverInfo: { name: "fake", version: "1" },
			nextId: 2,
		});
	});

	it("follows nextCursor through the pages of tools/list", async () => {
		const { server, client } = connect((request) => {
			if (request.method !== "tools/list") return echoHandler(request);
			return request.params?.cursor === "p2"
				? { result: { tools: [{ name: "two" }] } }
				: { result: { tools: [{ name: "one", annotations: { readOnlyHint: true } }], nextCursor: "p2" } };
		});
		const tools = await client.listTools();
		expect(tools.map((tool) => [tool.name, tool.replay])).toEqual([
			["one", "safe"],
			["two", "unsafe"],
		]);
		expect(server.requests("tools/list").map((request) => request.params)).toEqual([{}, { cursor: "p2" }]);
	});

	it("stops after the page limit when the server keeps giving cursors", async () => {
		let page = 0;
		const { server, client } = connect(() => {
			page += 1;
			return { result: { tools: [{ name: `t${page}` }], nextCursor: `p${page}` } };
		});
		expect(await client.listTools()).toHaveLength(MCP_TOOLS_PAGES_MAX);
		expect(server.requests("tools/list")).toHaveLength(MCP_TOOLS_PAGES_MAX);
	});

	it("calls a tool with the call's metadata under _meta", async () => {
		const { server, client } = connect();
		const meta = { [TOOL_SERVER_META.sessionId]: "ses_1", [TOOL_SERVER_META.callId]: "call_1" };
		const result = await client.callTool({ name: "echo", args: { text: "hi" }, meta });
		const params = { name: "echo", arguments: { text: "hi" }, _meta: meta };
		expect(server.requests("tools/call")[0]?.params).toEqual(params);
		expect(result).toEqual({ output: JSON.stringify(params) });
	});

	it("answers a server's ping and refuses its other requests", () => {
		const { server } = connect();
		server.push({ jsonrpc: "2.0", id: "s1", method: "ping" });
		server.push({ jsonrpc: "2.0", id: "s2", method: "sampling/createMessage", params: {} });
		server.push({ jsonrpc: "2.0", id: 7, method: "roots/list" });
		expect(server.received).toEqual([
			{ jsonrpc: "2.0", id: "s1", result: {} },
			{ jsonrpc: "2.0", id: "s2", error: { code: -32601, message: "Kantel doesn't offer sampling/createMessage" } },
			{ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Kantel doesn't offer roots/list" } },
		]);
	});

	it("says when the tools changed, and ignores other notifications and answers it isn't waiting for", () => {
		const onToolsChanged = vi.fn();
		const { server, client } = connect(undefined, { onToolsChanged });
		server.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		server.push({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } });
		server.push({ jsonrpc: "2.0", id: 99, result: {} });
		server.push({ jsonrpc: "2.0", id: "x", error: { code: 1, message: "late" } });
		expect(onToolsChanged).toHaveBeenCalledTimes(1);
		expect(server.received).toEqual([]);
		expect(client.receive("not json")).toBe(false);
	});

	it("makes an error answer an error result", async () => {
		const { client } = connect(() => ({ error: { code: -32602, message: "Unknown tool: nope" } }));
		expect(await client.callTool({ name: "nope" })).toEqual({ output: "Unknown tool: nope", isError: true });
	});

	it("refuses with the server's message when initialize or tools/list is refused", async () => {
		const { client } = connect(() => ({ error: { code: -32603, message: "broken" } }));
		await expect(client.initialize()).rejects.toThrow("The tool server refused initialize: broken");
		await expect(client.listTools()).rejects.toThrow("The tool server refused tools/list: broken");
	});

	it("sends notifications/cancelled and rejects with aborted when a call is aborted", async () => {
		const { server, client } = connect(() => "hold");
		const controller = new AbortController();
		const call = client.callTool({ name: "slow", signal: controller.signal });
		controller.abort();
		const error = await call.catch((caught: unknown) => caught);
		expect(isKantelError(error, "aborted")).toBe(true);
		expect(server.received.at(-1)).toEqual({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 1, reason: "The caller stopped waiting" },
		});
		// The answer that comes anyway is dropped.
		server.push({ jsonrpc: "2.0", id: 1, result: { content: [] } });
	});

	it("rejects at once, sending nothing, when the signal has already been aborted", async () => {
		const { server, client } = connect();
		await expect(client.callTool({ name: "echo", signal: AbortSignal.abort() })).rejects.toThrow(KantelError);
		expect(server.received).toEqual([]);
	});

	it("answers an error result and cancels when a call runs out of time", async () => {
		vi.useFakeTimers();
		try {
			const { server, client } = connect(() => "hold");
			const call = client.callTool({ name: "slow" });
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(await call).toEqual({ output: "The tool server didn't answer slow within 10 minutes.", isError: true });
			expect(server.received.at(-1)).toEqual({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: 1, reason: "No answer within 10 minutes" },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes its own timeout for a call", async () => {
		const { client } = connect(() => "hold");
		expect(await client.callTool({ name: "slow", timeoutMs: 5 })).toEqual({
			output: "The tool server didn't answer slow within 1 second.",
			isError: true,
		});
	});

	it("never cancels initialize", async () => {
		const { server, client } = connect(() => "hold");
		const controller = new AbortController();
		const initializing = client.initialize(controller.signal);
		controller.abort();
		await expect(initializing).rejects.toThrow("initialize was aborted");
		expect(server.methods()).toEqual(["initialize"]);
	});

	it("rejects every waiting request with unavailable on close, and every later one", async () => {
		const { client } = connect(() => "hold");
		const first = client.callTool({ name: "a" }).catch((caught: unknown) => caught);
		const second = client.listTools().catch((caught: unknown) => caught);
		client.close("The tunnel closed");
		for (const error of await Promise.all([first, second])) {
			expect(isKantelError(error, "unavailable")).toBe(true);
			expect((error as Error).message).toBe("The tunnel closed");
		}
		await expect(client.callTool({ name: "b" })).rejects.toThrow("The tunnel closed");
	});

	it("is unavailable when the link can't send", async () => {
		const client = new McpTunnelClient({
			send: () => {
				throw new Error("socket closed");
			},
		});
		const error = await client.callTool({ name: "a" }).catch((caught: unknown) => caught);
		expect(isKantelError(error, "unavailable")).toBe(true);
	});

	it("carries on from state() without initialising again", async () => {
		const first = connect();
		await first.client.initialize();
		await first.client.listTools();
		const state = JSON.parse(JSON.stringify(first.client.state())) as McpClientState;
		expect(state).toEqual({
			initialized: true,
			protocolVersion: "2025-03-26",
			serverInfo: { name: "fake", version: "1" },
			nextId: 3,
		});

		const rebuilt = connect(undefined, { state });
		expect(rebuilt.client.state()).toEqual(state);
		await rebuilt.client.callTool({ name: "echo" });
		expect(rebuilt.server.methods()).toEqual(["tools/call"]);
		expect(rebuilt.server.received[0]).toMatchObject({ id: 3 });
		expect(rebuilt.client.state().nextId).toBe(4);
	});
});
