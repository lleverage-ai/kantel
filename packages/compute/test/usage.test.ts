// Usage series: hosts' ticks kept per sandbox and per host (bounded), read with `since`, folded into the 5-minute
// sparklines `recentCpu` and `recentMemory`, fed to the metrics export, and the exec read kept only for a host that
// doesn't send ticks yet. The stub makes up its own ticks, so graphs move with no host.
import { createKantelClient } from "@kantel/api/sdk";
import type { SqlDriver } from "@kantel/sql";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend, UsageSample } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { FALLBACK_INTERVAL_MS, HOURLY_SAMPLES, keptSamples, MAX_SAMPLES, spanMean } from "../src/service.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
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
const databases: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
	for (const database of databases.splice(0)) await database.close();
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
			cpuMax: 0.4,
			memMaxBytes: 300,
			memMaxAt: start + 5000,
			diskUsedBytes: 0,
			readings: 2,
			diskReadings: 2,
			ioReadings: 0,
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
		const mean = {
			...point(start),
			cpuMax: point(start).cpu,
			memMaxBytes: point(start).memUsedBytes,
			memMaxAt: start,
			readings: 1,
			diskReadings: 1,
			ioReadings: 0,
			local: true,
		};
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
	it("carry a microVM's disk and IO pressure to its series and its means, and say where nothing was measured", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const start = clock;
		const reading = { id: box.id, kind: "microvm" as const, cpu: 0.2, memUsedBytes: 100 * MIB, memLimitBytes: 0 };
		// Ten minutes of ticks with disk and IO, but one tick in each minute without (a guest that didn't answer).
		for (let at = start; at < start + 10 * 60_000; at += USAGE_INTERVAL_MS) {
			clock = at;
			const answered = (at - start) % 60_000 !== 0;
			const figures = answered ? { diskUsedBytes: 2048 * MIB, diskTotalBytes: 8192 * MIB, ioPressure: 0.25 } : {};
			await api.service.recordUsage(STUB_HOST_ID, tick(at, [{ ...reading, ...figures }]));
		}
		const usage = await tom.getSandboxUsage(box.id, { since: start - 2 * ROLLUP_MS, intervalSeconds: 300 });
		expect(usage.diskTotalBytes).toBe(8192 * MIB);
		const series = usage.series.points;
		expect(series[0]).toEqual({ at: start, cpu: 0.2, memUsedBytes: 100 * MIB });
		expect(series[1]).toEqual({
			at: start + USAGE_INTERVAL_MS,
			cpu: 0.2,
			memUsedBytes: 100 * MIB,
			diskUsedBytes: 2048 * MIB,
			ioPressure: 0.25,
		});
		// The means: the two 5-minute spans before it started are unmeasured, not 0; those it ran have disk and IO, the
		// mean of the readings that had them.
		const [before, , first] = usage.points;
		expect(before).toMatchObject({ measured: false, cpu: 0 });
		expect(before?.diskUsedBytes).toBeUndefined();
		expect(first).toMatchObject({ measured: true, diskUsedBytes: 2048 * MIB, ioPressure: 0.25 });
		// And the closed 5-minute mean is kept in the sandbox's record with them.
		const stored = await api.store.sandboxes.get(box.id);
		expect(stored?.samples[0]).toMatchObject({ at: start, diskMb: 2048, io: 0.25 });
		// With how many of its 60 readings had them, for when it is folded into an hour.
		expect(stored?.samples[0]).toMatchObject({ readings: 60, diskReadings: 55, ioReadings: 55 });
	});

	it("keep each interval's highest CPU and memory beside its means, and the sandbox's peak after it is deleted", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const start = clock;
		const spikeAt = start + 60_000;
		// Ten minutes at 2 GiB and 10% CPU, but for one 5 s reading at 22 GiB and full CPU in the first five.
		for (let at = start; at < start + 10 * 60_000; at += USAGE_INTERVAL_MS) {
			clock = at;
			const spike = at === spikeAt;
			const reading = {
				id: box.id,
				kind: "microvm" as const,
				cpu: spike ? 1 : 0.1,
				memUsedBytes: (spike ? 22 * 1024 : 2048) * MIB,
				memLimitBytes: 0,
			};
			await api.service.recordUsage(STUB_HOST_ID, tick(at, [reading]));
		}
		const usage = await tom.getSandboxUsage(box.id, { since: start, intervalSeconds: 300 });
		const [first, second] = usage.points;
		// The first 5 minutes' mean hides the spike; its highest doesn't.
		expect(first?.memoryMb).toBeLessThan(2500);
		expect(first).toMatchObject({ memoryMbMax: 22 * 1024, cpuMax: 1 });
		expect(second).toMatchObject({ memoryMbMax: 2048, cpuMax: 0.1 });
		expect(usage).toMatchObject({ peakMemoryBytes: 22 * 1024 * MIB, peakMemoryAt: spikeAt, peakCpu: 1 });
		expect((await tom.getSandbox(box.id)).usage).toMatchObject({ peakMemoryBytes: 22 * 1024 * MIB, peakCpu: 1 });
		// An hour's interval keeps the highest of the means in it.
		const hourly = await tom.getSandboxUsage(box.id, { since: start, intervalSeconds: 3600 });
		expect(hourly.points[0]).toMatchObject({ memoryMbMax: 22 * 1024 });
		// Kept in the record, so it outlasts the series and the sandbox.
		expect((await api.store.sandboxes.get(box.id))?.peak).toEqual({
			memoryBytes: 22 * 1024 * MIB,
			memoryAt: spikeAt,
			cpu: 1,
		});
		await tom.deleteSandbox(box.id);
		expect((await api.store.sandboxes.get(box.id))?.peak?.memoryBytes).toBe(22 * 1024 * MIB);
	});

	it("carry a microVM's OOM kills and memory pressure to its series and its latest, with an event when kills rise", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const reading = {
			id: box.id,
			kind: "microvm" as const,
			cpu: 1,
			memUsedBytes: 7406 * MIB,
			memLimitBytes: 8192 * MIB,
		};
		const start = clock;
		const send = async (figures: Partial<ReportedUsage["sandboxes"][number]>, shared = false) => {
			clock += USAGE_INTERVAL_MS;
			await api.service.recordUsage(STUB_HOST_ID, tick(clock, [{ ...reading, ...figures }]), { shared });
		};
		const ooms = async () =>
			(await tom.listEvents({ sandboxId: box.id })).items.filter((event) => event.type === "sandbox.oom_kill");

		// Its first count is a baseline, whatever it is: kills before this process heard of it aren't new.
		await send({ oomKills: 3, memPressureSome: 0.1, memPressureFull: 0 });
		expect(await ooms()).toEqual([]);
		// The same count: nothing. Then two more: one event, saying so.
		await send({ oomKills: 3, memPressureSome: 0.4, memPressureFull: 0.05 });
		await send({ oomKills: 5, memPressureSome: 0.85, memPressureFull: 0.41 });
		let events = await ooms();
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toMatchObject({ oomKills: 2, state: "running" });
		expect(events[0]?.data.reason).toContain("killed 2 processes");
		expect(events[0]?.data.reason).toContain("8 GB");
		// A tick its agent missed has none, and the next answer is still measured from the last count.
		await send({});
		await send({ oomKills: 6, memPressureSome: 0.9 });
		events = await ooms();
		expect(events).toHaveLength(2);
		expect(events[0]?.data.oomKills).toBe(1);
		// Booted again (a recovery): its count starts again, and every kill it has counted since is new.
		await send({ oomKills: 1 });
		expect((await ooms()).map((event) => event.data.oomKills)).toEqual([1, 1, 2]);
		// A tick another replica passed on is that replica's to report.
		await send({ oomKills: 4 }, true);
		expect(await ooms()).toHaveLength(3);

		const usage = await tom.getSandboxUsage(box.id, { since: start });
		expect(usage.series.points[2]).toMatchObject({ oomKills: 5, memPressureSome: 0.85, memPressureFull: 0.41 });
		expect(usage.series.points[3]).not.toHaveProperty("oomKills");
		// The newest figures it has, for info and usage.
		expect(usage.memory).toEqual({ at: clock, oomKills: 4 });
		expect((await tom.getSandbox(box.id)).usage.memory).toEqual({ at: clock, oomKills: 4 });
		// Not in the 5-minute means.
		expect(usage.points.some((each) => "oomKills" in each)).toBe(false);
	});

	it("leave a sandbox without guest memory figures without them", async () => {
		const clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const reading = { id: box.id, kind: "microvm" as const, cpu: 0.2, memUsedBytes: MIB, memLimitBytes: 0 };
		await api.service.recordUsage(STUB_HOST_ID, tick(clock, [reading]));
		const usage = await tom.getSandboxUsage(box.id);
		expect(usage.memory).toBeUndefined();
		expect((await tom.getSandbox(box.id)).usage.memory).toBeUndefined();
	});

	it("count CPU seconds by the time each kept mean covers, and only within the span asked for", async () => {
		const HOUR = 3_600_000;
		const DAY = 24 * HOUR;
		const t0 = Date.UTC(2026, 10, 1, 0, 0, 0);
		let clock = t0;
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		// Six days of hourly means at full CPU, then a day of 5-minute means at none, running all week.
		const hours = Array.from({ length: HOURLY_SAMPLES }, (_, i) => ({
			at: t0 + i * HOUR,
			cpu: 1,
			memoryMb: 10,
			readings: 720,
			spanMs: HOUR,
		}));
		const day = Array.from({ length: MAX_SAMPLES }, (_, i) => ({
			at: t0 + 6 * DAY + i * ROLLUP_MS,
			cpu: 0,
			memoryMb: 10,
			readings: 60,
		}));
		await api.store.sandboxes.update(box.id, (current) => ({
			...current,
			createdAt: t0,
			runs: [{ from: t0 }],
			samples: [...hours, ...day],
		}));
		clock = t0 + 7 * DAY;
		// The last day ran at no CPU, whatever the week before it did.
		expect((await tom.getSandboxUsage(box.id)).totals).toMatchObject({ runningSeconds: DAY / 1000, cpuSeconds: 0 });
		// The week: six days of full CPU, each hour counting for an hour, not for five minutes.
		const week = await tom.getSandboxUsage(box.id, { since: t0, intervalSeconds: 3600 });
		expect(week.totals.cpuSeconds).toBe((6 * DAY) / 1000);
		expect((await tom.getSandbox(box.id)).usage.cpuSeconds).toBe((6 * DAY) / 1000);
	});

	it("keep an isolate's (no disk, no IO) without either", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const reading = { id: box.id, kind: "isolate" as const, cpu: 0.1, memUsedBytes: MIB, memLimitBytes: 0 };
		for (let at = clock; at < clock + 6 * 60_000; at += USAGE_INTERVAL_MS) {
			await api.service.recordUsage(STUB_HOST_ID, tick(at, [reading]));
		}
		clock += 6 * 60_000;
		const usage = await tom.getSandboxUsage(box.id, { intervalSeconds: 300 });
		expect(usage.diskTotalBytes).toBeUndefined();
		expect(usage.series.points.some((each) => "diskUsedBytes" in each || "ioPressure" in each)).toBe(false);
		expect(usage.points.some((each) => "diskUsedBytes" in each || "ioPressure" in each)).toBe(false);
	});

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
				{ at: T0 - ROLLUP_MS, cpu: 0.1, memoryMb: 1, cpuMax: 0.1, memoryMbMax: 1, readings: 1 },
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

	/** A microVM reading with its guest's OOM-kill count. */
	const oom = (id: string, oomKills: number) => ({
		id,
		kind: "microvm" as const,
		cpu: 1,
		memUsedBytes: MIB,
		memLimitBytes: 8192 * MIB,
		oomKills,
	});
	const oomEvents = async (tom: ReturnType<typeof setup>["tom"], id: string) =>
		(await tom.listEvents({ sandboxId: id })).items
			.filter((event) => event.type === "sandbox.oom_kill")
			.map((event) => event.data.oomKills)
			.reverse();

	async function oomHandover(
		open: (clock: () => number) => Promise<{
			readonly a: ComputeApi;
			readonly b: ComputeApi;
			readonly tom: ReturnType<typeof setup>["tom"];
			readonly id: string;
		}>,
	) {
		let clock = T0;
		const { a, b, tom, id } = await open(() => clock);
		const on = async (replica: ComputeApi, kills: number, shared = false) => {
			clock += USAGE_INTERVAL_MS;
			await replica.service.recordUsage(STUB_HOST_ID, tick(clock, [oom(id, kills)]), { shared });
		};
		await on(a, 0);
		await on(b, 0);
		// A takes a kill, and its copy never reaches B. The host moves to B with the count unchanged: not again.
		await on(a, 1);
		await on(b, 1);
		await on(b, 1);
		expect(await oomEvents(tom, id)).toEqual([1]);
		// A genuine rise on B: only the new kills. A reading older than the newest taken leaves the count be.
		await on(b, 3);
		await b.service.recordUsage(STUB_HOST_ID, tick(clock - 1, [oom(id, 0)]));
		await on(b, 3);
		expect(await oomEvents(tom, id)).toEqual([1, 2]);
		// Back on A, which last saw 1: measured from what is kept, not from its own view.
		await on(a, 3);
		// Booted again: every kill it counts since is new, once.
		await on(a, 1);
		await on(b, 1);
		expect(await oomEvents(tom, id)).toEqual([1, 2, 1]);
		// A tick passed on is the other replica's to count.
		await on(b, 2, true);
		expect(await oomEvents(tom, id)).toEqual([1, 2, 1]);
	}

	it("report each guest OOM kill once when the host moves replica, whatever each replica saw", async () => {
		await oomHandover(async (clock) => {
			const { a, b, tom, id } = await replicas(clock);
			return { a, b, tom, id };
		});
	});

	it("report each guest OOM kill once over the SQL store too", {
		...(pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs }),
	}, async () => {
		const database = await pgliteDatabase.open();
		databases.push(database);
		await migrateComputeStore(database.driver);
		await oomHandover(async (clock) => {
			const a = setup(hostless(clock).backend, clock, createSqlComputeStore(database.driver));
			const b = setup(hostless(clock).backend, clock, createSqlComputeStore(database.driver));
			const box = await a.tom.createSandbox({ wait: true });
			return { a: a.api, b: b.api, tom: a.tom, id: box.id };
		});
	});

	it("keep an OOM kill whose event couldn't be stored, and store it once, unchanged, with a later reading", async () => {
		let clock = T0;
		const { a, tom, store, id } = await replicas(() => clock);
		const on = async (kills: number) => {
			clock += USAGE_INTERVAL_MS;
			await a.service.recordUsage(STUB_HOST_ID, tick(clock, [oom(id, kills)]));
		};
		const put = store.events.put.bind(store.events);
		await on(0);
		// The event's write fails: the kill stays pending, and the tick is still taken.
		let failing = 1;
		store.events.put = async (event) => {
			if (event.type === "sandbox.oom_kill" && failing-- > 0) throw new Error("store unavailable");
			return put(event);
		};
		await on(1);
		expect(await oomEvents(tom, id)).toEqual([]);
		expect((await store.sandboxes.get(id))?.oomKills).toMatchObject({ count: 1, pending: { kills: 1 } });
		// A kill meanwhile doesn't change the event: it is stored as it was, and the new kill gets one of its own.
		failing = 1;
		await on(2);
		expect((await store.sandboxes.get(id))?.oomKills).toMatchObject({ count: 1, pending: { kills: 1 } });
		await on(2);
		expect(await oomEvents(tom, id)).toEqual([1]);
		await on(2);
		expect(await oomEvents(tom, id)).toEqual([1, 1]);
		// Written, but its answer lost: stored again under the same ID, so still one event.
		store.events.put = async (event) => {
			await put(event);
			if (event.type === "sandbox.oom_kill" && failing-- > 0) throw new Error("answer lost");
		};
		failing = 1;
		await on(3);
		const at = clock;
		await on(3);
		expect(await oomEvents(tom, id)).toEqual([1, 1, 1]);
		expect((await store.sandboxes.get(id))?.oomKills).toEqual({ count: 3, at });
	});

	it("store an OOM event as it was taken, whichever replica's write of it lands last", async () => {
		let clock = T0;
		const { a, b, tom, store, id } = await replicas(() => clock);
		const on = async (replica: ComputeApi, kills: number) => {
			clock += USAGE_INTERVAL_MS;
			await replica.service.recordUsage(STUB_HOST_ID, tick(clock, [oom(id, kills)]));
		};
		await on(a, 0);
		// A's write of its event is slow; meanwhile the host moves to B, which stores it too and counts a kill since.
		const put = store.events.put.bind(store.events);
		let release: () => void = () => undefined;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		store.events.put = async (event) => {
			if (event.type === "sandbox.oom_kill" && first) {
				first = false;
				await slow;
			}
			return put(event);
		};
		const onA = on(a, 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await on(b, 2);
		await on(b, 2);
		release();
		await onA;
		// Each kill once: A's late write of the first event says what B's did.
		expect(await oomEvents(tom, id)).toEqual([1, 1]);
		await on(b, 2);
		expect(await oomEvents(tom, id)).toEqual([1, 1]);
	});

	it("count a rebooted guest's kills when the host comes back to a replica that last saw its count before", async () => {
		let clock = T0;
		const { a, b, tom, id } = await replicas(() => clock);
		const on = async (replica: ComputeApi, kills: number) => {
			clock += USAGE_INTERVAL_MS;
			await replica.service.recordUsage(STUB_HOST_ID, tick(clock, [oom(id, kills)]));
		};
		await on(a, 0);
		await on(b, 1);
		// Booted again, and back on A within a few ticks, its count back at 0 and then 1: a new kill.
		await on(a, 0);
		await on(a, 1);
		expect(await oomEvents(tom, id)).toEqual([1, 1]);
	});

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

	for (const order of ["fuller first", "shorter first"] as const) {
		it(`keep the highest readings of both replicas' means of the same 5 minutes, ${order}`, async () => {
			let clock = T0;
			const { a, b, store, id } = await replicas(() => clock);
			const ticks = ROLLUP_MS / USAGE_INTERVAL_MS;
			const spike = (index: number) => index === ticks - 2;
			// A holds the host for two thirds of the 5 minutes, B for the rest, which has the spike; neither passes on.
			for (let index = 0; index < ticks; index += 1) {
				clock = T0 + index * USAGE_INTERVAL_MS;
				const sent = tick(clock, [
					{ ...reading(id, spike(index) ? 0.9 : 0.1), memUsedBytes: (spike(index) ? 900 : 100) * MIB },
				]);
				await (index < (ticks * 2) / 3 ? a : b).service.recordUsage(STUB_HOST_ID, sent);
			}
			clock = T0 + ROLLUP_MS;
			const next = tick(clock, [reading(id, 0.1)]);
			const [first, second] = order === "fuller first" ? [a, b] : [b, a];
			await first.service.recordUsage(STUB_HOST_ID, next);
			await second.service.recordUsage(STUB_HOST_ID, next);
			const samples = (await store.sandboxes.get(id))?.samples ?? [];
			expect(samples).toHaveLength(1);
			// The fuller mean, A's, with B's peak.
			expect(samples[0]).toMatchObject({ readings: (ticks * 2) / 3, cpuMax: 0.9, memoryMbMax: 900 });
			expect(samples[0]?.cpu).toBeCloseTo(0.1, 10);
			// And kept when it is folded into its hour.
			const later = Array.from({ length: MAX_SAMPLES }, (_, i) => ({
				at: T0 + (i + 12) * ROLLUP_MS,
				cpu: 0.1,
				memoryMb: 1,
				readings: 60,
			}));
			const [hour] = keptSamples([...samples, ...later]);
			expect(hour).toMatchObject({ cpuMax: 0.9, memoryMbMax: 900 });
		});
	}
});

