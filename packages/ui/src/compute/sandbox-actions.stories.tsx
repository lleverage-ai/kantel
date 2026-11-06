import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { Sandbox, SaveSnapshotOptions } from "./compute-model.ts";
import { API_SERVER, RENDER, SCRATCH } from "./fixtures.ts";
import { SaveSnapshotDialog } from "./sandbox-actions.tsx";

export default { title: "Compute/Save snapshot" } satisfies StoryDefault;

// The dialog as a sandbox's menu opens it. Save answers after a moment, or fails; what it was asked for shows below.
function Scenario({ sandbox, fail = false }: { sandbox: Sandbox; fail?: boolean }) {
	const [open, setOpen] = useState(true);
	const [asked, setAsked] = useState<string>();
	return (
		<div className="p-6">
			<p className="text-muted">{asked ?? "Not saved yet."}</p>
			<SaveSnapshotDialog
				sandbox={open ? sandbox : undefined}
				onClose={() => setOpen(false)}
				onSave={async (box, name, options?: SaveSnapshotOptions) => {
					await new Promise((resolve) => setTimeout(resolve, 600));
					if (fail) throw new Error("The host is unreachable.");
					setAsked(`Saved ${box.name} as ${name}, ${options?.memory === true ? "with its memory" : "its disk alone"}.`);
				}}
			/>
		</div>
	);
}

/** A running microVM: the disk alone unless Keep its memory too is ticked. */
export const Running: Story = () => <Scenario sandbox={API_SERVER} />;

/** A stopped one is saved as its latest snapshot is: no memory choice. */
export const Stopped: Story = () => <Scenario sandbox={RENDER} />;

/** An isolate has no memory to keep. */
export const Isolate: Story = () => <Scenario sandbox={SCRATCH} />;

/** Save fails: the dialog stays open and says so. */
export const Failed: Story = () => <Scenario sandbox={API_SERVER} fail />;

/** A long sandbox name. */
export const LongName: Story = () => (
	<Scenario sandbox={{ ...API_SERVER, name: "a-very-long-sandbox-name-for-the-nightly-integration-environment" }} />
);
