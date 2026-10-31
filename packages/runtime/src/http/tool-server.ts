/**
 * A tool server served in-process (docs/site/src/content/docs/api/tool-servers.md): the local side of a Kantel tunnel
 * as a `ToolServerEndpoint`, the shape `@kantel/tunnel`'s `openTunnel()` carries frames to and from. Two kinds:
 *
 * - `hostToolServer(tools, handler)`: a host's tools and its `HostToolHandler`, wrapped as a minimal MCP server that
 *   answers `initialize`, `ping`, `tools/list` and `tools/call`, and stops a call on `notifications/cancelled`.
 * - `mcpServerEndpoint(server)`: an MCP server object with `connect(transport)`, such as the MCP SDK's `Server` or
 *   `McpServer`, given a transport over the tunnel.
 *
 * Like the rest of this directory it imports only `@kantel/contracts`, so a host app can carry a copy. The few
 * protocol constants it needs are those of `@kantel/tools/protocol`, and a test in `@kantel/tunnel` keeps them equal.
 */
import {
	type HostToolCall,
	type HostToolDefinition,
	type HostToolHandler,
	type HostToolResult,
	type JsonValue,
	TOOL_SERVER_META,
} from "@kantel/contracts";

/** The local MCP server's side of a tunnel: `TunnelEndpoint` in `@kantel/tunnel`. */
export interface ToolServerEndpoint {
	/** Gives the server one JSON-RPC message from Kantel. */
	send(message: string): void;
	/** Registers the listener for the server's messages to Kantel. */
	onMessage(listener: (message: string) => void): void;
	/** The tunnel has stopped for good. */
	close?(): void | Promise<void>;
}

/** The MCP revision answered when Kantel asks for none: `MCP_PROTOCOL_VERSION` in `@kantel/tools/protocol`. */
export const IN_PROCESS_MCP_PROTOCOL_VERSION = "2025-06-18";
/** MCP's cancellation notification: `MCP_CANCELLED` in `@kantel/tools/protocol`. */
export const IN_PROCESS_MCP_CANCELLED = "notifications/cancelled";
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

type JsonRpcId = string | number;
type Params = { readonly [key: string]: unknown };

function isObject(value: unknown): value is Params {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** A host tool's result as MCP's `CallToolResult`: its output as one text block, with any object `structured`. */
export function hostResultToCallResult(result: HostToolResult): { [key: string]: JsonValue } {
	return {
		content: [{ type: "text", text: result.output }],
		...(isObject(result.structured) ? { structuredContent: result.structured } : {}),
		...(result.isError === true ? { isError: true } : {}),
	};
}

/** A host tool as `tools/list` lists it: `replay: "safe"` is `readOnlyHint: true`, as Kantel reads it back. */
function listed(tool: HostToolDefinition): { [key: string]: JsonValue } {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: { readOnlyHint: tool.replay === "safe" },
	};
}

export interface HostToolServerOptions {
	/** What a call names as its host, `HostToolCall.hostId`: the host's ID, which is its tool server's name. */
	readonly hostId: string;
	/** What the server says about itself in `initialize`. Default `{ name: hostId }`. */
	readonly serverInfo?: { readonly name: string; readonly version?: string };
}

/**
 * `tools` and `handler` as a minimal MCP server on a tunnel. Each `tools/call` reaches the handler as a
 * `HostToolCall` built from the call's `_meta` (`TOOL_SERVER_META`), with a signal that aborts on
 * `notifications/cancelled` and when the tunnel stops; a cancelled call gets no answer, as MCP says. A tool it doesn't
 * serve, and a handler that throws, answer error results.
 */
