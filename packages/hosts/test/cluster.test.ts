// Gateway replicas sharing hosts: two hosts services over one registry and one cluster store, each its own replica,
// with fake hosts connected to one or the other. A call, its events and a port stream reach the host through
// whichever replica holds it; a host that moves takes its routing with it; a replica that stops or dies stops being
// routed to; and replicas trust only each other's signatures, once.
import { isKantelError } from "@kantel/contracts";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClusterStore,
	createHostCluster,
	createMemoryClusterStore,
	createPeerVerifier,
	createReplicaKey,
	createSqlClusterStore,
	type HostCluster,
	MAX_USAGE_QUEUE,
	PEER_SKEW_MS,
	type PeerTransport,
	signPeerRequest,
} from "../src/cluster.ts";
import { HOST_CLOSE_REVOKED, type HostSandbox } from "../src/protocol.ts";
import { migrateRelay } from "../src/relay-store.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore, type HostStore } from "../src/store.ts";
import { FakeHost, facts } from "./fake-host.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
	for (const item of opened.splice(0)) item.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Replicas over one registry and one cluster store, reaching each other in process. */
function cluster(options: { now?: () => number; store?: ClusterStore } = {}) {
	const hosts: HostStore = createMemoryHostStore();
	const store = options.store ?? createMemoryClusterStore();
	const now = options.now ?? Date.now;
	const replicas = new Map<string, HostCluster>();
	const peer = (id: string) => {
		const replica = replicas.get(id);
		if (replica === undefined) throw new Error(`no replica ${id}`);
		return replica.local();
	};
	const forwarded: string[] = [];
	/** Usage ticks passed on: the peer, and the tick's `seq`. */
	const sharedUsage: string[] = [];
	const transport: PeerTransport = {
		usage: async (to, _hostId, usage) => {
			sharedUsage.push(`${to.id} ${(usage as { seq?: number }).seq}`);
		},
		call: (to, hostId, method, params, callOptions) => {
			forwarded.push(`${to.id} ${method}`);
			return peer(to.id).call(hostId, method, params, callOptions);
		},
		openPort: (to, hostId, sandboxId, port, sink) => {
			forwarded.push(`${to.id} port ${port}`);
			return peer(to.id).openPort(hostId, sandboxId, port, sink);
		},
		rewelcome: async (to, hostId, welcome) => peer(to.id).rewelcome(hostId, welcome),
		disconnect: async (to, hostId, code, reason) => peer(to.id).disconnect(hostId, code, reason),
	};
	const replica = async (id: string) => {
		const node = createHostCluster({
			store,
			transport,
			replicaId: id,
			url: `http://${id}.internal:8080`,
			key: await createReplicaKey(),
			now,
			staleMs: 10_000,
			heartbeatMs: 60_000,
			log: () => undefined,
		});
		replicas.set(id, node);
		const service: HostsService = createHostsService({
			store: hosts,
			publicUrl: "https://kantel.example.com",
			clock: { now },
			cluster: node,
			log: () => undefined,
		});
		opened.push(service);
		await node.start();
		opened.push({ close: () => void node.stop().catch(() => undefined) });
		return { id, node, service };
	};
	const join = async (service: HostsService) => {
		const token = await service.createJoinToken({ name: "box" });
		return (await service.register({ token: token.token, facts: facts() })).hostId;
	};
	return { store, replica, join, forwarded, sharedUsage };
}

