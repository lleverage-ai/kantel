// Usage series: hosts' ticks kept per sandbox and per host (bounded), read with `since`, folded into the 5-minute
// sparklines `recentCpu` and `recentMemory`, fed to the metrics export, and the exec read kept only for a host that
// doesn't send ticks yet. The stub makes up its own ticks, so graphs move with no host.
import { createKantelClient } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend, UsageSample } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { FALLBACK_INTERVAL_MS, MAX_SAMPLES, spanMean } from "../src/service.ts";
import { type ComputeStore, createMemoryStore } from "../src/store.ts";
import { createStubBackend, STUB_HOST_ID, stubReading } from "../src/stub-backend.ts";
import {
	createUsageSeries,
	MAX_RAW_POINTS,
	RAW_WINDOW_MS,
	type ReportedUsage,
	ROLLUP_MS,
	ROLLUP_POINTS,
	USAGE_INTERVAL_MS,
} from "../src/usage-series.ts";

const BASE_URL = "http://compute.test/v1";
const MIB = 1024 * 1024;
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};

const opened: ComputeApi[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

/** A point at `at`, its CPU and memory. */
const point = (at: number, cpu = 0.5, memUsedBytes = 100) => ({ at, cpu, memUsedBytes, diskUsedBytes: 0 });

describe("a usage series", () => {
	it("keeps points in order, drops repeats and clamps what came", () => {
		const series = createUsageSeries();
		series.add("s", point(10_000, 0.2), { intervalMs: 5000 });
		series.add("s", point(10_000, 0.9), { intervalMs: 5000 });
		series.add("s", point(5_000, 0.9), { intervalMs: 5000 });
		series.add("s", { at: 15_000, cpu: 3, memUsedBytes: -5, diskUsedBytes: Number.NaN }, { intervalMs: 5000 });
		expect(series.read("s").points).toEqual([
			{ at: 10_000, cpu: 0.2, memUsedBytes: 100, diskUsedBytes: 0 },
			{ at: 15_000, cpu: 1, memUsedBytes: 0, diskUsedBytes: 0 },
		]);
	});

	it("keeps an hour as it came, at most MAX_RAW_POINTS", () => {
		const series = createUsageSeries();
		const start = 1_000_000_000_000;
		// Two hours at 5 seconds.
		for (let at = start; at < start + 2 * RAW_WINDOW_MS; at += USAGE_INTERVAL_MS) {
			series.add("s", point(at), { intervalMs: USAGE_INTERVAL_MS });
		}
		const { points } = series.read("s");
		expect(points).toHaveLength(MAX_RAW_POINTS);
		const last = points[points.length - 1]?.at ?? 0;
		expect(last - (points[0]?.at ?? 0)).toBeLessThan(RAW_WINDOW_MS);
		// At one a second, the most kept bounds it before the hour does.
		const fast = createUsageSeries();
		for (let at = start; at < start + 20 * 60_000; at += 1000) fast.add("f", point(at), { intervalMs: 1000 });
		expect(fast.read("f").points).toHaveLength(MAX_RAW_POINTS);
	});

	it("answers only the points after `since`", () => {
		const series = createUsageSeries();
		for (let at = 5_000; at <= 50_000; at += 5_000) series.add("s", point(at), { intervalMs: 5000 });
		expect(series.read("s", 40_000).points.map((each) => each.at)).toEqual([45_000, 50_000]);
		expect(series.read("s", 50_000).points).toEqual([]);
		expect(series.read("s", 0).points).toHaveLength(10);
		expect(series.read("nobody", 0)).toEqual({ meta: undefined, points: [] });
	});

	it("folds points into 5-minute means, closing one when the next begins, and keeps a day of them", () => {
		const series = createUsageSeries();
		const start = ROLLUP_MS * 1000;
		expect(series.add("s", point(start, 0.2, 100), { intervalMs: 5000 })).toBeUndefined();
		expect(series.add("s", point(start + 5000, 0.4, 300), { intervalMs: 5000 })).toBeUndefined();
		expect(series.partial("s")).toEqual({
			at: start,
			cpu: 0.30000000000000004,
			memUsedBytes: 200,
			diskUsedBytes: 0,
			readings: 2,
			local: true,
		});
		const closed = series.add("s", point(start + ROLLUP_MS, 1, 1000), { intervalMs: 5000 });
		expect(closed).toMatchObject({ at: start, memUsedBytes: 200 });
		expect(closed?.cpu).toBeCloseTo(0.3);
		expect(series.rollups("s").map((each) => each.at)).toEqual([start, start + ROLLUP_MS]);
		for (let step = 2; step < ROLLUP_POINTS + 10; step += 1) {
			series.add("s", point(start + step * ROLLUP_MS), { intervalMs: 5000 });
		}
		expect(series.rollups("s", 10_000)).toHaveLength(ROLLUP_POINTS + 1);
	});

	it("closes the mean of a series that stopped, and forgets it after a day", () => {
		const series = createUsageSeries();
		const start = ROLLUP_MS * 1000;
		series.add("s", point(start), { intervalMs: 5000 });
		expect(series.settle(start + ROLLUP_MS)).toEqual([]);
		const mean = { ...point(start), readings: 1, local: true };
		expect(series.settle(start + ROLLUP_MS + 10_000)).toEqual([{ key: "s", rollup: mean }]);
		expect(series.keys()).toEqual(["s"]);
		// A point late for the closed 5 minutes is kept, but makes no second mean for them.
		series.add("s", point(start + 20_000, 1), { intervalMs: 5000 });
		expect(series.read("s").points).toHaveLength(2);
		expect(series.rollups("s")).toEqual([mean]);
		series.settle(start + ROLLUP_MS * (ROLLUP_POINTS + 2));
		expect(series.keys()).toEqual([]);
	});

	it("says whether a mean has a point taken here, not only ones another replica passed on", () => {
		const series = createUsageSeries();
		const start = ROLLUP_MS * 1000;
		series.add("passed", { ...point(start), shared: true }, { intervalMs: 5000 });
		series.add("mixed", { ...point(start), shared: true }, { intervalMs: 5000 });
		series.add("mixed", point(start + 5000), { intervalMs: 5000 });
		expect(series.partial("passed")).toMatchObject({ readings: 1, local: false });
		expect(series.partial("mixed")).toMatchObject({ readings: 2, local: true });
		expect(series.read("mixed").points.map((each) => each.shared === true)).toEqual([true, false]);
	});
});

/** The stub without its own ticks, counting its exec-style reads, on a clock the test moves. */
function hostless(clock: () => number) {
	const { usageReports: _, ...stub } = createStubBackend({ now: clock });
	const reads: string[] = [];
	const backend: SandboxBackend = {
		...stub,
		usage: async (sandboxId): Promise<UsageSample> => {
			reads.push(sandboxId);
			return { cpu: 0.25, memoryBytes: 300 * MIB };
		},
	};
	return { backend, reads };
}

function setup(backend: SandboxBackend, clock: () => number, store?: ComputeStore) {
	const api = createComputeApi({
		backend,
		now: clock,
		...(store === undefined ? {} : { store }),
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const client = (token: string) =>
		createKantelClient({
			baseUrl: BASE_URL,
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, tom: client("tom-token"), root: client("root-token") };
}

/** A host's tick at `at`, for `sandboxes`. */
function tick(at: number, sandboxes: ReportedUsage["sandboxes"], cpu = 0.4): ReportedUsage {
	return {
		at,
		intervalMs: USAGE_INTERVAL_MS,
		host: { cpu, memUsedBytes: 8 * 1024 * MIB, memTotalBytes: 64 * 1024 * MIB, diskUsedBytes: 10, diskTotalBytes: 100 },
		sandboxes,
	};
}

describe("a host's usage ticks", () => {
	it("are kept per sandbox and per host, read with since, and never exec'd for", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend, reads } = hostless(() => clock);
		const { api, tom, root } = setup(backend, () => clock);
		const vm = await tom.createSandbox({ type: "microvm", size: "small", wait: true });
		const reading = (cpu: number) => [
			{ id: vm.id, kind: "microvm" as const, cpu, memUsedBytes: 200 * MIB, memLimitBytes: 1024 * MIB },
		];
		const first = clock;
		for (let index = 0; index < 6; index += 1) {
			clock = first + index * USAGE_INTERVAL_MS;
			await api.service.recordUsage(STUB_HOST_ID, tick(clock, reading(index / 10)));
		}

		const usage = await tom.getSandboxUsage(vm.id);
		expect(usage.series.intervalMs).toBe(USAGE_INTERVAL_MS);
		expect(usage.series.points.map((each) => each.cpu)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
		expect(usage.series.points[0]).toEqual({ at: first, cpu: 0, memUsedBytes: 200 * MIB });
		expect(usage.memLimitBytes).toBe(1024 * MIB);
		const newer = await tom.getSandboxUsage(vm.id, { since: first + 3 * USAGE_INTERVAL_MS });
		expect(newer.series.points.map((each) => each.at)).toEqual([first + 20_000, first + 25_000]);
		expect((await tom.getSandboxUsage(vm.id, { since: clock })).series.points).toEqual([]);
		// The host sends its readings, so none is read by running a command in the sandbox.
		expect(reads).toEqual([]);

		const host = await root.getHostUsage(STUB_HOST_ID);
		expect(host).toMatchObject({
			hostId: STUB_HOST_ID,
			intervalMs: USAGE_INTERVAL_MS,
			memTotalBytes: 64 * 1024 * MIB,
			diskTotalBytes: 100,
		});
		expect(host.points).toHaveLength(6);
		expect(host.points[5]).toEqual({ at: clock, cpu: 0.4, memUsedBytes: 8 * 1024 * MIB, diskUsedBytes: 10 });
		expect((await root.getHostUsage(STUB_HOST_ID, { since: clock - 1 })).points).toHaveLength(1);
		const listed = (await root.listHosts()).items.find((each) => each.id === STUB_HOST_ID);
		expect(listed?.usage?.recentMemory).toEqual([8 * 1024 * MIB]);
		expect(listed?.usage?.recentCpu).toHaveLength(1);
		expect(listed?.usage?.recentCpu[0]).toBeCloseTo(0.4);
	});

	it("drop a sandbox the host doesn't hold, and a reading stamped ahead is stamped on arrival", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const mine = [{ id: box.id, kind: "isolate" as const, cpu: 0.5, memUsedBytes: 10, memLimitBytes: 128 * MIB }];
		await api.service.recordUsage("host_elsewhere", tick(clock, mine));
		// Another host's word for it is ignored: what the sandbox shows is its own host's (here, the exec read's 0.25).
		const after = (await tom.getSandboxUsage(box.id)).series.points;
		expect(after.map((each) => each.cpu)).toEqual([0.25]);
		clock += USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, tick(clock + 3_600_000, mine));
		const ahead = (await tom.getSandboxUsage(box.id)).series.points;
		expect(ahead[ahead.length - 1]).toEqual({ at: clock, cpu: 0.5, memUsedBytes: 10 });
		clock += USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, tick(clock, mine));
		expect((await tom.getSandboxUsage(box.id)).series.points.map((each) => each.at)).toEqual([
			clock - 2 * USAGE_INTERVAL_MS,
			clock - USAGE_INTERVAL_MS,
			clock,
		]);
	});

	it("keep recentCpu's contract: 5-minute means, oldest first, with recentMemory the same length", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		expect((await tom.getSandbox(box.id)).usage).toMatchObject({ recentCpu: [], recentMemory: [] });
		// Thirty minutes of ticks: six 5-minute means, the last under way, each a step up.
		const start = clock;
		for (let at = start; at < start + 30 * 60_000; at += USAGE_INTERVAL_MS) {
			clock = at;
			const step = Math.floor((at - start) / ROLLUP_MS);
			const sandboxes = [
				{ id: box.id, kind: "isolate" as const, cpu: step / 10, memUsedBytes: (step + 1) * MIB, memLimitBytes: 0 },
			];
			await api.service.recordUsage(STUB_HOST_ID, tick(at, sandboxes));
		}
		const { usage } = await tom.getSandbox(box.id);
		expect(usage.recentCpu).toHaveLength(6);
		expect(usage.recentCpu.map((cpu) => Math.round(cpu * 10) / 10)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
		expect(usage.recentMemory).toEqual([1, 2, 3, 4, 5, 6].map((mib) => mib * MIB));
		// Closed means are in the sandbox's record, so they outlast this process; the one under way isn't yet.
		const stored = await api.store.sandboxes.get(box.id);
		expect(stored?.samples.map((sample) => sample.at)).toEqual([0, 1, 2, 3, 4].map((step) => start + step * ROLLUP_MS));
		expect(stored?.samples.length).toBeLessThanOrEqual(MAX_SAMPLES);
		// The intervals of 5 minutes are still the means.
		const points = (await tom.getSandboxUsage(box.id, { since: start, intervalSeconds: 300 })).points;
		expect(points.slice(0, 6).map((each) => each.memoryMb)).toEqual([1, 2, 3, 4, 5, 6]);
		// An interval off the 5-minute boundaries gets the means it overlaps, by how much: here a minute of one and four
		// of the next. The last, a minute into the 5 minutes under way, gets that one's mean so far.
		const off = (await tom.getSandboxUsage(box.id, { since: start + 4 * 60_000, intervalSeconds: 300 })).points;
		expect(off[0]?.memoryMb).toBeCloseTo(1.8, 5);
		expect(off[off.length - 1]?.memoryMb).toBe(6);
		expect(off[off.length - 1]?.cpu).toBeCloseTo(0.5);
	});

	it("feed the metrics export once each, with no command run in the sandbox", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend, reads } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const sandboxes = [{ id: box.id, kind: "isolate" as const, cpu: 0.3, memUsedBytes: 5 * MIB, memLimitBytes: 0 }];
		for (let index = 0; index < 3; index += 1) {
			clock += USAGE_INTERVAL_MS;
			await api.service.recordUsage(STUB_HOST_ID, tick(clock, sandboxes));
		}
		const exported = await api.service.sampleUsage();
		expect(exported).toHaveLength(3);
		expect(exported[0]).toMatchObject({ sandboxId: box.id, cpu: 0.3, memoryBytes: 5 * MIB, sandboxType: "isolate" });
		expect(await api.service.sampleUsage()).toEqual([]);
		clock += USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, tick(clock, sandboxes));
		expect((await api.service.sampleUsage()).map((each) => each.at)).toEqual([clock]);
		expect(reads).toEqual([]);
	});
});

