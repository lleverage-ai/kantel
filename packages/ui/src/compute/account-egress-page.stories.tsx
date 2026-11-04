import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { AccountEgressPage, type EgressTab } from "./account-egress-page.tsx";
import type { ComputeAccount } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE, PERSONAL } from "./fixtures.ts";

export default { title: "Compute/Egress (account)" } satisfies StoryDefault;

// Each story keeps its own source, so a policy, a rule or a setting changes what the page reads next.
function Scenario({
	options,
	account = LLEVERAGE,
	tab,
	narrow = false,
}: {
	options?: ComputeFixtureOptions;
	account?: ComputeAccount;
	tab?: EgressTab;
	narrow?: boolean;
}) {
	const [source] = useState(() => createComputeFixtures(options));
	return (
		<AccountEgressPage
			source={source}
			account={account}
			{...(tab === undefined ? {} : { tab })}
			tabHref={(each) => `#${each}`}
			environmentHref={(id) => `#${id}`}
			sandboxHref={(id) => `#${id}`}
			narrow={narrow}
			now={FIXTURE_NOW}
		/>
	);
}

/** The organisation's log: every sandbox's requests, newest first; open a denial for why and its fixes. */
export const Log: Story = () => <Scenario />;

/** Every rule, from the account, its environments and its sandboxes, and where protected variables are swapped in. */
export const Rules: Story = () => <Scenario tab="rules" />;

/** The upstream proxy, the log, and turning the proxy off at the foot. */
export const Settings: Story = () => <Scenario tab="settings" />;

/** A personal account that hasn't set up its proxy: off, every host allowed, nothing logged. */
export const ProxyOff: Story = () => <Scenario account={PERSONAL} />;

/** The settings of a proxy that is off: Turn on at the foot. */
export const ProxyOffSettings: Story = () => <Scenario account={PERSONAL} tab="settings" />;

/** No sandboxes or environments yet. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** While it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** When Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: the log as two-line rows. */
export const Mobile: Story = () => <Scenario narrow />;
Mobile.meta = { width: 390 };

/** The rules on a phone. */
export const MobileRules: Story = () => <Scenario tab="rules" narrow />;
MobileRules.meta = { width: 390 };

/** Settings on a phone. */
export const MobileSettings: Story = () => <Scenario tab="settings" narrow />;
MobileSettings.meta = { width: 390 };
