// A tool server served in-process (`@kantel/runtime/http`'s tool-server.ts): a host's tools and handler as a minimal
// MCP server, and an MCP server object on a transport over the tunnel's frames. Driven here frame by frame, as the
// tunnel gives them; the self-hosted gateway's SDK test runs them over a real tunnel.
import type { HostToolCall, HostToolDefinition } from "@kantel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
	hostResultToCallResult,
	hostToolServer,
	isMcpServerLike,
	type McpTransport,
	mcpServerEndpoint,
	type ToolServerEndpoint,
} from "../src/http/tool-server.ts";

const echo: HostToolDefinition = {
	name: "echo",
	description: "Answers with what it was given",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
	replay: "safe",
};
const write: HostToolDefinition = {
	name: "write",
	description: "Writes",
	inputSchema: { type: "object" },
	replay: "unsafe",
};

/** The endpoint's answers, parsed, and a way to send it a request. */
function drive(endpoint: ToolServerEndpoint) {
	const out: { [key: string]: unknown }[] = [];
	endpoint.onMessage((message) => out.push(JSON.parse(message) as { [key: string]: unknown }));
	let id = 0;
	const request = (method: string, params?: unknown) => {
		id += 1;
		endpoint.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
		return id;
	};
	const notify = (method: string, params?: unknown) =>
		endpoint.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }));
	const answerTo = (requestId: number) => out.find((message) => message.id === requestId);
	return { out, request, notify, answerTo };
}

describe("hostToolServer", () => {
	it("initialises, lists the tools with readOnlyHint from replay, and answers ping", () => {
		const { request, answerTo } = drive(
			hostToolServer([echo, write], async () => ({ output: "" }), { hostId: "atlas-1" }),
		);
		const init = request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "h" } });
		expect(answerTo(init)).toEqual({
			jsonrpc: "2.0",
			id: init,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "atlas-1" },
			},
		});
		const list = request("tools/list", {});
		expect(answerTo(list)).toMatchObject({
			result: {
				tools: [
					{
						name: "echo",
						description: echo.description,
						inputSchema: echo.inputSchema,
						annotations: { readOnlyHint: true },
					},
					{ name: "write", annotations: { readOnlyHint: false } },
				],
			},
		});
		expect(answerTo(request("ping"))).toMatchObject({ result: {} });
		expect(answerTo(request("resources/list"))).toMatchObject({ error: { code: -32601 } });
	});

	it("gives the handler a HostToolCall from the call's _meta, and answers its result", async () => {
		const calls: HostToolCall[] = [];
		const { request, answerTo } = drive(
			hostToolServer(
				[echo],
				async (call) => {
					calls.push(call);
					return { output: "hi back", structured: { said: "hi" } };
				},
				{ hostId: "atlas-1" },
			),
		);
		const id = request("tools/call", {
			name: "echo",
			arguments: { text: "hi" },
			_meta: {
				"harbour/sessionId": "ses_1",
				"harbour/organisationId": "org_1",
				"harbour/projectId": "prj_1",
				"harbour/agentId": "agent",
				"harbour/callId": "call_1",
			},
		});
		await vi.waitFor(() => expect(answerTo(id)).toBeDefined());
		expect(calls).toEqual([
			{
				hostId: "atlas-1",
				sessionId: "ses_1",
				organisationId: "org_1",
				projectId: "prj_1",
				agentId: "agent",
				callId: "call_1",
				tool: "echo",
				args: { text: "hi" },
			},
		]);
		expect(answerTo(id)).toEqual({
			jsonrpc: "2.0",
			id,
			result: { content: [{ type: "text", text: "hi back" }], structuredContent: { said: "hi" } },
		});
	});

	it("answers an unknown tool and a throwing handler with error results", async () => {
		const { request, answerTo } = drive(
			hostToolServer(
				[echo],
				async () => {
					throw new Error("broken");
				},
				{ hostId: "atlas-1" },
			),
		);
		const unknown = request("tools/call", { name: "nope", arguments: {} });
		const thrown = request("tools/call", { name: "echo", arguments: {} });
		await vi.waitFor(() => expect(answerTo(thrown)).toBeDefined());
		expect(answerTo(unknown)).toMatchObject({
			result: { content: [{ type: "text", text: "No tool nope on this server" }], isError: true },
		});
		expect(answerTo(thrown)).toMatchObject({ result: { content: [{ text: "broken" }], isError: true } });
	});

	it("aborts a call on notifications/cancelled and on close, and doesn't answer it", async () => {
		const signals: AbortSignal[] = [];
		const endpoint = hostToolServer(
			[echo],
			(_call, signal) =>
				new Promise((resolve) => {
					signals.push(signal);
					signal.addEventListener("abort", () => resolve({ output: "stopped" }));
				}),
			{ hostId: "atlas-1" },
		);
		const { request, notify, answerTo } = drive(endpoint);
		const first = request("tools/call", { name: "echo", arguments: {} });
		const second = request("tools/call", { name: "echo", arguments: {} });
		await vi.waitFor(() => expect(signals).toHaveLength(2));
		notify("notifications/cancelled", { requestId: first, reason: "The caller stopped waiting" });
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		await endpoint.close?.();
		expect(signals[1]?.aborted).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(answerTo(first)).toBeUndefined();
		expect(answerTo(second)).toBeUndefined();
	});

	it("maps a host result to a CallToolResult, leaving out a structured value that isn't an object", () => {
		expect(hostResultToCallResult({ output: "x", isError: true, structured: [1] })).toEqual({
			content: [{ type: "text", text: "x" }],
			isError: true,
		});
	});
});

describe("mcpServerEndpoint", () => {
	/** A server as the MCP SDK's is: it sets `onmessage`, then starts the transport, and answers on it. */
	const fakeServer = () => {
		let transport: McpTransport | undefined;
		const closed = vi.fn();
		const server = {
			async connect(given: McpTransport) {
				transport = given;
				await new Promise((resolve) => setTimeout(resolve, 5));
				(given as { onmessage?: (message: unknown) => void }).onmessage = (message) => {
					const request = message as { id?: number; method: string };
					if (request.id !== undefined)
						void given.send({ jsonrpc: "2.0", id: request.id, result: { method: request.method } });
				};
				await given.start();
			},
			async close() {
				closed();
				await transport?.close();
			},
		};
		return { server, closed };
	};

	it("is told apart from a host's tools and handler", () => {
		expect(isMcpServerLike(fakeServer().server)).toBe(true);
		expect(isMcpServerLike({ tools: [], handler: async () => ({ output: "" }) })).toBe(false);
	});

	it("carries frames both ways, keeping those that come before the server listens, and closes the server", async () => {
		const { server, closed } = fakeServer();
		const endpoint = mcpServerEndpoint(server);
		const { request, answerTo } = drive(endpoint);
		const early = request("initialize", {});
		await vi.waitFor(() => expect(answerTo(early)).toMatchObject({ result: { method: "initialize" } }));
		const later = request("tools/list");
		await vi.waitFor(() => expect(answerTo(later)).toMatchObject({ result: { method: "tools/list" } }));
		await endpoint.close?.();
		expect(closed).toHaveBeenCalledTimes(1);
	});
});