describe("a host's usage ticks, when things happen in between", () => {
	const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
	const one = (id: string, cpu: number, kind: "isolate" | "microvm" = "isolate") => ({
		id,
		kind,
		cpu,
		memUsedBytes: MIB,
		memLimitBytes: 0,
	});

	it("are exported once each even when the sandbox stops before the export, and not again when it resumes", async () => {
		let clock = T0;
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		for (let index = 1; index <= 3; index += 1) {
			clock = T0 + index * USAGE_INTERVAL_MS;
			await api.service.recordUsage(STUB_HOST_ID, tick(clock, [one(box.id, 0.2)]));
		}
		await tom.stopSandbox(box.id, { wait: true });
		expect((await api.service.sampleUsage()).map((each) => each.at)).toEqual([T0 + 5000, T0 + 10_000, T0 + 15_000]);
		expect(await api.service.sampleUsage()).toEqual([]);

		clock += 60_000;
		await tom.startSandbox(box.id, { wait: true });
		clock += USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, tick(clock, [one(box.id, 0.3)]));
		const after = await api.service.sampleUsage();
		expect(after.map((each) => each.at)).toEqual([clock]);
	});

	it("from one host enter each series in order, though a 5-minute mean is slow to write", async () => {
		let clock = T0 - USAGE_INTERVAL_MS;
		const base = createMemoryStore();
		let gate: Promise<void> | undefined;
		const store: ComputeStore = {
			...base,
			sandboxes: {
				...base.sandboxes,
				update: async (id, change) => {
					if (gate !== undefined) await gate;
					return base.sandboxes.update(id, change);
				},
			},
		};
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock, store);
		const first = await tom.createSandbox({ wait: true });
		const second = await tom.createSandbox({ wait: true });
		const both = (cpu: number) => [one(first.id, cpu), one(second.id, cpu)];
		await api.service.recordUsage(STUB_HOST_ID, tick(clock, both(0.1)));
		// The next tick starts 5 minutes anew, closing the last for both: their writes are held.
		let release: () => void = () => undefined;
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		clock = T0;
		const boundary = api.service.recordUsage(STUB_HOST_ID, tick(T0, both(0.2)));
		clock = T0 + USAGE_INTERVAL_MS;
		const next = api.service.recordUsage(STUB_HOST_ID, tick(clock, both(0.3)));
		await new Promise((resolve) => setTimeout(resolve, 5));
		release();
		gate = undefined;
		await Promise.all([boundary, next]);
		for (const id of [first.id, second.id]) {
			const { points } = await tom.getSandboxUsage(id);
			expect(points.length).toBeGreaterThan(0);
			expect((await tom.getSandboxUsage(id)).series.points.map((each) => each.at)).toEqual([
				T0 - USAGE_INTERVAL_MS,
				T0,
				T0 + USAGE_INTERVAL_MS,
			]);
			expect((await api.store.sandboxes.get(id))?.samples).toEqual([
				{ at: T0 - ROLLUP_MS, cpu: 0.1, memoryMb: 1, readings: 1 },
			]);
		}
	});

	it("count the 5 minutes under way in CPU seconds", async () => {
		let clock = T0;
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		for (let index = 1; index <= 12; index += 1) {
			clock = T0 + index * USAGE_INTERVAL_MS;
			await api.service.recordUsage(STUB_HOST_ID, tick(clock, [one(box.id, 0.5)]));
		}
		const { usage } = await tom.getSandbox(box.id);
		expect(usage.runningSeconds).toBe(60);
		expect(usage.cpuSeconds).toBe(30);
		expect((await tom.getSandboxUsage(box.id)).totals.cpuSeconds).toBe(30);
	});

	it("say a host is reporting by when they arrive, so a host whose clock is behind isn't exec'd", async () => {
		let clock = T0;
		const { backend, reads } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		for (let index = 1; index <= 6; index += 1) {
			clock = T0 + index * USAGE_INTERVAL_MS;
			// 20 seconds behind.
			await api.service.recordUsage(STUB_HOST_ID, tick(clock - 20_000, [one(box.id, 0.4)]));
			await tom.getSandboxUsage(box.id);
		}
		expect(reads).toEqual([]);
		const { series } = await tom.getSandboxUsage(box.id);
		expect(series.points).toHaveLength(6);
		expect(series.points[5]?.at).toBe(clock - 20_000);
		// Once ticks stop coming, it is read that way again.
		clock += 60_000;
		await tom.getSandboxUsage(box.id);
		expect(reads).toEqual([box.id]);
	});

	it("another replica passed on are kept but exported by that one, not this", async () => {
		let clock = T0;
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		clock += USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, tick(clock, [one(box.id, 0.4)]), { shared: true });
		expect((await tom.getSandboxUsage(box.id)).series.points).toHaveLength(1);
		expect(await api.service.sampleUsage()).toEqual([]);
		// The host moves here: what it sends now is exported here, from where the other left off.
		clock += USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, tick(clock, [one(box.id, 0.4)]));
		expect((await api.service.sampleUsage()).map((each) => each.at)).toEqual([clock]);
	});

	it("replayed from the stub after a gap make one whole mean per 5 minutes", async () => {
		let clock = T0;
		const { api, tom, root } = setup(createStubBackend({ now: () => clock }), () => clock);
		const box = await tom.createSandbox({ wait: true });
		clock = T0 + 12 * 60_000;
		await tom.getSandbox(box.id);
		const samples = (await api.store.sandboxes.get(box.id))?.samples ?? [];
		expect(samples.map((sample) => sample.at)).toEqual([T0, T0 + ROLLUP_MS]);
		const ticks = Array.from({ length: ROLLUP_MS / USAGE_INTERVAL_MS }, (_, index) => T0 + index * USAGE_INTERVAL_MS);
		const expected = ticks.reduce((total, at) => total + stubReading(box.id, at, 0).cpu, 0) / ticks.length;
		expect(samples[0]?.cpu).toBeCloseTo(expected, 10);
		const host = (await root.listHosts()).items.find((each) => each.id === STUB_HOST_ID);
		expect(host?.usage?.recentCpu).toHaveLength(3);
	});

	it("from the stub give a microVM of its own shape that shape's memory limit, as its resources do", async () => {
		let clock = T0;
		const { tom } = setup(createStubBackend({ now: () => clock }), () => clock);
		const vm = await tom.createSandbox({ type: "microvm", resources: { vcpus: 3, memoryMb: 6144 }, wait: true });
		expect(vm.resources).toMatchObject({ memoryMb: 6144 });
		clock = T0 + 3 * USAGE_INTERVAL_MS;
		expect((await tom.getSandboxUsage(vm.id)).memLimitBytes).toBe(6144 * MIB);
	});
});

