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
}: {
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	adding?: boolean;
	owner?: { readonly name: string; readonly kind: "personal" | "organisation" };
	narrow?: boolean;
}) {
	const [source] = useState(() => createComputeFixtures({ hosting, ...options }).hosts as HostsSource);
	return (
		<HostsPage
			source={source}
			hosting={hosting}
			now={FIXTURE_NOW}
			adding={adding}
			narrow={narrow}
			{...(owner === undefined ? {} : { owner })}
		/>
	);
}

/** A self-hosted Kantel's four hosts: online, draining with an update out, a home server and an offline laptop. */
export const Default: Story = () => <Scenario />;

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

/** Add host on a phone. */
export const MobileAdding: Story = () => <Scenario narrow adding />;
MobileAdding.meta = { width: 390 };
