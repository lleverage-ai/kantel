/**
 * `watch` over a WebSocket, beside server-sent events. The same frames, the same resume (`?after=<cursor>`), on one
 * socket that the platform compresses: Workers negotiate `permessage-deflate` with the browser by themselves (the
 * `web_socket_compression` compatibility flag, on since 2023-08-15), and the same JSON keys repeat in every frame, so the
 * shared window does well on them.
 *
 * Each message is a JSON array of `ServerFrame`s: every frame the watch gave in one turn of the event loop goes in one
 * message, after T3 Code's coalescing of live updates (`ThreadLiveEventCoalescer.ts`), but with no window, so nothing
 * waits. An empty array (`[]`) is a keep-alive. The client sends nothing; it resumes by reconnecting with `?after=`.
 */
import type { ServerFrame } from "@kantel/protocol";

/** What the API needs of a server-side WebSocket: WHATWG's, as a Worker's `WebSocketPair` gives it. */
export interface ServerWebSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "close" | "error", listener: () => void): void;
}

/** An accepted upgrade: the socket to send on, and the `101` response to answer the request with. */
export interface WebSocketUpgrade {
	readonly socket: ServerWebSocket;
	readonly response: Response;
}

/** Accepts a request's WebSocket upgrade, where the platform can (a Worker or a Durable Object: `WebSocketPair`). */
export type AcceptWebSocket = (request: Request) => WebSocketUpgrade;

/** A message with no frames, sent on an idle socket so proxies don't close it. */
export const WS_KEEP_ALIVE = "[]";

/** Closed by the server: the API is shutting down or the watch ended. The client reconnects. */
export const WS_CLOSE_GOING_AWAY = 1001;

/** Whether `request` asks to upgrade to a WebSocket. */
export function isWebSocketUpgrade(request: Request): boolean {
	return request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** The frames in one message. Throws on a message that is not a JSON array. */
export function decodeFrames(data: string): ServerFrame[] {
	const value: unknown = JSON.parse(data);
	if (!Array.isArray(value)) throw new Error("A watch message must be a JSON array of frames");
	return value as ServerFrame[];
}

/**
 * Batches frames into messages: frames pushed in the same turn of the event loop go out together, in a microtask, so
 * a commit that yields several deltas costs one message and no frame waits for a timer.
 */
export function frameBatcher(send: (data: string) => void): { push(frame: ServerFrame): void; flush(): void } {
	let pending: ServerFrame[] = [];
	let scheduled = false;
	const flush = () => {
		scheduled = false;
		if (pending.length === 0) return;
		const frames = pending;
		pending = [];
		send(JSON.stringify(frames));
	};
	return {
		push(frame) {
			pending.push(frame);
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(flush);
		},
		flush,
	};
}
