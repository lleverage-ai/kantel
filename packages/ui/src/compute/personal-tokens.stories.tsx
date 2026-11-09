import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { PersonalTokensSource } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE, PERSONAL } from "./fixtures.ts";
import { PersonalTokensSection } from "./personal-tokens.tsx";
import { ProfilePage } from "./profile-page.tsx";

export default { title: "Compute/Personal access tokens" } satisfies StoryDefault;

const ACCOUNTS = [PERSONAL, LLEVERAGE];

// Each story keeps its own source, so New token and Revoke change its list.
function Section({
	options,
	narrow,
	creating,
}: {
	options?: ComputeFixtureOptions;
	narrow?: boolean;
	creating?: boolean;
}) {
	const [source] = useState(() => createComputeFixtures(options).personalTokens as PersonalTokensSource);
	return (
		<PersonalTokensSection
			source={source}
			accounts={ACCOUNTS}
			now={FIXTURE_NOW}
			{...(narrow === undefined ? {} : { narrow })}
			{...(creating === undefined ? {} : { creating })}
		/>
	);
}

/** A laptop's token from kantel login, a deploy script's in one organisation, and one that has expired. */
export const Default: Story = () => <Section />;

/** None yet: it says how to get one. */
export const Empty: Story = () => <Section options={{ empty: true }} />;

/** While it reads them. */
export const Loading: Story = () => <Section options={{ hang: true }} />;

/** Kantel can't be reached. */
export const Failed: Story = () => <Section options={{ fail: true }} />;

/** New token open: a name, what it may do, where and how long. */
export const NewToken: Story = () => <Section creating />;

/** A token just made, its secret shown once. */
export const Created: Story = () => {
	const [source] = useState(() => createComputeFixtures().personalTokens as PersonalTokensSource);
	return (
		<PersonalTokensSection
			source={source}
			accounts={ACCOUNTS}
			now={FIXTURE_NOW}
			created={{
				token: {
					id: "pat_new",
					name: "Nightly report",
					prefix: "kpt_N3wT",
					createdAt: FIXTURE_NOW,
					expiresAt: FIXTURE_NOW + 90 * 86_400_000,
				},
				secret: "kpt_N3wT0kenS3cretExampleOnly0000",
			}}
		/>
	);
};

/** On a phone: two-line rows. */
export const Phone: Story = () => <Section narrow />;
Phone.meta = { width: 420 };

/** In the Profile page, as the console shows it. */
export const InProfile: Story = () => {
	const [source] = useState(() => createComputeFixtures().personalTokens as PersonalTokensSource);
	return (
		<ProfilePage
			name="Tom Davies"
			email="tom@example.com"
			tokens={source}
			accounts={ACCOUNTS}
			now={FIXTURE_NOW}
			onDeleteAccount={() => new Promise(() => {})}
		/>
	);
};
