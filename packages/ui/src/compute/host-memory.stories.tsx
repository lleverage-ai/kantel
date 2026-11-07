import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostMemory } from "./compute-model.ts";
import { HostMemoryUsage } from "./host-memory.tsx";

export default { title: "Compute/Host memory" } satisfies StoryDefault;

const GIB = 1024;

// A 125 GiB host keeping 12 GiB for itself, with four 32 GiB checks VMs that use a few GiB each.
const checks: HostMemory = {
	mode: "reserved",
	state: "ok",
	totalMiB: 125 * GIB,
	reserveMiB: 12 * GIB,
	capacityMiB: 113 * GIB,
	reservedMiB: 128 * GIB,
	committedMiB: 44 * GIB,
	guestUsedMiB: 12 * GIB,
	residentMiB: 22 * GIB,
	availableMiB: 98 * GIB,
	swapUsedMiB: 0,
	pressureSome: 0,
	pressureFull: 0,
	maxRatio: 1.5,
};

/** Admitting by what sandboxes are given: more is given than there is, as the 1.5× allows. */
export const ByReservation: Story = () => <HostMemoryUsage host={{ name: "lleverage-1", memory: checks }} />;

/** Memory over-commit on: eight checks VMs, admitted by what they count for. */
export const ByUse: Story = () => (
	<HostMemoryUsage
		host={{
			name: "lleverage-1",
			memory: {
				...checks,
				mode: "used",
				reservedMiB: 256 * GIB,
				committedMiB: 88 * GIB,
				guestUsedMiB: 24 * GIB,
				residentMiB: 48 * GIB,
				availableMiB: 70 * GIB,
				maxRatio: 2.5,
			},
		}}
	/>
);

/** Every VM peaked at once: the host refuses new sandboxes. */
export const Refusing: Story = () => (
	<HostMemoryUsage
		host={{
			name: "lleverage-1",
			memory: {
				...checks,
				mode: "used",
				state: "refusing",
				committedMiB: 120 * GIB,
				guestUsedMiB: 96 * GIB,
				residentMiB: 104 * GIB,
				availableMiB: 9 * GIB,
				swapUsedMiB: 2 * GIB,
				pressureSome: 24.5,
				pressureFull: 3.2,
				maxRatio: 2.5,
			},
		}}
	/>
);

/** An older host agent says nothing about its memory: nothing shows. */
export const NotReported: Story = () => <HostMemoryUsage host={{ name: "toms-macbook" }} />;
