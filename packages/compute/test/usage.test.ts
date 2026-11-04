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
		expect(series.partial("s")).toEqual({ at: start, cpu: 0.30000000000000004, memUsedBytes: 200, diskUsedBytes: 0 });
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
		expect(series.settle(start + ROLLUP_MS + 10_000)).toEqual([{ key: "s", rollup: point(start) }]);
		expect(series.keys()).toEqual(["s"]);
		// A point late for the closed 5 minutes is kept, but makes no second mean for them.
		series.add("s", point(start + 20_000, 1), { intervalMs: 5000 });
		expect(series.read("s").points).toHaveLength(2);
		expect(series.rollups("s")).toEqual([point(start)]);
		series.settle(start + ROLLUP_MS * (ROLLUP_POINTS + 2));
		expect(series.keys()).toEqual([]);
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
			expect((await api.store.sandboxes.get(id))?.samples).toEqual([{ at: T0 - ROLLUP_MS, cpu: 0.1, memoryMb: 1 }]);
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
});

describe("spanMean", () => {
	it("weights 5-minute means by their overlap, and an older single reading as a minute", () => {
		const samples = [
			{ at: 0, cpu: 0.2, memoryMb: 100 },
			{ at: ROLLUP_MS, cpu: 0.6, memoryMb: 300 },
		];
		expect(spanMean(samples, 0, ROLLUP_MS)).toEqual({ cpu: 0.2, memoryMb: 100 });
		const straddling = spanMean(samples, ROLLUP_MS / 2, ROLLUP_MS + ROLLUP_MS / 2);
		expect(straddling.cpu).toBeCloseTo(0.4);
		expect(straddling.memoryMb).toBeCloseTo(200);
		expect(spanMean([{ at: 12_345, cpu: 0.7, memoryMb: 9 }], 0, ROLLUP_MS)).toEqual({ cpu: 0.7, memoryMb: 9 });
		expect(spanMean([{ at: 12_345, cpu: 0.7, memoryMb: 9 }], 20_000, ROLLUP_MS)).toEqual({ cpu: 0, memoryMb: 0 });
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
