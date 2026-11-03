import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostingMode } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE, PERSONAL } from "./fixtures.ts";
import { SandboxesPage } from "./sandboxes-page.tsx";

export default { title: "Compute/Sandboxes page" } satisfies StoryDefault;

// Each story keeps its own source, so New sandbox, Stop, Resume, Fork and Delete move its sandboxes through their states.
function Scenario({
	hosting = "self-hosted",
	options,
	personal = false,
	creating = false,
}: {
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	personal?: boolean;
	creating?: boolean;
}) {
	const [source] = useState(() => createComputeFixtures({ hosting, ...options }));
	return (
		<SandboxesPage
			source={source.sandboxes}
			snapshots={source.snapshots}
			account={personal ? PERSONAL : LLEVERAGE}
			hosting={hosting}
			now={FIXTURE_NOW}
			snapshotsHref={(id) => `#snapshots-${id}`}
			creating={creating}
		/>
	);
}

/** An organisation's sandboxes on a self-hosted Kantel: every state, both types, no cost column. */
export const SelfHosted: Story = () => <Scenario />;

/** The same on hosted Kantel, with each sandbox's cost this period. */
export const Hosted: Story = () => <Scenario hosting="hosted" />;

/** A personal account's own sandboxes. */
export const Personal: Story = () => <Scenario personal />;

/** New sandbox, open. */
export const Create: Story = () => <Scenario creating />;

/** No sandboxes yet. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** The list while it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: the table scrolls sideways. */
export const Mobile: Story = () => <Scenario />;
Mobile.meta = { width: 420 };
