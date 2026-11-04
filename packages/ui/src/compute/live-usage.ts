// Live usage for the compute pages' graphs: one hook that reads a sandbox's or a host's points every few seconds while
// the page is visible, asks only for what's newer than the newest it has, and keeps a window of them. Every graph reads
// through it, and every source reads through a `UsageRead`, so the sample data and the API differ only in that read.

import { useEffect, useRef, useState } from "react";
import type { UsagePoint, UsageRead, UsageSeries } from "./compute-model.ts";

/** How often the graphs read again: the hosts sample every 5 seconds. */
export const USAGE_POLL_MS = 5_000;

/** How much a sandbox's or host's page keeps: 10 minutes at 5 seconds. */
export const USAGE_KEEP_MS = 10 * 60_000;

/** How many points a row's sparkline draws: 2 minutes at 5 seconds. */
export const ROW_POINTS = 24;

export type LiveUsage =
	/** Nothing to read: no live source, or it isn't running. */
	| { readonly status: "off" }
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly series: UsageSeries }
	/** A read failed: the last points stay, and the next read tries again. */
	| { readonly status: "error"; readonly error: unknown; readonly series?: UsageSeries };

/**
 * `next`'s points after `current`'s, each time once, and none older than `keepMs` before the newest: the window a
 * graph draws. The newest point sets the window, not this browser's clock, so a clock that's off doesn't empty it.
 */
export function mergeSeries(current: UsageSeries | undefined, next: UsageSeries, keepMs: number): UsageSeries {
	const byAt = new Map<number, UsagePoint>();
	for (const point of current?.points ?? []) byAt.set(point.at, point);
	for (const point of next.points) byAt.set(point.at, point);
	const points = [...byAt.values()].sort((a, b) => a.at - b.at);
	const newest = points.at(-1)?.at;
	const kept = newest === undefined ? points : points.filter((point) => point.at > newest - keepMs);
	return {
		intervalMs: next.intervalMs,
		...(next.memLimitBytes === undefined
			? current?.memLimitBytes === undefined
				? {}
				: { memLimitBytes: current.memLimitBytes }
			: { memLimitBytes: next.memLimitBytes }),
		...(next.diskTotalBytes === undefined
			? current?.diskTotalBytes === undefined
				? {}
				: { diskTotalBytes: current.diskTotalBytes }
			: { diskTotalBytes: next.diskTotalBytes }),
		points: kept,
	};
}

/** The series a graph draws, from a hook's state: the last points read, even after a failed read. */
export const seriesOf = (live: LiveUsage): UsageSeries | undefined =>
	live.status === "ready" || live.status === "error" ? live.series : undefined;

const hidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * `id`'s usage, read through `read` now and then every `pollMs` while the page is visible: the first read asks for the
 * last `keepMs`, each one after for what's newer than the newest point. A hidden tab reads nothing; it reads at once
 * when it's shown again. `read` undefined (no live source, or nothing running) is `off`.
 */
export function useLiveUsage(
	read: UsageRead | undefined,
	id: string,
	{ pollMs = USAGE_POLL_MS, keepMs = USAGE_KEEP_MS }: { pollMs?: number; keepMs?: number } = {},
): LiveUsage {
	const [state, setState] = useState<LiveUsage>(read === undefined ? { status: "off" } : { status: "loading" });
	// The latest `read`, so a source rebuilt on every render doesn't start the loop again.
	const reader = useRef(read);
	reader.current = read;
	const on = read !== undefined;

	useEffect(() => {
		if (!on) {
			setState({ status: "off" });
			return;
		}
		setState({ status: "loading" });
		let stopped = false;
		let busy = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let series: UsageSeries | undefined;

		const tick = async () => {
			timer = undefined;
			const current = reader.current;
			if (stopped || busy || current === undefined || hidden()) return;
			busy = true;
			const since = series?.points.at(-1)?.at ?? Date.now() - keepMs;
			try {
				const next = await current(id, since);
				if (stopped) return;
				series = mergeSeries(series, next, keepMs);
				setState({ status: "ready", series });
			} catch (error) {
				if (stopped) return;
				setState(series === undefined ? { status: "error", error } : { status: "error", error, series });
			} finally {
				busy = false;
			}
			if (!stopped && !hidden()) timer = setTimeout(() => void tick(), pollMs);
		};
		const onVisibility = () => {
			if (hidden()) {
				if (timer !== undefined) clearTimeout(timer);
				timer = undefined;
			} else if (timer === undefined) void tick();
		};

		void tick();
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [on, id, pollMs, keepMs]);

	return state;
}

const GB = 1024 ** 3;

/** Bytes as GB with one decimal under 10 and none above: "0.4", "3.2", "41". */
export function gbText(bytes: number): string {
	const gb = bytes / GB;
	return gb < 10 ? (Math.round(gb * 10) / 10).toString() : Math.round(gb).toLocaleString("en-GB");
}

/** GB as bytes, for a limit the source didn't send. */
export const gbBytes = (gb: number): number => gb * GB;
