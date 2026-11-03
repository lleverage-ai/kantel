import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { EgressPage } from "./egress-page.tsx";
import {
	API_SERVER,
	type ComputeFixtureOptions,
	createComputeFixtures,
	DEV_STACK,
	LLEVERAGE,
	PERSONAL,
} from "./fixtures.ts";

export default { title: "Compute/Egress page" } satisfies StoryDefault;

// Each story keeps its own source, so Add grant and Remove change the sandbox's grants.
function Scenario({
	options,
	sandboxId = DEV_STACK.id,
	initialFilter,
	accountId = LLEVERAGE.id,
}: {
	options?: ComputeFixtureOptions;
	sandboxId?: string;
	initialFilter?: "all" | "denied" | "swapped";
	accountId?: string;
}) {
	const [source] = useState(() => createComputeFixtures(options));
	return (
		<EgressPage
			source={source.egress}
			sandboxId={sandboxId}
			accountId={accountId}
			sandboxesHref="#sandboxes"
			environmentHref={(id) => `#${id}`}
			{...(initialFilter === undefined ? {} : { initialFilter })}
		/>
	);
}

/** dev-stack's log: swaps, a tunnel, its placeholder sent to the wrong host, and denials by grant. */
export const Default: Story = () => <Scenario />;

/** Only what was denied, with why. */
export const Denied: Story = () => <Scenario initialFilter="denied" />;

/** A sandbox made from an environment that hasn't sent anything yet. */
export const Quiet: Story = () => <Scenario sandboxId={API_SERVER.id} />;

/** While it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** When Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** A sandbox of another account than the one selected (Back after switching): nothing to change. */
export const AnotherAccount: Story = () => <Scenario accountId={PERSONAL.id} />;

/** On a phone. */
export const Mobile: Story = () => <Scenario />;
Mobile.meta = { width: 420 };
