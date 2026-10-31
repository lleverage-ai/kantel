// A session's frames over a WebSocket (`GET /v1/sessions/:id/events` with an upgrade; `@kantel/runtime/http`'s
// `ws.ts`). Each message is a JSON array of frames; `[]` is the server's keep-alive. The browser offers
// `permessage-deflate` by itself and the Worker accepts it, so the frames travel compressed, with the window shared
// across messages.
//
// The socket only reads: like the event stream, it ends rather than reconnect, and the SessionClient reconnects with
// backoff from its own cursor. A socket that closes before it opens tells `failed`, so the caller can fall back to the
// event stream (a gateway without sockets, a proxy that refuses the upgrade, a refused session); one that goes silent
// for longer than `silenceMs` (three missed keep-alives) is closed and told as `lost`.

import type { ServerFrame } from "@kantel/protocol";

/** The parts of the browser's `WebSocket` the console uses, so tests can stand one in. */
export interface SocketLike {
	readonly extensions: string;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	close(code?: number, reason?: string): void;
}

export type OpenSocket = (url: string) => SocketLike;

/** The server sends `[]` every 15 s; three missed in a row means the link is gone. */
export const SOCKET_SILENCE_MS = 45_000;

export type SocketWatch = {
	/** Closes the socket; nothing is told after it. */
	close(): void;
};

export type SocketHandlers = {
	receive(frame: ServerFrame): void;
	/** The socket opened, with the extensions the server accepted (`permessage-deflate` when compressed). */
	opened?(extensions: string): void;
	/** It closed before it opened: no socket here. */
	failed(): void;
	/** It closed after it opened, or went silent. */
	lost(): void;
};

/** The `ws:` or `wss:` URL of a same-origin API path. */
export function socketUrl(path: string, base: string): string {
	const url = new URL(path, base);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

/** The frames in one message, or none for a keep-alive or a message that isn't an array of frames. */
export function framesOf(data: unknown): ServerFrame[] {
	if (typeof data !== "string") return [];
	try {
		const value: unknown = JSON.parse(data);
		return Array.isArray(value) ? (value as ServerFrame[]) : [];
	} catch {
		return [];
	}
}

export function watchOverSocket(
	open: OpenSocket,
	url: string,
	handlers: SocketHandlers,
	silenceMs = SOCKET_SILENCE_MS,
): SocketWatch {
	let done = false;
	let opened = false;
	let silence: ReturnType<typeof setTimeout> | undefined;
	let socket: SocketLike;
	const finish = (): boolean => {
		if (done) return false;
		done = true;
		clearTimeout(silence);
		socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
		return true;
	};
	const ended = () => {
		if (!finish()) return;
		try {
			socket.close();
		} catch {
			// Already closing.
		}
		if (opened) handlers.lost();
		else handlers.failed();
	};
	const listen = () => {
		clearTimeout(silence);
		silence = setTimeout(ended, silenceMs);
	};
	try {
		socket = open(url);
	} catch {
		queueMicrotask(handlers.failed);
		return { close() {} };
	}
	socket.onopen = () => {
		opened = true;
		listen();
		handlers.opened?.(socket.extensions);
	};
	socket.onmessage = (event) => {
		if (done) return;
		listen();
		for (const frame of framesOf(event.data)) {
			if (done) return;
			handlers.receive(frame);
		}
	};
	socket.onclose = ended;
	socket.onerror = ended;
	return {
		close() {
			if (!finish()) return;
			try {
				socket.close(1000);
			} catch {
				// Already closing.
			}
		},
	};
}
