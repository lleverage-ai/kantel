// A host's frames are untrusted (with account hosts, anyone who can add a machine to their own account has a host
// credential): after a valid hello, frames with null or malformed payloads go through the gateway's real WebSocket
// listener and hub. None of them may throw out of the socket callback into the gateway process; another host's
// connection and the gateway's routes carry on, and valid heartbeats and events still count.
import { HOSTS_CONNECT_PATH } from "@kantel/hosts/http";
import { createSqlHostStore } from "@kantel/hosts/store";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Cleanup, connectHost, joinHost, sharedDatabase, startReplica, wsUrl } from "./cluster-harness.ts";

const cleanups: Cleanup[] = [];

/**
 * What `read` answers once it is `want`, or its last answer after `timeoutMs`. These tests run on Vitest (ci.yml) and
 * Bun (selfhosted-spike.yml), so it stands in for Vitest's `expect.poll`, which Bun's `expect` doesn't have.
 */
async function eventually<T>(read: () => Promise<T>, want: T, timeoutMs = 5000): Promise<T> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value === want || Date.now() > until) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a host's malformed frames", () => {
	it("are contained: the gateway, its other hosts and valid frames carry on", async () => {
		const driver = await sharedDatabase(cleanups);
		const replica = await startReplica(driver, cleanups);
		const service = replica.relay.service;
		const mine = await joinHost(replica);
		const theirs = await joinHost(replica);
		const host = await connectHost(replica, mine.hostId, mine.credential, cleanups);
		const other = await connectHost(replica, theirs.hostId, theirs.credential, cleanups);

		const send = (frame: unknown) => host.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
		for (const frame of [
			{ type: "heartbeat", heartbeat: null },
			{ type: "heartbeat", heartbeat: 7 },
			{ type: "heartbeat", heartbeat: { capacity: null } },
			{ type: "event", event: null },
			{ type: "event", event: { kind: "sandbox.state", sandbox: null, at: 1 } },
			{ type: "event", event: { kind: "sandbox.state", sandbox: { id: 7 }, at: 1 } },
			{ type: "event", call: 9, event: { kind: "exec.output", at: 1 } },
			{ type: "result", id: "nothing-pending", error: null },
			{ type: "stream.close", stream: 99, reason: null },
			"not json",
			"null",
		]) {
			send(frame);
		}
		send(new Uint8Array([0, 0]));

		// A valid heartbeat after all of that still counts: the connection is alive and heard.
		send({
			type: "heartbeat",
			heartbeat: {
				capacity: { freeMemoryMiB: 1234, freeDiskGiB: 56, running: 0, stopped: 0, load1: 0.5, warm: {} },
			},
		});
		const registry = createSqlHostStore(driver);
		const heard = await eventually(async () => (await registry.getHost(mine.hostId))?.capacity?.freeMemoryMiB, 1234);
		expect(heard).toBe(1234);
		expect(service.hub.connected(mine.hostId)).toBe(true);
		expect(service.hub.connected(theirs.hostId)).toBe(true);
		// The gateway still answers.
		expect((await fetch(`${replica.url}/nothing-here`)).status).toBe(404);
		// And the other host's calls still go through.
		const before = other.calls.length;
		await service.hub.call(theirs.hostId, "sandbox.exec", { sandboxId: "sbx_x", command: "true" });
		expect(other.calls.length).toBe(before + 1);
	});

	it("refuse a hello whose refusal is long multibyte text with a close ws accepts", async () => {
		const driver = await sharedDatabase(cleanups);
		const replica = await startReplica(driver, cleanups);
		const odd = await joinHost(replica);
		const socket = new WebSocket(wsUrl(replica, HOSTS_CONNECT_PATH), {
			headers: { authorization: `Bearer ${odd.credential}` },
		});
		cleanups.push(() => socket.terminate());
		const closed = new Promise<{ code: number; reason: string }>((resolve) =>
			socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
		);
		await new Promise<void>((resolve, reject) => {
			socket.on("open", () => resolve());
			socket.on("error", reject);
		});
		socket.send(
			JSON.stringify({
				type: "hello",
				hello: { hostId: odd.hostId, facts: { protocol: "é".repeat(200) }, sandboxes: [], capacity: {} },
			}),
		);
		const { code, reason } = await closed;
		expect(code).toBe(4002);
		expect(reason).toMatch(/^This control plane speaks host protocol 1/);
		// The gateway still answers.
		expect((await fetch(`${replica.url}/nothing-here`)).status).toBe(404);
	});

	it("close a tunnel whose port.open the host refuses with long multibyte text, within a close frame's 123 bytes", async () => {
		const driver = await sharedDatabase(cleanups);
		const replica = await startReplica(driver, cleanups);
		const odd = await joinHost(replica);
		await connectHost(replica, odd.hostId, odd.credential, cleanups, [], { portOpenError: "é".repeat(120) });
		const made = await replica.relay.service.sandboxes.create({ tier: "microvm" });
		const ticket = await replica.relay.tickets.issue({
			sandboxId: made.sandbox.id,
			port: 22,
			expiresAt: Date.now() + 60_000,
		});
		const client = new WebSocket(wsUrl(replica, `/v1/hosts/tunnel/${ticket}`));
		cleanups.push(() => client.terminate());
		// `ws` gives the reason as a Buffer on Node, Bun's as a string: its bytes are counted the same either way.
		const { code, reason } = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
			client.on("close", (closeCode, closeReason) => resolve({ code: closeCode, reason: String(closeReason) }));
			client.on("error", reject);
		});
		expect(code).toBe(1011);
		expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(123);
		expect(reason).toMatch(/^é+$/);
		// The gateway and the host's connection carry on.
		expect((await fetch(`${replica.url}/nothing-here`)).status).toBe(404);
		expect(replica.relay.service.hub.connected(odd.hostId)).toBe(true);
	});
});
