import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { MountsSource } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { MountsPage } from "./mounts-page.tsx";

export default { title: "Compute/Mounts page" } satisfies StoryDefault;

// Each story keeps its own source, so Delete changes its bundles and bucket sources.
function Scenario({ options }: { options?: ComputeFixtureOptions }) {
	const [source] = useState(() => createComputeFixtures(options).mounts as MountsSource);
	return <MountsPage source={source} account={LLEVERAGE} now={FIXTURE_NOW} />;
}

/**
 * An organisation's three bundles and two bucket sources. The ones its sandboxes mount can't be deleted yet; the model
 * weights and the public datasets can.
 */
export const Default: Story = () => <Scenario />;

/** No bundles or bucket sources yet: both are made with the API. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** While they load. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** When Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: each row a card, Delete beside its digest or name. */
export const Mobile: Story = () => <Scenario />;
Mobile.meta = { width: 420 };