export function hostToolServer(
	tools: readonly HostToolDefinition[],
	handler: HostToolHandler,
	options: HostToolServerOptions,
): ToolServerEndpoint {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const serverInfo = options.serverInfo ?? { name: options.hostId };
	let listener: (message: string) => void = () => {};
	/** Calls in flight, by request ID. */
	const running = new Map<JsonRpcId, AbortController>();
	let closed = false;

	const post = (message: unknown): void => {
		if (!closed) listener(JSON.stringify(message));
	};
	const answer = (id: JsonRpcId, result: unknown): void => post({ jsonrpc: "2.0", id, result });
	const fail = (id: JsonRpcId, code: number, message: string): void =>
		post({ jsonrpc: "2.0", id, error: { code, message } });

	const call = async (id: JsonRpcId, params: Params): Promise<void> => {
		const name = params.name;
		if (typeof name !== "string") {
			fail(id, JSONRPC_INVALID_PARAMS, "tools/call needs a tool name");
			return;
		}
		if (!byName.has(name)) {
			answer(id, hostResultToCallResult({ output: `No tool ${name} on this server`, isError: true }));
			return;
		}
		const meta = isObject(params._meta) ? params._meta : {};
		const projectId = text(meta[TOOL_SERVER_META.projectId]);
		const hostCall: HostToolCall = {
			hostId: options.hostId,
			sessionId: text(meta[TOOL_SERVER_META.sessionId]) ?? "",
			organisationId: text(meta[TOOL_SERVER_META.organisationId]) ?? "",
			...(projectId === undefined ? {} : { projectId }),
			agentId: text(meta[TOOL_SERVER_META.agentId]) ?? "",
			callId: text(meta[TOOL_SERVER_META.callId]) ?? String(id),
			tool: name,
			args: (params.arguments ?? {}) as JsonValue,
		};
		const controller = new AbortController();
		running.set(id, controller);
		let result: HostToolResult;
		try {
			result = await handler(hostCall, controller.signal);
		} catch (error) {
			result = { output: error instanceof Error ? error.message : String(error), isError: true };
		}
		// Cancelled, or the tunnel stopped: Kantel has stopped waiting for this answer.
		if (running.get(id) !== controller || controller.signal.aborted) return;
		running.delete(id);
		answer(id, hostResultToCallResult(result));
	};

	const receive = (message: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		if (!isObject(parsed) || typeof parsed.method !== "string") return;
		const params = isObject(parsed.params) ? parsed.params : {};
		if (!("id" in parsed)) {
			if (parsed.method === IN_PROCESS_MCP_CANCELLED && isId(params.requestId)) {
				const controller = running.get(params.requestId);
				running.delete(params.requestId);
				controller?.abort(new Error(text(params.reason) ?? "Kantel cancelled the call"));
			}
			return;
		}
		const id = parsed.id;
		if (!isId(id)) return;
		switch (parsed.method) {
			case "initialize":
				answer(id, {
					protocolVersion: text(params.protocolVersion) ?? IN_PROCESS_MCP_PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo,
				});
				return;
			case "ping":
				answer(id, {});
				return;
			case "tools/list":
				answer(id, { tools: tools.map(listed) });
				return;
			case "tools/call":
				void call(id, params);
				return;
			default:
				fail(id, JSONRPC_METHOD_NOT_FOUND, `This server has no ${parsed.method}`);
		}
	};

	return {
		send: receive,
		onMessage(next) {
			listener = next;
		},
		close() {
			closed = true;
			for (const controller of running.values()) controller.abort(new Error("The tunnel stopped"));
			running.clear();
		},
	};
}

/** The MCP SDK's `Transport`, as much of it as a server uses. */
export interface McpTransport {
	start(): Promise<void>;
	send(message: unknown): Promise<void>;
	close(): Promise<void>;
	onmessage?: (message: never, extra?: never) => void;
	onclose?: () => void;
	onerror?: (error: Error) => void;
}

/** An MCP server object, such as the MCP SDK's `Server` or `McpServer`: it serves on the transport it is given. */
export interface McpServerLike {
	connect(transport: McpTransport): Promise<void>;
	close?(): Promise<void>;
}

/** Whether `value` is an MCP server object rather than a host's tools and handler. */
export function isMcpServerLike(value: unknown): value is McpServerLike {
	return isObject(value) && typeof (value as { connect?: unknown }).connect === "function";
}

/**
 * An MCP server object on a tunnel: it is connected to a transport whose messages are the tunnel's frames. Frames that
 * come before it has started listening wait for it. Closing the tunnel closes the server.
 */
export function mcpServerEndpoint(server: McpServerLike): ToolServerEndpoint {
	let listener: (message: string) => void = () => {};
	let closed = false;
	let started = false;
	const early: unknown[] = [];
	const flush = (): void => {
		started = true;
		for (const message of early.splice(0)) transport.onmessage?.(message as never);
	};
	const transport: McpTransport = {
		// The MCP SDK sets `onmessage` before it starts the transport.
		async start() {
			flush();
		},
		async send(message) {
			if (!closed) listener(JSON.stringify(message));
		},
		async close() {
			closed = true;
			transport.onclose?.();
		},
	};
	const connecting = server.connect(transport).then(
		() => flush(),
		(error: unknown) => {
			transport.onerror?.(error instanceof Error ? error : new Error(String(error)));
		},
	);
	return {
		send(message) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(message);
			} catch {
				return;
			}
			if (started && transport.onmessage !== undefined) transport.onmessage(parsed as never);
			else early.push(parsed);
		},
		onMessage(next) {
			listener = next;
		},
		async close() {
			await connecting;
			if (server.close !== undefined) await server.close();
			else await transport.close();
			closed = true;
		},
	};
}