// A host with `usage-acks` numbers its ticks (`run`, `seq`) and, after a reconnect, sends again every tick no
// `usage.ack` covered: those the dying connection lost, and those taken whose ack it lost. Each is taken once.
describe("numbered usage ticks sent again after a reconnect", () => {
	const T0 = Date.UTC(2026, 10, 4, 14, 0, 0);
	const RUN = "0123456789abcdef";
	const reading = (id: string, cpu: number) => ({
		id,
		kind: "isolate" as const,
		cpu,
		memUsedBytes: MIB,
		memLimitBytes: 0,
	});
	/** Tick `seq` of `run`, taken at T0 + seq ticks. */
	const numbered = (id: string, seq: number, run = RUN, at = T0 + seq * USAGE_INTERVAL_MS): ReportedUsage => ({
		...tick(at, [reading(id, seq / 100)]),
		seq,
		run,
	});

	it("are taken once each, in the series and the export, and fill what the connection lost", async () => {
		let clock = T0;
		const { backend, reads } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		// 1 to 3 arrive and are taken, but their acks are lost with the connection; 4 and 5 die with it unread.
		for (let seq = 1; seq <= 3; seq += 1) {
			clock = T0 + seq * USAGE_INTERVAL_MS;
			await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq));
		}
		const before = (await api.service.sampleUsage()).map((each) => each.at);
		// The host reconnects: everything unacknowledged, 1 to 5, then 6 to 8 as they are taken.
		clock = T0 + 8 * USAGE_INTERVAL_MS;
		for (let seq = 1; seq <= 8; seq += 1) await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq));
		// And a stray repeat of the newest.
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 8));
		const after = (await api.service.sampleUsage()).map((each) => each.at);

		const every = Array.from({ length: 8 }, (_, index) => T0 + (index + 1) * USAGE_INTERVAL_MS);
		const points = (await tom.getSandboxUsage(box.id)).series.points;
		expect(points.map((each) => each.at)).toEqual(every);
		expect(points.map((each) => each.cpu)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => seq / 100));
		expect([...before, ...after]).toEqual(every);
		expect(reads).toEqual([]);
	});

	it("are taken once even when stamped on arrival (the host's clock ahead), which a series' own check misses", async () => {
		let clock = T0;
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const ahead = T0 + 3_600_000;
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1, RUN, ahead));
		// Sent again after a reconnect, it would be stamped with the later arrival and taken as a second point.
		clock += USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1, RUN, ahead));
		expect((await tom.getSandboxUsage(box.id)).series.points.map((each) => each.at)).toEqual([T0]);
		expect((await api.service.sampleUsage()).map((each) => each.at)).toEqual([T0]);
	});

	it("of a restarted host, whose new run counts from 1 again, are taken", async () => {
		let clock = T0;
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		for (let seq = 1; seq <= 3; seq += 1) await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq));
		clock = T0 + 10 * USAGE_INTERVAL_MS;
		for (let seq = 1; seq <= 2; seq += 1) {
			await api.service.recordUsage(
				STUB_HOST_ID,
				numbered(box.id, seq, "fedcba9876543210", T0 + (seq + 5) * USAGE_INTERVAL_MS),
			);
		}
		expect((await tom.getSandboxUsage(box.id)).series.points).toHaveLength(5);
	});

	it("from an older host, unnumbered, are taken as before: a repeat by its time only", async () => {
		let clock = T0;
		const { backend } = hostless(() => clock);
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const old = tick(T0 + USAGE_INTERVAL_MS, [reading(box.id, 0.1)]);
		await api.service.recordUsage(STUB_HOST_ID, old);
		await api.service.recordUsage(STUB_HOST_ID, old);
		await api.service.recordUsage(STUB_HOST_ID, tick(T0 + 2 * USAGE_INTERVAL_MS, [reading(box.id, 0.2)]));
		clock = T0 + 2 * USAGE_INTERVAL_MS;
		expect((await tom.getSandboxUsage(box.id)).series.points.map((each) => each.cpu)).toEqual([0.1, 0.2]);
		expect(await api.service.sampleUsage()).toHaveLength(2);
	});

	it("to the replica the host moved to, of ticks the first passed on, are exported once between them", async () => {
		let clock = T0;
		const store = createMemoryStore();
		const a = setup(hostless(() => clock).backend, () => clock, store);
		const b = setup(hostless(() => clock).backend, () => clock, store);
		const box = await a.tom.createSandbox({ wait: true });
		// A holds the host: it takes 1 to 3 and passes them on to B; their acks die with the connection.
		for (let seq = 1; seq <= 3; seq += 1) {
			clock = T0 + seq * USAGE_INTERVAL_MS;
			await a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq));
			await b.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq), { shared: true });
		}
		// The host reconnects to B and sends 1 to 4 again; B passes on what it takes.
		clock = T0 + 4 * USAGE_INTERVAL_MS;
		for (let seq = 1; seq <= 4; seq += 1) {
			await b.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq));
			await a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq), { shared: true });
		}
		const fromA = (await a.api.service.sampleUsage()).map((each) => each.at);
		const fromB = (await b.api.service.sampleUsage()).map((each) => each.at);
		const every = [1, 2, 3, 4].map((seq) => T0 + seq * USAGE_INTERVAL_MS);
		expect([...fromA, ...fromB].sort()).toEqual(every);
		expect(fromB).toEqual([T0 + 4 * USAGE_INTERVAL_MS]);
		for (const api of [a, b]) {
			expect((await api.tom.getSandboxUsage(box.id)).series.points.map((each) => each.at)).toEqual(every);
		}
	});

	/** A memory store whose sandbox lookups (which every tick with readings makes) fail while `down` is set. */
	function flaky() {
		const inner = createMemoryStore();
		const state = { down: false };
		const store: ComputeStore = {
			...inner,
			sandboxes: {
				...inner.sandboxes,
				list: async (where) => {
					if (state.down) throw new Error("store down");
					return inner.sandboxes.list(where);
				},
			},
		};
		return { store, state };
	}

	it("that failed are taken when sent again, though one after it was taken first, and none after it is taken ahead", async () => {
		let clock = T0;
		const { store, state } = flaky();
		const { api, tom } = setup(hostless(() => clock).backend, () => clock, store);
		const box = await tom.createSandbox({ wait: true });
		clock = T0 + USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1));
		// 2 fails: the host isn't told it is in.
		state.down = true;
		clock = T0 + 2 * USAGE_INTERVAL_MS;
		await expect(api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 2))).rejects.toThrow("store down");
		// 3 comes on the same connection once the store is back: it is in only with 2 before it, so its ack is true of 2.
		state.down = false;
		clock = T0 + 3 * USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 3));
		// The host sends 2 and 3 again after a reconnect all the same (an ack it lost): neither is taken twice.
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 2));
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 3));
		const every = [1, 2, 3].map((seq) => T0 + seq * USAGE_INTERVAL_MS);
		const points = (await tom.getSandboxUsage(box.id)).series.points;
		expect(points.map((each) => each.at)).toEqual(every);
		expect(points.map((each) => each.cpu)).toEqual([0.01, 0.02, 0.03]);
		expect((await api.service.sampleUsage()).map((each) => each.at)).toEqual(every);
	});

	it("that failed are taken when only sent again, whatever came after them meanwhile", async () => {
		let clock = T0;
		const { store, state } = flaky();
		const { api, tom } = setup(hostless(() => clock).backend, () => clock, store);
		const box = await tom.createSandbox({ wait: true });
		clock = T0 + USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1));
		state.down = true;
		for (const seq of [2, 3, 4]) {
			clock = T0 + seq * USAGE_INTERVAL_MS;
			await expect(api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq))).rejects.toThrow("store down");
		}
		state.down = false;
		// The host reconnects and sends again all it has unacknowledged, oldest first.
		clock = T0 + 5 * USAGE_INTERVAL_MS;
		for (const seq of [2, 3, 4, 5]) await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq));
		const every = [1, 2, 3, 4, 5].map((seq) => T0 + seq * USAGE_INTERVAL_MS);
		expect((await tom.getSandboxUsage(box.id)).series.points.map((each) => each.at)).toEqual(every);
		expect((await api.service.sampleUsage()).map((each) => each.at)).toEqual(every);
	});

	it("held while the store failed are in the next export, with no tick after them to bring them in", async () => {
		let clock = T0;
		const { store, state } = flaky();
		const { api, tom } = setup(hostless(() => clock).backend, () => clock, store);
		const box = await tom.createSandbox({ wait: true });
		clock = T0 + USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1));
		state.down = true;
		clock = T0 + 2 * USAGE_INTERVAL_MS;
		await expect(api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 2))).rejects.toThrow("store down");
		state.down = false;
		const every = [1, 2].map((seq) => T0 + seq * USAGE_INTERVAL_MS);
		expect((await api.service.sampleUsage()).map((each) => each.at)).toEqual(every);
		// Sent again later, it isn't taken twice.
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 2));
		expect((await tom.getSandboxUsage(box.id)).series.points.map((each) => each.at)).toEqual(every);
		expect(await api.service.sampleUsage()).toEqual([]);
	});

	it("to the replica the host moved to, of ticks the first took but hadn't passed on, are exported once", async () => {
		let clock = T0;
		const store = createMemoryStore();
		const a = setup(hostless(() => clock).backend, () => clock, store);
		const b = setup(hostless(() => clock).backend, () => clock, store);
		const box = await a.tom.createSandbox({ wait: true });
		// A takes 1 to 3; the connection dies with their acks, and B hasn't had them passed on yet.
		for (let seq = 1; seq <= 3; seq += 1) {
			clock = T0 + seq * USAGE_INTERVAL_MS;
			await a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq));
		}
		// The host reconnects to B and sends 1 to 4 again.
		clock = T0 + 4 * USAGE_INTERVAL_MS;
		for (let seq = 1; seq <= 4; seq += 1) await b.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq));
		const fromA = (await a.api.service.sampleUsage()).map((each) => each.at);
		const fromB = (await b.api.service.sampleUsage()).map((each) => each.at);
		expect(fromA).toEqual([1, 2, 3].map((seq) => T0 + seq * USAGE_INTERVAL_MS));
		expect(fromB).toEqual([T0 + 4 * USAGE_INTERVAL_MS]);
		// B still draws all four.
		expect((await b.tom.getSandboxUsage(box.id)).series.points).toHaveLength(4);
	});

	/**
	 * One Postgres (PGlite) under any number of replicas' SQL stores. While `lose` is set, the next claim a replica writes
	 * (`usageClaims`) is committed and its answer lost: the statement runs, then the call fails, as when a connection
	 * dies with the reply on its way.
	 */
	async function sqlStores() {
		const database = await pgliteDatabase.open();
		databases.push(database);
		await migrateComputeStore(database.driver);
		const state = { lose: false };
		const driver: SqlDriver = {
			dialect: database.driver.dialect,
			batch: (statements) => database.driver.batch(statements),
			async query(text, params) {
				const rows = await database.driver.query(text, params);
				if (state.lose && text.startsWith("INSERT") && params?.[0] === "usageClaims") {
					state.lose = false;
					throw new Error("connection lost");
				}
				return rows as never;
			},
		};
		return { store: () => createSqlComputeStore(driver), state };
	}

	it("whose claim was written but its answer lost are still exported once, by the replica that claimed them", {
		...(pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs }),
	}, async () => {
		let clock = T0;
		const { store, state } = await sqlStores();
		const a = setup(hostless(() => clock).backend, () => clock, store());
		const b = setup(hostless(() => clock).backend, () => clock, store());
		const box = await a.tom.createSandbox({ wait: true });
		clock = T0 + USAGE_INTERVAL_MS;
		await a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1));
		// A's claim to 2 is in the store, but A doesn't know: 2 isn't acknowledged, and A holds it.
		state.lose = true;
		clock = T0 + 2 * USAGE_INTERVAL_MS;
		await expect(a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 2))).rejects.toThrow("connection lost");
		// The host moves to B and sends 2 again, then 3: B draws 2, A's, and exports 3, its own.
		clock = T0 + 3 * USAGE_INTERVAL_MS;
		await b.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 2));
		await b.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 3));
		// A's next export brings in what it holds, knowing the claim for its own.
		const fromA = (await a.api.service.sampleUsage()).map((each) => each.at);
		const fromB = (await b.api.service.sampleUsage()).map((each) => each.at);
		expect(fromA).toEqual([1, 2].map((seq) => T0 + seq * USAGE_INTERVAL_MS));
		expect(fromB).toEqual([T0 + 3 * USAGE_INTERVAL_MS]);
	});

	it("whose claim was written but its answer lost are exported once when sent to the same replica again", {
		...(pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs }),
	}, async () => {
		let clock = T0;
		const { store, state } = await sqlStores();
		const a = setup(hostless(() => clock).backend, () => clock, store());
		const box = await a.tom.createSandbox({ wait: true });
		state.lose = true;
		clock = T0 + USAGE_INTERVAL_MS;
		await expect(a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1))).rejects.toThrow("connection lost");
		await a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1));
		await a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 2));
		expect((await a.api.service.sampleUsage()).map((each) => each.at)).toEqual(
			[1, 2].map((seq) => T0 + seq * USAGE_INTERVAL_MS),
		);
	});

	it("of a restarted host's new run aren't exported twice when an old run's tick comes late to another replica", async () => {
		let clock = T0;
		const store = createMemoryStore();
		const a = setup(hostless(() => clock).backend, () => clock, store);
		const b = setup(hostless(() => clock).backend, () => clock, store);
		const box = await a.tom.createSandbox({ wait: true });
		const NEW_RUN = "fedcba9876543210";
		clock = T0 + 5 * USAGE_INTERVAL_MS;
		// The host restarted and joined B: B takes its new run's 1.
		await b.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1, NEW_RUN, T0 + 5 * USAGE_INTERVAL_MS));
		// A takes the old run's 4 late.
		await a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 4, RUN, T0 + 4 * USAGE_INTERVAL_MS));
		// The host moves to A and sends the new run's 1 again, its ack lost.
		await a.api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1, NEW_RUN, T0 + 5 * USAGE_INTERVAL_MS));
		const fromA = (await a.api.service.sampleUsage()).map((each) => each.at);
		const fromB = (await b.api.service.sampleUsage()).map((each) => each.at);
		expect(fromA).toEqual([T0 + 4 * USAGE_INTERVAL_MS]);
		expect(fromB).toEqual([T0 + 5 * USAGE_INTERVAL_MS]);
	});

	it("are claimed only while the host could send them again: an hour or more", async () => {
		let clock = T0;
		const store = createMemoryStore();
		const { api, tom } = setup(hostless(() => clock).backend, () => clock, store);
		const box = await tom.createSandbox({ wait: true });
		for (let seq = 1; seq <= 3; seq += 1) {
			clock = T0 + seq * USAGE_INTERVAL_MS;
			await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, seq));
		}
		expect(await store.usageClaims.list()).toHaveLength(3);
		// Over an hour on, the next tick sweeps them, keeping its own.
		clock = T0 + 2 * 3_600_000;
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 4, RUN, clock));
		// In the background: the tick doesn't wait for it.
		await vi.waitFor(async () =>
			expect((await store.usageClaims.list()).map((each) => each.id)).toEqual([`${STUB_HOST_ID}:${RUN}:4`]),
		);
	});

	it("taken from a new run aren't taken again after a late tick of the old run is passed on", async () => {
		let clock = T0;
		const { api, tom } = setup(hostless(() => clock).backend, () => clock);
		const box = await tom.createSandbox({ wait: true });
		const NEW_RUN = "fedcba9876543210";
		// The host restarted with its clock ahead: its new run's 1 is stamped on arrival.
		const ahead = T0 + 3_600_000;
		clock = T0 + USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1, NEW_RUN, ahead));
		// Another replica passes on its old run's 9, late.
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 9, RUN, T0), { shared: true });
		// The new run's 1 again, its ack lost: stamped on arrival again, it would be a second point.
		clock = T0 + 2 * USAGE_INTERVAL_MS;
		await api.service.recordUsage(STUB_HOST_ID, numbered(box.id, 1, NEW_RUN, ahead));
		expect((await api.service.sampleUsage()).map((each) => each.at)).toEqual([T0 + USAGE_INTERVAL_MS]);
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
		expect(spanMean(samples, 0, ROLLUP_MS)).toEqual({
			cpu: 0.2,
			memoryMb: 100,
			measured: true,
			cpuMax: 0.2,
			memoryMbMax: 100,
		});
		const straddling = spanMean(samples, ROLLUP_MS / 2, ROLLUP_MS + ROLLUP_MS / 2);
		expect(straddling.cpu).toBeCloseTo(0.4);
		expect(straddling.memoryMb).toBeCloseTo(200);
		const single = [{ at: 12_345, cpu: 0.7, memoryMb: 9 }];
		expect(spanMean(single, 0, ROLLUP_MS)).toEqual({
			cpu: 0.7,
			memoryMb: 9,
			measured: true,
			cpuMax: 0.7,
			memoryMbMax: 9,
		});
		expect(spanMean(single, 20_000, ROLLUP_MS)).toEqual({ cpu: 0, memoryMb: 0, measured: false });
		// A single reading taken on a 5-minute boundary is still a single reading: it counts only where it falls.
		const onBoundary = [{ at: ROLLUP_MS, cpu: 0.7, memoryMb: 9 }];
		expect(spanMean(onBoundary, ROLLUP_MS + 60_000, 2 * ROLLUP_MS)).toEqual({ cpu: 0, memoryMb: 0, measured: false });
		expect(spanMean(onBoundary, ROLLUP_MS, ROLLUP_MS + 60_000)).toEqual({
			cpu: 0.7,
			memoryMb: 9,
			measured: true,
			cpuMax: 0.7,
			memoryMbMax: 9,
		});
	});

	it("means disk and IO over the samples that have them, and covers an hourly mean's whole span", () => {
		const samples = [
			{ at: 0, cpu: 0.2, memoryMb: 100, readings: 60, diskMb: 1000, io: 0.1 },
			{ at: ROLLUP_MS, cpu: 0.6, memoryMb: 300, readings: 60 },
		];
		const both = spanMean(samples, 0, 2 * ROLLUP_MS);
		expect(both).toMatchObject({ measured: true, diskMb: 1000, io: 0.1 });
		expect(spanMean(samples, ROLLUP_MS, 2 * ROLLUP_MS)).toEqual({
			cpu: 0.6,
			memoryMb: 300,
			measured: true,
			cpuMax: 0.6,
			memoryMbMax: 300,
		});
		const hourly = [{ at: 0, cpu: 0.5, memoryMb: 50, readings: 720, spanMs: 3_600_000 }];
		expect(spanMean(hourly, 3_000_000, 3_300_000)).toMatchObject({ cpu: 0.5, measured: true });
		expect(spanMean(hourly, 3_600_000, 3_900_000).measured).toBe(false);
	});
});

