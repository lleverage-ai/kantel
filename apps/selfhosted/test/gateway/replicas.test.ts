// Two gateway replicas over one database, as behind a load balancer: real HTTP servers, a host speaking the protocol
// over a real WebSocket to one of them, and the replicas reaching each other over HTTP and WebSocket, signed. Whatever
// replica a request lands on reaches the host; a tunnel URL either gave out works on both; revoking the host from the
// other replica closes its connection; and in a rolling restart the host moves and the routing follows it. Requests
// between replicas that aren't signed by a live one are 404s.
import { createServer } from "node:net";
import { createSqlClusterStore } from "@kantel/hosts/cluster";
import { HOSTS_CONNECT_PATH } from "@kantel/hosts/http";
import {
	decodeStreamFrame,
	encodeStreamFrame,
	HOST_CLOSE_REVOKED,
	type HostMessage,
	type HostSandbox,
} from "@kantel/hosts/protocol";
import { createSqlRelayStore, migrateRelay } from "@kantel/hosts/relay-store";
import { createSqlHostStore, migrateHosts } from "@kantel/hosts/store";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CLUSTER_PATH, createGatewayCluster, type GatewayCluster } from "../../src/gateway/cluster.ts";
import {
	type ComputeHostsConfig,
	type GatewayHostsBackend,
	gatewayHosts,
	gatewayRelay,
	withHostUpgrades,
} from "../../src/gateway/compute.ts";
import { type Listening, listen } from "../../src/gateway/node-http.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const freePort = () =>
	new Promise<number>((resolve) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});

const config: ComputeHostsConfig = { publicUrl: "http://kantel.test" };

interface Replica {
	readonly cluster: GatewayCluster;
	readonly relay: GatewayHostsBackend;
	readonly server: Listening;
	readonly url: string;
	stop(): Promise<void>;
}

async function database() {
	const db = await pgliteDatabase.open();
	cleanups.push(() => db.close());
	await migrateHosts(db.driver);
	await migrateRelay(db.driver);
	return db.driver;
}

/** A gateway replica as main.ts makes one with hosts and a database, serving hosts, tunnels and other replicas. */
async function replica(driver: Awaited<ReturnType<typeof database>>): Promise<Replica> {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const cluster = await createGatewayCluster({
		store: createSqlClusterStore(driver),
		url,
		heartbeatMs: 200,
		staleMs: 2000,
		log: () => undefined,
	});
	const service = gatewayHosts(config, createSqlHostStore(driver), () => undefined, cluster.cluster);
	const relay = gatewayRelay(config, service, createSqlRelayStore(driver), { cluster });
	relay.bind(async () => true);
	await cluster.cluster.start();
	const server = await listen(
		async (request) => (await cluster.peerRoutes(request)) ?? new Response("Not found", { status: 404 }),
		port,
		{ host: "127.0.0.1", drainTimeoutMs: 100, onUpgrade: withHostUpgrades(relay, undefined) },
	);
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		// As main.ts closes: the other replicas stop routing here, then the hosts are told to go elsewhere.
		await cluster.cluster.stop();
		service.close();
		await server.close();
	};
	cleanups.push(stop);
	return { cluster, relay, server, url, stop };
}

/** A host as kantel-host behaves, over a real WebSocket: an echo server on every port. */
async function connectHost(target: Replica, hostId: string, credential: string, sandboxes: HostSandbox[] = []) {
	const socket = new WebSocket(`${target.url.replace("http", "ws")}${HOSTS_CONNECT_PATH}`, {
		headers: { authorization: `Bearer ${credential}` },
	});
	cleanups.push(() => socket.terminate());
	const held = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
	const calls: string[] = [];
	const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
	const send = (message: object) => socket.send(JSON.stringify(message));
	const welcomed = new Promise<void>((resolve) => {
		socket.on("message", (data, binary) => {
			if (binary) {
				const frame = decodeStreamFrame(new Uint8Array(data as Buffer));
				if (frame === undefined || frame.payload.byteLength === 0) return;
				const echo = new TextEncoder().encode(`echo:${new TextDecoder().decode(frame.payload)}`);
				socket.send(encodeStreamFrame(frame.stream, echo));
				return;
			}
			const message = JSON.parse(data.toString()) as HostMessage;
			if (message.type === "welcome") return resolve();
			if (message.type !== "call") return;
			calls.push(message.method ?? "");
			const params = message.params as { sandboxId: string };
			const answer = (result: unknown) => send({ type: "result", id: message.id, result });
			switch (message.method) {
				case "sandbox.create": {
					const sandbox: HostSandbox = {
						id: params.sandboxId,
						tier: "microvm",
						size: "default",
						state: "running",
						createdAt: 1,
					};
					held.set(sandbox.id, sandbox);
					return answer(sandbox);
				}
				case "sandbox.exec":
					send({ type: "event", call: message.id, event: { kind: "exec.output", stdout: btoa("hi\n"), at: 1 } });
					return answer({ exitCode: 0, stdout: "hi\n", stderr: "", durationMs: 1 });
				case "port.open":
					return answer({ ok: true });
				default:
					return send({ type: "result", id: message.id, error: { code: "unsupported", message: "no" } });
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		socket.on("open", () => resolve());
		socket.on("error", reject);
	});
	send({
		type: "hello",
		hello: {
			hostId,
			facts: {
				version: "0.1.0",
				protocol: 1,
				os: "linux",
				arch: "amd64",
				kernel: "6.8",
				hostname: "h",
				cpus: 16,
				memoryMiB: 32_768,
				diskGiB: 500,
				kvm: true,
				nested: true,
				tiers: ["microvm"],
				sizes: [{ name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 }],
				egress: "proxy",
				labels: {},
			},
			sandboxes: [...held.values()],
			capacity: { freeMemoryMiB: 20_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} },
		},
	});
	await welcomed;
	return { socket, calls, closed, sandboxes: () => [...held.values()] };
}

/** Opens a tunnel and resolves what the port echoes back to "ping". */
function throughTunnel(target: Replica, ticket: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`${target.url.replace("http", "ws")}/v1/hosts/tunnel/${ticket}`);
		socket.on("open", () => socket.send(Buffer.from("ping"), { binary: true }));
		socket.on("message", (data) => {
			resolve(data.toString());
			socket.close();
		});
		socket.on("close", (code, reason) => reject(new Error(`closed ${code} ${reason.toString()}`)));
		socket.on("error", reject);
	});
}

