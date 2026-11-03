import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { API_SERVER, type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { computePage } from "./parts.tsx";
import { SnapshotFiles } from "./snapshot-files.tsx";
import { SnapshotsPage, type SnapshotsView } from "./snapshots-page.tsx";

export default { title: "Compute/Snapshots page" } satisfies StoryDefault;

// Each story keeps its own source, so Delete takes a snapshot out of its list.
function Scenario({ options, initialView }: { options?: ComputeFixtureOptions; initialView?: SnapshotsView }) {
	const [source] = useState(() => createComputeFixtures(options));
	return (
		<SnapshotsPage
			source={source.snapshots}
			sandboxes={source.sandboxes}
			account={LLEVERAGE}
			now={FIXTURE_NOW}
			{...(initialView === undefined ? {} : { initialView })}
			// The console opens New sandbox with the snapshot chosen; here the menu item is only shown.
			onStartFrom={() => {}}
		/>
	);
}

/** An organisation's saved snapshots: microVMs and an isolate, one whose sandbox has since gone. */
export const Saved: Story = () => <Scenario />;

/** One sandbox's history: the regular saves while it runs, newest first. */
export const BySandbox: Story = () => <Scenario initialView={{ name: "sandbox", sandboxId: API_SERVER.id }} />;

/** A saved snapshot's files, in its app's folder. */
export const Files: Story = () => (
	<Scenario
		initialView={{
			name: "files",
			snapshotId: "ssn_dev_stack_warm",
			label: "dev-stack-warm",
			path: "home/user/app",
			back: { name: "saved" },
		}}
	/>
);

/** A file open beside the folder, in syntax colours. */
export const FileOpen: Story = () => {
	const [source] = useState(() => createComputeFixtures());
	const [path, setPath] = useState("home/user/app");
	return (
		<div className={computePage}>
			<SnapshotFiles
				source={source.snapshots}
				snapshotId="ssn_dev_stack_warm"
				label="dev-stack-warm"
				path={path}
				now={FIXTURE_NOW}
				backLabel="Back to saved snapshots"
				onBack={() => {}}
				onOpenFolder={setPath}
				initialFile="home/user/app/package.json"
			/>
		</div>
	);
};

/** A file Kantel can't show here: an image, with a Download link. */
export const FileBinary: Story = () => {
	const [source] = useState(() => createComputeFixtures());
	const [path, setPath] = useState("home/user/app");
	return (
		<div className={computePage}>
			<SnapshotFiles
				source={source.snapshots}
				snapshotId="ssn_dev_stack_warm"
				label="dev-stack-warm"
				path={path}
				now={FIXTURE_NOW}
				backLabel="Back to saved snapshots"
				onBack={() => {}}
				onOpenFolder={setPath}
				initialFile="home/user/app/screenshot.png"
			/>
		</div>
	);
};

/** No saved snapshots yet. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** No sandboxes, so no history. */
export const EmptyHistory: Story = () => <Scenario options={{ empty: true }} initialView={{ name: "sandbox" }} />;

/** The list while it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: the tables scroll sideways. */
export const Mobile: Story = () => <Scenario />;
Mobile.meta = { width: 420 };

/** A file open on a phone: it shows below the folder. */
export const MobileFile: Story = () => <FileOpen />;
MobileFile.meta = { width: 420 };
