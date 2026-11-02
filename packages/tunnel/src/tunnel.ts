/**
 * The tunnel's client side: dials Kantel, and carries frames between Kantel's socket and a local MCP server, the
 * `TunnelEndpoint`. The protocol is written down in `@kantel/tools/protocol`; this end pings, notices a dead socket,
 * and reconnects with backoff until Kantel says to stop.
 *
 * It reads just enough of each message to keep reconnects clean. Kantel's requests reach the server under IDs the
 * tunnel gives them, never reused, and their answers go back under Kantel's own. When a socket goes, what the server
 * hasn't answered is cancelled, and an answer that comes later is dropped: it can't meet a request of the same ID on
 * the next socket, where Kantel counts from 1 again.
 */
import {
	exceedsMessageLimit,
	isNotification,
	isRequest,
	isResponse,
	JSONRPC_INTERNAL_ERROR,
	type JsonRpcId,
	MCP_CANCELLED,
	parseMessage,
	TUNNEL_CLOSE_NORMAL,
	TUNNEL_CLOSE_SERVER_REMOVED,
	TUNNEL_CLOSE_TOKEN_REVOKED,
	TUNNEL_MAX_MESSAGE_BYTES,
	TUNNEL_PING,
	TUNNEL_PING_INTERVAL_MS,
	TUNNEL_PONG,
	TUNNEL_PONG_TIMEOUT_MS,
	tunnelPath,
} from "@kantel/tools/protocol";
import WebSocket from "ws";

/** The local MCP server's side of the tunnel: a stdio child, a loopback HTTP server, or an SDK's server in-process. */
export interface TunnelEndpoint {
	/** Gives the server one JSON-RPC message from Kantel. */
	send(message: string): void;
	/** Registers the listener for the server's messages to Kantel. */
	onMessage(listener: (message: string) => void): void;
	/** The tunnel has stopped for good. */
	close?(): void | Promise<void>;
}

export type TunnelStatus =
	| { readonly state: "connecting" }
	| { readonly state: "connected" }
	| { readonly state: "reconnecting"; readonly delayMs: number; readonly reason: string }
	/** `fatal` when Kantel said to stop (a revoked token, a removed server); not when `close()` stopped it. */
	| { readonly state: "stopped"; readonly reason: string; readonly fatal: boolean };

/** The client's timings. */
export interface TunnelTiming {
	readonly pingIntervalMs: number;
	readonly pongTimeoutMs: number;
	/** The first reconnect's delay, doubled each time after. */
	readonly backoffInitialMs: number;
	readonly backoffMaxMs: number;
	/** A connection that lasted this long resets the backoff. */
	readonly stableAfterMs: number;
}

export const TUNNEL_TIMING: TunnelTiming = {
	pingIntervalMs: TUNNEL_PING_INTERVAL_MS,
	pongTimeoutMs: TUNNEL_PONG_TIMEOUT_MS,
	backoffInitialMs: 1000,
	backoffMaxMs: 30_000,
	stableAfterMs: 60_000,
};

export interface OpenTunnelOptions {
	/** Kantel's origin, `https://…` (`http://` for a local one). */
	readonly kantel: string;
	/** The tool server's ID, `ts_…`. */
	readonly serverId: string;
	/** A tunnel token of that server, `ktt_…`. */
	readonly token: string;
	readonly endpoint: TunnelEndpoint;
	/**
	 * More headers for the upgrade, such as a Cloudflare Access service token's (`cf-access-client-id` and
	 * `cf-access-client-secret`) where Access guards the tunnel's path. They never replace `authorization`.
	 */
	readonly headers?: { readonly [name: string]: string };
	readonly onStatus?: (status: TunnelStatus) => void;
	/** Aborting it closes the tunnel. */
	readonly signal?: AbortSignal;
	/** `TUNNEL_TIMING` unless a test wants it shorter. */
	readonly timing?: Partial<TunnelTiming>;
}

export interface Tunnel {
	/** Closes the socket and the endpoint, and stops reconnecting. */
	close(): Promise<void>;
	readonly status: TunnelStatus;
}

/** The tunnel's WebSocket URL on `kantel`: `wss://` for an `https://` origin, `ws://` for `http://`. */
export function tunnelUrl(kantel: string, serverId: string): string {
	const origin = new URL(kantel);
	if (origin.protocol !== "https:" && origin.protocol !== "http:") {
		throw new Error(`Kantel's origin is an https:// URL, not ${kantel}`);
	}
	return `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}${tunnelPath(serverId)}`;
}

