import { describe, expect, it } from "vitest";
import type { UsageSeries } from "./compute-model.ts";
import { gbText, mergeSeries } from "./live-usage.ts";
import { linePoints } from "./parts.tsx";
import { STUB_INTERVAL_MS, stubUsage } from "./usage-stub.ts";

const series = (ats: readonly number[], extra: Partial<UsageSeries> = {}): UsageSeries => ({
	intervalMs: 5_000,
	points: ats.map((at) => ({ at, cpu: at / 100_000, memUsedBytes: at })),
	...extra,
});

describe("live usage", () => {
	it("adds a read's new points after the ones it has, each once, oldest first", () => {
		const merged = mergeSeries(series([5_000, 10_000]), series([10_000, 15_000]), 60_000);
		expect(merged.points.map((point) => point.at)).toEqual([5_000, 10_000, 15_000]);
	});

	it("keeps only the window before the newest point, whatever this browser's clock says", () => {
		const merged = mergeSeries(series([0, 5_000, 10_000]), series([15_000, 20_000]), 10_000);
		expect(merged.points.map((point) => point.at)).toEqual([15_000, 20_000]);
	});

	it("keeps the limits from an earlier read when a later one leaves them out", () => {
		const first = series([5_000], { memLimitBytes: 8, diskTotalBytes: 9 });
		const merged = mergeSeries(first, series([10_000]), 60_000);
		expect(merged.memLimitBytes).toBe(8);
		expect(merged.diskTotalBytes).toBe(9);
		expect(mergeSeries(first, series([10_000], { memLimitBytes: 16 }), 60_000).memLimitBytes).toBe(16);
	});

	it("starts from nothing", () => {
		expect(mergeSeries(undefined, series([]), 60_000).points).toEqual([]);
	});

	it("says GB with a decimal under 10 and none above", () => {
		expect(gbText(0.4 * 1024 ** 3)).toBe("0.4");
		expect(gbText(3.25 * 1024 ** 3)).toBe("3.3");
		expect(gbText(141.2 * 1024 ** 3)).toBe("141");
		expect(gbText(1_210 * 1024 ** 3)).toBe("1,210");
	});
});

describe("the stub usage", () => {
	const options = { memLimitBytes: 8 * 1024 ** 3, diskTotalBytes: 100 * 1024 ** 3 };

	it("gives a point every 5 seconds after `since`, up to now", () => {
		const now = 1_000_000_000_000;
		const read = stubUsage("sbx_1", { ...options, since: now - 60_000, now });
		expect(read.intervalMs).toBe(STUB_INTERVAL_MS);
		expect(read.points).toHaveLength(12);
		expect(read.points.every((point) => point.at > now - 60_000 && point.at <= now)).toBe(true);
	});

	it("answers the same for the same id and time, so a read again only adds at the end", () => {
		const now = 1_000_000_000_000;
		const first = stubUsage("host_a", { ...options, since: now - 60_000, now });
		const again = stubUsage("host_a", { ...options, since: now - 30_000, now: now + 10_000 });
		const shared = again.points.filter((point) => point.at <= now);
		expect(shared).toEqual(first.points.filter((point) => point.at > now - 30_000));
		expect(again.points.at(-1)?.at).toBe(now + 10_000);
	});

	it("stays within what there is", () => {
		const now = 1_000_000_000_000;
		const read = stubUsage("busy", { ...options, since: now - 3_600_000, now, busy: 0.9 });
		for (const point of read.points) {
			expect(point.cpu).toBeGreaterThan(0);
			expect(point.cpu).toBeLessThanOrEqual(1);
			expect(point.memUsedBytes).toBeLessThan(options.memLimitBytes);
			expect(point.diskUsedBytes).toBeLessThanOrEqual(options.diskTotalBytes);
		}
	});
});

describe("a graph's line", () => {
	it("ends at the right edge when it has fewer values than slots, so it grows from the right", () => {
		const points = linePoints([0, 1], { width: 100, height: 11, slots: 11 });
		expect(points).toEqual([
			[90, 10],
			[100, 1],
		]);
	});

	it("spreads across the width without slots", () => {
		expect(linePoints([0, 0.5, 1], { width: 100, height: 11 }).map(([x]) => x)).toEqual([0, 50, 100]);
	});

	it("draws against a limit and never past it", () => {
		const [half, over] = linePoints([4, 12], { width: 10, height: 11, max: 8 });
		expect(half?.[1]).toBeCloseTo(5.5);
		expect(over?.[1]).toBe(1);
	});
});