describe("keptSamples", () => {
	const HOUR = 3_600_000;
	const fiveMinute = (at: number, cpu: number, extra: object = {}) => ({
		at,
		cpu,
		memoryMb: 10,
		readings: 60,
		...extra,
	});

	it("keeps a day of 5-minute means and folds older ones into hourly means, weighted by their readings", () => {
		// A day and an hour of 5-minute means: the first hour's twelve fold into one.
		const samples = Array.from({ length: MAX_SAMPLES + 12 }, (_, i) =>
			fiveMinute(i * ROLLUP_MS, i < 12 ? (i < 6 ? 0.2 : 0.4) : 0.9, i === 0 ? { diskMb: 100, io: 0.5 } : {}),
		);
		const kept = keptSamples(samples);
		expect(kept).toHaveLength(MAX_SAMPLES + 1);
		const [hour] = kept;
		expect(hour).toMatchObject({ at: 0, readings: 720, spanMs: HOUR, diskMb: 100, io: 0.5 });
		expect(hour?.cpu).toBeCloseTo(0.3);
		expect(kept[1]).toEqual(samples[12]);
		// An hour's highest is the highest of its 5-minute means: their own where kept, else their means.
		expect(hour).toMatchObject({ cpuMax: 0.4, memoryMbMax: 10 });
		// Under a day, nothing changes.
		expect(keptSamples(samples.slice(12))).toEqual(samples.slice(12));
	});

	it("adds a 5-minute mean to its hour's mean, and keeps at most HOURLY_SAMPLES hours", () => {
		const hours = Array.from({ length: HOURLY_SAMPLES }, (_, i) => ({
			at: i * HOUR,
			cpu: 0.1,
			memoryMb: 10,
			readings: 60,
			spanMs: ROLLUP_MS,
		}));
		const last = (HOURLY_SAMPLES - 1) * HOUR;
		const day = Array.from({ length: MAX_SAMPLES + 1 }, (_, i) => fiveMinute(last + (i + 1) * ROLLUP_MS, 0.5));
		const kept = keptSamples([...hours, ...day]);
		expect(kept).toHaveLength(HOURLY_SAMPLES + MAX_SAMPLES);
		// The overflowing 5-minute mean was in the last hour's clock hour: folded into it, its span reaching to its end.
		const folded = kept[HOURLY_SAMPLES - 1];
		expect(folded).toMatchObject({ at: last, readings: 120, spanMs: 2 * ROLLUP_MS });
		expect(folded?.cpu).toBeCloseTo(0.3);
		// Eleven more fill that hour and start the next, which pushes out the oldest hour.
		const more = Array.from({ length: 11 }, (_, i) => fiveMinute(last + (MAX_SAMPLES + 2 + i) * ROLLUP_MS, 0.5));
		const next = keptSamples([...kept, ...more]);
		expect(next).toHaveLength(HOURLY_SAMPLES + MAX_SAMPLES);
		expect(next[0]?.at).toBe(HOUR);
		expect(next[HOURLY_SAMPLES - 2]).toMatchObject({ at: last, readings: 720, spanMs: HOUR });
		expect(next[HOURLY_SAMPLES - 1]).toMatchObject({ at: last + HOUR, readings: 60, spanMs: ROLLUP_MS });
	});

	it("weights an hour's disk and IO only by the readings that had them", () => {
		// IO 0, then a 5-minute mean whose guest never answered, then IO 1: the hour's IO is 1/2, not 1/3. Disk: 100 MB
		// from all 60 readings, then 400 MB from 20 of 60.
		const hour = [
			fiveMinute(0, 0.5, { io: 0, diskMb: 100 }),
			fiveMinute(ROLLUP_MS, 0.5),
			fiveMinute(2 * ROLLUP_MS, 0.5, { io: 1, diskMb: 400, diskReadings: 20 }),
		];
		const day = Array.from({ length: MAX_SAMPLES }, (_, i) => fiveMinute(HOUR + i * ROLLUP_MS, 0.5));
		const [folded] = keptSamples([...hour, ...day]);
		expect(folded).toMatchObject({ readings: 180, diskReadings: 80, ioReadings: 120 });
		expect(folded?.io).toBeCloseTo(0.5);
		expect(folded?.diskMb).toBeCloseTo(175);
		// Folding it again keeps the weights: another 60 readings at IO 1 make it (0 + 60 + 60) / 180.
		const [again] = keptSamples([
			folded as NonNullable<typeof folded>,
			fiveMinute(3 * ROLLUP_MS, 0.5, { io: 1 }),
			...day,
		]);
		expect(again).toMatchObject({ readings: 240, ioReadings: 180 });
		expect(again?.io).toBeCloseTo(2 / 3);
		// A spanMean over the hour weights them the same way.
		expect(spanMean([folded as NonNullable<typeof folded>], 0, HOUR).io).toBeCloseTo(0.5);
		// An hour with neither has neither.
		const [bare] = keptSamples([fiveMinute(0, 0.5), fiveMinute(ROLLUP_MS, 0.5), ...day]);
		expect(bare).not.toHaveProperty("io");
		expect(bare).not.toHaveProperty("diskMb");
		expect(bare).not.toHaveProperty("ioReadings");
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

	it("isn't read by running a command while the hosts can't be read either", async () => {
		let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
		const { backend: stub, reads } = hostless(() => clock);
		let failing = false;
		const backend: SandboxBackend = {
			...stub,
			capabilities: async () => {
				if (failing) throw new Error("the host list is out of reach");
				return stub.capabilities();
			},
		};
		const { api, tom } = setup(backend, () => clock);
		const box = await tom.createSandbox({ type: "microvm", size: "small", wait: true });
		const reading = [{ id: box.id, kind: "microvm" as const, cpu: 0.5, memUsedBytes: MIB, memLimitBytes: MIB }];
		const first = clock;
		await api.service.recordUsage(STUB_HOST_ID, tick(first, reading));
		failing = true;
		for (let index = 1; index <= 12; index += 1) {
			clock = first + index * USAGE_INTERVAL_MS;
			await tom.getSandboxUsage(box.id);
			if (index % 6 === 0) await api.service.sampleUsage();
		}
		expect(reads).toEqual([]);
		for (let index = 1; index <= 12; index += 1) {
			await api.service.recordUsage(STUB_HOST_ID, tick(first + index * USAGE_INTERVAL_MS, reading));
		}
		expect((await tom.getSandboxUsage(box.id)).series.points).toHaveLength(13);
		// Once they can be read again and the host turns out not to send ticks (the stub names no features), it is.
		failing = false;
		clock += 60_000;
		await tom.getSandboxUsage(box.id);
		expect(reads).toEqual([box.id]);
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
