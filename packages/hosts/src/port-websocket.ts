/**
 * A WebSocket client over a sandbox's port stream (`HostsService.sandboxes.openPort`): the handshake and RFC 6455
 * framing written out, because the gateway runs on Bun, whose `node:http` ignores `createConnection`, so `ws`'s client
 * can't be handed a stream that isn't a socket. The gateway uses it to pass a WebSocket through to a server in the
 * sandbox (Chrome's DevTools) message by message.
 */
import type { PortSink, PortStream } from "./hub.ts";

export interface PortWebSocketHandlers {
	message(data: Uint8Array, binary: boolean): void;
	/** The server closed, the stream ended or the handshake failed. */
	close(code: number, reason: string): void;
}

export interface PortWebSocket {
	send(data: Uint8Array | string, binary: boolean): void;
	close(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** A message this big ends the connection: more than any DevTools answer (a full-page screenshot) needs. */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

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
): PortWebSocket {
	let stream: PortStream | undefined;
	let closed = false;
	let handshaken = false;
	let buffer: Uint8Array = new Uint8Array(0);
	const pending: Uint8Array[] = [];
	let fragments: Uint8Array[] = [];
	let fragmentBinary = false;
	let fragmentBytes = 0;

	const write = (bytes: Uint8Array) => {
		if (closed) return;
		if (stream === undefined || !handshaken) pending.push(bytes);
		else stream.write(bytes);
	};
	const finish = (code: number, reason: string) => {
		if (closed) return;
		closed = true;
		stream?.close();
		handlers.close(code, reason);
	};

	const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
	const request =
		`GET ${path} HTTP/1.1\r\nHost: ${host.replace(/[\r\n]/g, "")}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
		`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;

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
				if (big > BigInt(MAX_MESSAGE_BYTES)) return finish(1009, "The message is too big");
				length = Number(big);
				offset = 10;
			}
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
			if (fragmentBytes > MAX_MESSAGE_BYTES) return finish(1009, "The message is too big");
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
		buffer = concat(buffer, bytes);
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
			buffer = buffer.slice(end);
			handshaken = true;
			for (const bytes of pending.splice(0)) stream?.write(bytes);
		}
		frames();
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
