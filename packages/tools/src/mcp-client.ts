/**
 * Kantel's MCP client over one message link, a tunnel's socket: `send` puts a JSON-RPC message on it, `receive` takes
 * each frame that comes back. Nothing here knows about sockets or timers beyond `setTimeout`, so it runs in a Durable
 * Object, which can keep `state()` in the socket's attachment and rebuild the client after hibernation without
 * initialising again, and on the self-hosted gateway alike.
 *
 * Kantel offers the server nothing back: a server's `ping` is answered, and any other request it makes (sampling,
 * elicitation, `roots/list`) is refused as a method not found.
 *
 * A call that is aborted rejects with `aborted`, because whoever aborted it has stopped listening. A call that runs
 * out of time answers an error result saying so, because that is something the model should read. Both send
 * `notifications/cancelled`, so the server can stop the work.
 */
import {
	type HostToolResult,
	type JsonValue,
	KantelError,
	TOOL_SERVER_CALL_TIMEOUT_MS,
	type ToolServerTool,
} from "@kantel/contracts";
import {
	isNotification,
	isRequest,
	JSONRPC_METHOD_NOT_FOUND,
	type JsonRpcErrorObject,
	type JsonRpcParams,
	MCP_CANCELLED,
	MCP_PROTOCOL_VERSION,
	MCP_TOOLS_CHANGED,
	parseMessage,
} from "./protocol.ts";
import { callResultToHostResult } from "./result.ts";
import { toolsFromList } from "./snapshot.ts";

/** What the server said about itself in `initialize`. */
export interface McpServerInfo {
	readonly name: string;
	readonly version?: string;
}

/** Everything the client needs to carry on over the same link after it is rebuilt; JSON. */
export interface McpClientState {
	readonly initialized: boolean;
	/** The revision the server answered `initialize` with. */
	readonly protocolVersion?: string;
	readonly serverInfo?: McpServerInfo;
	/** The ID the next request gets, so a rebuilt client never reuses one. */
	readonly nextId: number;
}

export interface McpTunnelClientOptions {
	/** Puts one message on the link. May throw when the link has gone. */
	send(text: string): void;
	/** The server said its tools changed (`notifications/tools/list_changed`). */
	onToolsChanged?(): void;
	/** From an earlier client's `state()`, to carry on where it left off. */
	state?: McpClientState;
}

export interface McpInitializeResult {
	readonly protocolVersion?: string;
	readonly serverInfo?: McpServerInfo;
}

export interface McpCallToolInput {
	/** The server's own name for the tool. */
	readonly name: string;
	readonly args?: JsonValue;
	/** Sent as `params._meta`: the `TOOL_SERVER_META` keys. */
	readonly meta?: { readonly [key: string]: JsonValue };
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

/** How long `initialize` and each page of `tools/list` may take: a server that is up answers them at once. */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;
/** The most `tools/list` pages read, so a server can't keep Kantel listing for ever. */
export const MCP_TOOLS_PAGES_MAX = 20;

const CLIENT_INFO = { name: "harbour", version: "0.0.0" } as const;

type Outcome =
	| { readonly kind: "result"; readonly result: unknown }
	| { readonly kind: "error"; readonly error: JsonRpcErrorObject }
	| { readonly kind: "timeout"; readonly after: string };

interface Pending {
	settle(outcome: Outcome): void;
	fail(error: KantelError): void;
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `10 minutes`, `60 seconds`. */
function durationText(ms: number): string {
	if (ms >= 60_000 && ms % 60_000 === 0) return ms === 60_000 ? "1 minute" : `${ms / 60_000} minutes`;
	const seconds = Math.max(1, Math.round(ms / 1000));
	return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

function serverInfoOf(value: unknown): McpServerInfo | undefined {
	if (!isObject(value) || typeof value.name !== "string") return undefined;
	return typeof value.version === "string" ? { name: value.name, version: value.version } : { name: value.name };
}

export class McpTunnelClient {
	readonly #send: (text: string) => void;
	readonly #onToolsChanged: (() => void) | undefined;
	readonly #pending = new Map<number, Pending>();
	#initialized: boolean;
	#protocolVersion: string | undefined;
	#serverInfo: McpServerInfo | undefined;
	#nextId: number;
	#closed: string | undefined;

	constructor(options: McpTunnelClientOptions) {
		this.#send = options.send;
		this.#onToolsChanged = options.onToolsChanged;
		this.#initialized = options.state?.initialized ?? false;
		this.#protocolVersion = options.state?.protocolVersion;
		this.#serverInfo = options.state?.serverInfo;
		this.#nextId = options.state?.nextId ?? 1;
	}

	/** Feeds one incoming frame. False when it isn't a JSON-RPC message, which the caller treats as a broken link. */
	receive(text: string): boolean {
		const message = parseMessage(text);
		if (message === undefined) return false;
		if (isRequest(message)) {
			if (message.method === "ping") this.#postQuietly({ jsonrpc: "2.0", id: message.id, result: {} });
			else {
				this.#postQuietly({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Kantel doesn't offer ${message.method}` },
				});
			}
		} else if (isNotification(message)) {
			if (message.method === MCP_TOOLS_CHANGED) this.#onToolsChanged?.();
		} else if (typeof message.id === "number") {
			// An answer to a request already given up on (cancelled, timed out) has no entry, and is dropped.
			const pending = this.#pending.get(message.id);
			if (message.error !== undefined) pending?.settle({ kind: "error", error: message.error });
			else pending?.settle({ kind: "result", result: message.result });
		}
		return true;
	}

