/**
 * A WebSocket client over a sandbox's port stream (`HostsService.sandboxes.openPort`): the handshake and RFC 6455
 * framing written out, because the gateway runs on Bun, whose `node:http` ignores `createConnection`, so `ws`'s client
 * can't be handed a stream that isn't a socket. The gateway uses it to pass a WebSocket through to a server in the
 * sandbox (Chromium's DevTools) message by message.
 */
import type { PortSink, PortStream } from "./hub.ts";

export interface PortWebSocketHandlers {
	message(data: Uint8Array, binary: boolean): void;
	/** The server closed, the stream ended or the handshake failed. */
	close(code: number, reason: string): void;
	/**
	 * The server accepted the handshake, choosing `protocol` of those offered (or none): what `send` writes now goes
	 * straight to it rather than waiting here.
	 */
	open?(protocol: string | undefined): void;
}

/** What else the handshake carries, and how much of the server's messages may be held while they arrive. */
export interface PortWebSocketOptions {
	/**
	 * Headers for the server (an exposed port's application cookies, its `Authorization`), CR and LF taken out. The
	 * handshake's own (Host, Upgrade, Connection, `Sec-WebSocket-*`) can't be set here.
	 */
	readonly headers?: Readonly<Record<string, string>>;
	/** Subprotocols the client offered, passed on; `open` says which the server chose. Any that isn't a token is left out. */
	readonly protocols?: readonly string[];
	/** The largest message, as frames declare it, held while it arrives (default `MAX_MESSAGE_BYTES`). */
	readonly maxMessageBytes?: number;
	/**
	 * Shared by the sockets given it: what they hold together of frames and messages still arriving, at most `limit`
	 * bytes. A socket that would go past it is closed (1009) before holding more.
	 */
	readonly budget?: PortWebSocketBudget;
}

export interface PortWebSocketBudget {
	readonly limit: number;
	held: number;
}

