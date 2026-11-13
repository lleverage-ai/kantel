import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostingMode, HostsSource } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW } from "./fixtures.ts";
import { HostsPage, type HostsPageProps } from "./hosts-page.tsx";

export default { title: "Compute/Hosts page" } satisfies StoryDefault;

// Each story keeps its own source, so Drain, Undrain and Remove change its hosts.
function Scenario({
	hosting = "self-hosted",
	options,
	adding = false,
	addingTo,
	owner,
	narrow = false,
	opened,
	confirmUpdate,
	limiting,
	moving,
	poolDialog,
	usage = "live",
	updateFails = false,
}: {
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	adding?: boolean;
	addingTo?: string;
	owner?: { readonly name: string; readonly kind: "personal" | "organisation" };
	narrow?: boolean;
	opened?: string;
	confirmUpdate?: string;
	limiting?: string;
	moving?: string;
	poolDialog?: HostsPageProps["poolDialog"];
	/** `live`: the sample's made-up usage every 5 seconds. `loading`: it never answers. `none`: no live source. */
	usage?: "live" | "loading" | "none";
	/** Update is refused by the host. */
	updateFails?: boolean;
}) {
	const [source] = useState(() => {
		const { usage: live, ...fixture } = createComputeFixtures({ hosting, ...options }).hosts as HostsSource;
		const hosts: HostsSource = updateFails
			? {
					...fixture,
					update: async () => {
						throw new Error("This host couldn't update itself: run sudo kantel-host update on the machine.");
					},
				}
			: fixture;
		if (usage === "none" || live === undefined) return hosts;
		return { ...hosts, usage: usage === "loading" ? () => new Promise<never>(() => {}) : live };
	});
	return (
		<HostsPage
			source={source}
			hosting={hosting}
			now={FIXTURE_NOW}
			adding={adding}
			{...(addingTo === undefined ? {} : { addingTo })}
			narrow={narrow}
			{...(opened === undefined ? {} : { opened })}
			{...(confirmUpdate === undefined ? {} : { confirmUpdate })}
			{...(limiting === undefined ? {} : { limiting })}
			{...(moving === undefined ? {} : { moving })}
			{...(poolDialog === undefined ? {} : { poolDialog })}
			{...(owner === undefined ? {} : { owner })}
		/>
	);
}

/** The first host in the sample data. */
const FIRST = "hst_hetzner_1";

/**
 * A self-hosted Kantel's four hosts in three pools: the default with a home server and an offline laptop, ci with two
 * Hetzner machines (one draining with an update out), and workflows with none yet.
 */
export const Default: Story = () => <Scenario />;

/** A host opened: its CPU, memory and disk over the last 10 minutes, read every 5 seconds. */
export const Opened: Story = () => <Scenario opened={FIRST} />;

/** A host nearly out of disk opened: its graphs, then what takes its disk and its limit on saved snapshots. */
export const OpenedNearlyFull: Story = () => <Scenario opened="hst_hetzner_2" />;

/** The saved snapshot limit dialog for a host with one set: Set limit, or Remove limit. */
export const SnapshotLimit: Story = () => <Scenario limiting="hst_home" />;

/** The saved snapshot limit dialog for a host without one. */
export const SnapshotLimitNone: Story = () => <Scenario limiting={FIRST} />;

/** A host opened while its first readings load. */
export const OpenedLoading: Story = () => <Scenario opened={FIRST} usage="loading" />;

/** An offline host opened: no readings while it's down. */
export const OpenedOffline: Story = () => <Scenario opened="hst_mac" />;

/** A host out of date, its Update dialog open. Update shows it updating, and back on 0.4.2 a few seconds later. */
export const ConfirmUpdate: Story = () => <Scenario confirmUpdate="hst_hetzner_2" />;

/** Update refused by the host: its reason, and how to update it on the machine. */
export const UpdateRefused: Story = () => <Scenario confirmUpdate="hst_hetzner_2" updateFails />;

/** A host part way through an update: its agent column says so until it's back on the new version. */
export const Updating: Story = () => (
	<Scenario
		options={{
			hostOverrides: { hst_hetzner_2: { updating: { version: "0.4.2", since: FIXTURE_NOW - 4_000 } } },
		}}
	/>
);

/** Where the source has no live usage: what's allocated on each, as bars. */
export const NoLiveUsage: Story = () => <Scenario usage="none" />;