describe("usage ticks across gateway replicas over one store", () => {
	const T0 = Date.UTC(2026, 10, 4, 13, 0, 0);
	const reading = (id: string, cpu: number) => ({
		id,
		kind: "isolate" as const,
		cpu,
		memUsedBytes: MIB,
		memLimitBytes: 0,
	});

	/** Replicas A and B over one store, and a sandbox on the stub's host made through A. */
	async function replicas(clock: () => number) {
		const store = createMemoryStore();
		const a = setup(hostless(clock).backend, clock, store);
		const b = setup(hostless(clock).backend, clock, store);
		const box = await a.tom.createSandbox({ wait: true });
		return { a: a.api, b: b.api, tom: a.tom, store, id: box.id };
	}

	it("export each point once when the host moves replica before either exports", async () => {
		let clock = T0 + 1000;
		const { a, b, id } = await replicas(() => clock);
		const t1 = clock;
		await a.service.recordUsage(STUB_HOST_ID, tick(t1, [reading(id, 0.2)]));
		await b.service.recordUsage(STUB_HOST_ID, tick(t1, [reading(id, 0.2)]), { shared: true });
		// The host reconnects to B, which takes t2 and passes it on to A.
		clock += USAGE_INTERVAL_MS;
		const t2 = clock;
		await b.service.recordUsage(STUB_HOST_ID, tick(t2, [reading(id, 0.3)]));
		await a.service.recordUsage(STUB_HOST_ID, tick(t2, [reading(id, 0.3)]), { shared: true });
		const fromA = (await a.service.sampleUsage()).map((each) => each.at);
		const fromB = (await b.service.sampleUsage()).map((each) => each.at);
		expect(fromA).toEqual([t1]);
		expect(fromB).toEqual([t2]);
	});

	it("keep the mean of the replica that saw the whole 5 minutes, not one that joined late", async () => {
		let clock = T0;
		const { a, b, store, id } = await replicas(() => clock);
		const ticks = ROLLUP_MS / USAGE_INTERVAL_MS;
		for (let index = 0; index < ticks; index += 1) {
			clock = T0 + index * USAGE_INTERVAL_MS;
			const sent = tick(clock, [reading(id, index < ticks - 1 ? 0.1 : 0.9)]);
			await a.service.recordUsage(STUB_HOST_ID, sent);
			// B starts for the last tick only.
			if (index === ticks - 1) await b.service.recordUsage(STUB_HOST_ID, sent, { shared: true });
		}
		// The next 5 minutes begin: B, passed on everything it has, closes its first, and keeps nothing.
		clock = T0 + ROLLUP_MS;
		const next = tick(clock, [reading(id, 0.5)]);
		await b.service.recordUsage(STUB_HOST_ID, next, { shared: true });
		expect((await store.sandboxes.get(id))?.samples).toEqual([]);
		await a.service.recordUsage(STUB_HOST_ID, next);
		const [kept] = (await store.sandboxes.get(id))?.samples ?? [];
		expect(kept?.readings).toBe(ticks);
		expect(kept?.cpu).toBeCloseTo((0.1 * (ticks - 1) + 0.9) / ticks, 10);
		// Settling a 5 minutes passed on only keeps nothing either.
		clock = T0 + 3 * ROLLUP_MS;
		await b.service.sampleUsage();
		expect((await store.sandboxes.get(id))?.samples.map((each) => each.at)).toEqual([T0]);
	});

	it("keep the fuller mean when a host moves part way through 5 minutes, whichever writes first", async () => {
		let clock = T0;
		const { a, b, store, id } = await replicas(() => clock);
		const ticks = ROLLUP_MS / USAGE_INTERVAL_MS;
		for (let index = 0; index < ticks; index += 1) {
			clock = T0 + index * USAGE_INTERVAL_MS;
			const sent = tick(clock, [reading(id, index < ticks / 2 ? 0.2 : 0.6)]);
			// A holds the host for the first half and passes it on; then B, just started, holds it and passes it to A.
			if (index < ticks / 2) {
				await a.service.recordUsage(STUB_HOST_ID, sent);
			} else {
				await b.service.recordUsage(STUB_HOST_ID, sent);
				await a.service.recordUsage(STUB_HOST_ID, sent, { shared: true });
			}
		}
		clock = T0 + ROLLUP_MS;
		const next = tick(clock, [reading(id, 0.5)]);
		await b.service.recordUsage(STUB_HOST_ID, next);
		expect((await store.sandboxes.get(id))?.samples[0]?.readings).toBe(ticks / 2);
		await a.service.recordUsage(STUB_HOST_ID, next, { shared: true });
		const samples = (await store.sandboxes.get(id))?.samples ?? [];
		expect(samples).toHaveLength(1);
		expect(samples[0]?.readings).toBe(ticks);
		expect(samples[0]?.cpu).toBeCloseTo(0.4, 10);
	});
});

