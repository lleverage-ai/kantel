import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { MoveTarget, Sandbox } from "./compute-model.ts";
import { BROWSER_AGENT, RENDER } from "./fixtures.ts";
import { MoveDialog } from "./sandbox-move.tsx";

export default { title: "Compute/Move to host" } satisfies StoryDefault;

const HOSTS: readonly MoveTarget[] = [
	{ hostId: "hst_hetzner_1", hostName: "hetzner-fsn1-01" },
	{ hostId: "hst_hetzner_3", hostName: "hetzner-fsn1-03" },
	{ hostId: "hst_hetzner_4", hostName: "hetzner-fsn1-04" },
];

/**
 * As a move's dry run answers: memory kept between matching hosts, with the pause Kantel expects, and a host whose CPU
 * differs restarting it, with why.
 */
const DRY_RUN: readonly MoveTarget[] = [
	{ hostId: "hst_hetzner_1", hostName: "hetzner-fsn1-01", memory: "kept", pauseMs: 4_000 },
	{ hostId: "hst_hetzner_3", hostName: "hetzner-fsn1-03", memory: "kept", pauseMs: 69_000 },
	{
		hostId: "hst_intel_1",
		hostName: "hetzner-fsn1-07",
		memory: "restarts",
		restartReason: "The new host has another CPU than its host, so its memory can't be restored there",
	},
];

/** As a dry run answers where no host matches: each restarts it, and says why. */
const NONE_MATCH: readonly MoveTarget[] = [
	{
		hostId: "hst_intel_1",
		hostName: "hetzner-fsn1-07",
		memory: "restarts",
		restartReason: "The new host has another CPU than its host, so its memory can't be restored there",
	},
	{
		hostId: "hst_old_1",
		hostName: "hetzner-fsn1-09",
		memory: "restarts",
		restartReason: "The new host can't take a sandbox's memory: upgrade its kantel-host",
	},
];

const LONG: readonly MoveTarget[] = [
	{
		hostId: "hst_long_1",
		hostName: "a-very-long-host-name-in-the-eu-central-datacentre-rack-17-slot-04",
		memory: "kept",
		pauseMs: 6_000,
	},
	{ hostId: "hst_long_2", hostName: "another-host-with-a-name-nobody-would-type-twice-fsn1-dc14-02" },
];

const moving = (
	phase: string,
	hostName = "hetzner-fsn1-01",
	more: { readonly keepMemory?: boolean; readonly restartReason?: string } = {},
): Sandbox => ({
	...RENDER,
	state: "moving",
	move: { phase, hostId: "hst_hetzner_1", hostName, keepMemory: false, startedAt: Date.now() - 42_000, ...more },
});

// The dialog as a microVM's menu opens it: the hosts come after a moment (or never, or not at all), and Move answers
// after a while, or fails and says why. What it was asked for shows below.
function Scenario({
	sandbox = RENDER,
	targets = HOSTS,
	read = "ready",
	fail,
	slow = false,
	press = false,
	unmount = false,
}: {
	sandbox?: Sandbox;
	targets?: readonly MoveTarget[];
	read?: "ready" | "hang" | "fail";
	fail?: string;
	slow?: boolean;
	/** Presses Move once the hosts are in, so the story opens on what comes of it. */
	press?: boolean;
	/** Takes the dialog away as soon as it moves, as a list does a row its filter no longer shows. */
	unmount?: boolean;
}) {
	const [open, setOpen] = useState(true);
	const [asked, setAsked] = useState<string>();
	useEffect(() => {
		if (!press) return;
		const timer = setTimeout(() => {
			document.querySelector<HTMLButtonElement>("dialog[open] button[type=submit]")?.click();
		}, 50);
		return () => clearTimeout(timer);
	}, [press]);
	return (
		<div className="p-6">
			<p className="text-muted">{asked ?? "Not moved yet."}</p>
			{unmount && asked !== undefined ? null : (
				<MoveDialog
					sandbox={open ? sandbox : undefined}
					targets={async () => {
						if (read === "hang") return new Promise(() => {});
						// Pressed stories read at once, so what comes of the press is on screen when the workbench looks.
						await new Promise((resolve) => setTimeout(resolve, press ? 0 : 300));
						if (read === "fail") throw new Error("Kantel couldn't list the hosts: the gateway didn't answer.");
						return targets;
					}}
					onClose={() => setOpen(false)}
					onMove={async (box, choice) => {
						if (unmount) setAsked("Moving; its row has gone from the list.");
						await new Promise((resolve) => setTimeout(resolve, slow ? 60_000 : press ? 50 : 800));
						if (fail !== undefined) throw new Error(fail);
						setAsked(`Moved ${box.name} to ${choice.hostId}, ${choice.keepMemory ? "with its memory" : "restarting"}.`);
					}}
					onFailed={(_box, reason) => setAsked(reason)}
				/>
			)}
		</div>
	);
}

