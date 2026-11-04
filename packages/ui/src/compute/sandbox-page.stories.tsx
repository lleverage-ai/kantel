import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostingMode } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW } from "./fixtures.ts";
import { SandboxPage, type SandboxView } from "./sandbox-page.tsx";

export default { title: "Compute/Sandbox page" } satisfies StoryDefault;

// Each story keeps its own source and view, so the tabs, Stop, Resume and the menu all work against the fixtures.
function Scenario({
	sandboxId = "sbx_7f3k2m9qa1",
	view = "overview",
	hosting = "self-hosted",
	options,
	narrow = false,
	menuOpen = false,
}: {
	sandboxId?: string;
	view?: SandboxView;
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	narrow?: boolean;
	menuOpen?: boolean;
}) {
	const [source] = useState(() => createComputeFixtures({ hosting, ...options }));
	return (
		<SandboxPage
			source={source.sandboxes}
			snapshots={source.snapshots}
			egress={source.egress}
			hosting={hosting}
			sandboxId={sandboxId}
			initialView={view}
			href={(to) => `#${sandboxId}/${to}`}
			sandboxesHref="#sandboxes"
			environmentHref={(id) => `#environments/${id}`}
			now={FIXTURE_NOW}
			narrow={narrow}
			menuOpen={menuOpen}
		/>
	);
}

/** A running microVM: previews of its desktop and browser, SSH, ports, CPU and details. */
export const Overview: Story = () => <Scenario />;

/** The same on hosted Kantel, with its cost. */
export const Hosted: Story = () => <Scenario hosting="hosted" />;

/** ⋯ open: Fork, Save snapshot, Auto-stop and Delete. */
export const Menu: Story = () => <Scenario menuOpen />;

/** Logs: commands and what happened to it, newest first, the failed build open. */
export const Logs: Story = () => <Scenario view="logs" />;

/** Its egress log. */
export const Egress: Story = () => <Scenario view="egress" />;

/** Its snapshots. */
export const Snapshots: Story = () => <Scenario view="snapshots" />;

/** What's in it now. */
export const Files: Story = () => <Scenario view="files" />;

/** Its desktop, full size in the console. */
export const Desktop: Story = () => <Scenario view="desktop" />;

/** Its browser, full size in the console. */
export const Browser: Story = () => <Scenario view="browser" />;

/** A stopped microVM: no previews, Resume, and its files from its last snapshot. */
export const Stopped: Story = () => <Scenario sandboxId="sbx_2q8w5e1rz4" />;

/** A stopped one's Files: its latest snapshot's. */
export const StoppedFiles: Story = () => <Scenario sandboxId="sbx_2q8w5e1rz4" view="files" />;

/** One that failed: what went wrong, and Recover. */
export const Failed: Story = () => <Scenario sandboxId="sbx_1o9p4a7se6" />;

/** An isolate: no desktop, browser or SSH. */
export const Isolate: Story = () => <Scenario sandboxId="sbx_9a2b6c4dq3" />;

/** While it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** When Kantel can't be reached. */
export const Unreachable: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: no previews, Stop in ⋯, the sections stacked. */
export const Mobile: Story = () => <Scenario narrow />;
Mobile.meta = { width: 390 };

/** A phone's Logs. */
export const MobileLogs: Story = () => <Scenario narrow view="logs" />;
MobileLogs.meta = { width: 390 };

/** A phone's desktop. */
export const MobileDesktop: Story = () => <Scenario narrow view="desktop" />;
MobileDesktop.meta = { width: 390 };
