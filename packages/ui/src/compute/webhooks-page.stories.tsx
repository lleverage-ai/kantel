import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { WebhooksPage } from "./webhooks-page.tsx";

export default { title: "Compute/Webhooks page" } satisfies StoryDefault;

// Each story keeps its own source, so Add endpoint, the switches, Send test event and Delete change its endpoints.
function Scenario({ options, initialOpen }: { options?: ComputeFixtureOptions; initialOpen?: string }) {
	const [source] = useState(() => createComputeFixtures(options));
	return (
		<WebhooksPage
			source={source.webhooks}
			account={LLEVERAGE}
			now={FIXTURE_NOW}
			{...(initialOpen === undefined ? {} : { initialOpen })}
		/>
	);
}

/** Two endpoints: one delivering, one whose last delivery failed after three attempts. */
export const Default: Story = () => <Scenario />;

/** The failing endpoint open, with its deliveries and their retries. */
export const Deliveries: Story = () => <Scenario initialOpen="whk_ops" />;

/** No endpoints yet. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** The list while it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: the table scrolls sideways. */
export const Mobile: Story = () => <Scenario initialOpen="whk_ops" />;
Mobile.meta = { width: 420 };