describe("gateway replicas", () => {
	it("send a host's calls, their events and its port streams to the replica holding its connection", async () => {
		const { replica, join, forwarded, store } = cluster();
		const a = await replica("rep_a");
		const b = await replica("rep_b");
		const hostId = await join(a.service);
		const host = new FakeHost(a.service, hostId);
		host.connect();
		await tick();
		expect(await store.getOwner(hostId)).toMatchObject({ replicaId: "rep_a", epoch: 1 });
		await b.node.tick();
		expect((await b.service.get(hostId)).state).toBe("online");

		// Placed, run and streamed from B; the host is on A.
		const created = await b.service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-far" });
		expect(created.hostId).toBe(hostId);
		const events: string[] = [];
		const result = await b.service.sandboxes.call(
			"sbx-far",
			"sandbox.exec",
			{ command: "echo hi" },
			{ onEvent: (event) => events.push(event.kind) },
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "hi\n" });
		expect(events).toEqual(["exec.output"]);
		const received: string[] = [];
		const stream = await b.service.sandboxes.openPort("sbx-far", 22, {
			data: (bytes) => received.push(new TextDecoder().decode(bytes)),
			end: () => undefined,
		});
		stream.write(new TextEncoder().encode("SSH-2.0-test"));
		expect(received).toEqual(["echo:SSH-2.0-test"]);
		expect(forwarded).toEqual(["rep_a sandbox.create", "rep_a sandbox.exec", "rep_a port 22"]);
		// A serves its own host itself.
		await a.service.sandboxes.call<HostSandbox>("sbx-far", "sandbox.stop");
		expect(forwarded).toHaveLength(3);
	});

	it("stop counting what they placed on a host held elsewhere once it reports again, so it isn't full for ever", async () => {
		let clock = 1_000_000;
		const { replica, join } = cluster({ now: () => clock });
		const a = await replica("rep_a");
		const b = await replica("rep_b");
		const hostId = await join(a.service);
		const host = new FakeHost(a.service, hostId);
		// Room for one `default` (2 GiB) at a time.
		host.freeMemoryMiB = 3_000;
		host.connect();
		await tick();
		await b.node.tick();
		const report = () =>
			host.send({
				type: "heartbeat",
				heartbeat: { capacity: { freeMemoryMiB: 3_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} } },
			});

		for (let round = 1; round <= 3; round++) {
			clock += 1_000;
			// B places on the host, through A; until the host reports again, B counts it.
			expect((await b.service.sandboxes.create({ tier: "microvm", sandboxId: `sbx-b${round}` })).hostId).toBe(hostId);
			await expect(b.service.sandboxes.create({ tier: "microvm" })).rejects.toSatisfy((error) =>
				isKantelError(error, "exhausted"),
			);
			await b.service.sandboxes.call(`sbx-b${round}`, "sandbox.delete");
			// The host's heartbeat reaches only A, which records it in the shared registry; B stops counting what it placed.
			clock += 1_000;
			report();
			await tick();
		}
		expect((await b.service.sandboxes.create({ tier: "microvm" })).hostId).toBe(hostId);
	});

	it("drain and revoke a host from any replica", async () => {
		const { replica, join } = cluster();
		const a = await replica("rep_a");
		const b = await replica("rep_b");
		const hostId = await join(a.service);
		const host = new FakeHost(a.service, hostId);
		host.connect();
		await tick();
		await b.service.update(hostId, { draining: true });
		await tick();
		expect(host.sent.filter((message) => message.type === "welcome").at(-1)?.welcome).toMatchObject({
			draining: true,
		});
		await b.service.revoke(hostId);
		await tick();
		expect(host.closedWith?.code).toBe(HOST_CLOSE_REVOKED);
	});

	it("follow a host that reconnects to another replica, and the old replica lets its stale connection go", async () => {
		const { replica, join, store } = cluster();
		const a = await replica("rep_a");
		const b = await replica("rep_b");
		const hostId = await join(a.service);
		const old = new FakeHost(a.service, hostId);
		old.connect();
		await tick();
		await a.service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-move" });

		// The balancer sends the host's next connection to B, before A has seen the old one close.
		const moved = new FakeHost(b.service, hostId);
		moved.connect([...old.sandboxes.values()]);
		await tick();
		expect(await store.getOwner(hostId)).toMatchObject({ replicaId: "rep_b", epoch: 2 });
		await a.node.tick();
		expect(old.closedWith?.code).toBe(4008);
		old.connection.closed(4008, "replaced");
		// The old connection's close doesn't release B's claim.
		await tick();
		expect(await store.getOwner(hostId)).toMatchObject({ replicaId: "rep_b", epoch: 2 });
		expect(await a.service.sandboxes.call("sbx-move", "sandbox.exec", { command: "true" }).then(() => "ran")).toBe(
			"ran",
		);
		expect(moved.sent.some((message) => message.method === "sandbox.exec")).toBe(true);
	});

	it("stop routing to a replica that stops (a rolling restart), and to one that died without saying so", async () => {
		let now = 1_000_000;
		const { replica, join, store } = cluster({ now: () => now });
		const a = await replica("rep_a");
		const b = await replica("rep_b");
		const hostId = await join(a.service);
		const host = new FakeHost(a.service, hostId);
		host.connect();
		await tick();
		await a.service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-x" });
		await b.node.tick();
		expect(b.service.hub.connected(hostId)).toBe(true);

		// A dies: it stops refreshing. Once it is stale, B no longer routes to it, and sweeps it later.
		now += 11_000;
		await b.node.tick();
		expect(b.service.hub.connected(hostId)).toBe(false);
		await expect(b.service.sandboxes.call("sbx-x", "sandbox.exec", {})).rejects.toSatisfy((error) =>
			isKantelError(error, "unavailable"),
		);
		now += 30_000;
		await b.node.tick();
		expect(await store.getReplica("rep_a")).toBeUndefined();
		expect(await store.getOwner(hostId)).toBeUndefined();

		// A comes back (the pause ends): it registers again and claims the host it still holds.
		await a.node.tick();
		expect(await store.getOwner(hostId)).toMatchObject({ replicaId: "rep_a" });
		await b.node.tick();
		expect(b.service.hub.connected(hostId)).toBe(true);

		// A stops for a restart: it forgets itself and its hosts at once.
		await a.node.stop();
		expect(await store.getOwner(hostId)).toBeUndefined();
		await b.node.tick();
		expect(b.service.hub.connected(hostId)).toBe(false);
	});

	it("record claims in SQL with epochs, so an old release never erases a newer claim", async () => {
		const database = await pgliteDatabase.open();
		opened.push({ close: () => void database.close() });
		await migrateRelay(database.driver);
		await migrateRelay(database.driver);
		const store = createSqlClusterStore(database.driver);
		await store.putReplica({ id: "rep_a", url: "http://a", publicKey: "k", startedAt: 1, heartbeatAt: 100 });
		await store.putReplica({ id: "rep_b", url: "http://b", publicKey: "k", startedAt: 1, heartbeatAt: 50 });
		expect(await store.claimHost("host_1", "rep_a", 10)).toBe(1);
		expect(await store.claimHost("host_1", "rep_b", 11)).toBe(2);
		await store.releaseHost("host_1", "rep_a", 1);
		expect(await store.getOwner("host_1")).toMatchObject({ replicaId: "rep_b", epoch: 2 });
		expect(await store.claimHost("host_2", "rep_a", 12)).toBe(1);
		expect((await store.liveReplicas(60)).map((replica) => replica.id)).toEqual(["rep_a"]);
		await store.sweepReplicas(60);
		expect(await store.getOwner("host_1")).toBeUndefined();
		expect(await store.getOwner("host_2")).toMatchObject({ replicaId: "rep_a" });
		await store.removeReplica("rep_a");
		expect(await store.owners()).toEqual([]);
	});
});

