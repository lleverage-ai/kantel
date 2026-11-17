import { HOUR, MINUTE } from "../primitives/format.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostSyncDisk, HostSyncFetch, HostSync as HostSyncModel } from "./compute-model.ts";
import { FIXTURE_NOW } from "./fixtures.ts";
import { HostSync } from "./host-sync.tsx";

export default { title: "Compute/Host sync" } satisfies StoryDefault;

const GB = 1024 ** 3;
const BLOCK = 4 * 1024 ** 2;

const disk = (name: string, state: HostSyncDisk["state"], gb: number, ago: number): HostSyncDisk => ({
	diskId: `sdk_${name.replace(/-/g, "_")}`,
	name,
	version: `sdv_${name.length}${state.length}`,
	state,
	allocatedBytes: gb * GB,
	committedAt: FIXTURE_NOW - ago,
});

const fetchOf = (
	of: HostSyncDisk,
	state: HostSyncFetch["state"],
	share: number,
	fetchedGb: number,
	error?: string,
): HostSyncFetch => {
	const blocks = Math.round(of.allocatedBytes / BLOCK);
	return {
		kind: "sticky",
		objectId: of.diskId,
		version: of.version,
		state,
		blocks,
		blocksInPlace: Math.round(blocks * share),
		bytes: fetchedGb * GB,
		totalBytes: blocks * BLOCK,
		...(error === undefined ? {} : { error }),
	};
};

const host = (sync: HostSyncModel | undefined, state: "online" | "offline" = "online") => ({
	name: "lleverage-ci-6",
	state,
	...(sync === undefined ? {} : { sync }),
});

const ciCache = disk("lleverage-ci-cache", "fetching", 148, 40 * MINUTE);
const gitMirror = disk("git-mirror", "held", 12, 3 * HOUR);
const dockerLayers = disk("docker-layers", "waiting", 61, 5 * HOUR);

/** Holding every head its pool uses. */
export const InSync: Story = () => (
	<HostSync
		host={host({
			disks: [disk("lleverage-ci-cache", "held", 148, 40 * MINUTE), gitMirror],
			fetches: [],
		})}
	/>
);

/** A new host catching up: one head coming in, one queued behind it, one held already. */
export const Fetching: Story = () => (
	<HostSync
		host={host({
			disks: [ciCache, gitMirror, dockerLayers],
			fetches: [fetchOf(ciCache, "running", 0.42, 38.5)],
		})}
	/>
);

/** A fetch that failed part way, with its error, and a head no reachable host holds. */
export const Failed: Story = () => {
	const failed = disk("lleverage-ci-cache", "failed", 148, 40 * MINUTE);
	return (
		<HostSync
			host={host({
				disks: [failed, disk("git-mirror", "no-source", 12, 3 * HOUR), disk("docker-layers", "no-room", 61, 5 * HOUR)],
				fetches: [
					fetchOf(failed, "failed", 0.18, 26.1, "fetch blocks 6400-6463 from host_8by8: connection reset by peer"),
				],
			})}
		/>
	);
};

/** Draining: what it's missing, and that it isn't asked for anything new. */
export const Draining: Story = () => (
	<HostSync
		host={host({
			paused: "draining",
			disks: [disk("lleverage-ci-cache", "missing", 148, 40 * MINUTE), gitMirror],
			fetches: [],
		})}
	/>
);

/** Its pool syncs but has no disk used lately, while it copies a template's snapshot. */
export const Empty: Story = () => (
	<HostSync
		host={host({
			disks: [],
			fetches: [
				{
					kind: "template",
					objectId: "tsn_4k2m9q",
					version: "1",
					state: "running",
					blocks: 2048,
					blocksInPlace: 1310,
					bytes: 3.1 * GB,
					totalBytes: 2048 * BLOCK,
				},
			],
		})}
	/>
);

/** A pool without sync. */
export const NoSync: Story = () => <HostSync host={host(undefined)} />;

/** Not connected. */
export const NotConnected: Story = () => <HostSync host={host(undefined, "offline")} />;

/** Many disks with long names, and other fetches of every kind. */
export const LongContent: Story = () => {
	const long = disk(
		"monorepo-build-cache-for-the-merge-queue-and-every-pull-request-check",
		"fetching",
		412,
		12 * MINUTE,
	);
	return (
		<HostSync
			host={host({
				disks: [
					long,
					ciCache,
					gitMirror,
					dockerLayers,
					disk("playwright-browsers", "missing", 3, 2 * HOUR),
					disk("rust-target-dir", "no-room", 220, 8 * HOUR),
				],
				fetches: [
					fetchOf(long, "running", 0.07, 1.2),
					fetchOf(ciCache, "running", 0.91, 120),
					{
						kind: "rootfs",
						objectId: "c0ffee5a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789",
						version: "1",
						state: "queued",
						blocks: 0,
						blocksInPlace: 0,
						totalBytes: 0,
					},
					{
						kind: "snapshot",
						objectId: "ssnap_6b1f0c2a9e8d4c7b8a5f3e2d1c0b9a87",
						version: "disk",
						state: "failed",
						blocks: 5120,
						blocksInPlace: 5000,
						bytes: 0.4 * GB,
						totalBytes: 5120 * BLOCK,
						error:
							"no other host in the pool holds ssnap_6b1f0c2a9e8d4c7b8a5f3e2d1c0b9a87 where this host can reach it",
					},
				],
			})}
		/>
	);
};

/** A phone. */
export const Mobile: Story = () => (
	<HostSync
		host={host({
			disks: [ciCache, gitMirror, dockerLayers],
			fetches: [fetchOf(ciCache, "running", 0.42, 38.5)],
		})}
		narrow
	/>
);
