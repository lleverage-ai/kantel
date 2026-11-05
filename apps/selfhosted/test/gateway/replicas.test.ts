// Two gateway replicas over one database, as behind a load balancer: real HTTP servers, a host speaking the protocol
// over a real WebSocket to one of them, and the replicas reaching each other over HTTP and WebSocket, signed. Whatever
// replica a request lands on reaches the host; a tunnel URL either gave out works on both; revoking the host from the
// other replica closes its connection; and in a rolling restart the host moves and the routing follows it.
import { createReplicaKey, createSqlClusterStore } from "@kantel/hosts/cluster";
import { HOST_CLOSE_REVOKED } from "@kantel/hosts/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPeerTransport } from "../../src/gateway/cluster.ts";
import {
	type Cleanup,
	connectHost,
	joinHost,
	openSession,
	sharedDatabase,
	startReplica,
	wsUrl,
} from "./cluster-harness.ts";

const cleanups: Cleanup[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const echoThrough = async (target: { url: string }, ticket: string) => {
	const session = await openSession(wsUrl(target, `/v1/hosts/tunnel/${ticket}`), cleanups);
	const echoed = await new Promise<string>((resolve) => {
		session.socket.once("message", (data) => resolve(data.toString()));
		session.socket.send(Buffer.from("again"), { binary: true });
	});
	session.socket.close();
	return echoed;
};

describe("gateway replicas behind a load balancer", { timeout: 30_000 }, () => {
	it("reach a host connected to either one: calls, their events, and tunnels from both", async () => {
		const driver = await sharedDatabase(cleanups);
		const a = await startReplica(driver, cleanups);
		const b = await startReplica(driver, cleanups);
		const { hostId, credential } = await joinHost(b);
		const host = await connectHost(a, hostId, credential, cleanups);
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
		expect(await echoThrough(b, fromA)).toBe("echo:again");
		expect(await echoThrough(a, fromB)).toBe("echo:again");
	});

	it("revoke a host from the replica it isn't connected to", async () => {
		const driver = await sharedDatabase(cleanups);
		const a = await startReplica(driver, cleanups);
		const b = await startReplica(driver, cleanups);
		const { hostId, credential } = await joinHost(a);
		const host = await connectHost(a, hostId, credential, cleanups);
		await b.relay.service.revoke(hostId);
		expect(await host.closed).toBe(HOST_CLOSE_REVOKED);
	});

	it("follow a host through a rolling restart", async () => {
		const driver = await sharedDatabase(cleanups);
		const a = await startReplica(driver, cleanups);
		const b = await startReplica(driver, cleanups);
		const { hostId, credential } = await joinHost(a);
		const first = await connectHost(a, hostId, credential, cleanups);
		await a.relay.service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-roll" });

		// A stops: the host is told to go (1001), and reconnects through the balancer to B.
		await a.stop();
		// The gateway sends 1001 on Bun and Node alike (kantel-host reads it so), but Bun's WebSocket client reports a
		// 1001 it receives as 1000. The reason shows it is the stop's close, not a dropped socket (1006).
		expect(await first.closed).toBe("Bun" in globalThis ? 1000 : 1001);
		expect(await first.reason).toBe("The control plane is stopping");
		const second = await connectHost(b, hostId, credential, cleanups, first.sandboxes());
		// A new replica takes A's place, and reaches the host on B.
		const c = await startReplica(driver, cleanups);
		await c.cluster.cluster.tick();
		expect(await c.relay.service.sandboxes.call("sbx-roll", "sandbox.exec", { command: "true" })).toMatchObject({
			exitCode: 0,
		});
		expect(second.calls).toEqual(["sandbox.exec"]);
		const ticket = await c.relay.tickets.issue({ sandboxId: "sbx-roll", port: 5901, expiresAt: Date.now() + 60_000 });
		expect(await echoThrough(c, ticket)).toBe("echo:again");
	});

	it("pass a host's usage ticks on to each other, taken only from the replica holding the host", async () => {
		const driver = await sharedDatabase(cleanups);
		const a = await startReplica(driver, cleanups);
		const b = await startReplica(driver, cleanups);
		const recorded = { a: vi.fn(async () => undefined), b: vi.fn(async () => undefined) };
		for (const [name, replica] of [
			["a", a],
			["b", b],
		] as const) {
			replica.relay.service.useCompute({
				secrets: async () => undefined,
				recordEgress: async () => undefined,
				recordUsage: recorded[name],
			});
			replica.cluster.useUsage((hostId, usage) => replica.relay.service.recordSharedUsage(hostId, usage));
		}
		const { hostId, credential } = await joinHost(a);
		const host = await connectHost(a, hostId, credential, cleanups);
		await a.cluster.cluster.tick();
		const usage = {
			at: Date.now(),
			intervalMs: 5000,
			host: { cpu: 0.25, memUsedBytes: 1, memTotalBytes: 2, diskUsedBytes: 3, diskTotalBytes: 4 },
			sandboxes: [{ id: "sbx-1", kind: "microvm", cpu: 0.5, memUsedBytes: 5, memLimitBytes: 6 }],
		};
		host.socket.send(JSON.stringify({ type: "usage", usage }));
		// Polled by hand: `bun test`, which main's self-hosted job runs this under, has no `vi.waitFor`.
		for (const deadline = Date.now() + 5000; recorded.b.mock.calls.length === 0 && Date.now() < deadline; ) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(recorded.b).toHaveBeenCalledTimes(1);
		expect(recorded.a).toHaveBeenCalledWith(hostId, usage);
		expect(recorded.b).toHaveBeenCalledWith(hostId, usage, { shared: true });

		// A replica that doesn't hold the host can't speak for it, even signed.
		const store = createSqlClusterStore(driver);
		const key = await createReplicaKey();
		const now = Date.now();
		await store.putReplica({
			id: "rep_other",
			url: "http://127.0.0.1:1",
			publicKey: key.publicKey,
			startedAt: now,
			heartbeatAt: now,
		});
		const peerA = await store.getReplica(a.cluster.cluster.replicaId);
		if (peerA === undefined) throw new Error("replica A isn't registered");
		const other = createPeerTransport({ replicaId: "rep_other", key });
		await expect(other.usage?.(peerA, hostId, usage)).rejects.toThrow(/409/);
		expect(recorded.a).toHaveBeenCalledTimes(1);
	});
});
