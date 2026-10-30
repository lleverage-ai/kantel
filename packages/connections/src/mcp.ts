/**
 * A small MCP client over Streamable HTTP (#338): `initialize`, then `tools/list` or `tools/call`, through a `post`
 * the connections service supplies, which adds the connection's credential on the way out. A server may answer a
 * request with JSON or with a `text/event-stream` carrying the answer; both are read. Each call opens its own MCP
 * session, so nothing is held between tool calls.
 */
import { HarbourError } from "@harbour/contracts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpPostAnswer {
	readonly status: number;
	readonly headers: { readonly [name: string]: string };
	readonly body: string;
}

/** Sends one POST to the MCP endpoint with `headers` and `body`. */
export type McpPost = (body: string, headers: { readonly [name: string]: string }) => Promise<McpPostAnswer>;

export interface McpTool {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
	readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
}

export interface McpToolResult {
	readonly content: readonly unknown[];
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
}

/** An MCP server refused or failed: the status, and whether a sign-in is what it wants. */
export class McpError extends HarbourError {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(status === 401 || status === 403 ? "refused" : "unavailable", message);
	}
}

/** The JSON-RPC message answering `id` in a body that is JSON or an event stream. */
export function readRpcAnswer(answer: McpPostAnswer, id: number): Record<string, unknown> | undefined {
	const type = Object.entries(answer.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
	const messages: unknown[] = [];
	if (type.includes("text/event-stream")) {
		for (const event of answer.body.split(/\r?\n\r?\n/)) {
			const data = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n");
			if (data.length === 0) continue;
			try {
				messages.push(JSON.parse(data));
			} catch {
				// Not JSON: skip it.
			}
		}
	} else if (answer.body.trim().length > 0) {
		try {
			messages.push(JSON.parse(answer.body));
		} catch {
			return undefined;
		}
	}
	for (const message of messages.flat()) {
		if (typeof message === "object" && message !== null && (message as { id?: unknown }).id === id) {
			return message as Record<string, unknown>;
		}
	}
	return undefined;
}

function header(answer: McpPostAnswer, name: string): string | undefined {
	return Object.entries(answer.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** Opens an MCP session and runs `work` in it. */
async function inSession<T>(
	post: McpPost,
	work: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
	let sessionId: string | undefined;
	let next = 1;
	const headers = (): Record<string, string> => ({
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"mcp-protocol-version": MCP_PROTOCOL_VERSION,
		...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
	});
	const call = async (method: string, params: unknown): Promise<unknown> => {
		const id = next;
		next += 1;
		const answer = await post(JSON.stringify({ jsonrpc: "2.0", id, method, params }), headers());
		if (answer.status < 200 || answer.status >= 300) {
			throw new McpError(`The MCP server answered ${method} with ${answer.status}`, answer.status);
		}
		if (method === "initialize") sessionId = header(answer, "mcp-session-id") ?? sessionId;
		const message = readRpcAnswer(answer, id);
		if (message === undefined) throw new McpError(`The MCP server sent no answer to ${method}`, 502);
		if (typeof message.error === "object" && message.error !== null) {
			const error = message.error as { message?: unknown; code?: unknown };
			throw new HarbourError(
				"refused",
				`The MCP server refused ${method}: ${String(error.message ?? error.code ?? "error").slice(0, 300)}`,
			);
		}
		return message.result;
	};
	await call("initialize", {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "Harbour", version: "1" },
	});
	const initialized = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), headers());
	if (initialized.status >= 400 && initialized.status !== 404 && initialized.status !== 405) {
		throw new McpError(
			`The MCP server refused notifications/initialized with ${initialized.status}`,
			initialized.status,
		);
	}
	return work(call);
}

/** Every tool the server offers, following `nextCursor` up to 20 pages. */
export async function listMcpTools(post: McpPost): Promise<McpTool[]> {
	return inSession(post, async (call) => {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20; page += 1) {
			const result = (await call("tools/list", cursor === undefined ? {} : { cursor })) as {
				tools?: unknown;
				nextCursor?: unknown;
			};
			if (Array.isArray(result?.tools)) {
				for (const tool of result.tools) {
					if (typeof tool === "object" && tool !== null && typeof (tool as McpTool).name === "string") {
						tools.push(tool as McpTool);
					}
				}
			}
			cursor = typeof result?.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
			if (cursor === undefined) break;
		}
		return tools;
	});
}

/** Calls one tool. */
export async function callMcpTool(post: McpPost, name: string, args: unknown): Promise<McpToolResult> {
	return inSession(post, async (call) => {
		const result = (await call("tools/call", { name, arguments: args ?? {} })) as Record<string, unknown> | undefined;
		return {
			content: Array.isArray(result?.content) ? result.content : [],
			...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
			...(result?.isError === true ? { isError: true } : {}),
		};
	});
}
