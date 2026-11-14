import { MINUTE } from "../primitives/format.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { Host, HostEvacuation, HostEvacuationSandbox } from "./compute-model.ts";
import { FIXTURE_NOW } from "./fixtures.ts";
import { EvacuateDialog, HostEvacuationPanel } from "./host-evacuation.tsx";

export default { title: "Compute/Host evacuation" } satisfies StoryDefault;

const names = new Map([
	["hst_hetzner_1", "hetzner-fsn1-01"],
	["hst_hetzner_2", "hetzner-fsn1-02"],
	["hst_home", "home-server"],
]);

const host = { name: "hetzner-fsn1-03", state: "draining" as const };

const microvm = (id: string, name: string, more: Partial<HostEvacuationSandbox>): HostEvacuationSandbox => ({
	id,
	name,
	kind: "microvm",
	state: "waiting",
	...more,
});

const SANDBOXES = {
	moved: microvm("sbx_7f3k2a", "agent-review-1", { state: "moved", hostId: "hst_hetzner_1", keptMemory: true }),
	restarted: microvm("sbx_9q1w4e", "nightly-build", {
		state: "moved",
		hostId: "hst_hetzner_2",
		keptMemory: false,
		reason: "The new host's CPU differs from this host's",
	}),
	copying: microvm("sbx_2m8n6b", "agent-review-2", { state: "moving", phase: "copying", hostId: "hst_hetzner_1" }),
	finalCopy: microvm("sbx_5t7y3u", "docs-preview", { state: "moving", phase: "final-copy", hostId: "hst_hetzner_2" }),
	waiting: microvm("sbx_1z4x8c", "data-pipeline", {}),
	waitingToo: microvm("sbx_6v2b9n", "agent-review-3", {}),
	pinned: microvm("sbx_3h5j7k", "gpu-bench", {
		state: "skipped",
		reason: "It's kept to this host: its create named the host",
	}),
	isolate: {
		id: "sbx_8l0p2o",
		name: "lint-script",
		kind: "isolate",
		state: "skipped",
		reason: "An isolate doesn't move to another host",
	},
	errored: microvm("sbx_4d6f8g", "flaky-test", {
		state: "skipped",
		reason: "It's in error: recover or delete it, then move it",
	}),
	privateOne: { id: "sbx_0r9e8w", kind: "microvm", state: "waiting" },
	failed: microvm("sbx_2s4d6f", "agent-review-4", {
		state: "failed",
		reason: "The move didn't happen: hetzner-fsn1-02 ran out of disk as it copied",
	}),
} satisfies Record<string, HostEvacuationSandbox>;

const evacuation = (
	state: HostEvacuation["state"],
	sandboxes: readonly HostEvacuationSandbox[],
	more: Partial<HostEvacuation> = {},
): HostEvacuation => {
	const counted = (which: HostEvacuationSandbox["state"]) => sandboxes.filter((item) => item.state === which).length;
	return {
		state,
		startedAt: FIXTURE_NOW - 4 * MINUTE,
		...(state === "running" ? {} : { endedAt: FIXTURE_NOW - MINUTE }),
		moved: counted("moved"),
		remaining: counted("waiting") + counted("moving"),
		skipped: counted("skipped"),
		failed: counted("failed"),
		sandboxes,
		...more,
	};
};

/** A draining host with no evacuation yet: what it does, and the button. */
export const Idle: Story = () => <HostEvacuationPanel host={host} names={names} onStart={() => undefined} />;

/** A host that isn't connected: the button waits for it. */
export const IdleOffline: Story = () => (
	<HostEvacuationPanel host={{ ...host, state: "offline" }} names={names} onStart={() => undefined} />
);

/** Two moving (copying, and a running one's last copy), two waiting their turn, two moved already. */
export const InProgress: Story = () => (
	<HostEvacuationPanel
		host={host}
		names={names}
		evacuation={evacuation("running", [
			SANDBOXES.moved,
			SANDBOXES.restarted,
			SANDBOXES.copying,
			SANDBOXES.finalCopy,
			SANDBOXES.waiting,
			SANDBOXES.waitingToo,
		])}
	/>
);

/** Skipped ones, each with its reason: kept to the host, an isolate, one in error; and one the viewer may not see. */
export const SomeSkipped: Story = () => (
	<HostEvacuationPanel
		host={host}
		names={names}
		evacuation={evacuation("running", [
			SANDBOXES.moved,
			SANDBOXES.copying,
			SANDBOXES.pinned,
			SANDBOXES.isolate,
			SANDBOXES.errored,
			SANDBOXES.privateOne,
		])}
	/>
);

