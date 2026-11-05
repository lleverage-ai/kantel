// Where the console's live graphs read from over Kantel's API: a sandbox's and a host's usage every 5 seconds, newer than
// a point it already has. The pages read through the `UsageRead`s this returns (`SandboxesSource.usageSeries`,
// `HostsSource.usage`); the sample data and the stories have their own (`@kantel/ui`'s usage-stub.ts).
//
// - A sandbox: `getSandboxUsage`'s `series`, with `memLimitBytes` beside it. Its `points` (5-minute means from `since`)
//   aren't wanted here, so the coarsest interval keeps that part of the answer small.
// - A host: `getHostUsage` for a super-admin's deployment hosts, `getAccountHostUsage` for an account's own. Its totals
//   are 0 until the host has sent a reading, so a 0 is left out and the page falls back to the host's listed size.
//
// An older gateway without these answers an error, which the graphs show as a stale or empty line; a host that doesn't
// send readings yet answers no points.

import type { HostUsage, KantelClient } from "@kantel/api/sdk";
import type { SandboxesSource } from "@kantel/ui";

/** Reads a sandbox's or host's points newer than `since`. */
type UsageRead = NonNullable<SandboxesSource["usageSeries"]>;
type UsageSeries = Awaited<ReturnType<UsageRead>>;

export interface LiveUsageReads {
	/** A sandbox's CPU and memory. */
	readonly sandbox: UsageRead;
	/** A deployment host's CPU, memory and disk, for a super-admin. */
	readonly host: UsageRead;
	/** An account's own host's. */
	readonly ownHost: (accountId: string) => UsageRead;
}

/** The longest interval `getSandboxUsage` takes, in seconds: the fewest 5-minute points beside the series. */
const COARSEST_SECONDS = 86_400;

export function liveUsage(api: KantelClient): LiveUsageReads {
	return {
		sandbox: async (id, since) => {
			const usage = await api.getSandboxUsage(id, { since, intervalSeconds: COARSEST_SECONDS });
			return {
				intervalMs: usage.series.intervalMs,
				...(usage.memLimitBytes ? { memLimitBytes: usage.memLimitBytes } : {}),
				points: usage.series.points,
			};
		},
		host: async (id, since) => hostSeries(await api.getHostUsage(id, { since })),
		// An account's own host is read by its ID alone; the route checks the caller may see it.
		ownHost: () => async (id, since) => hostSeries(await api.getAccountHostUsage(id, { since })),
	};
}

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