describe("the stub's replay", () => {
	it("settles no further than the ticks it took in, however long it took", async () => {
		const T0 = Date.UTC(2026, 10, 4, 16, 0, 0);
		let clock = T0;
		const base = createMemoryStore();
		let hold: { held: () => void; release: Promise<void> } | undefined;
		const store: ComputeStore = {
			...base,
			sandboxes: {
				...base.sandboxes,
				update: async (id, change) => {
					const once = hold;
					hold = undefined;
					if (once !== undefined) {
						once.held();
						await once.release;
					}
					return base.sandboxes.update(id, change);
				},
			},
		};
		const { api, tom } = setup(createStubBackend({ now: () => clock }), () => clock, store);
		const box = await tom.createSandbox({ wait: true });
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			hold = { held: resolve, release: new Promise<void>((done) => (release = done)) };
		});
		// A replay to 10 s before the third 5 minutes end, held at its first write until well past their end.
		clock = T0 + 3 * ROLLUP_MS - 10_000;
		const read = tom.getSandbox(box.id);
		await held;
		clock = T0 + 3 * ROLLUP_MS + 30_000;
		release();
		await read;
		// Its third 5 minutes are still open, for the ticks it hadn't fetched; the next settle takes them in first.
		expect((await api.store.sandboxes.get(box.id))?.samples.map((sample) => sample.at)).toEqual([T0, T0 + ROLLUP_MS]);
		await api.service.sampleUsage();
		const samples = (await api.store.sandboxes.get(box.id))?.samples ?? [];
		expect(samples.map((sample) => [sample.at, sample.readings])).toEqual([
			[T0, ROLLUP_MS / USAGE_INTERVAL_MS],
			[T0 + ROLLUP_MS, ROLLUP_MS / USAGE_INTERVAL_MS],
			[T0 + 2 * ROLLUP_MS, ROLLUP_MS / USAGE_INTERVAL_MS],
		]);
	});

	it("is taken in before a live host's tick settles anything", async () => {
		const T0 = Date.UTC(2026, 10, 4, 15, 0, 0);
		let clock = T0;
		const { api, tom } = setup(createStubBackend({ now: () => clock }), () => clock);
		const box = await tom.createSandbox({ wait: true });
		// Its ticks are in to a minute through its first 5 minutes.
		clock = T0 + 60_000;
		await tom.getSandbox(box.id);
		// 11 minutes on, another host's tick comes before any read: what it settles, it settles with every tick in.
		clock = T0 + 12 * 60_000;
		await api.service.recordUsage("host_other", tick(clock, []));
		const samples = (await api.store.sandboxes.get(box.id))?.samples ?? [];
		expect(samples.map((sample) => [sample.at, sample.readings])).toEqual([
			[T0, ROLLUP_MS / USAGE_INTERVAL_MS],
			[T0 + ROLLUP_MS, ROLLUP_MS / USAGE_INTERVAL_MS],
		]);
	});

	it("is waited for by an export that comes while it is part way through, and a live host's tick doesn't settle it", async () => {
		const T0 = Date.UTC(2026, 10, 4, 14, 0, 0);
		let clock = T0;
		const base = createMemoryStore();
		let hold: { held: () => void; release: Promise<void> } | undefined;
		const store: ComputeStore = {
			...base,
			sandboxes: {
				...base.sandboxes,
				update: async (id, change) => {
					const once = hold;
					hold = undefined;
					if (once !== undefined) {
						once.held();
						await once.release;
					}
					return base.sandboxes.update(id, change);
				},
			},
		};
		const { api, tom } = setup(createStubBackend({ now: () => clock }), () => clock, store);
		const box = await tom.createSandbox({ wait: true });
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			hold = { held: resolve, release: new Promise<void>((done) => (release = done)) };
		});
		// 12 minutes on: the replay closes its first 5 minutes at the second's first tick, and that write is held.
		clock = T0 + 12 * 60_000;
		const read = tom.getSandbox(box.id);
		await held;
		// Another host's tick, which settles now and then: it waits for the replay to settle.
		const live = api.service.recordUsage("host_other", tick(clock, []));
		const exported = api.service.sampleUsage();
		await new Promise((resolve) => setTimeout(resolve, 5));
		release();
		await Promise.all([read, live, exported]);
		const samples = (await api.store.sandboxes.get(box.id))?.samples ?? [];
		expect(samples.map((sample) => [sample.at, sample.readings])).toEqual([
			[T0, ROLLUP_MS / USAGE_INTERVAL_MS],
			[T0 + ROLLUP_MS, ROLLUP_MS / USAGE_INTERVAL_MS],
		]);
	});
});

