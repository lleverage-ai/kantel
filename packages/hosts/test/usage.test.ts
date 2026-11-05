// A host's `usage` ticks on the link: checked and normalised, handed to compute's `recordUsage` for a welcomed host,
// and an invalid one dropped (logged at most once an hour per host).
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_USAGE_SANDBOXES, parseHostUsage } from "../src/facts.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { FakeHost, facts } from "./fake-host.ts";

const TICK = {
	at: 1_793_793_600_000,
	intervalMs: 5000,
	host: { cpu: 0.42, memUsedBytes: 8e9, memTotalBytes: 64e9, diskUsedBytes: 1e11, diskTotalBytes: 5e11 },
	sandboxes: [
		{ id: "sbx_a", kind: "microvm", cpu: 0.1, memUsedBytes: 2e8, memLimitBytes: 1e9, memSource: "guest" },
		{ id: "sbx_b", kind: "isolate", cpu: 0.02, memUsedBytes: 3e7, memLimitBytes: 0, memSource: "rss" },
	],
};

describe("parseHostUsage", () => {
	it("takes a tick as kantel-host sends it", () => {
		expect(parseHostUsage(TICK)).toEqual({ ok: true, value: TICK });
	});

	it("takes the frame kantel-host's Go side marshals, with sandboxes or with none (a nil slice)", () => {
		// As in usage-compat.test.ts, from TestUsageEventWireShape in apps/host/internal/agent/usage_test.go.
		const frame = JSON.parse(
			'{"type":"usage","usage":{"at":1,"intervalMs":5000,"host":{"cpu":0.25,"memUsedBytes":1,"memTotalBytes":2,"diskUsedBytes":3,"diskTotalBytes":4},"sandboxes":[{"id":"sbx_a","kind":"microvm","cpu":0.5,"memUsedBytes":5,"memLimitBytes":6,"memSource":"guest"}]}}',
		) as { usage: { sandboxes: unknown } };
		expect(parseHostUsage(frame.usage)).toEqual({ ok: true, value: frame.usage });
		expect(parseHostUsage({ ...frame.usage, sandboxes: null })).toMatchObject({ ok: true, value: { sandboxes: [] } });
	});

	it("takes CPU above 1 as 1, null sandboxes as none, and leaves out a kind it doesn't know", () => {
		const parsed = parseHostUsage({
			...TICK,
			host: { ...TICK.host, cpu: 1.2 },
			sandboxes: [...TICK.sandboxes, { id: "sbx_c", kind: "wasm", cpu: 0, memUsedBytes: 0, memLimitBytes: 0 }],
		});
		expect(parsed.ok && parsed.value.host.cpu).toBe(1);
		expect(parsed.ok && parsed.value.sandboxes.map((each) => each.id)).toEqual(["sbx_a", "sbx_b"]);
		expect(parseHostUsage({ ...TICK, sandboxes: null })).toMatchObject({ ok: true, value: { sandboxes: [] } });
	});

	it("takes a reading with no memory source (an older host's) and leaves out a source it doesn't know", () => {
		const older = { id: "sbx_a", kind: "microvm", cpu: 0.1, memUsedBytes: 2e8, memLimitBytes: 1e9 };
		const parsed = parseHostUsage({
			...TICK,
			sandboxes: [older, { ...older, id: "sbx_n", memSource: "psi" }, { ...older, id: "sbx_x", memSource: 3 }],
		});
		expect(parsed).toEqual({
			ok: true,
			value: { ...TICK, sandboxes: [older, { ...older, id: "sbx_n" }, { ...older, id: "sbx_x" }] },
		});
	});

	it("takes a microVM's disk and IO pressure, and leaves out figures that make no sense without refusing the tick", () => {
		const reading = { id: "sbx_a", kind: "microvm", cpu: 0.1, memUsedBytes: 2e8, memLimitBytes: 1e9 };
		const full = { ...reading, diskUsedBytes: 3e9, diskTotalBytes: 1e10, ioPressure: 0.25 };
		const parsed = parseHostUsage({
			...TICK,
			sandboxes: [
				full,
				{ ...reading, id: "sbx_d", diskUsedBytes: 2e10, diskTotalBytes: 1e10, ioPressure: 1.5 },
				{ ...reading, id: "sbx_e", diskUsedBytes: 3e9, ioPressure: -1 },
				{ ...reading, id: "sbx_f", diskUsedBytes: "3e9", diskTotalBytes: 1e10, ioPressure: Number.NaN },
			],
		});
		expect(parsed).toEqual({
			ok: true,
			value: {
				...TICK,
				sandboxes: [full, { ...reading, id: "sbx_d" }, { ...reading, id: "sbx_e" }, { ...reading, id: "sbx_f" }],
			},
		});
	});

	it("refuses one that isn't shaped as a tick", () => {
		const reasons = [
			{ ...TICK, at: "now" },
			{ ...TICK, intervalMs: 10 },
			{ ...TICK, host: undefined },
			{ ...TICK, host: { ...TICK.host, memUsedBytes: -1 } },
			{ ...TICK, sandboxes: [{ ...TICK.sandboxes[0], cpu: Number.NaN }] },
			{ ...TICK, sandboxes: Array.from({ length: MAX_USAGE_SANDBOXES + 1 }, () => TICK.sandboxes[0]) },
		].map((each) => parseHostUsage(each));
		for (const reason of reasons) expect(reason.ok).toBe(false);
	});
});

const services: HostsService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
});

