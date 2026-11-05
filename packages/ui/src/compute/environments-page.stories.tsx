import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { EnvironmentPage, EnvironmentsPage } from "./environments-page.tsx";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE, PERSONAL } from "./fixtures.ts";

export default { title: "Compute/Environments page" } satisfies StoryDefault;

// Each story keeps its own source, so adding, editing, rotating and removing change its environments.
function List({ options, creating }: { options?: ComputeFixtureOptions; creating?: boolean }) {
	const [source] = useState(() => createComputeFixtures(options));
	return (
		<EnvironmentsPage
			source={source.environments}
			account={LLEVERAGE}
			environmentHref={(id) => `#${id}`}
			now={FIXTURE_NOW}
			{...(creating === undefined ? {} : { creating })}
		/>
	);
}

function One({
	environmentId = "env_backend",
	addingProtected,
	accountId = LLEVERAGE.id,
	options,
}: {
	environmentId?: string;
	addingProtected?: boolean;
	accountId?: string;
	options?: ComputeFixtureOptions;
}) {
	const [source] = useState(() => createComputeFixtures(options));
	return (
		<EnvironmentPage
			source={source.environments}
			environmentId={environmentId}
			accountId={accountId}
			listHref="#environments"
			now={FIXTURE_NOW}
			{...(addingProtected === undefined ? {} : { addingProtected })}
		/>
	);
}

/** The organisation's two environments, with how many of their variables are protected. */
export const Default: Story = () => <List />;

/** No environments yet. */
export const Empty: Story = () => <List options={{ empty: true }} />;

/** New environment open. */
export const Creating: Story = () => <List creating />;

/** The list while it loads. */
export const Loading: Story = () => <List options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const Failed: Story = () => <List options={{ fail: true }} />;

/** backend-dev: plain and protected variables with their bindings, secret files, repositories and grants. */
export const Environment: Story = () => <One />;

/** Add protected variable open: a value, and the hosts it's swapped in for. */
export const AddProtected: Story = () => <One addingProtected />;

/** An environment of another account than the one selected (Back after switching): nothing to change. */
export const AnotherAccount: Story = () => <One accountId={PERSONAL.id} />;

/** A deployment with no secrets key: the list says protected values and secret files aren't supported here. */
export const NoProtectedValuesList: Story = () => <List options={{ noProtectedValues: true }} />;

/** The same deployment's environment: plain variables, repositories and grants, with no protected variable or file to add. */
export const NoProtectedValues: Story = () => <One options={{ noProtectedValues: true }} />;

/** On a phone: the tables scroll sideways. */
export const Mobile: Story = () => <One />;
Mobile.meta = { width: 420 };
