import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { ComputeAccount, ProxySource } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE, PERSONAL } from "./fixtures.ts";
import { ProxyPage, REMOVE_UPSTREAM_AUTH } from "./proxy-page.tsx";

export default { title: "Compute/Proxy page" } satisfies StoryDefault;

/**
 * The fixtures' proxy, with Remove for the upstream's credentials: the fixtures count any `auth` as set, so an empty
 * one is turned into a change that leaves none.
 */
function withAuthRemoval(proxy: ProxySource): ProxySource {
	return {
		...proxy,
		update: async (accountId, change) => {
			const removing = change.upstream?.auth === REMOVE_UPSTREAM_AUTH;
			if (!removing || change.upstream == null) return proxy.update(accountId, change);
			const { url } = change.upstream;
			// Dropping the upstream and setting it again without credentials leaves its URL and no credentials.
			await proxy.update(accountId, { upstream: null });
			return proxy.update(accountId, { ...change, upstream: { url } });
		},
	};
}

// Each story keeps its own source, so Save changes what the page reads next.
function Scenario({ options, account = LLEVERAGE }: { options?: ComputeFixtureOptions; account?: ComputeAccount }) {
	const [source] = useState(() => withAuthRemoval(createComputeFixtures(options).proxy));
	return <ProxyPage source={source} account={account} now={FIXTURE_NOW} />;
}

/** An organisation's proxy: an allow list, an upstream gateway with credentials, two added headers and the log. */
export const Default: Story = () => <Scenario />;

/** A personal account that hasn't set up its proxy: off, open, nothing logged. */
export const Unconfigured: Story = () => <Scenario account={PERSONAL} />;

/** The settings while they load. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The settings when Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: the form in one column, the tables scrolling sideways. */
export const Mobile: Story = () => <Scenario />;
Mobile.meta = { width: 420 };