async function join(target: Replica) {
	const token = await target.relay.service.createJoinToken({ name: "box" });
	return target.relay.service.register({ token: token.token });
}

describe("gateway replicas behind a load balancer", { timeout: 30_000 }, () => {
	it("reach a host connected to either one: calls, their events, and tunnels from both", async () => {
		const driver = await database();
		const a = await replica(driver);
		const b = await replica(driver);
		const { hostId, credential } = await join(b);
		const host = await connectHost(a, hostId, credential);
		await b.cluster.cluster.tick();
		expect((await b.relay.service.get(hostId)).state).toBe("online");

		// Through B, to the host on A.
		await b.relay.service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-far" });
		const events: string[] = [];
		const result = await b.relay.service.sandboxes.call(
			"sbx-far",
			"sandbox.exec",
			{ command: "echo hi" },
			{ onEvent: (event) => events.push(event.kind) },
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "hi\n" });
		expect(events).toEqual(["exec.output"]);
		expect(host.calls).toEqual(["sandbox.create", "sandbox.exec"]);

		// A ticket either replica issued opens on both: B's port stream goes on to A.
		const expiresAt = Date.now() + 60_000;
		const fromB = await b.relay.tickets.issue({ sandboxId: "sbx-far", port: 22, expiresAt });
		const fromA = await a.relay.tickets.issue({ sandboxId: "sbx-far", port: 22, expiresAt });
		expect(await throughTunnel(b, fromA)).toBe("echo:ping");
		expect(await throughTunnel(a, fromB)).toBe("echo:ping");
	});

	it("revoke a host from the replica it isn't connected to", async () => {
		const driver = await database();
		const a = await replica(driver);
		const b = await replica(driver);
		const { hostId, credential } = await join(a);
		const host = await connectHost(a, hostId, credential);
		await b.relay.service.revoke(hostId);
		expect(await host.closed).toBe(HOST_CLOSE_REVOKED);
	});

	it("follow a host through a rolling restart", async () => {
		const driver = await database();
		const a = await replica(driver);
		const b = await replica(driver);
		const { hostId, credential } = await join(a);
		const first = await connectHost(a, hostId, credential);
		await a.relay.service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-roll" });

		// A stops: the host is told to go (1001), and reconnects through the balancer to B.
		await a.stop();
		expect(await first.closed).toBe(1001);
		const second = await connectHost(b, hostId, credential, first.sandboxes());
		// A new replica takes A's place, and reaches the host on B.
		const c = await replica(driver);
		await c.cluster.cluster.tick();
		expect(await c.relay.service.sandboxes.call("sbx-roll", "sandbox.exec", { command: "true" })).toMatchObject({
			exitCode: 0,
		});
		expect(second.calls).toEqual(["sandbox.exec"]);
		const ticket = await c.relay.tickets.issue({ sandboxId: "sbx-roll", port: 5901, expiresAt: Date.now() + 60_000 });
		expect(await throughTunnel(c, ticket)).toBe("echo:ping");
	});

	it("refuse requests between replicas that a live replica didn't sign", async () => {
		const driver = await database();
		const a = await replica(driver);
		const body = JSON.stringify({ hostId: "host_x", method: "sandbox.exec", params: {} });
		const post = (headers: Record<string, string>) =>
			fetch(`${a.url}${CLUSTER_PATH}/call`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body,
			}).then((response) => response.status);
		expect(await post({})).toBe(404);
		expect(
			await post({
				"x-kantel-replica": a.cluster.cluster.replicaId,
				"x-kantel-at": String(Date.now()),
				"x-kantel-nonce": "AAAAAAAAAAAAAAAAAAAAAAAA",
				"x-kantel-signature": "AAAA",
			}),
		).toBe(404);
		// Nor a port stream.
		const upgraded = await new Promise<string>((resolve) => {
			const socket = new WebSocket(`${a.url.replace("http", "ws")}${CLUSTER_PATH}/port?host=h&sandbox=s&port=22`);
			socket.on("unexpected-response", (_request, response) => resolve(`http ${response.statusCode}`));
			socket.on("open", () => resolve("opened"));
			socket.on("error", () => undefined);
		});
		expect(upgraded).toBe("http 404");
	});
});
