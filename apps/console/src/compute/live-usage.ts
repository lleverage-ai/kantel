// Where the console's live graphs read from over Kantel's API: a sandbox's and a host's usage every 5 seconds, newer than
// a point it already has. This file is the only one that changes when the API's series arrive: the pages read through
// the `UsageRead`s it returns (`SandboxesSource.usageSeries`, `HostsSource.usage`), and the sample data has its own.
//
// The API doesn't serve 5-second series yet: `getSandboxUsage` has 1-minute points at the finest, and each read makes
// the host take a sample, and there's no host usage route. So for now none is returned, and the pages show what they
// did before: a sandbox's recent CPU as listed, and what's allocated on each host. The series come with the compute
// plane's usage storage (`series` on `GET /v1/sandboxes/{id}/usage?since=`, and `GET /v1/hosts/{id}/usage?since=` with
// `intervalMs`, `memTotalBytes`, `diskTotalBytes` and points of `at`, `cpu`, `memUsedBytes` and `diskUsedBytes`).

import type { KantelClient } from "@kantel/api/sdk";
import type { SandboxesSource } from "@kantel/ui";

/** Reads a sandbox's or host's points newer than `since`. */
type UsageRead = NonNullable<SandboxesSource["usageSeries"]>;

export interface LiveUsageReads {
	/** A sandbox's CPU and memory. */
	readonly sandbox?: UsageRead;
	/** A deployment host's CPU, memory and disk, for a super-admin. */
	readonly host?: UsageRead;
	/** An account's own host's. */
	readonly ownHost?: (accountId: string) => UsageRead | undefined;
}

export function liveUsage(_api: KantelClient): LiveUsageReads {
	return {};
}

/** `source` with its live read under `key`, or as it is where there's none. */
export function withUsage<S extends object, K extends string>(source: S, key: K, read: UsageRead | undefined): S {
	return read === undefined ? source : { ...source, [key]: read };
}
