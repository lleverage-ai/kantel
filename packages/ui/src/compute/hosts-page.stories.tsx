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
	usage = "live",
}: {
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	adding?: boolean;
	owner?: { readonly name: string; readonly kind: "personal" | "organisation" };
	narrow?: boolean;
	opened?: string;
	/** `live`: the sample's made-up usage every 5 seconds. `loading`: it never answers. `none`: no live source. */
	usage?: "live" | "loading" | "none";
}) {
	const [source] = useState(() => {
		const { usage: live, ...hosts } = createComputeFixtures({ hosting, ...options }).hosts as HostsSource;
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

/** Add host on a phone. */
export const MobileAdding: Story = () => <Scenario narrow adding />;
MobileAdding.meta = { width: 390 };
