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
}: {
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	adding?: boolean;
	owner?: { readonly name: string; readonly kind: "personal" | "organisation" };
}) {
	const [source] = useState(() => createComputeFixtures({ hosting, ...options }).hosts as HostsSource);
	return (
		<HostsPage
			source={source}
			hosting={hosting}
			now={FIXTURE_NOW}
			adding={adding}
			{...(owner === undefined ? {} : { owner })}
		/>
	);
}

/** A self-hosted Kantel's four hosts: online, draining with an update out, a home server and an offline laptop. */
export const Default: Story = () => <Scenario />;

/** Add a host, open, with its join command made. */
export const Adding: Story = () => <Scenario adding />;

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

/** On a phone: the stats wrap and the table scrolls sideways. */
export const Mobile: Story = () => <Scenario />;
Mobile.meta = { width: 420 };