/** Why Kantel's answer means stop for good, or undefined when it's worth trying again. */
function fatalReason(code: number, httpStatus: number | undefined): string | undefined {
	if (code === TUNNEL_CLOSE_TOKEN_REVOKED) return "token revoked";
	if (code === TUNNEL_CLOSE_SERVER_REMOVED) return "tool server removed";
	if (httpStatus === 401) return "token refused (HTTP 401)";
	if (httpStatus === 403) return "token not for this tool server (HTTP 403)";
	if (httpStatus === 404) return "no such tool server (HTTP 404)";
	return undefined;
}

const CANCELLED_REASON = "Kantel's side of the tunnel disconnected";

export function openTunnel(options: OpenTunnelOptions): Tunnel {
	const timing: TunnelTiming = { ...TUNNEL_TIMING, ...options.timing };
	const url = tunnelUrl(options.kantel, options.serverId);
	const { endpoint } = options;
	const extraHeaders = Object.fromEntries(
		Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"),
	);
	let status: TunnelStatus = { state: "connecting" };
	let socket: WebSocket | undefined;
	let stopping = false;
	let attempt = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Kantel's requests on the current socket that the server hasn't answered, by the ID the tunnel gave each on the
	 * way to the server. The tunnel's IDs are never reused, while Kantel starts again from 1 on each socket.
	 */
	const waiting = new Map<number, { readonly kantelId: JsonRpcId; readonly method: string }>();
	const tunnelIds = new Map<JsonRpcId, number>();
	let nextId = 1;
	let finished: Promise<void> | undefined;

	const report = (next: TunnelStatus): void => {
		status = next;
		options.onStatus?.(next);
	};

	/** Takes a frame from Kantel to the server, giving a request the tunnel's own ID. */
	const toServer = (text: string): void => {
		const parsed = parseMessage(text);
		if (parsed !== undefined && isRequest(parsed)) {
			const id = nextId;
			nextId += 1;
			waiting.set(id, { kantelId: parsed.id, method: parsed.method });
			tunnelIds.set(parsed.id, id);
			endpoint.send(JSON.stringify({ ...parsed, id }));
			return;
		}
		if (parsed !== undefined && isNotification(parsed) && parsed.method === MCP_CANCELLED) {
			const requestId = parsed.params?.requestId;
			const id = typeof requestId === "string" || typeof requestId === "number" ? tunnelIds.get(requestId) : undefined;
			if (id !== undefined) {
				endpoint.send(JSON.stringify({ ...parsed, params: { ...parsed.params, requestId: id } }));
				return;
			}
		}
		endpoint.send(text);
	};

	/** Tells the server Kantel has stopped waiting for what it hasn't answered. */
	const cancelWaiting = (): void => {
		for (const [id, { method }] of waiting) {
			// MCP says `initialize` is never cancelled.
			if (method === "initialize") continue;
			endpoint.send(
				JSON.stringify({ jsonrpc: "2.0", method: MCP_CANCELLED, params: { requestId: id, reason: CANCELLED_REASON } }),
			);
		}
		waiting.clear();
		tunnelIds.clear();
	};

	/** Takes a message from the server to Kantel, giving an answer back Kantel's ID. */
	endpoint.onMessage((message) => {
		const open = socket;
		if (open === undefined || open.readyState !== WebSocket.OPEN) return;
		const parsed = parseMessage(message);
		let text = message;
		if (parsed !== undefined && isResponse(parsed) && parsed.id !== null) {
			const request = typeof parsed.id === "number" ? waiting.get(parsed.id) : undefined;
			// The answer to a request from an earlier socket, cancelled when its socket went.
			if (request === undefined) return;
			waiting.delete(parsed.id as number);
			tunnelIds.delete(request.kantelId);
			text = JSON.stringify({ ...parsed, id: request.kantelId });
			if (exceedsMessageLimit(text)) {
				// Kantel would close the socket on it, so answer the request with an error instead.
				text = JSON.stringify({
					jsonrpc: "2.0",
					id: request.kantelId,
					error: {
						code: JSONRPC_INTERNAL_ERROR,
						message: `The tool server's answer is larger than the tunnel's ${TUNNEL_MAX_MESSAGE_BYTES} bytes`,
					},
				});
			}
		} else if (exceedsMessageLimit(text)) {
			return;
		}
		open.send(text);
	});

	const finish = async (final: TunnelStatus): Promise<void> => {
		report(final);
		await endpoint.close?.();
	};

	const connect = (): void => {
		retry = undefined;
		if (stopping) return;
		report({ state: "connecting" });
		const ws = new WebSocket(url, {
			headers: { ...extraHeaders, authorization: `Bearer ${options.token}` },
			maxPayload: TUNNEL_MAX_MESSAGE_BYTES,
		});
		socket = ws;
		let openedAt: number | undefined;
		let lastPongAt = 0;
		let pinger: ReturnType<typeof setInterval> | undefined;
		let httpStatus: number | undefined;
		let lastError: string | undefined;
		let dead = false;

		/** Why the socket went, for the status line. */
		const why = (code: number, reason: string): string => {
			if (dead) return `no pong for ${Math.round(timing.pongTimeoutMs / 1000)} s`;
			if (httpStatus !== undefined) return `HTTP ${httpStatus}`;
			// 1006: the socket went without a close frame, and the error says why.
			if (openedAt === undefined || code === 1006) return lastError ?? "connection lost";
			return reason.length > 0 ? `closed ${code}: ${reason}` : `closed ${code}`;
		};

		ws.on("unexpected-response", (_request, response) => {
			httpStatus = response.statusCode;
			response.resume();
			ws.terminate();
		});
		ws.on("open", () => {
			openedAt = Date.now();
			lastPongAt = openedAt;
			report({ state: "connected" });
			pinger = setInterval(() => {
				if (Date.now() - lastPongAt > timing.pongTimeoutMs) {
					dead = true;
					ws.terminate();
					return;
				}
				ws.send(TUNNEL_PING);
			}, timing.pingIntervalMs);
		});
		ws.on("message", (data, isBinary) => {
			if (isBinary) return;
			const text = data.toString();
			if (text === TUNNEL_PONG) {
				lastPongAt = Date.now();
				return;
			}
			if (text === TUNNEL_PING) {
				ws.send(TUNNEL_PONG);
				return;
			}
			toServer(text);
		});
		ws.on("error", (error) => {
			// The close that follows decides what happens; this only says why.
			lastError = error.message;
		});
		ws.on("close", (code, reasonBytes) => {
			clearInterval(pinger);
			if (socket === ws) socket = undefined;
			cancelWaiting();
			if (stopping) return;
			const fatal = fatalReason(code, httpStatus);
			if (fatal !== undefined) {
				stopping = true;
				finished = finish({ state: "stopped", reason: fatal, fatal: true });
				return;
			}
			if (openedAt !== undefined && Date.now() - openedAt >= timing.stableAfterMs) attempt = 0;
			const base = Math.min(timing.backoffMaxMs, timing.backoffInitialMs * 2 ** attempt);
			attempt += 1;
			// Half the delay fixed and half random, so clients that dropped together don't come back together.
			const delayMs = Math.round(base / 2 + (Math.random() * base) / 2);
			report({ state: "reconnecting", delayMs, reason: why(code, reasonBytes.toString()) });
			retry = setTimeout(connect, delayMs);
		});
	};

	const close = (): Promise<void> => {
		if (finished !== undefined) return finished;
		stopping = true;
		clearTimeout(retry);
		const ws = socket;
		finished = (async () => {
			if (ws !== undefined) await closeSocket(ws);
			await finish({ state: "stopped", reason: "closed", fatal: false });
		})();
		return finished;
	};

	if (options.signal?.aborted) void close();
	else {
		options.signal?.addEventListener("abort", () => void close(), { once: true });
		connect();
	}

	return {
		close,
		get status() {
			return status;
		},
	};
}

/** Closes `ws` and waits for it, ending it outright if Kantel doesn't finish the closing handshake in time. */
function closeSocket(ws: WebSocket): Promise<void> {
	return new Promise((resolve) => {
		if (ws.readyState === WebSocket.CLOSED) {
			resolve();
			return;
		}
		const timer = setTimeout(() => ws.terminate(), 2000);
		ws.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
		if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
		else ws.close(TUNNEL_CLOSE_NORMAL, "The tunnel was closed");
	});
}