export interface PortWebSocket {
	send(data: Uint8Array | string, binary: boolean): void;
	close(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** A message this big ends the connection: more than any DevTools answer (a full-page screenshot) needs. */
export const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
/** RFC 7230's token: what a subprotocol's name may be. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers only the handshake itself sets. */
const HANDSHAKE_HEADERS = new Set(["host", "upgrade", "connection", "content-length", "transfer-encoding"]);
const clean = (value: string) => value.replace(/[\r\n]+/g, " ");

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

/** One client frame: FIN set, masked as RFC 6455 requires of a client. */
export function encodeClientFrame(opcode: number, payload: Uint8Array): Uint8Array {
	const length = payload.length;
	const extra = length < 126 ? 0 : length < 65_536 ? 2 : 8;
	const frame = new Uint8Array(2 + extra + 4 + length);
	frame[0] = 0x80 | opcode;
	const view = new DataView(frame.buffer);
	if (extra === 0) frame[1] = 0x80 | length;
	else if (extra === 2) {
		frame[1] = 0x80 | 126;
		view.setUint16(2, length);
	} else {
		frame[1] = 0x80 | 127;
		view.setBigUint64(2, BigInt(length));
	}
	const mask = crypto.getRandomValues(new Uint8Array(4));
	frame.set(mask, 2 + extra);
	const start = 2 + extra + 4;
	for (let i = 0; i < length; i++) frame[start + i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
	return frame;
}

/**
 * Opens a WebSocket to `path` on the port `open` connects to, as a client on `127.0.0.1:{port}`, or with `host` as its
 * Host (an exposed port's public name).
 */
export function openPortWebSocket(
	open: (sink: PortSink) => Promise<PortStream>,
	port: number,
	path: string,
	handlers: PortWebSocketHandlers,
	host = `127.0.0.1:${port}`,
	options: PortWebSocketOptions = {},
): PortWebSocket {
	const maxMessage = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
	const budget = options.budget;
	const offered = (options.protocols ?? []).map((name) => name.trim()).filter((name) => TOKEN.test(name));
	let stream: PortStream | undefined;
	let closed = false;
	let handshaken = false;
	let buffer: Uint8Array = new Uint8Array(0);
	const pending: Uint8Array[] = [];
	let fragments: Uint8Array[] = [];
	let fragmentBinary = false;
	let fragmentBytes = 0;
	/** What this socket has counted against `budget`: its buffer and fragments, as last counted. */
	let counted = 0;
	const recount = () => {
		const now = closed ? 0 : buffer.length + fragmentBytes;
		if (budget !== undefined) budget.held += now - counted;
		counted = now;
	};

	const write = (bytes: Uint8Array) => {
		if (closed) return;
		if (stream === undefined || !handshaken) pending.push(bytes);
		else stream.write(bytes);
	};
	const finish = (code: number, reason: string) => {
		if (closed) return;
		closed = true;
		buffer = new Uint8Array(0);
		fragments = [];
		fragmentBytes = 0;
		recount();
		stream?.close();
		handlers.close(code, reason);
	};

	const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
	const extra = Object.entries(options.headers ?? {})
		.filter(([name]) => {
			const lower = name.toLowerCase();
			return TOKEN.test(name) && !HANDSHAKE_HEADERS.has(lower) && !lower.startsWith("sec-websocket-");
		})
		.map(([name, value]) => `${name}: ${clean(value)}\r\n`)
		.join("");
	const request =
		`GET ${path} HTTP/1.1\r\nHost: ${host.replace(/[\r\n]/g, "")}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
		`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
		(offered.length === 0 ? "" : `Sec-WebSocket-Protocol: ${offered.join(", ")}\r\n`) +
		`${extra}\r\n`;

	const frames = () => {
		for (;;) {
			if (buffer.length < 2) return;
			const first = buffer[0] ?? 0;
			const second = buffer[1] ?? 0;
			const fin = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let offset = 2;
			const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
			if (length === 126) {
				if (buffer.length < 4) return;
				length = view.getUint16(2);
				offset = 4;
			} else if (length === 127) {
				if (buffer.length < 10) return;
				const big = view.getBigUint64(2);
				if (big > BigInt(maxMessage)) return finish(1009, "The message is too big");
				length = Number(big);
				offset = 10;
			}
			// Refused on what the frame says it is, before waiting for (and holding) its payload.
			if (opcode < 0x8 && (opcode === 0x0 ? fragmentBytes : 0) + length > maxMessage) {
				return finish(1009, "The message is too big");
			}
			// A control frame (close, ping, pong) is never more than 125 bytes (RFC 6455, 5.5).
			if (opcode >= 0x8 && length > 125) return finish(1002, "A control frame is too big");
			const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
			if (masked) offset += 4;
			if (buffer.length < offset + length) return;
			const payload = buffer.slice(offset, offset + length);
			if (maskKey !== undefined)
				for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (maskKey[i & 3] ?? 0);
			buffer = buffer.slice(offset + length);
			if (opcode === 0x8) {
				const code = payload.length >= 2 ? ((payload[0] ?? 0) << 8) | (payload[1] ?? 0) : 1005;
				write(encodeClientFrame(0x8, payload.subarray(0, 2)));
				return finish(code === 1005 ? 1000 : code, decoder.decode(payload.subarray(2)));
			}
			if (opcode === 0x9) {
				write(encodeClientFrame(0xa, payload));
				continue;
			}
			if (opcode === 0xa) continue;
			if (opcode === 0x1 || opcode === 0x2) {
				fragments = [];
				fragmentBytes = 0;
				fragmentBinary = opcode === 0x2;
			} else if (opcode !== 0x0) {
				return finish(1002, `Unknown opcode ${opcode}`);
			}
			fragments.push(payload);
			fragmentBytes += payload.length;
			if (fragmentBytes > maxMessage) return finish(1009, "The message is too big");
			if (!fin) continue;
			const message = fragments.length === 1 ? (fragments[0] ?? new Uint8Array(0)) : new Uint8Array(fragmentBytes);
			if (fragments.length > 1) {
				let at = 0;
				for (const part of fragments) {
					message.set(part, at);
					at += part.length;
				}
			}
			fragments = [];
			fragmentBytes = 0;
			handlers.message(message, fragmentBinary);
		}
	};

	const receive = (bytes: Uint8Array) => {
		if (closed) return;
		// Counted before it is held: past the shared budget, the socket is closed instead.
		if (budget !== undefined && budget.held - counted + buffer.length + fragmentBytes + bytes.length > budget.limit) {
			return finish(1009, "Too much is held of messages still arriving");
		}
		buffer = concat(buffer, bytes);
		recount();
		if (!handshaken) {
			let end = -1;
			for (let i = 3; i < buffer.length; i++) {
				if (buffer[i - 3] === 13 && buffer[i - 2] === 10 && buffer[i - 1] === 13 && buffer[i] === 10) {
					end = i + 1;
					break;
				}
			}
			if (end < 0) {
				if (buffer.length > 16_384) finish(1002, "The server's handshake is too long");
				return;
			}
			const head = decoder.decode(buffer.subarray(0, end));
			if (!/^HTTP\/1\.1 101 /.test(head)) return finish(1011, `The server refused: ${head.split("\r\n")[0] ?? ""}`);
			// The server may choose only one of those offered, as RFC 6455 says; none offered, none chosen.
			const chosen = /\r\nsec-websocket-protocol:[ \t]*([^\r\n]*)/i.exec(head)?.[1]?.trim();
			if (chosen !== undefined && chosen !== "" && !offered.includes(chosen)) {
				return finish(1002, "The server chose a subprotocol nobody offered");
			}
			buffer = buffer.slice(end);
			handshaken = true;
			for (const bytes of pending.splice(0)) stream?.write(bytes);
			handlers.open?.(chosen === "" ? undefined : chosen);
		}
		frames();
		recount();
	};

	open({ data: receive, end: (reason) => finish(1006, reason) }).then(
		(opened) => {
			if (closed) return opened.close();
			stream = opened;
			opened.write(encoder.encode(request));
		},
		(error: unknown) => finish(1011, error instanceof Error ? error.message : String(error)),
	);

	return {
		send(data, binary) {
			write(encodeClientFrame(binary ? 0x2 : 0x1, typeof data === "string" ? encoder.encode(data) : data));
		},
		close() {
			if (closed) return;
			if (stream !== undefined && handshaken) stream.write(encodeClientFrame(0x8, new Uint8Array([0x03, 0xe8])));
			finish(1000, "");
		},
	};
}
