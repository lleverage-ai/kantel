// A host cut off without a close (a silent partition) is taken as gone within the heartbeat deadline, not when TCP
// gives up minutes later: a welcomed connection that carries nothing for longer than it is closed with 4009, the host
// shows disconnected, and its calls fail at once. Anything from the host keeps the connection, not only heartbeats.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostHub, HostCallError, type HostHub, type HostHubOptions } from "../src/hub.ts";
import { HOST_CLOSE_SILENT, type HostMessage } from "../src/protocol.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { FakeHost, facts } from "./fake-host.ts";

const hubs: HostHub[] = [];
const services: HostsService[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const hub of hubs.splice(0)) hub.closeAll(1000, "done");
	for (const service of services.splice(0)) service.close();
	vi.useRealTimers();
});

const HELLO = JSON.stringify({
	type: "hello",
	hello: {
		hostId: "host_a",
		facts: facts(),
		sandboxes: [],
		capacity: { freeMemoryMiB: 1, freeDiskGiB: 1, running: 0, stopped: 0, load1: 0 },
	},
});
const HEARTBEAT = JSON.stringify({
	type: "heartbeat",
	heartbeat: { capacity: { freeMemoryMiB: 1, freeDiskGiB: 1, running: 0, stopped: 0, load1: 0 } },
});

/** A hub with one welcomed host whose socket delivers only what the test feeds it. */
async function connected(options: Partial<HostHubOptions> = {}, heartbeatSeconds = 15) {
	const onDisconnected = vi.fn();
	const hub = createHostHub({
		onHello: async (hostId) => ({ hostId, heartbeatSeconds }),
		onDisconnected,
		...options,
	});
	hubs.push(hub);
	const sent: HostMessage[] = [];
	const closed: { code: number; reason: string }[] = [];
	const accepted = hub.accept("host_a", {
		sendText: (text) => sent.push(JSON.parse(text) as HostMessage),
		sendBinary: () => undefined,
		close: (code, reason) => closed.push({ code, reason }),
	});
	accepted.receive(HELLO);
	await vi.advanceTimersByTimeAsync(0);
	expect(sent.some((message) => message.type === "welcome")).toBe(true);
	expect(hub.connected("host_a")).toBe(true);
	return { hub, accepted, sent, closed, onDisconnected };
}

describe("the heartbeat deadline", () => {
	it("closes a welcomed connection silent for three heartbeats, and fails its calls at once", async () => {
		const { hub, sent, closed, onDisconnected } = await connected();
		const call = hub.call("host_a", "sandbox.list", {}).catch((error: unknown) => error);
		expect(sent.some((message) => message.type === "call")).toBe(true);

		await vi.advanceTimersByTimeAsync(44_999);
		expect(hub.connected("host_a")).toBe(true);
		expect(closed).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(closed).toEqual([{ code: HOST_CLOSE_SILENT, reason: "Nothing from the host for 45 s" }]);
		expect(hub.connected("host_a")).toBe(false);
		expect(hub.connectedHosts()).toEqual([]);
		expect(onDisconnected).toHaveBeenCalledWith("host_a");
		// The call waiting on it fails now, as unanswered, not after its own 120 s timeout.
		const error = await call;
		expect(error).toBeInstanceOf(HostCallError);
		expect((error as HostCallError).disconnected).toBe(true);
		expect((error as HostCallError).unanswered).toBe(true);
		await expect(hub.call("host_a", "sandbox.list", {})).rejects.toMatchObject({ disconnected: true });
	});

	it("keeps a connection whose host goes on beating, or sends anything else", async () => {
		const { hub, accepted, closed } = await connected();
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(15_000);
			accepted.receive(HEARTBEAT);
		}
		// Not a heartbeat, but the host is there: a usage tick, then a stream frame.
		await vi.advanceTimersByTimeAsync(40_000);
		accepted.receive(JSON.stringify({ type: "usage", usage: {} }));
		await vi.advanceTimersByTimeAsync(40_000);
		accepted.receive(new Uint8Array([0, 0, 0, 1, 7]));
		await vi.advanceTimersByTimeAsync(40_000);
		expect(closed).toEqual([]);
		expect(hub.connected("host_a")).toBe(true);
		// Then silence.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(closed.map((c) => c.code)).toEqual([HOST_CLOSE_SILENT]);
		expect(hub.connected("host_a")).toBe(false);
	});

	it("follows the welcome's heartbeat interval, or the deadline it is given, and 0 turns it off", async () => {
		const slow = await connected({}, 60);
		await vi.advanceTimersByTimeAsync(179_000);
		expect(slow.hub.connected("host_a")).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(slow.hub.connected("host_a")).toBe(false);

		const given = await connected({ heartbeatDeadlineMs: 5_000 });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(given.closed.map((c) => c.code)).toEqual([HOST_CLOSE_SILENT]);

		const off = await connected({ heartbeatDeadlineMs: 0 });
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(off.closed).toEqual([]);
		expect(off.hub.connected("host_a")).toBe(true);
	});

	it("leaves a host that hasn't said hello to the hello timeout, and stops watching a connection that closed", async () => {
		const onDisconnected = vi.fn();
		const hub = createHostHub({ onHello: async (hostId) => ({ hostId, heartbeatSeconds: 15 }), onDisconnected });
		hubs.push(hub);
		const closed: number[] = [];
		const socket = {
			sendText: () => undefined,
			sendBinary: () => undefined,
			close: (code: number) => closed.push(code),
		};
		hub.accept("host_a", socket);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(closed).toEqual([4002]);

		const { accepted, closed: second, onDisconnected: gone } = await connected();
		accepted.closed(1006, "gone");
		expect(gone).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(second).toEqual([]);
		expect(gone).toHaveBeenCalledTimes(1);
	});
});

describe("a host that goes silent", () => {
	it("is shown unreachable within the deadline, and online again once it reconnects", async () => {
		const service = createHostsService({
			store: createMemoryHostStore(),
			publicUrl: "https://kantel.example.com/",
			log: () => undefined,
		});
		services.push(service);
		const token = await service.createJoinToken({ name: "a" });
		const { hostId } = await service.register({ token: token.token, facts: facts() });
		const host = new FakeHost(service, hostId);
		host.connect();
		await vi.advanceTimersByTimeAsync(10);
		expect(host.welcomed()).toBe(true);
		expect((await service.get(hostId)).state).toBe("online");

		await vi.advanceTimersByTimeAsync(45_000);
		expect(host.closedWith?.code).toBe(HOST_CLOSE_SILENT);
		expect(service.hub.connected(hostId)).toBe(false);
		expect((await service.get(hostId)).state).toBe("unreachable");

		// Once the link heals, the host's next write fails and it connects again.
		const back = new FakeHost(service, hostId);
		back.connect();
		await vi.advanceTimersByTimeAsync(10);
		expect((await service.get(hostId)).state).toBe("online");
	});
});