describe("usage ticks passed on to other replicas", () => {
	it("go to each peer one at a time, in the order they came, the oldest dropped past MAX_USAGE_QUEUE", async () => {
		const store = createMemoryClusterStore();
		const sent: string[] = [];
		let inFlight = 0;
		let most = 0;
		let release: () => void = () => undefined;
		const first = new Promise<void>((resolve) => {
			release = resolve;
		});
		const transport: PeerTransport = {
			call: async () => undefined,
			openPort: async () => {
				throw new Error("no");
			},
			rewelcome: async () => undefined,
			disconnect: async () => undefined,
			usage: async (to, hostId, usage) => {
				inFlight += 1;
				most = Math.max(most, inFlight);
				if (sent.length === 0) await first;
				sent.push(`${to.id} ${hostId} ${(usage as { at: number }).at}`);
				inFlight -= 1;
				// One that fails doesn't hold back the rest.
				if ((usage as { at: number }).at === 10) throw new Error("peer gone");
			},
		};
		const node = (id: string) =>
			createReplicaKey().then((key) =>
				createHostCluster({
					store,
					transport,
					replicaId: id,
					url: `http://${id}.internal:8080`,
					key,
					staleMs: 10_000,
					heartbeatMs: 60_000,
					log: () => undefined,
				}),
			);
		const b = await node("rep_b");
		await b.start();
		const a = await node("rep_a");
		await a.start();
		opened.push({ close: () => void a.stop().catch(() => undefined) });
		opened.push({ close: () => void b.stop().catch(() => undefined) });
		for (let at = 1; at <= MAX_USAGE_QUEUE + 3; at += 1) a.shareUsage(at % 2 === 0 ? "host_x" : "host_y", { at });
		release();
		await vi.waitFor(() => expect(sent).toHaveLength(MAX_USAGE_QUEUE + 1));
		expect(most).toBe(1);
		const order = sent.map((each) => Number(each.split(" ")[2]));
		// The first was on its way; of the rest, the newest MAX_USAGE_QUEUE.
		expect(order).toEqual([1, ...Array.from({ length: MAX_USAGE_QUEUE }, (_, index) => index + 4)]);
		expect(sent.every((each) => each.startsWith("rep_b "))).toBe(true);
		// Once drained, the next goes at once.
		a.shareUsage("host_x", { at: 1000 });
		await vi.waitFor(() => expect(sent.at(-1)).toBe("rep_b host_x 1000"));
	});
});

