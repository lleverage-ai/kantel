// A desktop's stream through the gateway, over a real HTTP server and WebSocket clients, to a fake Selkies that
// records what reaches it. A view-only ticket's client can't drive the desktop however it is modified: its socket is
// Selkies' viewer role whatever it asks for, its input never reaches the sandbox, and a ticket changed to say
// otherwise, or a desktop ticket used as a raw tunnel, is refused before the sandbox is touched.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DESKTOP_PORT } from "@kantel/hosts/desktop";
import type { PortSink } from "@kantel/hosts/hub";
import { createMemoryRelayStore } from "@kantel/hosts/relay-store";
import type { HostsService } from "@kantel/hosts/service";
import { createTunnelTickets, type DesktopMode } from "@kantel/hosts/tunnel";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { gatewayRelay, withHostUpgrades } from "../../src/gateway/compute.ts";

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

const relay = createMemoryRelayStore();

/** What reached the fake Selkies: each connection's handshake path and the messages its client sent. */
interface Seen {
	readonly port: number;
	path: string;
	readonly messages: { binary: boolean; text: string }[];
}

/** Unmasks the client frames in `buffer`, returning what is left over. */
function readFrames(buffer: Uint8Array, seen: Seen): Uint8Array {
	let rest = buffer;
	for (;;) {
		if (rest.length < 2) return rest;
		const opcode = (rest[0] ?? 0) & 0x0f;
		let length = (rest[1] ?? 0) & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (rest.length < 4) return rest;
			length = ((rest[2] ?? 0) << 8) | (rest[3] ?? 0);
			offset = 4;
		}
		if (rest.length < offset + 4 + length) return rest;
		const mask = rest.subarray(offset, offset + 4);
		const payload = rest.slice(offset + 4, offset + 4 + length).map((byte, i) => byte ^ (mask[i & 3] ?? 0));
		rest = rest.slice(offset + 4 + length);
		if (opcode === 0x1 || opcode === 0x2) {
			seen.messages.push({ binary: opcode === 0x2, text: new TextDecoder().decode(payload) });
		}
	}
}

