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
		{ id: "sbx_a", kind: "microvm", cpu: 0.1, memUsedBytes: 2e8, memLimitBytes: 1e9 },
		{ id: "sbx_b", kind: "isolate", cpu: 0.02, memUsedBytes: 3e7, memLimitBytes: 0 },
	],
};

describe("parseHostUsage", () => {
	it("takes a tick as kantel-host sends it", () => {
		expect(parseHostUsage(TICK)).toEqual({ ok: true, value: TICK });
	});

	it("takes the frame kantel-host's Go side marshals, with sandboxes or with none (a nil slice)", () => {
		// As in usage-compat.test.ts, from TestUsageEventWireShape in apps/host/internal/agent/usage_test.go.
		const frame = JSON.parse(
			'{"type":"usage","usage":{"at":1,"intervalMs":5000,"host":{"cpu":0.25,"memUsedBytes":1,"memTotalBytes":2,"diskUsedBytes":3,"diskTotalBytes":4},"sandboxes":[{"id":"sbx_a","kind":"microvm","cpu":0.5,"memUsedBytes":5,"memLimitBytes":6}]}}',
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
