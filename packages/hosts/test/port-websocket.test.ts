// The WebSocket client the gateway opens over a sandbox's port stream (for Chromium's DevTools): its handshake, masked
// frames out, and unmasked, fragmented, extended-length and control frames in.
import { describe, expect, it } from "vitest";
import type { PortSink } from "../src/hub.ts";
import { openPortWebSocket } from "../src/port-websocket.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A server frame: never masked. */
function serverFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
	const extra = payload.length < 126 ? 0 : payload.length < 65_536 ? 2 : 8;
	const frame = new Uint8Array(2 + extra + payload.length);
	frame[0] = (fin ? 0x80 : 0) | opcode;
	const view = new DataView(frame.buffer);
	if (extra === 0) frame[1] = payload.length;
	else if (extra === 2) {
		frame[1] = 126;
		view.setUint16(2, payload.length);
	} else {
		frame[1] = 127;
		view.setBigUint64(2, BigInt(payload.length));
	}
	frame.set(payload, 2 + extra);
	return frame;
}

/** Unmasks one client frame. */
function clientFrame(frame: Uint8Array): { opcode: number; payload: Uint8Array } {
	expect((frame[1] ?? 0) & 0x80).toBe(0x80);
	let length = (frame[1] ?? 0) & 0x7f;
	let offset = 2;
	if (length === 126) {
		length = new DataView(frame.buffer, frame.byteOffset).getUint16(2);
		offset = 4;
	}
	const mask = frame.subarray(offset, offset + 4);
	const payload = frame.slice(offset + 4, offset + 4 + length);
	for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
	return { opcode: (frame[0] ?? 0) & 0x0f, payload };
}

