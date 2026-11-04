import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostingMode } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE, PERSONAL } from "./fixtures.ts";
import { SandboxesPage } from "./sandboxes-page.tsx";

export default { title: "Compute/Sandboxes page" } satisfies StoryDefault;

// Each story keeps its own source, so New, Stop, Resume, Fork and Delete move its sandboxes through their states.
function Scenario({
	hosting = "self-hosted",
	options,
	personal = false,
	creating = false,
	narrow = false,
	noHosts = false,
}: {
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	personal?: boolean;
	creating?: boolean;
	narrow?: boolean;
	noHosts?: boolean;
}) {
	const [source] = useState(() => createComputeFixtures({ hosting, ...options }));
	return (
		<SandboxesPage
			source={source.sandboxes}
			snapshots={source.snapshots}
			account={personal ? PERSONAL : LLEVERAGE}
			hosting={hosting}
			now={FIXTURE_NOW}
			sandboxHref={(id, view) => `#sandbox/${id}${view === undefined || view === "overview" ? "" : `/${view}`}`}
			creating={creating}
			narrow={narrow}
			{...(noHosts ? { addHostHref: "#add-host" } : {})}
		/>
	);
}

/** An organisation's sandboxes on a self-hosted Kantel: every state, both types, no cost column. Press New. */
export const SelfHosted: Story = () => <Scenario />;

/** The same on hosted Kantel, with each sandbox's cost this period. */
export const Hosted: Story = () => <Scenario hosting="hosted" />;

/** A personal account's own sandboxes. */
export const Personal: Story = () => <Scenario personal />;

/**
 * Sandboxes on an outdated base image: api-server's has security fixes waiting (red), render-farm's doesn't (amber).
 * Each badge's tooltip has the versions; ⋯ has Restart on latest base.
 */
export const BaseOutdated: Story = () => <Scenario />;

/** New's caret: New sandbox, open. */
export const Create: Story = () => <Scenario creating />;

/** No sandboxes yet. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** No host anywhere yet: no New, and the way to add one. */
export const NoHosts: Story = () => <Scenario options={{ empty: true }} noHosts />;

/** The list while it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: a row for each, its CPU beside its state. */
export const Mobile: Story = () => <Scenario narrow />;
Mobile.meta = { width: 390 };