describe("the link's usage message", () => {
	it("reaches recordUsage checked, for a welcomed host only", async () => {
		const logs: string[] = [];
		const service = createHostsService({
			store: createMemoryHostStore(),
			publicUrl: "https://kantel.example.com/",
			clock: { now: () => 1_000 },
			log: (message) => logs.push(message),
		});
		services.push(service);
		const recordUsage = vi.fn(async () => undefined);
		service.useCompute({ secrets: async () => undefined, recordEgress: async () => undefined, recordUsage });
		const token = await service.createJoinToken({ name: "box" });
		const { hostId } = await service.register({ token: token.token, facts: facts() });
		const host = new FakeHost(service, hostId, ["usage"]);
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));

		host.send({ type: "usage", usage: { ...TICK, host: { ...TICK.host, cpu: 7 } } });
		await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
		expect(recordUsage).toHaveBeenCalledWith(hostId, { ...TICK, host: { ...TICK.host, cpu: 1 } });

		host.send({ type: "usage", usage: { ...TICK, intervalMs: 1 } });
		host.send({ type: "usage", usage: { ...TICK, intervalMs: 2 } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(recordUsage).toHaveBeenCalledTimes(1);
		expect(logs.filter((line) => line.includes("usage tick"))).toHaveLength(1);
	});
});

/** A service with compute's `recordUsage` (absent, `compute: false`), and a joined host's id. */
async function linked(recordUsage?: (hostId: string, usage: unknown) => Promise<void>) {
	const service = createHostsService({
		store: createMemoryHostStore(),
		publicUrl: "https://kantel.example.com/",
		clock: { now: () => 1_000 },
		log: () => undefined,
	});
	services.push(service);
	if (recordUsage !== undefined) {
		service.useCompute({ secrets: async () => undefined, recordEgress: async () => undefined, recordUsage });
	}
	const token = await service.createJoinToken({ name: "box" });
	const { hostId } = await service.register({ token: token.token, facts: facts() });
	return { service, hostId };
}

const acks = (host: FakeHost) =>
	host.sent.filter((message) => message.type === "usage.ack").map((message) => message.acked);

describe("acknowledged usage ticks (usage-acks)", () => {
	it("parse run and seq both or neither, and leave a tick without them as an older host's", () => {
		expect(parseHostUsage({ ...TICK, seq: 3, run: "0123456789abcdef" })).toMatchObject({
			ok: true,
			value: { seq: 3, run: "0123456789abcdef" },
		});
		for (const odd of [
			{ seq: 3 },
			{ run: "r" },
			{ seq: 0, run: "r" },
			{ seq: 1.5, run: "r" },
			{ seq: 2, run: "" },
			{ seq: 2, run: "x".repeat(65) },
		]) {
			const parsed = parseHostUsage({ ...TICK, ...odd });
			expect(parsed.ok).toBe(true);
			expect(parsed.ok && "seq" in parsed.value).toBe(false);
			expect(parsed.ok && "run" in parsed.value).toBe(false);
		}
	});

	it("are acknowledged once compute has taken them, in order, and never one compute failed to take", async () => {
		const holds = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
		const { service, hostId } = await linked(
			(_, usage) =>
				new Promise<void>((resolve, reject) => {
					holds.set((usage as { seq: number }).seq, { resolve, reject });
				}),
		);
		const host = new FakeHost(service, hostId, ["usage", "usage-acks"]);
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		expect(host.sent.find((message) => message.type === "welcome")?.welcome?.usageAcks).toBe(true);
		for (let seq = 1; seq <= 4; seq += 1) host.send({ type: "usage", usage: { ...TICK, seq, run: "r1" } });
		await vi.waitFor(() => expect(holds.size).toBe(4));
		// Nothing is acknowledged before it is taken.
		expect(acks(host)).toEqual([]);
		holds.get(1)?.resolve();
		await vi.waitFor(() => expect(acks(host)).toEqual([1]));
		// 2 fails, and compute fails those after it too (it holds them until 2 is in): none is acknowledged, so the host
		// sends them again.
		holds.get(2)?.reject(new Error("store down"));
		holds.get(3)?.reject(new Error("store down"));
		holds.get(4)?.reject(new Error("store down"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(acks(host)).toEqual([1]);

		// On the next connection, the ticks again: acknowledged as taken.
		const again = new FakeHost(service, hostId, ["usage", "usage-acks"]);
		again.connect();
		await vi.waitFor(() => expect(again.welcomed()).toBe(true));
		holds.clear();
		for (let seq = 2; seq <= 4; seq += 1) again.send({ type: "usage", usage: { ...TICK, seq, run: "r1" } });
		await vi.waitFor(() => expect(holds.size).toBe(3));
		holds.get(4)?.resolve();
		holds.get(2)?.resolve();
		holds.get(3)?.resolve();
		await vi.waitFor(() => expect(acks(again).at(-1)).toBe(4));
		// Acks only go forward, however the promises settled.
		expect(acks(again)).toEqual([...acks(again)].sort());
	});

	it("aren't acknowledged by a gateway with no compute link, whose welcome doesn't offer them", async () => {
		const { service, hostId } = await linked();
		const host = new FakeHost(service, hostId, ["usage", "usage-acks"]);
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		expect(host.sent.find((message) => message.type === "welcome")?.welcome?.usageAcks).toBeUndefined();
		host.send({ type: "usage", usage: { ...TICK, seq: 1, run: "r1" } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(acks(host)).toEqual([]);
	});

	it("leave an older host's unnumbered ticks unacknowledged, and taken as before", async () => {
		const recordUsage = vi.fn(async () => undefined);
		const { service, hostId } = await linked(recordUsage);
		const host = new FakeHost(service, hostId, ["usage"]);
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		host.send({ type: "usage", usage: TICK });
		await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledWith(hostId, TICK));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(acks(host)).toEqual([]);
		expect(host.closedWith).toBeUndefined();
	});
});