describe("usage ticks from a host held here", () => {
	it("are passed on only once taken here, in order, and not when taking them failed", async () => {
		const { replica, join, sharedUsage } = cluster();
		const a = await replica("rep_a");
		await replica("rep_b");
		const hostId = await join(a.service);
		const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
		a.service.useCompute({
			secrets: async () => undefined,
			recordEgress: async () => undefined,
			recordUsage: (_, usage) =>
				new Promise<void>((resolve, reject) => {
					pending.set(usage.seq ?? 0, { resolve, reject });
				}),
		});
		await a.node.tick();
		const host = new FakeHost(a.service, hostId, ["usage", "usage-acks"]);
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		const usage = (seq: number) => ({
			seq,
			run: "r1",
			at: 1_793_793_600_000 + seq * 5000,
			intervalMs: 5000,
			host: { cpu: 0.1, memUsedBytes: 1, memTotalBytes: 2, diskUsedBytes: 3, diskTotalBytes: 4 },
			sandboxes: [],
		});
		for (const seq of [1, 2, 3]) host.send({ type: "usage", usage: usage(seq) });
		await vi.waitFor(() => expect(pending.size).toBe(3));
		await tick();
		// Nothing goes on before it is taken here.
		expect(sharedUsage).toEqual([]);
		pending.get(1)?.resolve();
		pending.get(2)?.reject(new Error("store down"));
		pending.get(3)?.resolve();
		await vi.waitFor(() => expect(sharedUsage).toEqual(["rep_b 1", "rep_b 3"]));
	});
});

describe("requests between replicas", () => {
	it("are taken once, signed by a live replica, within the time allowed", async () => {
		let now = 5_000_000;
		const store = createMemoryClusterStore();
		const key = await createReplicaKey();
		const other = await createReplicaKey();
		await store.putReplica({
			id: "rep_a",
			url: "http://a",
			publicKey: key.publicKey,
			startedAt: now,
			heartbeatAt: now,
		});
		const verify = createPeerVerifier({ replicaId: "rep_b", store, staleMs: 10_000, now: () => now });
		const elsewhere = createPeerVerifier({ replicaId: "rep_c", store, staleMs: 10_000, now: () => now });
		const body = JSON.stringify({ hostId: "host_1", method: "sandbox.exec" });
		const toB = { from: "rep_a", to: "rep_b" };
		const signed = await signPeerRequest(key, toB, "call", body, now);
		const request = { replicaId: "rep_a", operation: "call", at: Number(signed.at), nonce: signed.nonce, body };
		expect(await verify({ ...request, signature: signed.signature })).toBe(true);
		// Played again, to it or to another replica, which hasn't seen its nonce.
		expect(await verify({ ...request, signature: signed.signature })).toBe(false);
		expect(await elsewhere({ ...request, signature: signed.signature })).toBe(false);

		const fresh = async (overrides: Partial<typeof request> = {}, signer = key, operation = "call", peers = toB) => {
			const made = await signPeerRequest(signer, peers, operation, body, now);
			return verify({ ...request, at: Number(made.at), nonce: made.nonce, signature: made.signature, ...overrides });
		};
		expect(await fresh()).toBe(true);
		expect(await fresh({ body: `${body} ` })).toBe(false);
		expect(await fresh({ operation: "disconnect" })).toBe(false);
		expect(await fresh({}, other)).toBe(false);
		expect(await fresh({ replicaId: "rep_unknown" })).toBe(false);
		expect(await fresh({}, key, "call", { from: "rep_a", to: "rep_c" })).toBe(false);
		expect(await fresh({ at: now - PEER_SKEW_MS - 1 })).toBe(false);
		// A replica gone stale is no longer believed.
		now += 11_000;
		expect(await fresh()).toBe(false);
	});
});
