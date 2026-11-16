import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { StickyDisksSource } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { StickyDisksPage } from "./sticky-disks-page.tsx";

export default { title: "Compute/Disks page" } satisfies StoryDefault;

// Each story keeps its own source, so New disk and Delete change its disks.
function Scenario({
	options,
	narrow = false,
	creating = false,
	opened,
}: {
	options?: ComputeFixtureOptions;
	narrow?: boolean;
	creating?: boolean;
	opened?: readonly string[];
}) {
	const [source] = useState(() => createComputeFixtures(options).stickyDisks as StickyDisksSource);
	return (
		<StickyDisksPage
			source={source}
			account={LLEVERAGE}
			now={FIXTURE_NOW}
			narrow={narrow}
			creating={creating}
			{...(opened === undefined ? {} : { opened })}
		/>
	);
}

/**
 * Lleverage's disks by pool: CI's cache and Docker images in `ci`, with versions on both Hetzner hosts; a pnpm store and
 * a git mirror with no commit yet in the default pool; and a scratch disk in no pool yet.
 */
export const Default: Story = () => <Scenario />;

/** CI's cache opened: each host with a version, how many it has and what they take there. */
export const Opened: Story = () => <Scenario opened={["sdk_ci_cache", "sdk_git"]} />;

/** New disk: name, size, pool (the default first) and a description. Try `ci-cache` to see the name refused. */
export const NewDisk: Story = () => <Scenario creating />;

/** No disks yet. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** While they load. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** When Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** Pools with names as long as a name may be. */
export const LongNames: Story = () => <Scenario options={{ pools: "long-names" }} opened={["sdk_ci_cache"]} />;

/** On a phone: two-line rows under each pool, CI's cache opened. */
export const Mobile: Story = () => <Scenario narrow opened={["sdk_ci_cache"]} />;
Mobile.meta = { width: 420 };

/** The pools can't be read: the disks are still grouped, each pool named by its ID. */
export const PoolsFailed: Story = () => <Scenario options={{ pools: "fail" }} />;
