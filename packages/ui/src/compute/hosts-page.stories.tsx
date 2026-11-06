import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostingMode, HostsSource } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW } from "./fixtures.ts";
import { HostsPage } from "./hosts-page.tsx";

export default { title: "Compute/Hosts page" } satisfies StoryDefault;

// Each story keeps its own source, so Drain, Undrain and Remove change its hosts.
function Scenario({
	hosting = "self-hosted",
	options,
	adding = false,
	owner,
	narrow = false,
	opened,
	confirmUpdate,
	usage = "live",
	updateFails = false,
}: {
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	adding?: boolean;
	owner?: { readonly name: string; readonly kind: "personal" | "organisation" };
	narrow?: boolean;
	opened?: string;
	confirmUpdate?: string;
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
			narrow={narrow}
			{...(opened === undefined ? {} : { opened })}
			{...(confirmUpdate === undefined ? {} : { confirmUpdate })}
			{...(owner === undefined ? {} : { owner })}
		/>
	);
}

/** The first host in the sample data. */
const FIRST = "hst_hetzner_1";

/** A self-hosted Kantel's four hosts: online, draining with an update out, a home server and an offline laptop. */
export const Default: Story = () => <Scenario />;

/** A host opened: its CPU, memory and disk over the last 10 minutes, read every 5 seconds. */
export const Opened: Story = () => <Scenario opened={FIRST} />;

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

/** Add host on a phone. */
export const MobileAdding: Story = () => <Scenario narrow adding />;
MobileAdding.meta = { width: 390 };