function setup() {
	const written: Uint8Array[] = [];
	let sink: PortSink | undefined;
	const messages: { data: string; binary: boolean }[] = [];
	const closes: { code: number; reason: string }[] = [];
	const socket = openPortWebSocket(
		async (given) => {
			sink = given;
			return { stream: 1, write: (bytes) => written.push(bytes), close: () => undefined };
		},
		9222,
		"/devtools/browser/abc",
		{
			message: (data, binary) => messages.push({ data: text(data), binary }),
			close: (code, reason) => closes.push({ code, reason }),
		},
	);
	const server = (bytes: Uint8Array) => sink?.data(bytes);
	return { socket, written, server, messages, closes };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const enc = (value: string) => new TextEncoder().encode(value);

describe("a WebSocket over a port stream", () => {
	it("handshakes on loopback, sends masked frames once upgraded, and reads what the server sends", async () => {
		const { socket, written, server, messages, closes } = setup();
		socket.send('{"id":1}', false);
		await tick();
		const request = text(written[0] ?? new Uint8Array(0));
		expect(request).toMatch(/^GET \/devtools\/browser\/abc HTTP\/1\.1\r\n/);
		expect(request).toContain("Host: 127.0.0.1:9222\r\n");
		expect(request).toContain("Upgrade: websocket\r\n");
		expect(written).toHaveLength(1);

		// The 101 and the first frame arrive in one chunk.
		const big = "x".repeat(70_000);
		server(
			new Uint8Array([
				...enc("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"),
				...serverFrame(1, enc("hi")),
			]),
		);
		expect(written).toHaveLength(2);
		expect(clientFrame(written[1] ?? new Uint8Array(0))).toMatchObject({ opcode: 1 });
		expect(text(clientFrame(written[1] ?? new Uint8Array(0)).payload)).toBe('{"id":1}');

		// Split across chunks, fragmented, a ping in between, and a 64-bit length.
		const fragmented = [
			...serverFrame(1, enc("frag"), false),
			...serverFrame(9, enc("p")),
			...serverFrame(0, enc("ment")),
		];
		server(new Uint8Array(fragmented.slice(0, 3)));
		server(new Uint8Array(fragmented.slice(3)));
		server(serverFrame(2, enc(big)));
		expect(messages).toEqual([
			{ data: "hi", binary: false },
			{ data: "fragment", binary: false },
			{ data: big, binary: true },
		]);
		const pong = clientFrame(written[2] ?? new Uint8Array(0));
		expect(pong.opcode).toBe(0xa);
		expect(text(pong.payload)).toBe("p");

		server(serverFrame(8, new Uint8Array([0x03, 0xe8, ...enc("bye")])));
		expect(closes).toEqual([{ code: 1000, reason: "bye" }]);
	});

	it("closes when the server refuses the upgrade", async () => {
		const { server, closes } = setup();
		await tick();
		server(enc("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
		expect(closes[0]?.code).toBe(1011);
		expect(closes[0]?.reason).toContain("403");
	});
});

const SWITCHED = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n";

/** A socket with `options`, its server's side, and what it heard. */
function withOptions(options: Parameters<typeof openPortWebSocket>[5]) {
	const written: Uint8Array[] = [];
	let sink: PortSink | undefined;
	let closedStream = false;
	const opened: (string | undefined)[] = [];
	const messages: string[] = [];
	const closes: { code: number; reason: string }[] = [];
	openPortWebSocket(
		async (given) => {
			sink = given;
			return {
				stream: 1,
				write: (bytes) => written.push(bytes),
				close: () => {
					closedStream = true;
				},
			};
		},
		5173,
		"/",
		{
			open: (protocol) => opened.push(protocol),
			message: (data) => messages.push(text(data)),
			close: (code, reason) => closes.push({ code, reason }),
		},
		"app-3000.ports.kantel.test",
		options,
	);
	return {
		written,
		server: (bytes: Uint8Array) => sink?.data(bytes),
		opened,
		messages,
		closes,
		streamClosed: () => closedStream,
	};
}

describe("what a relayed WebSocket's handshake carries", () => {
	it("offers the client's subprotocols and the application's headers, and says which the server chose", async () => {
		const socket = withOptions({
			protocols: ["vite-hmr", "bad token", "vite-ping"],
			headers: {
				cookie: "session=abc",
				authorization: "Bearer app\r\nX-Injected: 1",
				Host: "evil.test",
				"Sec-WebSocket-Key": "nope",
			},
		});
		await tick();
		const request = text(socket.written[0] ?? new Uint8Array(0));
		expect(request).toContain("Sec-WebSocket-Protocol: vite-hmr, vite-ping\r\n");
		expect(request).toContain("cookie: session=abc\r\n");
		expect(request).toContain("authorization: Bearer app X-Injected: 1\r\n");
		expect(request).not.toContain("evil.test");
		expect(request).not.toContain("nope");
		expect(request).toContain("Host: app-3000.ports.kantel.test\r\n");
		socket.server(enc(`${SWITCHED}Sec-WebSocket-Protocol: vite-hmr\r\n\r\n`));
		expect(socket.opened).toEqual(["vite-hmr"]);
		expect(socket.closes).toEqual([]);
	});

	it("opens with no subprotocol when none was offered or chosen, and closes on one nobody offered", async () => {
		const none = withOptions({});
		await tick();
		expect(text(none.written[0] ?? new Uint8Array(0))).not.toContain("Sec-WebSocket-Protocol");
		none.server(enc(`${SWITCHED}\r\n`));
		expect(none.opened).toEqual([undefined]);

		const stray = withOptions({ protocols: ["vite-hmr"] });
		await tick();
		stray.server(enc(`${SWITCHED}Sec-WebSocket-Protocol: other\r\n\r\n`));
		expect(stray.opened).toEqual([]);
		expect(stray.closes[0]?.code).toBe(1002);
	});
});

describe("what a relayed WebSocket holds of the server's messages", () => {
	it("closes on a message bigger than its limit as soon as the frame says so, and passes those within it", async () => {
		const socket = withOptions({ maxMessageBytes: 1024 });
		await tick();
		socket.server(enc(`${SWITCHED}\r\n`));
		socket.server(serverFrame(0x1, enc("x".repeat(1024))));
		expect(socket.messages).toEqual(["x".repeat(1024)]);
		// Only the frame's head has arrived: refused on what it declares, before its payload is waited for.
		socket.server(serverFrame(0x2, new Uint8Array(70_000)).subarray(0, 10));
		expect(socket.closes[0]?.code).toBe(1009);
		expect(socket.streamClosed()).toBe(true);
	});

	it("closes on fragments that together pass the limit", async () => {
		const socket = withOptions({ maxMessageBytes: 1024 });
		await tick();
		socket.server(enc(`${SWITCHED}\r\n`));
		socket.server(serverFrame(0x1, enc("x".repeat(600)), false));
		expect(socket.closes).toEqual([]);
		socket.server(serverFrame(0x0, enc("x".repeat(600)), false));
		expect(socket.closes[0]?.code).toBe(1009);
	});

	it("closes on a message in too many pieces, empty ones included, and counts each piece against the budget", async () => {
		const budget = { limit: 1_000_000, held: 0 };
		const socket = withOptions({ maxFragments: 100, budget });
		await tick();
		socket.server(enc(`${SWITCHED}\r\n`));
		socket.server(serverFrame(0x1, new Uint8Array(0), false));
		// Empty continuations: no bytes, but each kept piece is counted.
		for (let i = 0; i < 50; i++) socket.server(serverFrame(0x0, new Uint8Array(0), false));
		expect(socket.closes).toEqual([]);
		expect(budget.held).toBeGreaterThanOrEqual(51 * 64);
		const flood = new Uint8Array(60 * 2);
		for (let i = 0; i < 60; i++) flood.set(serverFrame(0x0, new Uint8Array(0), false), i * 2);
		socket.server(flood);
		expect(socket.closes[0]).toEqual({ code: 1009, reason: "The message is in too many pieces" });
		expect(budget.held).toBe(0);

		// Tiny pieces against a small shared budget: closed once their keep passes it.
		const small = { limit: 2048, held: 0 };
		const tiny = withOptions({ budget: small });
		await tick();
		tiny.server(enc(`${SWITCHED}\r\n`));
		tiny.server(serverFrame(0x1, enc("a"), false));
		for (let i = 0; i < 100 && tiny.closes.length === 0; i++) tiny.server(serverFrame(0x0, enc("a"), false));
		expect(tiny.closes[0]?.code).toBe(1009);
		expect(small.held).toBe(0);
	});

	it("shares one budget between sockets, a message split across many chunks counted as it comes", async () => {
		const budget = { limit: 8192, held: 0 };
		const first = withOptions({ budget });
		const second = withOptions({ budget });
		await tick();
		first.server(enc(`${SWITCHED}\r\n`));
		second.server(enc(`${SWITCHED}\r\n`));
		expect(budget.held).toBe(0);
		// The first holds 4 KiB of a 6000-byte message, 64 bytes at a time.
		const big = serverFrame(0x2, new Uint8Array(6000));
		for (let at = 0; at < 4096; at += 64) first.server(big.subarray(at, at + 64));
		expect(first.closes).toEqual([]);
		expect(budget.held).toBe(4096);
		// The second can't hold another message as big on top: it is closed before passing the budget.
		const other = serverFrame(0x2, new Uint8Array(6000));
		for (let at = 0; at < other.length && second.closes.length === 0; at += 64) {
			second.server(other.subarray(at, at + 64));
			expect(budget.held).toBeLessThanOrEqual(budget.limit);
		}
		expect(second.closes[0]?.code).toBe(1009);
		expect(second.streamClosed()).toBe(true);
		expect(budget.held).toBe(4096);
		// The first goes on: once its message is whole and passed on, what it held is given back.
		for (let at = 4096; at < big.length; at += 64) first.server(big.subarray(at, at + 64));
		expect(first.closes).toEqual([]);
		expect(budget.held).toBe(0);
		// Small messages still pass.
		const small = withOptions({ budget });
		await tick();
		small.server(enc(`${SWITCHED}\r\n`));
		small.server(serverFrame(0x1, enc("hello")));
		expect(small.messages).toEqual(["hello"]);
	});
});
