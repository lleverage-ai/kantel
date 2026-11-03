import { useState } from "react";
import { DAY } from "../primitives/format.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { ComputeApiKeysPage } from "./api-keys-page.tsx";
import type { CreatedApiKey } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";

export default { title: "Compute/API keys page" } satisfies StoryDefault;

/** A key just made, for the Created story: the fixtures' secrets are made on create, so this one is written out. */
const JUST_MADE: CreatedApiKey = {
	key: {
		id: "key_eval_runner",
		name: "Eval runner",
		prefix: "kt_live_c3e9",
		accountId: LLEVERAGE.id,
		scopes: ["sandboxes:read", "sandboxes:write", "sandboxes:exec", "snapshots:read"],
		createdAt: FIXTURE_NOW,
		createdBy: "Tom Davies",
		expiresAt: FIXTURE_NOW + 90 * DAY,
	},
	secret: "kt_live_c3e9t7wq2mzk8vhn4rjx6pb5sdyf3gac",
};

// Each story keeps its own source, so New key and Revoke change its keys.
function Scenario({
	options,
	creating = false,
	created,
}: {
	options?: ComputeFixtureOptions;
	creating?: boolean;
	created?: CreatedApiKey;
}) {
	const [source] = useState(() => createComputeFixtures(options));
	return (
		<ComputeApiKeysPage
			source={source.keys}
			account={LLEVERAGE}
			now={FIXTURE_NOW}
			creating={creating}
			{...(created === undefined ? {} : { created })}
		/>
	);
}

/** An organisation's keys: a preset, a custom set, one never used, one revoked at the end. */
export const Default: Story = () => <Scenario />;

/** New key, open, with the Agent preset ticked. */
export const Create: Story = () => <Scenario creating />;

/** A key just made: its secret once, with the commands that use it. */
export const Created: Story = () => <Scenario created={JUST_MADE} />;

/** No keys yet. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** The list while it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: the table scrolls sideways. */
export const Mobile: Story = () => <Scenario />;
Mobile.meta = { width: 420 };
