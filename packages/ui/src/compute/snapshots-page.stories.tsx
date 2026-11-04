import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { DeviceSetupError } from "./compute-model.ts";
import { API_SERVER, type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { computePage } from "./parts.tsx";
import { type FilesAt, SnapshotFiles } from "./snapshot-files.tsx";
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

/** A snapshot's files at `initial`, moving as the console's address would. */
function Browser({ initial, options }: { initial: FilesAt; options?: ComputeFixtureOptions }) {
	const [source] = useState(() => createComputeFixtures(options));
	const [at, setAt] = useState(initial);
	return (
		<div className={computePage}>
			<SnapshotFiles
				source={source.snapshots}
				snapshotId="ssn_dev_stack_warm"
				label="dev-stack-warm"
				at={at}
				now={FIXTURE_NOW}
				backLabel="Back to saved snapshots"
				onBack={() => {}}
				onNavigate={setAt}
			/>
		</div>
	);
}

/** A file open beside the folder, in syntax colours. */
export const FileOpen: Story = () => <Browser initial={{ path: "home/user/app", file: "package.json" }} />;

/** A file Kantel can't show here: an image, with its size and Download. */
export const FileBinary: Story = () => <Browser initial={{ path: "home/user/app", file: "screenshot.png" }} />;

/** A large file: its first 256 KB, and Load more. */
export const FileLarge: Story = () => <Browser initial={{ path: "var/log", file: "syslog" }} />;

/** A file while it's read. */
export const FileLoading: Story = () => (
	<Browser initial={{ path: "home/user", file: "notes.md" }} options={{ hang: true }} />
);

/** An end-to-end sandbox's files where this browser isn't a device yet: one line, and nothing read. */
export const EndToEndSetup: Story = () => {
	const [source] = useState(() => {
		const setup = () =>
			Promise.reject(
				new DeviceSetupError(
					"End-to-end encrypted: set this browser up as a device (the strip at the top) to see its files.",
				),
			);
		return { list: setup, read: setup };
	});
	const [at, setAt] = useState<FilesAt>({ path: "home/user" });
	return (
		<div className={computePage}>
			<SnapshotFiles source={source} snapshotId="sbx_e2e" at={at} now={FIXTURE_NOW} onNavigate={setAt} />
		</div>
	);
};

/** An empty folder, in one line. */
export const FolderEmpty: Story = () => <Browser initial={{ path: "home/user/app/node_modules" }} />;

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

/** A folder on a phone: one line a row, the size and time folded away. */
export const MobileFolder: Story = () => <Browser initial={{ path: "home/user/app" }} />;
MobileFolder.meta = { width: 390 };

/** A file open on a phone: it takes the folder's place, with Back to it. */
export const MobileFile: Story = () => <FileOpen />;
MobileFile.meta = { width: 390 };