describe("spanMean", () => {
	it("weights 5-minute means by their overlap, and an older single reading as a minute", () => {
		const samples = [
			{ at: 0, cpu: 0.2, memoryMb: 100, readings: 60 },
			{ at: ROLLUP_MS, cpu: 0.6, memoryMb: 300, readings: 60 },
		];
		expect(spanMean(samples, 0, ROLLUP_MS)).toEqual({ cpu: 0.2, memoryMb: 100 });
		const straddling = spanMean(samples, ROLLUP_MS / 2, ROLLUP_MS + ROLLUP_MS / 2);
		expect(straddling.cpu).toBeCloseTo(0.4);
		expect(straddling.memoryMb).toBeCloseTo(200);
		expect(spanMean([{ at: 12_345, cpu: 0.7, memoryMb: 9 }], 0, ROLLUP_MS)).toEqual({ cpu: 0.7, memoryMb: 9 });
		expect(spanMean([{ at: 12_345, cpu: 0.7, memoryMb: 9 }], 20_000, ROLLUP_MS)).toEqual({ cpu: 0, memoryMb: 0 });
		// A single reading taken on a 5-minute boundary is still a single reading: it counts only where it falls.
		const onBoundary = [{ at: ROLLUP_MS, cpu: 0.7, memoryMb: 9 }];
		expect(spanMean(onBoundary, ROLLUP_MS + 60_000, 2 * ROLLUP_MS)).toEqual({ cpu: 0, memoryMb: 0 });
		expect(spanMean(onBoundary, ROLLUP_MS, ROLLUP_MS + 60_000)).toEqual({ cpu: 0.7, memoryMb: 9 });
	});
});

