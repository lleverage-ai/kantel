// A sandbox's metrics together: CPU, memory, disk and IO as one small chart in its row (the Sandboxes list's Usage
// column), and, a click on that, its metrics dialog: the last hour, day or week, the four as they are now, the four on
// one chart with a legend and a reading under the pointer, and its busiest processes. After boat.dev's sandboxes list
// (Tom, 5 Nov 2026). A metric the sandbox's host doesn't measure yet is never drawn as a zero: the row leaves its line
// out and the dialog says it isn't measured.

import { type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { SegmentedControl } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import { ReconnectIcon, TelemetryIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import { Tooltip } from "../primitives/tooltip.tsx";
import type { Sandbox, SandboxesSource, SandboxProcess, UsagePoint, UsageRange, UsageSeries } from "./compute-model.ts";
import { gbText, lineOf } from "./live-usage.ts";
import { lineSegments, messageOf } from "./parts.tsx";

// ---------------------------------------------------------------------------------------------------------------------
// The four metrics

export type MetricKey = "cpu" | "memory" | "disk" | "io";

export interface Metric {
	readonly key: MetricKey;
	/** Its name in a legend and a heading: "CPU", "RAM". */
	readonly label: string;
	/** Its line's colour (`currentColor`), and its legend dot's. */
	readonly line: string;
	readonly dot: string;
}

/** In the order a legend lists them; the row draws CPU last, on top. */
export const METRICS: readonly Metric[] = [
	{ key: "cpu", label: "CPU", line: "text-chart-cpu", dot: "bg-chart-cpu" },
	{ key: "memory", label: "RAM", line: "text-chart-memory", dot: "bg-chart-memory" },
	{ key: "disk", label: "Disk", line: "text-chart-disk", dot: "bg-chart-disk" },
	{ key: "io", label: "IO", line: "text-chart-io", dot: "bg-chart-io" },
];

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * A metric at one point as a share, 0 to 1: CPU of its vCPUs, memory of its limit, disk of its size, and the time its
 * work waited on IO. Undefined where it isn't measured (no limit or size to measure against, or no reading).
 */
export function shareAt(
	key: MetricKey,
	point: UsagePoint,
	series: Pick<UsageSeries, "memLimitBytes" | "diskTotalBytes">,
) {
	switch (key) {
		case "cpu":
			return clamp01(point.cpu);
		case "memory":
			return series.memLimitBytes === undefined || series.memLimitBytes <= 0
				? undefined
				: clamp01(point.memUsedBytes / series.memLimitBytes);
		case "disk":
			return point.diskUsedBytes === undefined || series.diskTotalBytes === undefined || series.diskTotalBytes <= 0
				? undefined
				: clamp01(point.diskUsedBytes / series.diskTotalBytes);
		case "io":
			return point.ioPressure === undefined ? undefined : clamp01(point.ioPressure);
	}
}

/** The metrics a series has a reading of, at any of its points. */
export function measuredIn(series: UsageSeries | undefined): ReadonlySet<MetricKey> {
	const found = new Set<MetricKey>();
	for (const point of series?.points ?? [])
		for (const { key } of METRICS)
			if (!found.has(key) && shareAt(key, point, series ?? {}) !== undefined) found.add(key);
	return found;
}

/** Each metric's newest reading in a series, and the point it's from. */
export function latestOf(
	series: UsageSeries | undefined,
): Partial<Record<MetricKey, { share: number; point: UsagePoint }>> {
	const latest: Partial<Record<MetricKey, { share: number; point: UsagePoint }>> = {};
	const points = series?.points ?? [];
	for (const { key } of METRICS) {
		for (let at = points.length - 1; at >= 0; at -= 1) {
			const point = points[at];
			const share = point === undefined || series === undefined ? undefined : shareAt(key, point, series);
			if (point !== undefined && share !== undefined) {
				latest[key] = { share, point };
				break;
			}
		}
	}
	return latest;
}

/** A share as a whole percentage: "12%", "<1%" for a little above none, "0%". */
export function percentText(share: number): string {
	if (share > 0 && share < 0.005) return "<1%";
	return `${Math.round(share * 100)}%`;
}

/** The highest reading of a metric in a series, as a share. */
export function peakOf(key: MetricKey, series: UsageSeries | undefined): number | undefined {
	let peak: number | undefined;
	for (const point of series?.points ?? []) {
		const share = series === undefined ? undefined : shareAt(key, point, series);
		if (share !== undefined && (peak === undefined || share > peak)) peak = share;
	}
	return peak;
}

/** "2.0 of 7.8 GB": memory or disk in use of what there is. */
const ofGb = (used: number, total: number): string => `${gbText(used)} of ${gbText(total)} GB`;

/** What a metric's reading says beside its share: how much of how much, where that's known. */
function detailOf(key: MetricKey, point: UsagePoint, series: UsageSeries): string | undefined {
	if (key === "memory" && series.memLimitBytes !== undefined) return ofGb(point.memUsedBytes, series.memLimitBytes);
	if (key === "disk" && point.diskUsedBytes !== undefined && series.diskTotalBytes !== undefined)
		return ofGb(point.diskUsedBytes, series.diskTotalBytes);
	return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// The row's chart

/** How much a row's chart draws: the last 10 minutes. */
export const ROW_USAGE_SPAN_MS = 10 * MINUTE;

const ROW_WIDTH = 96;
const ROW_HEIGHT = 24;

const pointsText = (points: readonly (readonly [number, number])[]): string =>
	points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/** The four in a tooltip or a reading: a dot, the name, the share and how much of how much. */
function Readings({
	series,
	point,
	hidden,
}: {
	series: UsageSeries | undefined;
	/** One point's readings; without, each metric's newest. */
	point?: UsagePoint;
	hidden?: ReadonlySet<MetricKey>;
}) {
	const latest = point === undefined ? latestOf(series) : undefined;
	return (
		<span className="grid grid-cols-[auto_auto_1fr] items-baseline gap-x-2 gap-y-0.5 tabular-nums">
			{METRICS.filter(({ key }) => hidden?.has(key) !== true).map(({ key, label, dot }) => {
				const at = point ?? latest?.[key]?.point;
				const share = at === undefined || series === undefined ? undefined : shareAt(key, at, series);
				const detail =
					at === undefined || series === undefined || share === undefined ? undefined : detailOf(key, at, series);
				return (
					<span key={key} className="contents">
						<span className={`inline-block size-dot -translate-y-px rounded-full ${dot}`} aria-hidden="true" />
						<span className="text-muted">{label}</span>
						<span className={share === undefined ? "text-faint" : "text-fg"}>
							{share === undefined ? "Not measured" : percentText(share)}
							{detail === undefined ? null : <span className="text-muted"> ({detail})</span>}
						</span>
					</span>
				);
			})}
		</span>
	);
}

/**
 * A sandbox's CPU, memory, disk and IO over the last 10 minutes as one small chart, a line each, 0 to 100% from the
 * bottom up, CPU on top; its tooltip has the latest of each, and a click opens its metrics dialog. A metric that isn't
 * measured has no line. Without live readings it's the sandbox's recent CPU as listed (`fallback`), which doesn't move;
 * a sandbox that isn't running is a faint flat line, still a way into its metrics.
 */
export function UsageSparkline({
	name,
	series,
	fallback = [],
	loading = false,
	running = true,
	onOpen,
}: {
	/** The sandbox's name, for its accessible name. */
	name: string;
	series: UsageSeries | undefined;
	/** Its recent CPU, 0 to 1, untimed: what's drawn where there's no live series. */
	fallback?: readonly number[];
	loading?: boolean;
	running?: boolean;
	/** Opens its metrics dialog. Without, the chart is only a picture. */
	onOpen?: () => void;
}) {
	const lines = useMemo(() => {
		if (!running) return [];
		if (series === undefined) {
			const cpu = METRICS[0];
			return fallback.length < 2 || cpu === undefined
				? []
				: [{ metric: cpu, segments: lineSegments(fallback, { width: ROW_WIDTH, height: ROW_HEIGHT }) }];
		}
		return METRICS.map((metric) => {
			const line = lineOf(series, (point) => shareAt(metric.key, point, series), ROW_USAGE_SPAN_MS);
			return {
				metric,
				segments:
					line.values.length < 2
						? []
						: lineSegments(line.values, {
								width: ROW_WIDTH,
								height: ROW_HEIGHT,
								timed: { ...line.timed, spanMs: ROW_USAGE_SPAN_MS },
							}),
			};
		})
			.filter((line) => line.segments.length > 0)
			.reverse();
	}, [series, fallback, running]);
	const latest = latestOf(series);
	const summary = METRICS.flatMap(({ key, label }) => {
		const reading = latest[key];
		return reading === undefined ? [] : [`${label} ${percentText(reading.share)}`];
	});
	const label = !running
		? `Metrics of ${name}: not running`
		: loading
			? `Reading ${name}'s metrics`
			: summary.length === 0
				? `Metrics of ${name}: no readings yet`
				: `Metrics of ${name}: ${summary.join(", ")}`;
	const chart = (
		<svg
			className={`block h-6 w-24 flex-none overflow-visible ${loading ? breathe : ""}`}
			viewBox={`0 0 ${ROW_WIDTH} ${ROW_HEIGHT}`}
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			{lines.length === 0 ? (
				<line
					className="text-faint"
					x1="0"
					x2={ROW_WIDTH}
					y1={ROW_HEIGHT - 1}
					y2={ROW_HEIGHT - 1}
					stroke="currentColor"
					strokeWidth="1.25"
					vectorEffect="non-scaling-stroke"
					{...(loading ? { strokeDasharray: "2 3" } : {})}
				/>
			) : (
				lines.map(({ metric, segments }) => (
					<g key={metric.key} className={metric.line}>
						{segments.map((points) => (
							<polyline
								key={points[0]?.[0] ?? 0}
								points={pointsText(points)}
								fill="none"
								stroke="currentColor"
								strokeWidth="1.25"
								strokeLinejoin="round"
								vectorEffect="non-scaling-stroke"
							/>
						))}
					</g>
				))
			)}
		</svg>
	);
	const tip = (
		<span className="flex flex-col gap-1.5">
			<span className="text-fg">CPU, RAM, disk and IO {running ? "over the last 10 minutes" : ""}</span>
			{running ? <Readings series={series} /> : <span className="text-muted">Not running now.</span>}
			{onOpen === undefined ? null : <span className="text-muted">Click for details.</span>}
		</span>
	);
	if (onOpen === undefined)
		return (
			<span role="img" aria-label={label} className="inline-flex">
				{chart}
			</span>
		);
	return (
		<Tooltip content={tip}>
			<button
				type="button"
				className="kt-usage-sparkline kt-focusable relative z-1 -m-1 inline-flex cursor-pointer rounded-control border border-transparent bg-transparent p-1 hover:border-border-strong hover:bg-sunken"
				aria-label={label}
				aria-haspopup="dialog"
				{...(loading ? { "aria-busy": true } : {})}
				onClick={onOpen}
			>
				{chart}
			</button>
		</Tooltip>
	);
}

/** A loading line's breathing: opacity only, as the status dots do. */
const breathe = "animate-[kt-pulse_var(--kt-duration-pulse)_var(--kt-ease-breathe)_infinite]";

// ---------------------------------------------------------------------------------------------------------------------
// The dialog's chart

/** Each range's span, and the gap between ticks on its time axis. */
export const RANGES: Readonly<
	Record<UsageRange, { readonly spanMs: number; readonly tickMs: number; readonly words: string }>
> = {
	"1h": { spanMs: HOUR, tickMs: 10 * MINUTE, words: "the last hour" },
	"24h": { spanMs: DAY, tickMs: 3 * HOUR, words: "the last 24 hours" },
	"1w": { spanMs: 7 * DAY, tickMs: DAY, words: "the last week" },
};

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric" });
const dayClock = new Intl.DateTimeFormat("en-GB", {
	weekday: "short",
	day: "numeric",
	month: "short",
	hour: "2-digit",
	minute: "2-digit",
});

/**
 * The times a range's axis marks, oldest first, on the local clock: every 10 minutes over an hour, every 3 hours over
 * a day, each midnight over a week.
 */
export function ticksOf(range: UsageRange, from: number, to: number): readonly number[] {
	const { tickMs } = RANGES[range];
	const start = new Date(from);
	if (range === "1w") start.setHours(0, 0, 0, 0);
	else if (range === "24h") start.setHours(Math.floor(start.getHours() / 3) * 3, 0, 0, 0);
	else start.setMinutes(Math.floor(start.getMinutes() / 10) * 10, 0, 0);
	const ticks: number[] = [];
	for (let at = start.getTime(); at <= to; ) {
		if (at >= from) ticks.push(at);
		const next = new Date(at);
		// By the clock, not by adding milliseconds, so a clock change doesn't move the marks off the hour.
		if (range === "1w") next.setDate(next.getDate() + 1);
		else if (range === "24h") next.setHours(next.getHours() + 3);
		else next.setTime(at + tickMs);
		at = next.getTime();
	}
	return ticks;
}

/** A tick's words: "14:30", or "Tue 4" over a week. */
export const tickText = (range: UsageRange, at: number): string =>
	range === "1w" ? weekday.format(at) : clock.format(at);

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 200;
const GRID = [0, 0.25, 0.5, 0.75, 1] as const;

/**
 * One metric's line between `from` and `to`, in the chart's box: a piece for each run of readings, broken where three
 * intervals pass without one, so missing readings show as missing.
 */
export function chartSegments(
	series: UsageSeries,
	key: MetricKey,
	from: number,
	to: number,
): readonly (readonly [number, number])[][] {
	const span = Math.max(1, to - from);
	const gapMs = 3 * Math.max(series.intervalMs, 5_000);
	const segments: [number, number][][] = [];
	let previous: number | undefined;
	for (const point of series.points) {
		if (point.at < from || point.at > to) continue;
		const share = shareAt(key, point, series);
		if (share === undefined) {
			previous = undefined;
			continue;
		}
		const xy: [number, number] = [((point.at - from) / span) * CHART_WIDTH, (1 - share) * CHART_HEIGHT];
		const last = segments.at(-1);
		if (last === undefined || previous === undefined || point.at - previous > gapMs) segments.push([xy]);
		else last.push(xy);
		previous = point.at;
	}
	return segments.map((segment) => {
		const only = segment[0];
		return segment.length === 1 && only !== undefined ? [[Math.max(0, only[0] - 2), only[1]], only] : segment;
	});
}

/** The point nearest a time, among those in the range. */
function nearest(series: UsageSeries | undefined, at: number, from: number, to: number): UsagePoint | undefined {
	let best: UsagePoint | undefined;
	for (const point of series?.points ?? []) {
		if (point.at < from || point.at > to) continue;
		if (best === undefined || Math.abs(point.at - at) < Math.abs(best.at - at)) best = point;
	}
	return best;
}

/**
 * The four on one chart, 0 to 100% up its side and the range's times along its foot, a gridline at each quarter. The
 * pointer over it marks the nearest reading with its time and figures.
 */
export function MetricsChart({
	series,
	range,
	to,
	hidden,
	loading = false,
	label,
}: {
	series: UsageSeries | undefined;
	range: UsageRange;
	/** The right-hand edge: now. */
	to: number;
	hidden: ReadonlySet<MetricKey>;
	loading?: boolean;
	label: string;
}) {
	const from = to - RANGES[range].spanMs;
	const plot = useRef<HTMLDivElement>(null);
	const [hover, setHover] = useState<UsagePoint>();
	const measured = measuredIn(series);
	const shown = METRICS.filter(({ key }) => measured.has(key) && !hidden.has(key)).reverse();
	const ticks = ticksOf(range, from, to);
	const xOf = (at: number) => ((at - from) / (to - from)) * 100;
	const onMove = (event: PointerEvent<HTMLDivElement>) => {
		const box = plot.current?.getBoundingClientRect();
		if (box === undefined || box.width === 0) return;
		const at = from + ((event.clientX - box.left) / box.width) * (to - from);
		setHover(nearest(series, at, from, to));
	};
	const hoverX = hover === undefined ? undefined : xOf(hover.at);
	return (
		<div className="kt-metrics-chart grid min-w-0 grid-cols-[auto_1fr] gap-x-2 gap-y-1.5">
			<div className="relative w-9 text-right text-2xs text-faint tabular-nums" aria-hidden="true">
				{GRID.map((share) => (
					<span key={share} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - share) * 100}%` }}>
						{share * 100}%
					</span>
				))}
			</div>
			<div
				ref={plot}
				className={`relative h-52 min-w-0 ${loading ? breathe : ""}`}
				role="img"
				aria-label={label}
				{...(loading ? { "aria-busy": true } : {})}
				onPointerMove={onMove}
				onPointerLeave={() => setHover(undefined)}
			>
				<svg
					className="absolute inset-0 block size-full overflow-visible"
					viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					{GRID.map((share) => (
						<line
							key={share}
							className={share === 0 ? "text-border-strong" : "text-border"}
							x1="0"
							x2={CHART_WIDTH}
							y1={(1 - share) * CHART_HEIGHT}
							y2={(1 - share) * CHART_HEIGHT}
							stroke="currentColor"
							{...(share === 0 ? {} : { strokeDasharray: "3 4" })}
							vectorEffect="non-scaling-stroke"
						/>
					))}
					{series === undefined
						? null
						: shown.map(({ key, line }) => (
								<g key={key} className={line}>
									{chartSegments(series, key, from, to).map((points) => (
										<polyline
											key={points[0]?.[0] ?? 0}
											points={pointsText(points)}
											fill="none"
											stroke="currentColor"
											strokeWidth="1.5"
											strokeLinejoin="round"
											vectorEffect="non-scaling-stroke"
										/>
									))}
								</g>
							))}
				</svg>
				{hover === undefined || hoverX === undefined || series === undefined ? null : (
					<>
						<span
							className="pointer-events-none absolute inset-y-0 w-px bg-border-strong"
							style={{ left: `${hoverX}%` }}
							aria-hidden="true"
						/>
						{shown.map(({ key, dot }) => {
							const share = shareAt(key, hover, series);
							return share === undefined ? null : (
								<span
									key={key}
									className={`pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-raised ${dot}`}
									style={{ left: `${hoverX}%`, top: `${(1 - share) * 100}%` }}
									aria-hidden="true"
								/>
							);
						})}
						<span
							className={`kt-metrics-reading pointer-events-none absolute top-2 flex w-max flex-col gap-1 rounded-control border border-border-strong bg-raised px-2.5 py-1.5 text-xs shadow-float ${hoverX > 60 ? "-translate-x-full -ml-2" : "ml-2"}`}
							style={{ left: `${hoverX}%` }}
						>
							<span className="text-muted tabular-nums">{(range === "1w" ? dayClock : clock).format(hover.at)}</span>
							<Readings
								series={series}
								point={hover}
								hidden={new Set(METRICS.map(({ key }) => key).filter((key) => !shown.some((m) => m.key === key)))}
							/>
						</span>
					</>
				)}
			</div>
			<span />
			<div className="relative h-4 text-2xs text-faint tabular-nums" aria-hidden="true">
				{ticks.map((at) => (
					<span key={at} className="absolute top-0 -translate-x-1/2 whitespace-nowrap" style={{ left: `${xOf(at)}%` }}>
						{tickText(range, at)}
					</span>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// The dialog

/** How often the open dialog reads again: every 10 seconds over an hour, every minute over longer. */
const historyPollMs = (range: UsageRange): number => (range === "1h" ? 10_000 : 60_000);
/** How often it reads the processes again. */
const PROCESSES_POLL_MS = 10_000;
/** How many processes it lists. */
const PROCESSES_SHOWN = 8;

type Read<T> =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: unknown; readonly value?: T }
	| { readonly status: "ready"; readonly value: T };

/** `load` now and every `pollMs` while mounted and the tab is shown; a failed read keeps the last answer. */
function usePolled<T>(
	load: (() => Promise<T>) | undefined,
	key: string,
	pollMs: number,
): Read<T> & { reload: () => void } {
	const [state, setState] = useState<Read<T>>({ status: "loading" });
	const [generation, setGeneration] = useState(0);
	const latest = useRef(load);
	latest.current = load;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is what's read, `generation` a read again.
	useEffect(() => {
		setState({ status: "loading" });
	}, [key]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is what's read, `generation` a read again.
	useEffect(() => {
		const read = latest.current;
		if (read === undefined) return;
		let live = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			if (typeof document !== "undefined" && document.visibilityState === "hidden") {
				timer = setTimeout(tick, pollMs);
				return;
			}
			read().then(
				(value) => {
					if (!live) return;
					setState({ status: "ready", value });
					timer = setTimeout(tick, pollMs);
				},
				(error: unknown) => {
					if (!live) return;
					setState((current) =>
						current.status === "loading"
							? { status: "error", error }
							: { status: "error", error, value: current.value },
					);
					timer = setTimeout(tick, pollMs);
				},
			);
		};
		tick();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [key, pollMs, generation]);
	return { ...state, reload: () => setGeneration((value) => value + 1) };
}

/** A sandbox's history over a range, from its source: its own history read, else what the live read has. */
const historyRead = (source: SandboxesSource, id: string, range: UsageRange, now: () => number) => {
	if (source.usageHistory !== undefined) {
		const read = source.usageHistory;
		return () => read(id, range);
	}
	if (source.usageSeries !== undefined) {
		const read = source.usageSeries;
		return () => read(id, now() - RANGES[range].spanMs);
	}
	return undefined;
};

/** One of the four figures over the chart: its name, its share now and what that is of. */
function Stat({
	metric,
	value,
	detail,
	missing,
}: {
	metric: Metric;
	value?: string;
	detail?: ReactNode;
	/** Why there's no figure: "Not measured on this host yet". */
	missing?: string;
}) {
	return (
		<div className="kt-metrics-stat flex min-w-0 flex-col gap-1 border-border not-first:border-l not-first:pl-4 max-sm:nth-3:border-l-0 max-sm:nth-3:pl-0">
			<span className="flex items-center gap-1.5 text-sm text-muted">
				<span
					className={`inline-block size-dot rounded-full ${missing === undefined ? metric.dot : "bg-status-idle"}`}
					aria-hidden="true"
				/>
				{metric.label}
			</span>
			<span
				className={`text-heading font-strong leading-tight tabular-nums ${missing === undefined ? "text-fg" : "text-faint"}`}
			>
				{value ?? "–"}
			</span>
			<span className="line-clamp-2 text-sm text-muted">{missing ?? detail}</span>
		</div>
	);
}

/** What the four say now, from the newest readings. */
function Stats({ series, running, range }: { series: UsageSeries | undefined; running: boolean; range: UsageRange }) {
	const latest = latestOf(series);
	const missing = (key: MetricKey) =>
		latest[key] !== undefined
			? undefined
			: series === undefined || series.points.length === 0
				? "No readings yet"
				: "Not measured yet";
	const cpu = latest.cpu;
	const memory = latest.memory;
	const disk = latest.disk;
	const io = latest.io;
	const peak = peakOf("cpu", series);
	const when = running ? "" : ", when it last ran";
	const [cpuMetric, memoryMetric, diskMetric, ioMetric] = METRICS as unknown as [Metric, Metric, Metric, Metric];
	return (
		<div className="grid grid-cols-4 gap-y-4 max-sm:grid-cols-2">
			<Stat
				metric={cpuMetric}
				{...(cpu === undefined ? {} : { value: percentText(cpu.share) })}
				detail={peak === undefined ? `utilisation${when}` : `utilisation, peak ${percentText(peak)} in ${range}`}
				{...(missing("cpu") === undefined ? {} : { missing: missing("cpu") })}
			/>
			<Stat
				metric={memoryMetric}
				{...(memory === undefined ? {} : { value: percentText(memory.share) })}
				{...(memory === undefined || series === undefined ? {} : { detail: detailOf("memory", memory.point, series) })}
				{...(missing("memory") === undefined ? {} : { missing: missing("memory") })}
			/>
			<Stat
				metric={diskMetric}
				{...(disk === undefined ? {} : { value: percentText(disk.share) })}
				{...(disk === undefined || series === undefined ? {} : { detail: detailOf("disk", disk.point, series) })}
				{...(missing("disk") === undefined ? {} : { missing: missing("disk") })}
			/>
			<Stat
				metric={ioMetric}
				{...(io === undefined ? {} : { value: percentText(io.share) })}
				detail="of time stalled on IO"
				{...(missing("io") === undefined ? {} : { missing: missing("io") })}
			/>
		</div>
	);
}

/** The legend over the chart: a toggle for each metric it has, and a muted name for each it doesn't. */
function Legend({
	measured,
	hidden,
	onToggle,
}: {
	measured: ReadonlySet<MetricKey>;
	hidden: ReadonlySet<MetricKey>;
	onToggle: (key: MetricKey) => void;
}) {
	return (
		<span className="flex flex-wrap items-center gap-x-1 gap-y-1">
			{METRICS.map(({ key, label, dot }) => {
				if (!measured.has(key))
					return (
						<Tooltip key={key} content={`${label} isn't measured on this sandbox's host yet.`}>
							<span className="inline-flex items-center gap-1.5 px-1.5 text-sm text-disabled">
								<span className="inline-block size-dot rounded-full bg-status-idle" aria-hidden="true" />
								{label}
							</span>
						</Tooltip>
					);
				const on = !hidden.has(key);
				return (
					<button
						key={key}
						type="button"
						aria-pressed={on}
						className={`kt-focusable inline-flex h-control-xs cursor-pointer items-center gap-1.5 rounded-control border-0 bg-transparent px-1.5 text-sm hover:bg-hover ${on ? "text-fg" : "text-faint line-through"}`}
						onClick={() => onToggle(key)}
					>
						<span className={`inline-block size-dot rounded-full ${on ? dot : "bg-status-idle"}`} aria-hidden="true" />
						{label}
					</button>
				);
			})}
		</span>
	);
}

/** "1.2", "340": memory in MB, whole above 10. */
const mbText = (bytes: number): string => {
	const mb = bytes / 1024 ** 2;
	return mb < 10 ? (Math.round(mb * 10) / 10).toString() : Math.round(mb).toLocaleString("en-GB");
};

/** The busiest processes: the command line, truncated with the whole of it on hover, its CPU and its memory. */
export function ProcessTable({ processes }: { processes: readonly SandboxProcess[] }) {
	const head = "h-control-sm border-b border-border px-0 py-0 text-sm font-medium whitespace-nowrap text-muted";
	const cell = "border-b border-border py-2 align-middle whitespace-nowrap";
	return (
		<table className="kt-processes w-full table-fixed border-collapse text-left text-sm">
			<thead>
				<tr>
					<th className={head} scope="col">
						Process
					</th>
					<th className={`${head} w-20 text-right`} scope="col">
						CPU %
					</th>
					<th className={`${head} w-24 text-right`} scope="col">
						RAM (MB)
					</th>
				</tr>
			</thead>
			<tbody>
				{processes.slice(0, PROCESSES_SHOWN).map((process) => (
					<tr key={process.pid}>
						<td className={`${cell} min-w-0 pr-4`}>
							<Tooltip
								className="w-full"
								content={
									<span className="flex flex-col gap-1">
										<span className="font-mono text-code break-all">{process.command}</span>
										<span className="text-muted">PID {process.pid}</span>
									</span>
								}
							>
								<span className="block truncate font-mono text-code text-fg">{process.command}</span>
							</Tooltip>
						</td>
						<td className={`${cell} text-right tabular-nums`}>{process.cpuPercent.toFixed(1)}</td>
						<td className={`${cell} text-right tabular-nums`}>{mbText(process.memoryBytes)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** Top processes, as far as the source and the sandbox let it read them. */
function Processes({ sandbox, source }: { sandbox: Sandbox; source: SandboxesSource }) {
	const running = sandbox.state === "running";
	const list = source.processes;
	const read = usePolled(
		running && list !== undefined ? () => list(sandbox.id) : undefined,
		`${sandbox.id}/${running}`,
		PROCESSES_POLL_MS,
	);
	let body: ReactNode;
	if (!running) body = <p className="m-0 text-sm text-muted">It isn't running, so it has no processes.</p>;
	else if (list === undefined)
		body = <p className="m-0 text-sm text-muted">This sandbox's host can't list its processes yet.</p>;
	else if (read.status === "loading")
		body = (
			<div className="flex flex-col gap-3 py-1" aria-busy="true">
				{[0, 1, 2, 3].map((row) => (
					<Skeleton key={row} />
				))}
			</div>
		);
	else if (read.status === "error" && read.value === undefined)
		body = (
			<Notice
				level="error"
				action={
					<Button size="sm" onClick={read.reload}>
						Try again
					</Button>
				}
			>
				{messageOf(read.error, "Kantel couldn't list its processes.")}
			</Notice>
		);
	else if (read.value !== undefined && read.value.length === 0)
		body = <p className="m-0 text-sm text-muted">No processes are using any CPU.</p>;
	else body = read.value === undefined ? null : <ProcessTable processes={read.value} />;
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby={`${sandbox.id}-processes`}>
			<div className="flex min-h-control-xs items-center justify-between gap-2">
				<h3 id={`${sandbox.id}-processes`} className="m-0 text-md font-strong text-fg">
					Top processes (by CPU)
				</h3>
				{running && list !== undefined && read.status !== "loading" ? (
					<IconButton
						size="xs"
						variant="ghost"
						label="Read the processes again"
						icon={<ReconnectIcon size="sm" />}
						onClick={read.reload}
					/>
				) : null}
			</div>
			{body}
		</section>
	);
}

/** The dialog's body: the four figures, the chart with its legend, and the processes. Mounted only while it's open. */
function MetricsBody({
	sandbox,
	source,
	range,
	now: fixedNow,
}: {
	sandbox: Sandbox;
	source: SandboxesSource;
	range: UsageRange;
	now?: number;
}) {
	const clockNow = () => fixedNow ?? Date.now();
	const load = historyRead(source, sandbox.id, range, clockNow);
	const read = usePolled(load, `${sandbox.id}/${range}`, historyPollMs(range));
	const [hidden, setHidden] = useState<ReadonlySet<MetricKey>>(new Set());
	const series = read.status === "loading" ? undefined : read.value;
	const to = fixedNow ?? Math.max(Date.now(), series?.points.at(-1)?.at ?? 0);
	const measured = measuredIn(series);
	const running = sandbox.state === "running";
	const loading = read.status === "loading" && load !== undefined;
	const toggle = (key: MetricKey) =>
		setHidden((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	const empty = series === undefined || series.points.every((point) => point.at < to - RANGES[range].spanMs);
	return (
		<div className="flex min-w-0 flex-col gap-6 pt-2 text-fg">
			{load === undefined ? (
				<Notice level="info">Kantel doesn't read this sandbox's metrics here.</Notice>
			) : read.status === "error" && read.value === undefined ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={read.reload}>
							Try again
						</Button>
					}
				>
					{messageOf(read.error, "Kantel couldn't read its metrics.")}
				</Notice>
			) : null}
			{loading ? (
				<div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2" aria-busy="true">
					{METRICS.map(({ key }) => (
						<Skeleton key={key} lines={3} />
					))}
				</div>
			) : (
				<Stats series={series} running={running} range={range} />
			)}
			<div className="flex min-w-0 flex-col gap-3 border-t border-border pt-5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Legend
						measured={loading ? new Set(METRICS.map(({ key }) => key)) : measured}
						hidden={hidden}
						onToggle={toggle}
					/>
					<span className="text-sm text-muted">% used over {range}</span>
				</div>
				<div className="relative">
					<MetricsChart
						series={series}
						range={range}
						to={to}
						hidden={hidden}
						loading={loading}
						label={`${sandbox.name}'s CPU, RAM, disk and IO over ${RANGES[range].words}`}
					/>
					{!loading && empty && load !== undefined ? (
						<span className="pointer-events-none absolute inset-0 flex items-center justify-center pb-6 pl-11 text-sm text-muted">
							No readings in {RANGES[range].words}.
						</span>
					) : null}
				</div>
			</div>
			<div className="border-t border-border pt-5">
				<Processes sandbox={sandbox} source={source} />
			</div>
		</div>
	);
}

/**
 * "Metrics of api-server": a sandbox's CPU, memory, disk and IO over the last hour, day or week, as four figures and a
 * chart, and its busiest processes, read again every few seconds while it's open. The range is a choice in its heading.
 */
export function SandboxMetricsDialog({
	sandbox,
	source,
	onClose,
	now,
	defaultRange = "1h",
}: {
	/** The sandbox shown; none, closed. */
	sandbox: Sandbox | undefined;
	source: SandboxesSource;
	onClose: () => void;
	/** A fixed time, for stories. */
	now?: number;
	defaultRange?: UsageRange;
}) {
	const [range, setRange] = useState<UsageRange>(defaultRange);
	// The last one shown stays in it while it closes.
	const [shown, setShown] = useState(sandbox);
	useEffect(() => {
		if (sandbox !== undefined) setShown(sandbox);
	}, [sandbox]);
	const box = sandbox ?? shown;
	return (
		<Dialog
			open={sandbox !== undefined}
			width="wide"
			title={box === undefined ? "Metrics" : `Metrics of ${box.name}`}
			icon={<TelemetryIcon />}
			toolbar={
				<SegmentedControl
					label="Range"
					options={[
						{ value: "1h", label: "1h" },
						{ value: "24h", label: "24h" },
						{ value: "1w", label: "1w" },
					]}
					value={range}
					onChange={setRange}
				/>
			}
			onClose={onClose}
		>
			{box === undefined ? null : (
				<MetricsBody sandbox={box} source={source} range={range} {...(now === undefined ? {} : { now })} />
			)}
		</Dialog>
	);
}
