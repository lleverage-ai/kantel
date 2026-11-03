// The gateway's tunnel endpoint, over a real HTTP server and WebSocket clients: a ticket the gateway's secret signed
// reaches its sandbox's port; anything else (forged, altered, expired, too long-lived, malformed) is closed with 4003
// before any sandbox is touched.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostsService } from "@kantel/hosts/service";
import { MAX_TUNNEL_MINUTES, signTunnel } from "@kantel/hosts/tunnel";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type GatewayHostsBackend, withHostUpgrades } from "../../src/gateway/compute.ts";

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

const secret = crypto.getRandomValues(new Uint8Array(32));

/** A gateway's upgrades over a fake registry whose sandbox port echoes what it is sent. */
async function gateway() {
	const opened: { sandboxId: string; port: number }[] = [];
	const service = {
		authenticate: async () => undefined,
		sandboxes: {
			async openPort(
				sandboxId: string,
				port: number,
				sink: { data(bytes: Uint8Array): void; end(reason: string): void },
			) {
				opened.push({ sandboxId, port });
				return { write: (bytes: Uint8Array) => sink.data(bytes), close: () => undefined };
			},
		},
	} as unknown as HostsService;
	const hosts = { service, config: {}, tunnelSecret: secret } as unknown as GatewayHostsBackend;
	const upgrades = withHostUpgrades(hosts, undefined);
	const server = createServer((_, response) => response.writeHead(404).end());
	server.on("upgrade", (incoming, socket, head) => upgrades?.(incoming, socket, head));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { base: `ws://127.0.0.1:${port}/v1/hosts/tunnel`, opened };
}

/** Connects, sends `hello` once open, and resolves with what came back and how it closed. */
function connect(url: string): Promise<{ echoed: string; code: number; reason: string }> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		let echoed = "";
		socket.on("open", () => socket.send(Buffer.from("hello"), { binary: true }));
		socket.on("message", (data: Buffer) => {
			echoed += data.toString();
			socket.close(1000);
		});
		socket.on("close", (code, reason) => resolve({ echoed, code, reason: reason.toString() }));
		socket.on("error", reject);
	});
}

const ticket = (overrides: { sandboxId?: string; port?: number; expiresAt?: number; key?: Uint8Array } = {}) =>
	signTunnel(overrides.key ?? secret, {
		sandboxId: overrides.sandboxId ?? "sbx_4kq9x2mt",
		port: overrides.port ?? 22,
		expiresAt: overrides.expiresAt ?? Date.now() + 10 * 60_000,
	});

describe("the gateway's tunnel endpoint", () => {
	it("relays a ticket the gateway signed to that sandbox's port", async () => {
		const { base, opened } = await gateway();
		const result = await connect(`${base}/${await ticket()}`);
		expect(result.echoed).toBe("hello");
		expect(opened).toEqual([{ sandboxId: "sbx_4kq9x2mt", port: 22 }]);
	});

	it("refuses forged, altered, expired, too long-lived and malformed tickets before touching a sandbox", async () => {
		const { base, opened } = await gateway();
		const valid = await ticket();
		const [payload, signature] = valid.split(".") as [string, string];
		const other = (await ticket({ sandboxId: "sbx_someone" })).split(".")[0];
		const refused = {
			"signed with another secret": await ticket({ key: crypto.getRandomValues(new Uint8Array(32)) }),
			"another sandbox's grant under this signature": `${other}.${signature}`,
			"a changed signature": `${payload}.${signature.slice(0, -2)}AA`,
			expired: await ticket({ expiresAt: Date.now() - 1 }),
			"good for longer than the gateway gives": await ticket({
				expiresAt: Date.now() + (MAX_TUNNEL_MINUTES + 1) * 60_000,
			}),
			"not base64": "abc.def",
		};
		for (const [what, bad] of Object.entries(refused)) {
			const result = await connect(`${base}/${bad}`);
			expect({ what, code: result.code, echoed: result.echoed }).toEqual({ what, code: 4003, echoed: "" });
			expect(result.reason).toBe("The tunnel URL is wrong or has expired");
		}
		// A path the pattern doesn't take isn't a tunnel at all.
		await expect(connect(`${base}/no-dot-here`)).rejects.toThrow(/404/);
		expect(opened).toEqual([]);
	});
});
