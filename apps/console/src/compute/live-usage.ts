// Where the console's live graphs read from over Kantel's API: a sandbox's and a host's usage every 5 seconds, newer than
// a point it already has. The pages read through the `UsageRead`s this returns (`SandboxesSource.usageSeries`,
// `HostsSource.usage`); the sample data and the stories have their own (`@kantel/ui`'s usage-stub.ts).
//
// - A sandbox: `getSandboxUsage`'s `series`, with `memLimitBytes` and `diskTotalBytes` beside it: CPU and memory, and a
//   microVM's disk and IO pressure where its host and guest send them. Its `points` (5-minute means from `since`)
//   aren't wanted here, so the coarsest interval keeps that part of the answer small.
// - A sandbox's metrics over an hour, a day or a week (`history`): the hour from `series`, as it came; the day and the
//   week from `points`, 5-minute and hourly means, without the intervals no reading covers (`measured` false), which
//   the chart then leaves as gaps rather than drawing as 0.
// - A host: `getHostUsage` for a super-admin's deployment hosts, `getAccountHostUsage` for an account's own. Its totals
//   are 0 until the host has sent a reading, so a 0 is left out and the page falls back to the host's listed size.
//
// An older gateway without these answers an error, which the graphs show as a stale or empty line; a host that doesn't
// send readings yet answers no points.

import type { HostUsage, KantelClient, SandboxUsage } from "@kantel/api/sdk";
import type { SandboxesSource, UsageRange, UsageSeries } from "@kantel/ui";

/** Reads a sandbox's or host's points newer than `since`. */
type UsageRead = NonNullable<SandboxesSource["usageSeries"]>;

export interface LiveUsageReads {
	/** A sandbox's CPU and memory. */
	readonly sandbox: UsageRead;
	/** A deployment host's CPU, memory and disk, for a super-admin. */
	readonly host: UsageRead;
	/** An account's own host's. */
	readonly ownHost: (accountId: string) => UsageRead;
	/** A sandbox's over the last hour, day or week, for its metrics dialog. */
	readonly history: NonNullable<SandboxesSource["usageHistory"]>;
}

/** How far back each range reaches, and the interval of `points` it reads (none: the hour's `series`). */
const RANGES: { readonly [range in UsageRange]: { readonly spanMs: number; readonly intervalSeconds?: number } } = {
	"1h": { spanMs: 3_600_000 },
	"24h": { spanMs: 86_400_000, intervalSeconds: 300 },
	"1w": { spanMs: 7 * 86_400_000, intervalSeconds: 3_600 },
};

/** The longest interval `getSandboxUsage` takes, in seconds: the fewest 5-minute points beside the series. */
const COARSEST_SECONDS = 86_400;

export function liveUsage(api: KantelClient): LiveUsageReads {
	return {
		sandbox: async (id, since) =>
			sandboxSeries(await api.getSandboxUsage(id, { since, intervalSeconds: COARSEST_SECONDS })),
		history: async (id, range) => {
			const { spanMs, intervalSeconds } = RANGES[range];
			const now = Date.now();
			const since = now - spanMs;
			if (intervalSeconds === undefined) {
				return sandboxSeries(await api.getSandboxUsage(id, { since, intervalSeconds: COARSEST_SECONDS }));
			}
			return sandboxMeans(await api.getSandboxUsage(id, { since, intervalSeconds }), now);
		},
		host: async (id, since) => hostSeries(await api.getHostUsage(id, { since })),
		// An account's own host is read by its ID alone; the route checks the caller may see it.
		ownHost: () => async (id, since) => hostSeries(await api.getAccountHostUsage(id, { since })),
	};
}

/** A sandbox's readings as they came, as the graphs take them. */
export function sandboxSeries(usage: SandboxUsage): UsageSeries {
	return {
		intervalMs: usage.series.intervalMs,
		...(usage.memLimitBytes ? { memLimitBytes: usage.memLimitBytes } : {}),
		...(usage.diskTotalBytes ? { diskTotalBytes: usage.diskTotalBytes } : {}),
		points: usage.series.points,
	};
}

/**
 * A sandbox's means over a day or a week as the chart takes them: each at its interval's end (or now, for the one under
 * way), without those no reading covers. From a gateway before `measured`, an interval it didn't run in is left out.
 */
export function sandboxMeans(usage: SandboxUsage, now: number): UsageSeries {
	const intervalMs = usage.intervalSeconds * 1000;
	return {
		intervalMs,
		...(usage.memLimitBytes ? { memLimitBytes: usage.memLimitBytes } : {}),
		...(usage.diskTotalBytes ? { diskTotalBytes: usage.diskTotalBytes } : {}),
		points: usage.points
			.filter((point) => point.measured ?? point.runningSeconds > 0)
			.map((point) => ({
				at: Math.min(point.at + intervalMs, now),
				cpu: point.cpu,
				memUsedBytes: Math.round(point.memoryMb * MIB),
				...(point.cpuMax === undefined ? {} : { cpuMax: point.cpuMax }),
				...(point.memoryMbMax === undefined ? {} : { memMaxBytes: Math.round(point.memoryMbMax * MIB) }),
				...(point.diskUsedBytes === undefined ? {} : { diskUsedBytes: point.diskUsedBytes }),
				...(point.ioPressure === undefined ? {} : { ioPressure: point.ioPressure }),
			})),
	};
}

const MIB = 1024 * 1024;

/** A host's usage as the graphs take it. */
export function hostSeries(usage: HostUsage): UsageSeries {
	return {
		intervalMs: usage.intervalMs,
		...(usage.memTotalBytes > 0 ? { memLimitBytes: usage.memTotalBytes } : {}),
		...(usage.diskTotalBytes > 0 ? { diskTotalBytes: usage.diskTotalBytes } : {}),
		points: usage.points,
	};
}

/** `source` with its live read under `key`, or as it is where there's none. */
export function withUsage<S extends object, K extends string>(source: S, key: K, read: UsageRead | undefined): S {
	return read === undefined ? source : { ...source, [key]: read };
}
