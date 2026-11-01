import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { ConnectFlow, ConnectFlowState } from "./connect-flow.tsx";
import { ConnectionsPage, fakeWindow } from "./connections-page.tsx";
import {
	CATALOGUE,
	CONNECTIONS,
	createConnectionsScenario,
	FIXTURE_NOW,
	GITHUB_APP_MADE,
	GITHUB_OWN_APP,
	PEOPLE,
	REDIRECT_URI,
	type ScenarioOptions,
	VIEWER,
} from "./fixtures.ts";
import { GitHubAppPermissions } from "./github-page.tsx";
import { ProviderDetail } from "./provider-detail.tsx";

export default { title: "Connections/GitHub page" } satisfies StoryDefault;

const people = (userId: string) => PEOPLE[userId];
const noop = () => {};
const never = () => new Promise<never>(() => {});
const withGitHub = (github: typeof GITHUB_APP_MADE) => CATALOGUE.map((t) => (t.id === "github" ? github : t));
const github = CONNECTIONS.filter((c) => c.templateId === "github");

/** GitHub's page in the Connections page, on its own fixtures, with Try it wired to nothing. */
function GitHub({ options, viewer = VIEWER }: { options?: ScenarioOptions; viewer?: typeof VIEWER }) {
	const [source] = useState(() =>
		createConnectionsScenario({ catalogue: withGitHub(GITHUB_APP_MADE), connections: github, ...options }, viewer),
	);
	return (
		<ConnectionsPage
			source={source}
			viewer={viewer}
			people={people}
			redirectUri={REDIRECT_URI}
			now={FIXTURE_NOW}
			openWindow={fakeWindow()}
			initialView={{ name: "service", templateId: "github" }}
			onStartSession={noop}
		/>
	);
}

/** Not set up: the one thing to do is have GitHub make the organisation's app. Its permissions show, read only. */
export const NotSetUp: Story = () => <GitHub options={{ catalogue: withGitHub(GITHUB_OWN_APP), connections: [] }} />;

/**
 * App made: kantel-agent is there. Install it on repositories, then connect your account through it: who can use it
 * starts on Just me, and the app's permissions are fixed, so there are no scope checkboxes. Connect ends on the
 * connected state.
 */
export const AppMade: Story = () => <GitHub options={{ connections: [], signInTime: 1200 }} />;

/** App made where every session is seen by its project: Just me can't reach agents yet, and the form says so. */
export const AppMadeProjectSessions: Story = () => (
	<GitHub options={{ connections: [] }} viewer={{ ...VIEWER, projectId: "proj_support", personal: false }} />
);

/** Connected: led by Tom's account, with what it reaches, what agents may do and prompts to try it in a session. */
export const Connected: Story = () => <GitHub />;

/** Connected, while GitHub is asked what the connection reaches. */
export const ConnectedReachLoading: Story = () => <GitHub options={{ reach: "hang" }} />;

/** Connected, when GitHub can't be asked: try again. */
export const ConnectedReachError: Story = () => <GitHub options={{ reach: "fail" }} />;

/** Connected, with more repositories than Kantel lists: the first few, Show all, and the rest on GitHub. */
export const ConnectedManyRepositories: Story = () => <GitHub options={{ reach: "many" }} />;

/** Connected, with the app installed nowhere the account can open. */
export const ConnectedNotInstalled: Story = () => <GitHub options={{ reach: "none" }} />;

/** Connected, on a phone. */
export const ConnectedMobile: Story = () => <GitHub />;
ConnectedMobile.meta = { width: 420 };

/** App made, on a phone. */
export const AppMadeMobile: Story = () => <GitHub options={{ connections: [] }} />;
AppMadeMobile.meta = { width: 420 };

const still = (state: ConnectFlowState): ConnectFlow => ({ state, run: noop, reopen: noop, cancel: noop, reset: noop });

/** Connected, with Connect another GitHub account open. */
export const ConnectAnother: Story = () => {
	const [source] = useState(() => createConnectionsScenario({ connections: github }));
	return (
		<ProviderDetail
			template={GITHUB_APP_MADE}
			connections={github}
			viewer={VIEWER}
			people={people}
			now={FIXTURE_NOW}
			flow={still({ phase: "idle" })}
			onConnect={never}
			onBack={noop}
			onUseKey={noop}
			onOpenConnection={noop}
			reach={source.reach}
			rules={source.rules}
			onTry={noop}
			initial={{ another: true }}
		/>
	);
};

/** Just connected a personal account where sessions are the project's: share it with a project next. */
export const ConnectedShareNext: Story = () => {
	const made = github[0];
	return made === undefined ? null : (
		<ProviderDetail
			template={GITHUB_APP_MADE}
			connections={[]}
			viewer={{ ...VIEWER, personal: false }}
			people={people}
			now={FIXTURE_NOW}
			flow={still({ phase: "connected", connection: made })}
			onConnect={never}
			onBack={noop}
			onUseKey={noop}
			onOpenConnection={noop}
		/>
	);
};

/** The GitHub App's permissions, read only. */
export const AppPermissions: Story = () => <GitHubAppPermissions app="kantel-agent" />;