/** The hosts are being read. */
export const Loading: Story = () => <Scenario read="hang" />;

/** No other host in its pool can take it. */
export const NoHosts: Story = () => <Scenario targets={[]} />;

/** Several hosts, from a Kantel that can't say what a move does to memory: each restarts it, with no estimate. */
export const SeveralHosts: Story = () => <Scenario />;

/** With the dry run: memory kept between matching hosts, and the pause expected, with Restart it instead. */
export const DryRun: Story = () => <Scenario sandbox={{ ...BROWSER_AGENT, state: "running" }} targets={DRY_RUN} />;

/** No host matches a running sandbox's: each restarts it, and the dialog says why for the one chosen. */
export const NoMatchingHost: Story = () => (
	<Scenario sandbox={{ ...BROWSER_AGENT, state: "running" }} targets={NONE_MATCH} />
);

/** A paused sandbox: its memory moves where the hosts match, and it carries on there. */
export const Paused: Story = () => <Scenario sandbox={{ ...BROWSER_AGENT, state: "paused" }} targets={DRY_RUN} />;

/** A paused sandbox with no matching host: it boots on its disk on the new host, its memory lost. */
export const PausedRestarts: Story = () => (
	<Scenario sandbox={{ ...BROWSER_AGENT, state: "paused" }} targets={NONE_MATCH} />
);

/** A running sandbox with no dry run: copied as it runs, then stopped for a last copy and restarted on its disk. */
export const Running: Story = () => <Scenario sandbox={{ ...BROWSER_AGENT, state: "running" }} />;

/** Moving: the dialog shows its phase until it runs there, and Close leaves it moving. */
export const InProgress: Story = () => <Scenario slow press />;

/** Its disk is being copied to the new host. */
export const Copying: Story = () => <Scenario sandbox={moving("copying")} />;

/** Its disk is there, and it is starting on the new host. */
export const Starting: Story = () => <Scenario sandbox={moving("starting")} />;

/** A running sandbox's move (a later Kantel): stopped for the last copy. */
export const StoppingPhase: Story = () => <Scenario sandbox={moving("stopping")} />;

/** A running sandbox's move that keeps its memory: its programs carry on there. */
export const KeepingMemory: Story = () => <Scenario sandbox={moving("final-copy", undefined, { keepMemory: true })} />;

/** A move that restarts it although it was asked to keep its memory: why, as Kantel said once it chose the host. */
export const RestartingWithReason: Story = () => (
	<Scenario
		sandbox={moving("copying", "hetzner-fsn1-07", {
			restartReason: "The new host has another CPU than its host, so its memory can't be restored there",
		})}
	/>
);

/** A running sandbox's move: the changes made since the first copy go across. */
export const FinalCopy: Story = () => <Scenario sandbox={moving("final-copy")} />;

/** A phase this console doesn't know reads as Kantel names it. */
export const UnknownPhase: Story = () => <Scenario sandbox={moving("verifying-checksums")} />;

/** The move fails: the dialog stays open and says why, the sandbox where it was. */
export const Failed: Story = () => (
	<Scenario
		press
		fail="hetzner-fsn1-01 can't take the sandbox's root image: its disk has 3 GB free of the 40 GB it needs. It's stopped where it was."
	/>
);

/** The dialog goes mid-move (its row filtered out of the list): the failure still says why, on the page. */
export const FailedAfterRowGone: Story = () => (
	<Scenario press unmount fail="lle-h2 refused the move: the pool's sync is off. It's stopped where it was." />
);

/** The hosts can't be read. */
export const ReadFailed: Story = () => <Scenario read="fail" />;

/** Long host and sandbox names wrap or are cut short, with the whole name in the tooltip. */
export const LongNames: Story = () => (
	<Scenario
		sandbox={{ ...RENDER, name: "a-very-long-sandbox-name-for-the-nightly-integration-environment" }}
		targets={LONG}
	/>
);

/** Moving to a host with a long name. */
export const LongNameMoving: Story = () => (
	<Scenario sandbox={moving("copying", "a-very-long-host-name-in-the-eu-central-datacentre-rack-17-slot-04")} />
);

/** On a phone (check at 420px): the dry run's columns go under the host's name where they don't fit. */
export const Mobile: Story = () => <Scenario targets={[...DRY_RUN, ...LONG]} />;
