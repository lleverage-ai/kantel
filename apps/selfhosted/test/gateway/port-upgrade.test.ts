// WebSocket upgrades on an exposed port's name, over a real HTTP server: refused without the port's token (even for
// a path that would be a tunnel on the gateway's own name), passed through to the sandbox's server with it, with the
// port's public name as Host and the token taken off.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PortSink } from "@kantel/hosts/hub";
import { PORT_COOKIE } from "@kantel/hosts/ports";
import { createMemoryRelayStore } from "@kantel/hosts/relay-store";
import type { HostsService } from "@kantel/hosts/service";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { gatewayRelay, withHostUpgrades } from "../../src/gateway/compute.ts";
import { closeServer } from "./close-server.ts";

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await closeServer(server);
});

/** A gateway whose sandbox port is a WebSocket server that says "hi" and records the handshake it was sent. */
async function gateway() {
	const handshakes: string[] = [];
	const openPort = async (_sandboxId: string, _port: number, sink: PortSink) => ({
		stream: 1,
		write(bytes: Uint8Array) {
			const request = new TextDecoder().decode(bytes);
			if (!request.startsWith("GET ")) return;
			handshakes.push(request);
			const key = /Sec-WebSocket-Key: (\S+)/.exec(request)?.[1] ?? "";
			const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
			sink.data(
				new TextEncoder().encode(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
				),
			);
			sink.data(new Uint8Array([0x81, 0x02, 0x68, 0x69]));
		},
		close() {},
	});
	const service = { authenticate: async () => undefined, sandboxes: { openPort } } as unknown as HostsService;
	const hosts = gatewayRelay(
		{ publicUrl: "http://gateway.test", portsDomain: "kantel-ports.test" },
		service,
		createMemoryRelayStore(),
	);
	hosts.bind(async () => true);
	const ports = hosts.ports;
	if (ports === undefined) throw new Error("no ports");
	const upgrades = withHostUpgrades(hosts, undefined);
	const server = createServer((_, response) => response.writeHead(404).end());
	server.on("upgrade", (incoming, socket, head) => upgrades?.(incoming, socket, head));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { address: `ws://127.0.0.1:${port}`, ports, handshakes, hosts };
}

/**
 * Resolves the first message from the sandbox's side. A refusal rejects with its close code: the gateway completes the
 * handshake and closes (4401 for no token, 4404 for no port exposed there), as Bun drops an HTTP status on an upgrade.
 */
function connect(url: string, headers: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers });
		let answered = false;
		// Sent before the close arrives too: it must never reach the sandbox.
		socket.on("open", () => socket.send("from the client"));
		socket.on("message", (data: Buffer) => {
			answered = true;
			resolve(data.toString());
			socket.close();
		});
		socket.on("close", (code) => {
			if (!answered) reject(new Error(`closed ${code}`));
		});
		socket.on("error", reject);
	});
}

describe("upgrades on an exposed port's name", () => {
	it("are refused without the token, and passed through with it", async () => {
		const { address, ports, handshakes, hosts } = await gateway();
		const { url } = await ports.expose("sbx_1", 5173, { public: false, subdomain: "brave-otter-ab12cd" });
		const token = new URL(url).searchParams.get("_token") ?? "";
		const host = "5173-brave-otter-ab12cd.kantel-ports.test";

		await expect(connect(`${address}/hmr`, { host })).rejects.toThrow(/closed 4401/);
		await expect(connect(`${address}/hmr`, { host, cookie: `${PORT_COOKIE}=wrong` })).rejects.toThrow(/closed 4401/);
		// On a port's name, a tunnel's path is the sandbox's, behind its token, not a tunnel.
		const ticket = await hosts.tickets.issue({ sandboxId: "sbx_1", port: 22, expiresAt: Date.now() + 60_000 });
		await expect(connect(`${address}/v1/hosts/tunnel/${ticket}`, { host })).rejects.toThrow(/closed 4401/);
		await expect(connect(`${address}/hmr`, { host: "5174-brave-otter-ab12cd.kantel-ports.test" })).rejects.toThrow(
			/closed 4404/,
		);
		expect(handshakes).toEqual([]);

		expect(await connect(`${address}/hmr?v=1`, { host, cookie: `${PORT_COOKIE}=${token}` })).toBe("hi");
		expect(await connect(`${address}/hmr?_token=${token}`, { host })).toBe("hi");
		expect(handshakes[0]).toMatch(new RegExp(`^GET /hmr\\?v=1 HTTP/1\\.1\\r\\nHost: ${host}\\r\\n`));
		expect(handshakes[1]).toMatch(/^GET \/hmr HTTP\/1\.1\r\n/);
		expect(handshakes.join("")).not.toContain(token);
	});
});