/** Every sandbox that could move did; the skipped ones stay. */
export const Done: Story = () => (
	<HostEvacuationPanel
		host={host}
		names={names}
		evacuation={evacuation("done", [SANDBOXES.moved, SANDBOXES.restarted, SANDBOXES.pinned, SANDBOXES.isolate])}
		onStart={() => undefined}
	/>
);

/** Nothing was on it. */
export const DoneEmpty: Story = () => (
	<HostEvacuationPanel host={host} names={names} evacuation={evacuation("done", [])} onStart={() => undefined} />
);

/** It ended with a move that failed, its sandbox where it was: Try again moves what's left. */
export const Failed: Story = () => (
	<HostEvacuationPanel
		host={host}
		names={names}
		evacuation={evacuation("failed", [SANDBOXES.moved, SANDBOXES.restarted, SANDBOXES.failed, SANDBOXES.pinned])}
		onStart={() => undefined}
	/>
);

/** It couldn't carry on at all: the host was revoked. */
export const FailedRevoked: Story = () => (
	<HostEvacuationPanel
		host={host}
		names={names}
		evacuation={evacuation("failed", [SANDBOXES.moved, SANDBOXES.waiting], { reason: "The host was revoked" })}
	/>
);

/** Undrained part way, which stops it. */
export const Stopped: Story = () => (
	<HostEvacuationPanel
		host={{ ...host, state: "online" }}
		names={names}
		evacuation={evacuation("stopped", [SANDBOXES.moved, SANDBOXES.waiting, SANDBOXES.waitingToo], {
			reason: "The host was undrained",
		})}
		onStart={() => undefined}
	/>
);

export const Loading: Story = () => <HostEvacuationPanel host={host} names={names} loading />;

export const ReadFailed: Story = () => (
	<HostEvacuationPanel
		host={host}
		names={names}
		error="Kantel couldn't read how far it has got."
		onRetry={() => undefined}
	/>
);

/** Long names, a host it went to that the page has no name for, and many sandboxes. */
export const LongContent: Story = () => (
	<HostEvacuationPanel
		host={{ ...host, name: "ovh-gra-builds-and-checks-runner-with-a-long-name-01" }}
		names={names}
		evacuation={evacuation("running", [
			microvm("sbx_long01", "an-agent-sandbox-with-a-very-long-name-that-goes-on-and-on-past-the-column", {
				state: "moved",
				hostId: "hst_unknown_7q2w9e",
				keptMemory: false,
				reason:
					"The new host's runtime differs: it has firecracker v1.18.0 and kernel 6.1.160, where this sandbox's memory was made on firecracker v1.17.0",
			}),
			...Array.from({ length: 18 }, (_, at) =>
				microvm(`sbx_many${at}`, `agent-${String(at + 1).padStart(2, "0")}`, {
					...(at < 6 ? { state: "moved" as const, hostId: "hst_hetzner_1", keptMemory: true } : {}),
					...(at === 6 || at === 7 ? { state: "moving" as const, phase: "copying", hostId: "hst_hetzner_2" } : {}),
				}),
			),
		])}
	/>
);

/** A phone: a short row per sandbox. */
export const Mobile: Story = () => (
	<HostEvacuationPanel
		host={host}
		names={names}
		narrow
		evacuation={evacuation("running", [
			SANDBOXES.moved,
			SANDBOXES.restarted,
			SANDBOXES.copying,
			SANDBOXES.waiting,
			SANDBOXES.pinned,
			SANDBOXES.failed,
		])}
	/>
);

export const MobileIdle: Story = () => (
	<HostEvacuationPanel host={host} names={names} narrow onStart={() => undefined} />
);

const sample = (): Host => ({
	id: "hst_hetzner_2",
	name: "hetzner-fsn1-02",
	state: "online",
	arch: "x86_64",
	os: "Ubuntu 24.04",
	version: "0.4.1",
	vcpus: 32,
	memoryGb: 128,
	diskGb: 1800,
	used: { vcpus: 18, memoryGb: 72, diskGb: 900 },
	sandboxes: { isolates: 4, microvms: 9 },
	kvm: true,
	nestedVirtualisation: false,
	labels: {},
	lastSeenAt: FIXTURE_NOW,
	joinedAt: FIXTURE_NOW - 30 * 24 * 60 * MINUTE,
});

/** Move sandboxes off's dialog: what it does, before it begins. */
export const Confirm: Story = () => (
	<EvacuateDialog
		host={sample()}
		onClose={() => undefined}
		onStart={() => new Promise((resolve) => setTimeout(resolve, 600))}
	/>
);

/** Refused: the host went away as it was asked. */
export const ConfirmRefused: Story = () => (
	<EvacuateDialog
		host={sample()}
		onClose={() => undefined}
		onStart={async () => {
			throw new Error("The host isn't connected: move its sandboxes off once it is back");
		}}
	/>
);