describe("a host that doesn't send ticks yet", () => {
	it("is read by running a command, at most once per gap on reads and once per export", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend, reads } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ type: "microvm", size: "small", wait: true });
		const usage = await tom.getSandboxUsage(box.id);
		expect(reads).toEqual([box.id]);
		expect(usage.series).toEqual({
			intervalMs: FALLBACK_INTERVAL_MS,
			points: [{ at: clock, cpu: 0.25, memUsedBytes: 300 * MIB }],
		});
		expect(usage.memLimitBytes).toBe(1024 * MIB);
		// A poll soon after reads nothing new.
		clock += 5_000;
		await tom.getSandboxUsage(box.id, { since: clock - 5_000 });
		expect(reads).toHaveLength(1);
		// The export reads it on its own timer, and exports that reading once.
		clock += 60_000;
		const exported = await api.service.sampleUsage();
		expect(reads).toHaveLength(2);
		expect(exported.map((each) => each.at)).toEqual([clock - 65_000, clock]);
		expect((await tom.getSandbox(box.id)).usage.recentCpu).toEqual([0.25]);

		// Once its host sends ticks, it isn't read that way again.
		clock += 60_000;
		await api.service.recordUsage(
			STUB_HOST_ID,
			tick(clock, [{ id: box.id, kind: "microvm", cpu: 0.6, memUsedBytes: MIB, memLimitBytes: MIB }]),
		);
		await api.service.sampleUsage();
		await tom.getSandboxUsage(box.id);
		expect(reads).toHaveLength(2);
	});
});

