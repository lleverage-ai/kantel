import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { BillingPage } from "./billing-page.tsx";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";

export default { title: "Compute/Billing page" } satisfies StoryDefault;

// Each story keeps its own hosted source, so switching plans changes what the page reads back.
function Scenario({ options }: { options?: ComputeFixtureOptions }) {
	const [source] = useState(() => createComputeFixtures({ ...options, hosting: "hosted" }));
	if (source.billing === undefined) return null;
	return <BillingPage source={source.billing} account={LLEVERAGE} now={FIXTURE_NOW} />;
}

/** Lleverage on the Team plan, three days into November. */
export const Billing: Story = () => <Scenario />;

/** An account with no sandboxes yet: nothing used this period. */
export const BillingEmpty: Story = () => <Scenario options={{ empty: true }} />;

/** The plan and usage while they load. */
export const BillingLoading: Story = () => <Scenario options={{ hang: true }} />;

/** The plan and usage when Kantel can't be reached. */
export const BillingFailed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: the plans stack and the rates table scrolls sideways. */
export const BillingMobile: Story = () => <Scenario />;
BillingMobile.meta = { width: 420 };
