// Two gateway replicas over one database, as behind a load balancer: real HTTP servers, a host speaking the protocol
// over a real WebSocket to one of them, and the replicas reaching each other over HTTP and WebSocket, signed. Whatever
// replica a request lands on reaches the host; a tunnel URL either gave out works on both; revoking the host from the
// other replica closes its connection; and in a rolling restart the host moves and the routing follows it.
import { HOST_CLOSE_REVOKED } from "@kantel/hosts/protocol";
import { afterEach, describe, expect, it } from "vitest";
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
		expect(await first.closed).toBe(1001);
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
});
