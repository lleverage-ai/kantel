/**
 * Usage series: what hosts report every tick (`HostUsageReport` in @kantel/hosts, 5 seconds apart), kept per sandbox
 * and per host in memory, for live graphs, the sparklines and the metrics export.
 *
 * Each series keeps its points as they came for `RAW_WINDOW_MS` (an hour: 720 at 5 seconds, at most `MAX_RAW_POINTS`),
 * and folds them into 5-minute means (`ROLLUP_MS`), the last `ROLLUP_POINTS` (a day) of which it keeps too. A closed
 * 5-minute mean is handed back to the caller, which keeps a sandbox's in its record (`StoredSandbox.samples`), so its
 * sparkline outlasts a restart and is the same on every gateway; a host's stay here.
 *
 * Nothing is written per point: a host's tick costs memory, not a database write.
 */

/** How far apart a current host's readings are. */
export const USAGE_INTERVAL_MS = 5_000;
/** How long a series keeps its points as they came. */
export const RAW_WINDOW_MS = 3_600_000;
/** The most points a series keeps as they came, whatever their interval: an hour at 5 seconds. */
export const MAX_RAW_POINTS = 720;
/** The span of one rolled-up mean, as `recentCpu`'s steps. */
export const ROLLUP_MS = 300_000;
/** The rolled-up means a series keeps: a day. */
export const ROLLUP_POINTS = 288;
/** The sparklines' length. */
export const SPARKLINE_POINTS = 24;

/** A host's usage tick as the compute plane takes it: checked and clamped (`parseHostUsage` in @kantel/hosts). */
export interface ReportedUsage {
	readonly at: number;
	readonly intervalMs: number;
	readonly host: {
		readonly cpu: number;
		readonly memUsedBytes: number;
		readonly memTotalBytes: number;
		readonly diskUsedBytes: number;
		readonly diskTotalBytes: number;
	};
	readonly sandboxes: readonly {
		readonly id: string;
		readonly kind: "microvm" | "isolate";
		readonly cpu: number;
		readonly memUsedBytes: number;
		readonly memLimitBytes: number;
	}[];
}

/** A backend's own tick, for a backend with no host to send it (the stub): a report and the host it is for. */
export interface BackendUsageReport extends ReportedUsage {
	readonly hostId: string;
}

export interface UsagePoint {
	readonly at: number;
	/** 0 to 1. */
	readonly cpu: number;
	readonly memUsedBytes: number;
	/** A host's; 0 for a sandbox. */
	readonly diskUsedBytes: number;
}

/** What a series knows besides its points: the newest report's limits. */
export interface UsageMeta {
	readonly intervalMs: number;
	readonly memLimitBytes?: number;
	readonly memTotalBytes?: number;
	readonly diskTotalBytes?: number;
}

/** A 5-minute mean: `at` is its start. */
export type Rollup = UsagePoint;

export interface UsageSeries {
	/**
	 * Adds a point, unless it isn't newer than the newest (a repeat). Answers the 5-minute mean it closed, if it started
	 * another.
	 */
	add(key: string, point: UsagePoint, meta: UsageMeta): Rollup | undefined;
	/** The points as they came after `since` (all the window has, without), oldest first, and the series' meta. */
	read(key: string, since?: number): { readonly meta: UsageMeta | undefined; readonly points: UsagePoint[] };
	latest(key: string): UsagePoint | undefined;
	meta(key: string): UsageMeta | undefined;
	/** The 5-minute mean under way, if any point has come in it. */
	partial(key: string): Rollup | undefined;
	/** The kept 5-minute means and the one under way, the newest `count` (default `SPARKLINE_POINTS`). */
	rollups(key: string, count?: number): Rollup[];
	/** Whether a point came within `withinMs` of `now`. */
	fresh(key: string, now: number, withinMs?: number): boolean;
	/**
	 * Closes the 5-minute means whose span ended `graceMs` or more before `now` (a sandbox that stopped reporting), and
	 * forgets series with no point for `RAW_WINDOW_MS` and no mean for a day. Answers the means it closed, by key.
	 */
	settle(now: number, graceMs?: number): { readonly key: string; readonly rollup: Rollup }[];
	drop(key: string): void;
	keys(): string[];
}

interface Bucket {
	from: number;
	count: number;
	cpu: number;
	mem: number;
	disk: number;
}

interface Track {
	meta: UsageMeta;
	/** The points as they came, oldest first, from `start`. Compacted once `start` passes `MAX_RAW_POINTS`. */
	points: UsagePoint[];
	start: number;
	bucket: Bucket | undefined;
	rollups: Rollup[];
}

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const bytes = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

