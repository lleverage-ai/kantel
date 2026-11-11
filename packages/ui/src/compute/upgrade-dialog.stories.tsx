import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { Sandbox } from "./compute-model.ts";
import { SCRATCH } from "./fixtures.ts";
import { UpgradeDialog } from "./sandbox-actions.tsx";

export default { title: "Compute/Upgrade to microVM" } satisfies StoryDefault;

// The dialog as an isolate's menu opens it: Upgrade is busy until the microVM runs (a few seconds), or fails and says
// why, the isolate as it was.
function Scenario({ sandbox, fail = false, slow = false }: { sandbox: Sandbox; fail?: boolean; slow?: boolean }) {
	const [open, setOpen] = useState(true);
	const [done, setDone] = useState<string>();
	return (
		<div className="p-6">
			<p className="text-muted">{done ?? "Not upgraded yet."}</p>
			<UpgradeDialog
				sandbox={open ? sandbox : undefined}
				onClose={() => setOpen(false)}
				onUpgrade={async (box) => {
					await new Promise((resolve) => setTimeout(resolve, slow ? 60_000 : 800));
					if (fail) throw new Error("No host has room for a microVM of size default now; try again in a minute.");
					setDone(`Upgraded ${box.name}.`);
				}}
			/>
		</div>
	);
}

/** A running isolate: its files move to /home/user/workspace. */
export const Running: Story = () => <Scenario sandbox={SCRATCH} />;

/** A stopped isolate comes back running, as a microVM. */
export const Stopped: Story = () => <Scenario sandbox={{ ...SCRATCH, state: "stopped" }} />;

/** Upgrading: the dialog stays open and busy until the microVM runs. */
export const InProgress: Story = () => <Scenario sandbox={SCRATCH} slow />;

/** The microVM can't be made: the dialog stays open and says why. */
export const Failed: Story = () => <Scenario sandbox={SCRATCH} fail />;

/** A long isolate name. */
export const LongName: Story = () => (
	<Scenario sandbox={{ ...SCRATCH, name: "an-isolate-with-a-very-long-name-reading-the-nightly-incident-logs" }} />
);