describe("a host that says it sends ticks (`usage`)", () => {
	it("is never read by running a command, so the ticks it kept while out of reach fill the gap when they come", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend: stub, reads } = hostless(() => clock);
		const backend: SandboxBackend = {
			...stub,
			capabilities: async () => {
				const capabilities = await stub.capabilities();
				return { ...capabilities, hosts: capabilities.hosts.map((host) => ({ ...host, features: ["usage"] })) };
			},
		};
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ type: "microvm", size: "small", wait: true });
		const reading = [{ id: box.id, kind: "microvm" as const, cpu: 0.5, memUsedBytes: MIB, memLimitBytes: MIB }];
		const first = clock;
		await api.service.recordUsage(STUB_HOST_ID, tick(first, reading));
		// Its link stalls for two minutes: the console's polls and the export's timer come, and nothing is exec'd.
		for (let index = 1; index <= 24; index += 1) {
			clock = first + index * USAGE_INTERVAL_MS;
			await tom.getSandboxUsage(box.id);
			if (index % 12 === 0) await api.service.sampleUsage();
		}
		expect(reads).toEqual([]);
		// Then the ticks it kept arrive, oldest first, and every one is in the series.
		for (let index = 1; index <= 24; index += 1) {
			await api.service.recordUsage(STUB_HOST_ID, tick(first + index * USAGE_INTERVAL_MS, reading));
		}
		const { series } = await tom.getSandboxUsage(box.id);
		expect(series.points.map((each) => each.at)).toEqual(
			Array.from({ length: 25 }, (_, index) => first + index * USAGE_INTERVAL_MS),
		);
		expect(reads).toEqual([]);
	});
});