const mean = (bucket: Bucket): Rollup => ({
	at: bucket.from,
	cpu: clamp01(bucket.cpu / bucket.count),
	memUsedBytes: bytes(bucket.mem / bucket.count),
	diskUsedBytes: bytes(bucket.disk / bucket.count),
});

/** An in-memory usage series, keyed by sandbox or host ID. */
export function createUsageSeries(): UsageSeries {
	const tracks = new Map<string, Track>();

	const live = (track: Track) => track.points.slice(track.start);
	const newest = (track: Track): UsagePoint | undefined =>
		track.points.length > track.start ? track.points[track.points.length - 1] : undefined;

	const close = (track: Track): Rollup | undefined => {
		if (track.bucket === undefined) return undefined;
		const rollup = mean(track.bucket);
		track.bucket = undefined;
		track.rollups.push(rollup);
		if (track.rollups.length > ROLLUP_POINTS) track.rollups.splice(0, track.rollups.length - ROLLUP_POINTS);
		return rollup;
	};

	/** Drops the points older than the window, or past the most kept. */
	const trim = (track: Track, now: number) => {
		const end = track.points.length;
		while (
			track.start < end &&
			((track.points[track.start]?.at ?? now) < now - RAW_WINDOW_MS || end - track.start > MAX_RAW_POINTS)
		) {
			track.start += 1;
		}
		if (track.start >= MAX_RAW_POINTS || (track.start > 0 && track.start === end)) {
			track.points = track.points.slice(track.start);
			track.start = 0;
		}
	};

	return {
		add(key, point, meta) {
			let track = tracks.get(key);
			if (track === undefined) {
				track = { meta, points: [], start: 0, bucket: undefined, rollups: [] };
				tracks.set(key, track);
			}
			const last = newest(track);
			if (!Number.isFinite(point.at) || (last !== undefined && point.at <= last.at)) return undefined;
			const clean: UsagePoint = {
				at: Math.round(point.at),
				cpu: clamp01(point.cpu),
				memUsedBytes: bytes(point.memUsedBytes),
				diskUsedBytes: bytes(point.diskUsedBytes),
			};
			track.meta = meta;
			track.points.push(clean);
			trim(track, clean.at);
			const from = Math.floor(clean.at / ROLLUP_MS) * ROLLUP_MS;
			let closed: Rollup | undefined;
			if (track.bucket !== undefined && track.bucket.from !== from) closed = close(track);
			track.bucket ??= { from, count: 0, cpu: 0, mem: 0, disk: 0 };
			track.bucket.count += 1;
			track.bucket.cpu += clean.cpu;
			track.bucket.mem += clean.memUsedBytes;
			track.bucket.disk += clean.diskUsedBytes;
			return closed;
		},
		read(key, since) {
			const track = tracks.get(key);
			if (track === undefined) return { meta: undefined, points: [] };
			const points = live(track);
			if (since === undefined) return { meta: track.meta, points };
			// Points are in order: find the first after `since` from the end, as a poll asks for the newest few.
			let first = points.length;
			while (first > 0 && (points[first - 1]?.at ?? 0) > since) first -= 1;
			return { meta: track.meta, points: points.slice(first) };
		},
		latest(key) {
			const track = tracks.get(key);
			return track === undefined ? undefined : newest(track);
		},
		meta(key) {
			return tracks.get(key)?.meta;
		},
		partial(key) {
			const bucket = tracks.get(key)?.bucket;
			return bucket === undefined ? undefined : mean(bucket);
		},
		rollups(key, count = SPARKLINE_POINTS) {
			const track = tracks.get(key);
			if (track === undefined) return [];
			const all = track.bucket === undefined ? track.rollups : [...track.rollups, mean(track.bucket)];
			return all.slice(-count);
		},
		fresh(key, now, withinMs) {
			const track = tracks.get(key);
			const last = track === undefined ? undefined : newest(track);
			if (track === undefined || last === undefined) return false;
			return now - last.at <= (withinMs ?? Math.max(3 * track.meta.intervalMs, 15_000));
		},
		settle(now, graceMs = 2 * USAGE_INTERVAL_MS) {
			const closed: { key: string; rollup: Rollup }[] = [];
			for (const [key, track] of tracks) {
				if (track.bucket !== undefined && track.bucket.from + ROLLUP_MS + graceMs <= now) {
					const rollup = close(track);
					if (rollup !== undefined) closed.push({ key, rollup });
				}
				trim(track, now);
				const lastRollup = track.rollups[track.rollups.length - 1];
				if (
					newest(track) === undefined &&
					track.bucket === undefined &&
					(lastRollup === undefined || lastRollup.at < now - ROLLUP_POINTS * ROLLUP_MS)
				) {
					tracks.delete(key);
				}
			}
			return closed;
		},
		drop(key) {
			tracks.delete(key);
		},
		keys() {
			return [...tracks.keys()];
		},
	};
}
