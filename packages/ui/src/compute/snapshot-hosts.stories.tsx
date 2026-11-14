import { type ReactNode, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { SnapshotHost, SnapshotsSource } from "./compute-model.ts";
import { SAVED_HOSTS } from "./fixtures.ts";
import { SavedSnapshotHosts, SnapshotCopiesSwitch, SnapshotHosts } from "./snapshot-hosts.tsx";

export default { title: "Compute/Snapshot hosts" } satisfies StoryDefault;

const held = (hostId: string, hostName: string, memory = false): SnapshotHost => ({
	hostId,
	hostName,
	state: "held",
	memory,
});

/** A width a dialog gives it, so a story reads as it shows. */
const Frame = ({ children }: { children: ReactNode }) => <div className="max-w-(--kt-card-width)">{children}</div>;

/** A source whose read of the hosts never settles, or settles as given. */
const sourceOf = (hosts: () => Promise<readonly SnapshotHost[] | undefined>): Pick<SnapshotsSource, "hosts"> => ({
	hosts,
});

/** Read from its source: a skeleton until the hosts come. */
export const Loading: Story = () => {
	const [source] = useState(() => sourceOf(() => new Promise(() => {})));
	return (
		<Frame>
			<SavedSnapshotHosts source={source} snapshot={{ id: "ssn_node22_base" }} />
		</Frame>
	);
};

/** Only on the host it was saved on: its pool has one host that can hold it, or the account's setting is off. */
export const OneHost: Story = () => (
	<Frame>
		<SnapshotHosts hosts={[held("hst_hetzner_1", "hetzner-fsn1-01")]} />
	</Frame>
);

/** On two hosts of its pool, as Kantel keeps it where it can. */
export const TwoHosts: Story = () => (
	<Frame>
		<SnapshotHosts hosts={SAVED_HOSTS.ssn_node22_base ?? []} />
	</Frame>
);

/** Its second copy on its way to another host. */
export const Fetching: Story = () => (
	<Frame>
		<SnapshotHosts hosts={SAVED_HOSTS.ssn_playwright ?? []} />
	</Frame>
);

/**
 * Saved with its memory: a sandbox made from it restores it on the host it was saved on and on a copy whose memory
 * came too; on a host of another CPU, only the disk.
 */
export const WithMemory: Story = () => (
	<Frame>
		<SnapshotHosts
			memory
			hosts={[held("hst_hetzner_1", "hetzner-fsn1-01", true), held("hst_home", "home-server", false)]}
		/>
	</Frame>
);

/** On the deployment's shared hosts, for anyone but a super-admin: Kantel doesn't say which. */
export const SharedHosts: Story = () => (
	<Frame>
		<SnapshotHosts
			hosts={[
				{ state: "held", memory: false },
				{ state: "fetching", memory: false },
			]}
		/>
	</Frame>
);

/** Just saved: its host hasn't reported it yet. */
export const Empty: Story = () => (
	<Frame>
		<SnapshotHosts hosts={[]} />
	</Frame>
);

/** A long host name truncates, whole on hover. */
export const LongContent: Story = () => (
	<Frame>
		<SnapshotHosts
			memory
			hosts={[
				held("hst_ovh_1", "ovh-gra-builds-and-checks-runner-with-a-long-name-01", true),
				{ hostId: "hst_hetzner_2", hostName: "hetzner-fsn1-02", state: "fetching", memory: false },
			]}
		/>
	</Frame>
);

/** The read failed: the reason, with Try again. */
export const Failed: Story = () => {
	const [source] = useState(() =>
		sourceOf(() => Promise.reject(new Error("The gateway didn't answer. Try again in a moment."))),
	);
	return (
		<Frame>
			<SavedSnapshotHosts source={source} snapshot={{ id: "ssn_node22_base" }} />
		</Frame>
	);
};

/** A gateway from before it doesn't list a snapshot's hosts. */
export const OlderGateway: Story = () => {
	const [source] = useState(() => sourceOf(() => Promise.resolve(undefined)));
	return (
		<Frame>
			<SavedSnapshotHosts source={source} snapshot={{ id: "ssn_node22_base" }} />
		</Frame>
	);
};

/** On a phone: a long name wraps the state under it. */
export const Mobile: Story = () => (
	<SnapshotHosts
		memory
		hosts={[
			held("hst_ovh_1", "ovh-gra-builds-and-checks-runner-with-a-long-name-01", true),
			{ hostId: "hst_hetzner_2", hostName: "hetzner-fsn1-02", state: "fetching", memory: false },
		]}
	/>
);
Mobile.meta = { width: 420 };

const settle = (on: boolean) => new Promise<boolean>((resolve) => setTimeout(() => resolve(on), 600));

/** The account's setting, on by default; it saves as it changes. */
export const CopiesSwitch: Story = () => <SnapshotCopiesSwitch on manager onChange={settle} />;

/** Turned off: no new copies are made, those there stay. */
export const CopiesSwitchOff: Story = () => <SnapshotCopiesSwitch on={false} manager onChange={settle} />;

/** A member sees it, but only an admin or owner changes it. */
export const CopiesSwitchMember: Story = () => <SnapshotCopiesSwitch on manager={false} onChange={settle} />;

/** A change Kantel refused: the switch stays as it was, with the reason under it. */
export const CopiesSwitchError: Story = () => (
	<SnapshotCopiesSwitch
		on
		manager
		onChange={() => Promise.reject(new Error("Kantel couldn't change it. Try again."))}
	/>
);