/** A gateway's upgrades over a fake registry whose sandbox port is a WebSocket server, as Selkies' socket is. */
async function gateway() {
	const seen: Seen[] = [];
	const openPort = async (_sandboxId: string, port: number, sink: PortSink) => {
		const connection: Seen = { port, path: "", messages: [] };
		seen.push(connection);
		let buffer: Uint8Array = new Uint8Array(0);
		let open = false;
		return {
			stream: seen.length,
			write(bytes: Uint8Array) {
				if (!open) {
					const request = new TextDecoder().decode(bytes);
					connection.path = /^GET (\S+) /.exec(request)?.[1] ?? "";
					const key = /Sec-WebSocket-Key: (\S+)/.exec(request)?.[1] ?? "";
					const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
					sink.data(
						new TextEncoder().encode(
							`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
						),
					);
					open = true;
					// The stream's first frame, so the client knows the socket is through.
					sink.data(new Uint8Array([0x82, 0x01, 0x00]));
					return;
				}
				const joined = new Uint8Array(buffer.length + bytes.length);
				joined.set(buffer);
				joined.set(bytes, buffer.length);
				buffer = readFrames(joined, connection);
			},
			close() {},
		};
	};
	const service = { authenticate: async () => undefined, sandboxes: { openPort } } as unknown as HostsService;
	const hosts = gatewayRelay({ publicUrl: "http://gateway.test" }, service, relay);
	hosts.bind(async () => true);
	const upgrades = withHostUpgrades(hosts, undefined);
	const server = createServer((_, response) => response.writeHead(404).end());
	server.on("upgrade", (incoming, socket, head) => upgrades?.(incoming, socket, head));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { base: `ws://127.0.0.1:${port}`, seen };
}

/** What a client that ignores its own view-only setting would send: Selkies' input, as text and binary. */
const INPUT: (string | Uint8Array)[] = [
	"kd,65",
	"ku,65",
	"m,100,100,1,0",
	"m2,5,5,1,0",
	"cw,aGVsbG8=",
	"co,end,typed",
	"cmd,xterm",
	"r,3840x2160,primary",
	"js,c,0,cGFk,4,16",
	"_gz,1",
	new Uint8Array([0x05, 0x1f, 0x8b, 0x08]),
	new Uint8Array([0x01, 0x02, 0x03]),
];
const WATCHING = ['SETTINGS,{"displayId":"primary"}', "START_VIDEO", "REQUEST_KEYFRAME"];

/** Connects, sends `messages` once the stream's first frame is through, and resolves once the gateway has them. */
function drive(url: string, messages: (string | Uint8Array)[]): Promise<{ code: number; reason: string }> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		let sent = false;
		socket.on("message", () => {
			if (sent) return;
			sent = true;
			for (const message of messages) socket.send(message, { binary: typeof message !== "string" });
			// A last message the fake Selkies sees in every mode, so the test knows the rest arrived or was dropped.
			socket.send("STOP_VIDEO");
			setTimeout(() => socket.close(1000), 100);
		});
		socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
		socket.on("error", reject);
	});
}

const ticket = (desktop: DesktopMode | undefined, port = DESKTOP_PORT) =>
	createTunnelTickets(relay).issue({
		sandboxId: "sbx_4kq9x2mt",
		port,
		expiresAt: Date.now() + 10 * 60_000,
		...(desktop === undefined ? {} : { desktop }),
	});
const texts = (seen: Seen | undefined) => seen?.messages.map((message) => message.text);

describe("a desktop's stream through the gateway", () => {
	it("passes everything through for a ticket that drives", async () => {
		const { base, seen } = await gateway();
		await drive(`${base}/v1/hosts/desktop/${await ticket("control")}/api/websockets`, [...INPUT, ...WATCHING]);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.port).toBe(DESKTOP_PORT);
		expect(seen[0]?.path).toBe("/api/websockets");
		expect(seen[0]?.messages).toHaveLength(INPUT.length + WATCHING.length + 1);
		expect(texts(seen[0])).toContain("kd,65");
	});

	it("never lets a view-only ticket's client type, click, paste or run anything, whatever it sends or asks for", async () => {
		const { base, seen } = await gateway();
		await drive(`${base}/v1/hosts/desktop/${await ticket("view")}/api/websockets?role=controller&slot=2`, [
			...INPUT,
			...WATCHING,
		]);
		expect(seen).toHaveLength(1);
		// Selkies' viewer role, so Selkies refuses input too; the client's role and slot never reach it.
		expect(seen[0]?.path).toBe("/api/websockets?role=viewer");
		expect(texts(seen[0])).toEqual([...WATCHING, "STOP_VIDEO"]);
		expect(seen[0]?.messages.some((message) => message.binary)).toBe(false);
	});

	it("refuses a view-only ticket changed to drive, and a desktop ticket used as a tunnel, before touching the sandbox", async () => {
		const { base, seen } = await gateway();
		const view = await ticket("view");
		const [, secret] = view.split(".") as [string, string];
		// The mode is in the ticket's row, not its URL: the nearest thing to changing it is another ticket's ID.
		const [controlId] = (await ticket("control")).split(".") as [string, string];
		const [tunnelId] = (await ticket(undefined)).split(".") as [string, string];
		const refused = {
			"view-only's secret under a driving ticket's ID": `${controlId}.${secret}`,
			"view-only's secret under a tunnel ticket's ID": `${tunnelId}.${secret}`,
			"a tunnel's ticket for the desktop's port": await ticket(undefined),
			"a desktop ticket for another port": await ticket("control", 22),
		};
		for (const [what, bad] of Object.entries(refused)) {
			const result = await drive(`${base}/v1/hosts/desktop/${bad}/api/websockets`, INPUT);
			expect({ what, code: result.code }).toEqual({ what, code: 4003 });
		}
		// Raw TCP to Selkies, or its HTTP API through the DevTools passthrough, with a desktop ticket: refused too.
		for (const path of [`/v1/hosts/tunnel/${view}`, `/v1/hosts/tunnel/${view}/api/websockets`]) {
			const result = await drive(`${base}${path}`, INPUT);
			expect({ path, code: result.code }).toEqual({ path, code: 4003 });
		}
		// Only Selkies' stream socket is reachable on the desktop's route.
		const signalling = await drive(`${base}/v1/hosts/desktop/${view}/api/webrtc/signaling`, INPUT);
		expect(signalling.code).toBe(4003);
		expect(seen).toEqual([]);
	});
});
