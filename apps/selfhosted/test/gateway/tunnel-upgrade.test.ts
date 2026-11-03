// The gateway's tunnel endpoint, over a real HTTP server and WebSocket clients: a ticket the relay issued reaches its
// sandbox's port, on any gateway over the same relay store; anything else (guessed, altered, expired, too long-lived,
// malformed) is closed with 4003 before any sandbox is touched.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMemoryRelayStore, type RelayStore } from "@kantel/hosts/relay-store";
import type { HostsService } from "@kantel/hosts/service";
import { createTunnelTickets, MAX_TUNNEL_MINUTES } from "@kantel/hosts/tunnel";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { gatewayRelay, withHostUpgrades } from "../../src/gateway/compute.ts";
import { closeServer } from "./close-server.ts";

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await closeServer(server);
});

const relay = createMemoryRelayStore();

/** A gateway's upgrades over a fake registry whose sandbox port echoes what it is sent. */
async function gateway(store: RelayStore = relay) {
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
	const hosts = gatewayRelay({ publicUrl: "http://gateway.test" }, service, store);
	hosts.bind(async () => true);
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

const ticket = (overrides: { sandboxId?: string; port?: number; expiresAt?: number; store?: RelayStore } = {}) =>
	createTunnelTickets(overrides.store ?? relay).issue({
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

	it("relays a ticket another gateway over the same store issued, as after a restart or on another replica", async () => {
		const shared = createMemoryRelayStore();
		const issued = await ticket({ store: shared });
		const other = await gateway(shared);
		expect((await connect(`${other.base}/${issued}`)).echoed).toBe("hello");
		// A gateway over another store never issued it.
		const stranger = await gateway(createMemoryRelayStore());
		expect((await connect(`${stranger.base}/${issued}`)).code).toBe(4003);
		expect(stranger.opened).toEqual([]);
	});

	it("refuses forged, altered, expired, too long-lived and malformed tickets before touching a sandbox", async () => {
		const { base, opened } = await gateway();
		const valid = await ticket();
		const [id, secret] = valid.split(".") as [string, string];
		const other = (await ticket({ sandboxId: "sbx_someone" })).split(".")[0];
		const refused = {
			"issued by a relay over another store": await ticket({ store: createMemoryRelayStore() }),
			"another sandbox's ticket ID with this secret": `${other}.${secret}`,
			"a changed secret": `${id}.${secret.slice(0, -2)}AA`,
			"a guessed ticket": `${"A".repeat(16)}.${"B".repeat(43)}`,
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
		expect(await connect(`${base}/no-dot-here`)).toMatchObject({ code: 4404, echoed: "" });
		expect(opened).toEqual([]);
	});
});
