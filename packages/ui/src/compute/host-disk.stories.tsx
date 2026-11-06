import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostDisk } from "./compute-model.ts";
import { FIXTURE_NOW, HOSTS } from "./fixtures.ts";
import { HostDiskUsage } from "./host-disk.tsx";

export default { title: "Compute/Host disk" } satisfies StoryDefault;

const GB = 1024 ** 3;
const [first, nearlyFull, home] = HOSTS;
if (first === undefined || nearlyFull === undefined || home === undefined) throw new Error("No sample hosts");

/** A host's disk by what takes it, with no limit on saved snapshots. */
export const Default: Story = () => <HostDiskUsage host={first} now={FIXTURE_NOW} />;

/** Nearly full, mostly snapshots: the bar turns red, and the limit on each account's saved snapshots shows. */
export const NearlyFull: Story = () => <HostDiskUsage host={nearlyFull} now={FIXTURE_NOW} />;

/** A small home server with a limit. */
export const WithLimit: Story = () => <HostDiskUsage host={home} now={FIXTURE_NOW} />;

/** Not measured yet: a host just joined, or an older host agent. */
export const NotMeasured: Story = () => <HostDiskUsage host={{ name: "toms-macbook" }} now={FIXTURE_NOW} />;

/** Measured just now, nothing on it yet but the system. */
export const EmptyHost: Story = () => {
	const disk: HostDisk = {
		totalBytes: 500 * GB,
		usedBytes: 9 * GB,
		savedSnapshots: 0,
		automaticSnapshots: 0,
		sandboxes: 0,
		images: 2 * GB,
		templates: 0,
		bundles: 0,
		other: 7 * GB,
		measuredAt: FIXTURE_NOW - 10_000,
	};
	return <HostDiskUsage host={{ name: "new-host", disk }} now={FIXTURE_NOW} />;
};

/** Very large figures, in TB. */
export const LongFigures: Story = () => {
	const disk: HostDisk = {
		totalBytes: 61_440 * GB,
		usedBytes: 52_210 * GB,
		savedSnapshots: 20_480 * GB,
		automaticSnapshots: 18_002 * GB,
		sandboxes: 9_800 * GB,
		images: 120 * GB,
		templates: 640 * GB,
		bundles: 900 * GB,
		other: 2_268 * GB,
		measuredAt: FIXTURE_NOW - 26 * 60_000,
	};
	return (
		<HostDiskUsage host={{ name: "storage-heavy-01", disk, savedSnapshotLimitBytes: 1_024 * GB }} now={FIXTURE_NOW} />
	);
};

/** On a phone: the figures in one column. */
export const Mobile: Story = () => <HostDiskUsage host={first} now={FIXTURE_NOW} narrow />;
Mobile.meta = { width: 390 };
