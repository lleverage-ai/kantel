import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HOUR, MINUTE } from "../primitives/format.ts";
import type { Sandbox, UsageSeries } from "./compute-model.ts";
import { API_SERVER, SCRATCH } from "./fixtures.ts";
import {
	chartSegments,
	latestOf,
	measuredIn,
	type ProcessesRead,
	ProcessesSection,
	ProcessTable,
	peakMemoryOf,
	peakOf,
	percentText,
	shareAt,
	ticksOf,
	UsageSparkline,
} from "./usage-metrics.tsx";
import { stubUsage } from "./usage-stub.ts";

const GB = 1024 ** 3;

const series = (points: UsageSeries["points"], extra: Partial<UsageSeries> = {}): UsageSeries => ({
	intervalMs: 5_000,
	memLimitBytes: 4 * GB,
	points,
	...extra,
});

describe("a sandbox's metrics", () => {
	it("reads each metric as a share of what it has, and leaves out what isn't measured", () => {
		const point = { at: 0, cpu: 0.25, memUsedBytes: GB, diskUsedBytes: 5 * GB, ioPressure: 0.1 };
		const full = series([point], { diskTotalBytes: 20 * GB });
		expect(shareAt("cpu", point, full)).toBe(0.25);
		expect(shareAt("memory", point, full)).toBe(0.25);
		expect(shareAt("disk", point, full)).toBe(0.25);
		expect(shareAt("io", point, full)).toBe(0.1);
		// An older host: CPU and memory, no disk size and no IO.
		const old = series([{ at: 0, cpu: 0.5, memUsedBytes: GB }]);
		expect(shareAt("disk", { at: 0, cpu: 0.5, memUsedBytes: GB }, old)).toBeUndefined();
		expect([...measuredIn(old)].sort()).toEqual(["cpu", "memory"]);
		expect([...measuredIn(full)].sort()).toEqual(["cpu", "disk", "io", "memory"]);
		expect(measuredIn(undefined).size).toBe(0);
	});

	it("keeps each metric's newest reading and its peak", () => {
		const read = series([
			{ at: 0, cpu: 0.9, memUsedBytes: GB, ioPressure: 0.2 },
			{ at: 5_000, cpu: 0.1, memUsedBytes: 2 * GB },
		]);
		const latest = latestOf(read);
		expect(latest.cpu?.share).toBe(0.1);
		expect(latest.memory?.share).toBe(0.5);
		// The newest point has no IO reading, so the one before it is the newest IO.
		expect(latest.io?.point.at).toBe(0);
		expect(peakOf("cpu", read)).toBe(0.9);
		expect(peakMemoryOf(read)).toBe(2 * GB);
		// A mean's peak is its interval's highest reading, not the mean.
		const means = series([
			{ at: 0, cpu: 0.2, cpuMax: 1, memUsedBytes: GB, memMaxBytes: 3 * GB },
			{ at: 300_000, cpu: 0.3, memUsedBytes: 2 * GB },
		]);
		expect(peakOf("cpu", means)).toBe(1);
		expect(peakOf("memory", means)).toBe(0.75);
		expect(peakMemoryOf(means)).toBe(3 * GB);
		expect(latestOf(means).memory?.share).toBe(0.5);
		expect(percentText(0.004)).toBe("<1%");
		expect(percentText(0)).toBe("0%");
		expect(percentText(0.456)).toBe("46%");
	});

	it("breaks the chart's line where readings stop, and keeps a lone reading visible", () => {
		const read = series([
			{ at: 0, cpu: 0.5, memUsedBytes: 0 },
			{ at: 5_000, cpu: 0.5, memUsedBytes: 0 },
			// A minute with none.
			{ at: 65_000, cpu: 1, memUsedBytes: 0 },
		]);
		const segments = chartSegments(read, "cpu", 0, 100_000);
		expect(segments).toHaveLength(2);
		expect(segments[0]).toHaveLength(2);
		// The lone point is drawn as a short stroke, not dropped.
		expect(segments[1]).toHaveLength(2);
		expect(segments[1]?.[1]?.[1]).toBe(0);
	});

	it("marks an hour every 10 minutes and a week each midnight", () => {
		const to = new Date(2026, 10, 5, 14, 37).getTime();
		const hour = ticksOf("1h", to - HOUR, to);
		expect(hour).toHaveLength(6);
		for (const at of hour) expect(new Date(at).getMinutes() % 10).toBe(0);
		const week = ticksOf("1w", to - 7 * 24 * HOUR, to);
		expect(week).toHaveLength(7);
		for (const at of week) expect(new Date(at).getHours()).toBe(0);
	});

	it("says what each line is in its accessible name, and that a click opens the dialog", () => {
		const read = stubUsage("sbx_test", {
			since: 0,
			now: 10 * MINUTE,
			memLimitBytes: 4 * GB,
			diskTotalBytes: 20 * GB,
			io: true,
		});
		const html = renderToStaticMarkup(createElement(UsageSparkline, { name: "api", series: read, onOpen: () => {} }));
		expect(html).toMatch(/aria-label="Metrics of api: CPU \d+%, RAM \d+%, Disk \d+%, IO (<1|\d+)%"/);
		expect(html).toContain('aria-haspopup="dialog"');
		const stopped = renderToStaticMarkup(
			createElement(UsageSparkline, { name: "api", series: undefined, running: false }),
		);
		expect(stopped).toContain("Metrics of api: not running");
	});

	it("lists processes by their command line, CPU and memory in MB", () => {
		const html = renderToStaticMarkup(
			createElement(ProcessTable, {
				processes: [{ pid: 1, command: "node server.js", cpuPercent: 12.345, memoryBytes: 300 * 1024 ** 2 }],
			}),
		);
		expect(html).toContain("node server.js");
		expect(html).toContain(">12.3<");
		expect(html).toContain(">300<");
	});

	it("says why it has no processes to list: stopped, an isolate, or a host or guest agent that can't list them", () => {
		const reload = () => undefined;
		const running = API_SERVER;
		const isolate = SCRATCH;
		expect([running.kind, running.state, isolate.kind, isolate.state]).toEqual([
			"microvm",
			"running",
			"isolate",
			"running",
		]);
		const stopped = { ...running, state: "stopped" as const };
		const html = (sandbox: Sandbox, listed: boolean, read: ProcessesRead) =>
			renderToStaticMarkup(createElement(ProcessesSection, { sandbox, listed, read }));
		const rows = [{ pid: 812, command: "yes", cpuPercent: 99.5, memoryBytes: 1024 ** 2 }];
		const ready = { status: "ready", value: rows, reload } as const;

		expect(html(stopped, true, ready)).toContain("It isn&#x27;t running, so it has no processes.");
		const isolated = html(isolate, false, { status: "loading", reload });
		expect(isolated).toContain("Not listed for an isolate");
		expect(isolated).not.toContain("can&#x27;t list");
		// No read in the source, or one that answered that this sandbox's host or guest agent can't list them.
		const unlisted = "This sandbox&#x27;s host can&#x27;t list its processes yet.";
		expect(html(running, false, { status: "loading", reload })).toContain(unlisted);
		const older = html(running, true, { status: "ready", value: null, reload });
		expect(older).toContain(unlisted);
		expect(older).not.toContain("Read the processes again");
		// While it reads, if it fails before any answer, with none, and with some.
		expect(html(running, true, { status: "loading", reload })).toContain('aria-busy="true"');
		expect(html(running, true, { status: "error", error: new Error("The host went away"), reload })).toContain(
			"The host went away",
		);
		expect(html(running, true, { status: "ready", value: [], reload })).toContain("No processes");
		const listed = html(running, true, ready);
		expect(listed).toContain(">yes<");
		expect(listed).toContain(">99.5<");
		expect(listed).toContain("Read the processes again");
		// A failed read again keeps the last answer.
		expect(html(running, true, { status: "error", error: new Error("gone"), value: rows, reload })).toContain(">yes<");
	});
});