describe("the stub's own ticks", () => {
	it("make plausible readings every 5 seconds from when a sandbox booted, the same however read", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { tom, root } = setup(createStubBackend({ now: () => clock }), () => clock);
		const vm = await tom.createSandbox({ type: "microvm", wait: true });
		clock += 60_000;
		const usage = await tom.getSandboxUsage(vm.id);
		expect(usage.series.intervalMs).toBe(USAGE_INTERVAL_MS);
		expect(usage.series.points.length).toBeGreaterThanOrEqual(11);
		for (const each of usage.series.points) {
			expect(each.cpu).toBeGreaterThanOrEqual(0);
			expect(each.cpu).toBeLessThanOrEqual(1);
			expect(each.memUsedBytes).toBeGreaterThan(64 * MIB);
			expect(each.memUsedBytes).toBeLessThan(usage.memLimitBytes ?? 0);
		}
		const last = usage.series.points[usage.series.points.length - 1];
		clock += 10_000;
		const next = await tom.getSandboxUsage(vm.id, { since: last?.at ?? 0 });
		expect(next.series.points.map((each) => each.at)).toEqual([(last?.at ?? 0) + 5000, (last?.at ?? 0) + 10_000]);
		expect((await tom.getSandbox(vm.id)).usage.recentCpu.length).toBeGreaterThan(0);

		const host = await root.getHostUsage(STUB_HOST_ID);
		expect(host.points.length).toBeGreaterThan(10);
		expect(host.memTotalBytes).toBeGreaterThan(0);
		expect(stubReading("sbx_a", 1_000_000, 0)).toEqual(stubReading("sbx_a", 1_000_000, 0));
		expect(stubReading("sbx_a", 1_000_000, 0)).not.toEqual(stubReading("sbx_b", 1_000_000, 0));
	});
});