	/** Initialises the session: `initialize`, then `notifications/initialized`. Any revision the server picks is taken. */
	async initialize(signal?: AbortSignal): Promise<McpInitializeResult> {
		const outcome = await this.#request(
			"initialize",
			{ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
			signal,
			MCP_REQUEST_TIMEOUT_MS,
		);
		const result = this.#expect("initialize", outcome);
		if (!isObject(result)) throw new KantelError("unavailable", "The tool server's initialize answer is malformed");
		this.#protocolVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : undefined;
		this.#serverInfo = serverInfoOf(result.serverInfo);
		this.#notify("notifications/initialized");
		this.#initialized = true;
		return {
			...(this.#protocolVersion === undefined ? {} : { protocolVersion: this.#protocolVersion }),
			...(this.#serverInfo === undefined ? {} : { serverInfo: this.#serverInfo }),
		};
	}

	/** Every tool the server lists, following `nextCursor` for at most `MCP_TOOLS_PAGES_MAX` pages. */
	async listTools(signal?: AbortSignal): Promise<ToolServerTool[]> {
		const raw: unknown[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MCP_TOOLS_PAGES_MAX; page += 1) {
			const outcome = await this.#request(
				"tools/list",
				cursor === undefined ? {} : { cursor },
				signal,
				MCP_REQUEST_TIMEOUT_MS,
			);
			const result = this.#expect("tools/list", outcome);
			if (!isObject(result)) break;
			if (Array.isArray(result.tools)) raw.push(...result.tools);
			cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
			if (cursor === undefined) break;
		}
		return toolsFromList(raw);
	}

	/**
	 * Calls one tool, with `meta` under `params._meta`. A JSON-RPC error answer, a malformed result and running out of
	 * time are error results; an abort rejects with `aborted`, and a closed link with `unavailable`.
	 */
	async callTool(input: McpCallToolInput): Promise<HostToolResult> {
		const params: { [key: string]: unknown } = { name: input.name, arguments: input.args ?? {} };
		if (input.meta !== undefined) params._meta = input.meta;
		const outcome = await this.#request(
			"tools/call",
			params,
			input.signal,
			input.timeoutMs ?? TOOL_SERVER_CALL_TIMEOUT_MS,
		);
		if (outcome.kind === "error") return { output: outcome.error.message, isError: true };
		if (outcome.kind === "timeout") {
			return { output: `The tool server didn't answer ${input.name} within ${outcome.after}.`, isError: true };
		}
		return callResultToHostResult(outcome.result);
	}

	/** Rejects every request still waiting with `unavailable` and `reason`, and every later one too. */
	close(reason: string): void {
		if (this.#closed !== undefined) return;
		this.#closed = reason;
		for (const pending of [...this.#pending.values()]) pending.fail(new KantelError("unavailable", reason));
	}

	state(): McpClientState {
		return {
			initialized: this.#initialized,
			...(this.#protocolVersion === undefined ? {} : { protocolVersion: this.#protocolVersion }),
			...(this.#serverInfo === undefined ? {} : { serverInfo: this.#serverInfo }),
			nextId: this.#nextId,
		};
	}

	#expect(method: string, outcome: Outcome): unknown {
		if (outcome.kind === "result") return outcome.result;
		if (outcome.kind === "error") {
			throw new KantelError("refused", `The tool server refused ${method}: ${outcome.error.message}`);
		}
		throw new KantelError("unavailable", `The tool server didn't answer ${method} within ${outcome.after}`);
	}

	#post(message: unknown): void {
		this.#send(JSON.stringify(message));
	}

	/** Sends a message nobody waits on here (a notification, an answer), or nothing when the link has gone. */
	#postQuietly(message: unknown): void {
		try {
			this.#post(message);
		} catch {
			// The link's close will say so.
		}
	}

	#notify(method: string, params?: JsonRpcParams): void {
		this.#postQuietly(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
	}

	#request(
		method: string,
		params: JsonRpcParams,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<Outcome> {
		if (this.#closed !== undefined) return Promise.reject(new KantelError("unavailable", this.#closed));
		if (signal?.aborted) return Promise.reject(new KantelError("aborted", `${method} was aborted`));
		const id = this.#nextId;
		this.#nextId += 1;
		return new Promise<Outcome>((resolve, reject) => {
			const done = (): void => {
				this.#pending.delete(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			// MCP says `initialize` is never cancelled.
			const cancel = (reason: string): void => {
				if (method !== "initialize") this.#notify(MCP_CANCELLED, { requestId: id, reason });
			};
			const onAbort = (): void => {
				done();
				cancel("The caller stopped waiting");
				reject(new KantelError("aborted", `${method} was aborted`));
			};
			const timer = setTimeout(() => {
				done();
				const after = durationText(timeoutMs);
				cancel(`No answer within ${after}`);
				resolve({ kind: "timeout", after });
			}, timeoutMs);
			this.#pending.set(id, {
				settle: (outcome) => {
					done();
					resolve(outcome);
				},
				fail: (error) => {
					done();
					reject(error);
				},
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				this.#post({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				done();
				reject(
					new KantelError(
						"unavailable",
						`Couldn't send ${method}: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
		});
	}
}
