/**
 * The Kantel tunnel protocol (docs/design/private-mcp-tools.md, section 2B): how a tool server's side reaches Kantel
 * over one outbound WebSocket and carries MCP on it. MCP lets a transport be custom if it keeps JSON-RPC's message
 * format, its message patterns and the per-request metadata, and asks for the framing to be written down; this is it.
 *
 * - **Dialling.** The client (`@kantel/tunnel`, or the SDK in-process) opens
 *   `wss://<harbour>/v1/tool-servers/{id}/connect` with `Authorization: Bearer hbt_…`, a tunnel token of that server.
 *   Kantel checks the token before the upgrade, and refuses it with HTTP 401, 403 or 404 (a bad token, one of another
 *   server, an unknown server). Kantel needs no secret in the other direction: TLS authenticated it when the client
 *   dialled.
 * - **Roles.** Kantel is the MCP client and the tunnel's side the MCP server, whichever end dialled. Kantel sends
 *   `initialize` once the socket is open, then `notifications/initialized`, `tools/list` and `tools/call`.
 * - **Framing.** One JSON-RPC 2.0 message per WebSocket text frame, UTF-8, with no batches. A binary frame closes the
 *   socket with 1003 (`TUNNEL_CLOSE_UNSUPPORTED_DATA`), a frame larger than `TUNNEL_MAX_MESSAGE_BYTES` (4 MiB) with
 *   1009 (`TUNNEL_CLOSE_TOO_BIG`), and a text frame that isn't a JSON-RPC message with 1008.
 * - **Liveness.** The literal text frame `ping`, answered with the literal `pong`, outside JSON-RPC, so a hibernating
 *   Durable Object answers it with an auto-response without waking. The client pings every 25 s and, when no pong has
 *   come for 60 s, takes the socket for dead and reconnects. MCP's own `ping` request still works inside JSON-RPC.
 * - **Cancellation.** MCP's `notifications/cancelled` with `{ requestId, reason }`, sent by Kantel when a request is
 *   aborted or times out. The server should stop the work; an answer that comes anyway is ignored. `initialize` is
 *   never cancelled, as MCP says.
 * - **Metadata.** Each `tools/call` carries the call's session, organisation, project, agent and call ID under
 *   `params._meta`, keyed as `TOOL_SERVER_META` in `@kantel/contracts` says.
 * - **Closing.** Close codes are the constants below. After 4003 or 4004, or a 401, 403 or 404 at the upgrade, the
 *   client stops for good; after any other close it reconnects with backoff, and Kantel initialises the new socket
 *   afresh.
 */

/** The tunnel's path on Kantel's origin, for a server's ID. */
export function tunnelPath(serverId: string): string {
	return `/v1/tool-servers/${encodeURIComponent(serverId)}/connect`;
}

/** The largest frame either side may send, in UTF-8 bytes. */
export const TUNNEL_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** The liveness frame the client sends, outside JSON-RPC. */
export const TUNNEL_PING = "ping";
/** Kantel's answer to `TUNNEL_PING`. */
export const TUNNEL_PONG = "pong";
/** How often the client pings. */
export const TUNNEL_PING_INTERVAL_MS = 25_000;
/** How long the client waits for a pong before it takes the socket for dead. */
export const TUNNEL_PONG_TIMEOUT_MS = 60_000;

/** Closed on purpose, by either side. */
export const TUNNEL_CLOSE_NORMAL = 1000;
/** The closing side is going away (shutting down, or moving the socket); the client reconnects. */
export const TUNNEL_CLOSE_GOING_AWAY = 1001;
/** A binary frame came. */
export const TUNNEL_CLOSE_UNSUPPORTED_DATA = 1003;
/** A frame that isn't a JSON-RPC message came, or the server's side gave no usable `initialize` or `tools/list`. */
export const TUNNEL_CLOSE_BAD_MESSAGE = 1008;
/** A frame larger than `TUNNEL_MAX_MESSAGE_BYTES` came. */
export const TUNNEL_CLOSE_TOO_BIG = 1009;
/** The token the socket opened with was revoked. The client stops. */
export const TUNNEL_CLOSE_TOKEN_REVOKED = 4003;
/** The tool server was removed. The client stops. */
export const TUNNEL_CLOSE_SERVER_REMOVED = 4004;
/** A newer connection for the same server took over from this one. */
export const TUNNEL_CLOSE_REPLACED = 4008;

/** Whether `text` is larger than `TUNNEL_MAX_MESSAGE_BYTES` in UTF-8, without encoding it when the length settles it. */
export function exceedsMessageLimit(text: string): boolean {
	// A UTF-16 code unit is one to three UTF-8 bytes (a surrogate pair, two units, is four).
	if (text.length > TUNNEL_MAX_MESSAGE_BYTES) return true;
	if (text.length * 3 <= TUNNEL_MAX_MESSAGE_BYTES) return false;
	return new TextEncoder().encode(text).byteLength > TUNNEL_MAX_MESSAGE_BYTES;
}

// JSON-RPC 2.0.

/** The MCP revision Kantel asks for in `initialize`. It accepts whichever the server answers with. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type JsonRpcId = string | number;

/** What MCP puts in `params`: always an object. */
export type JsonRpcParams = { readonly [key: string]: unknown };

export interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly method: string;
	readonly params?: JsonRpcParams;
}

export interface JsonRpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: JsonRpcParams;
}

export interface JsonRpcErrorObject {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export type JsonRpcResponse =
	| { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly result: unknown; readonly error?: undefined }
	/** `id` is null when the request it answers couldn't be read. */
	| { readonly jsonrpc: "2.0"; readonly id: JsonRpcId | null; readonly error: JsonRpcErrorObject };

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** JSON-RPC's code for a method the receiver doesn't offer. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;
/** JSON-RPC's code for a failure inside the receiver. */
export const JSONRPC_INTERNAL_ERROR = -32603;

/** MCP's cancellation notification. */
export const MCP_CANCELLED = "notifications/cancelled";
/** The server's word that its tools changed. */
export const MCP_TOOLS_CHANGED = "notifications/tools/list_changed";

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** The JSON-RPC message in one frame, or undefined when it isn't one (bad JSON, a batch, a malformed message). */
export function parseMessage(text: string): JsonRpcMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObject(value) || value.jsonrpc !== "2.0") return undefined;
	if (value.params !== undefined && !isObject(value.params)) return undefined;
	if (typeof value.method === "string") {
		if (!("id" in value)) return value as unknown as JsonRpcNotification;
		return isId(value.id) ? (value as unknown as JsonRpcRequest) : undefined;
	}
	if ("method" in value) return undefined;
	const hasResult = "result" in value;
	const hasError = "error" in value;
	if (hasResult === hasError) return undefined;
	if (hasResult) return isId(value.id) ? (value as unknown as JsonRpcResponse) : undefined;
	const error = value.error;
	if (!isObject(error) || typeof error.code !== "number" || typeof error.message !== "string") return undefined;
	return isId(value.id) || value.id === null ? (value as unknown as JsonRpcResponse) : undefined;
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
	return "method" in message && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
	return "method" in message && !("id" in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
	return !("method" in message);
}