/** Add host, open, on a default install: its address is loopback, so the warning asks for one hosts can reach. */
export const Adding: Story = () => <Scenario adding />;

/** Add host where the deployment has an address hosts can reach: just the command. */
export const AddingReachable: Story = () => <Scenario adding options={{ publicUrl: "https://kantel.example.com" }} />;

/** No hosts yet. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** Someone's own hosts on a hosted Kantel, with none added yet. */
export const OwnEmpty: Story = () => (
	<Scenario hosting="hosted" options={{ empty: true }} owner={{ name: "Ada", kind: "personal" }} />
);

/** An organisation's own hosts, Add a host open. */
export const OwnAdding: Story = () => (
	<Scenario hosting="hosted" adding owner={{ name: "Analytical Engines", kind: "organisation" }} />
);

/** The list while it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: a row per host, the stats wrapping over them. */
export const Mobile: Story = () => <Scenario narrow />;
Mobile.meta = { width: 390 };

/** A host opened on a phone: its graphs one under another. */
export const MobileOpened: Story = () => <Scenario narrow opened={FIRST} />;
MobileOpened.meta = { width: 390 };

/** A phone with a host updating and one out of date. */
export const MobileUpdating: Story = () => (
	<Scenario
		narrow
		options={{
			hostOverrides: { hst_hetzner_2: { updating: { version: "0.4.2", since: FIXTURE_NOW - 4_000 } } },
		}}
	/>
);
MobileUpdating.meta = { width: 390 };

/** The saved snapshot limit dialog on a phone. */
export const MobileSnapshotLimit: Story = () => <Scenario narrow limiting="hst_home" />;
MobileSnapshotLimit.meta = { width: 390 };

/** Add host on a phone. */
export const MobileAdding: Story = () => <Scenario narrow adding />;
MobileAdding.meta = { width: 390 };

/** One pool, the default, with every host in it: its heading over them, and no Move to pool. */
export const OnePool: Story = () => <Scenario options={{ pools: "one" }} />;

/** Pools whose names are as long as a name may be: they wrap in their headings rather than being cut short. */
export const LongContent: Story = () => <Scenario options={{ pools: "long-names" }} />;

/** The pools can't be read: the hosts ungrouped, and a notice with Try again. */
export const PoolsFailed: Story = () => <Scenario options={{ pools: "fail" }} />;

/** A source with no pools, as an older gateway's: the hosts ungrouped, with no pool actions. */
export const NoPools: Story = () => <Scenario options={{ pools: "none" }} />;

/** New pool: its name, checked as typed against what the API takes. */
export const NewPool: Story = () => <Scenario poolDialog={{ kind: "new" }} />;

/** Rename pool, with its name to edit. */
export const RenamePool: Story = () => <Scenario poolDialog={{ kind: "rename", pool: "pool_ci" }} />;

/** Delete pool, for the empty workflows pool. A pool with hosts, or the default, has Delete greyed out. */
export const DeletePool: Story = () => <Scenario poolDialog={{ kind: "delete", pool: "pool_workflows" }} />;

/** Move to pool for an online host: the rule, and that it isn't drained, with Drain. Move shows Kantel's refusal. */
export const MoveNotDrained: Story = () => <Scenario moving={FIRST} />;

/** Move to pool for a drained host that still has sandboxes. */
export const MoveWithSandboxes: Story = () => <Scenario moving="hst_hetzner_2" />;

/** Move to pool for a drained host with no sandboxes: nothing in the way. */
export const MoveReady: Story = () => (
	<Scenario moving="hst_mac" options={{ hostOverrides: { hst_mac: { state: "draining" } } }} />
);

/** Add host from the ci pool's menu: the picker starts on ci, and the command names it. */
export const AddingToPool: Story = () => (
	<Scenario adding addingTo="pool_ci" options={{ publicUrl: "https://kantel.example.com" }} />
);

/** Add host with one pool: no picker, and the host joins the default. */
export const AddingOnePool: Story = () => (
	<Scenario adding options={{ pools: "one", publicUrl: "https://kantel.example.com" }} />
);

/** Pools with long names on a phone. */
export const MobileLongContent: Story = () => <Scenario narrow options={{ pools: "long-names" }} />;
MobileLongContent.meta = { width: 390 };

/** Move to pool on a phone. */
export const MobileMove: Story = () => <Scenario narrow moving={FIRST} />;
MobileMove.meta = { width: 390 };
