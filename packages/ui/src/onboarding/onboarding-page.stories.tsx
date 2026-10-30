import { useMemo, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { createFixtureOnboardingApi, type FixtureOptions, fixtureAt } from "./onboarding-fixture.ts";
import { OnboardingPage } from "./onboarding-page.tsx";

export default { title: "Onboarding/Onboarding page" } satisfies StoryDefault;

const PROJECTS = [
	{ id: "prj_default", name: "Default" },
	{ id: "prj_harbour", name: "Harbour" },
];

/** The page on the real onboarding and model provider services, starting at a step. */
function Live({
	options,
	settled = [],
	canChange,
}: {
	options?: FixtureOptions;
	settled?: readonly ("models" | "connectors")[];
	canChange?: boolean;
}) {
	const [left, setLeft] = useState<string>();
	const api = useMemo(() => {
		const made = createFixtureOnboardingApi(options);
		// The steps before this one, settled before the page first reads where it is.
		const ready = fixtureAt(made, settled);
		return { ...made, get: async () => (await ready, made.get()) };
	}, [options, settled]);
	if (left !== undefined) return <p className="p-6 text-sm text-muted">{left}</p>;
	return (
		<OnboardingPage
			api={api}
			projects={PROJECTS}
			product="Partan"
			{...(canChange === undefined ? {} : { canChange })}
			onLeave={() => setLeft("Left setup for the console.")}
			onSessionStarted={(projectId, sessionId) => setLeft(`Opened session ${sessionId} in ${projectId}.`)}
			openUrl={() => undefined}
		/>
	);
}

const FRESH: FixtureOptions = {};
export const FreshInstall: Story = () => <Live options={FRESH} />;
FreshInstall.storyName = "Fresh install: connect a model";

const SIGNED_IN: FixtureOptions = { platformDefault: true, signedIn: { anthropic: "tom@example.com" } };
export const SubscriptionSignedIn: Story = () => <Live options={SIGNED_IN} />;
SubscriptionSignedIn.storyName = "Models: a subscription signed in";

const NO_CPA: FixtureOptions = { subscriptions: false };
export const KeysOnly: Story = () => <Live options={NO_CPA} />;
KeysOnly.storyName = "Models: no CLIProxyAPI management key";

const CONNECTORS_AT: readonly "models"[] = ["models"];
const WITH_DEFAULT: FixtureOptions = { platformDefault: true };
export const Connectors: Story = () => <Live options={WITH_DEFAULT} settled={CONNECTORS_AT} />;
Connectors.storyName = "Connectors: the catalogue";

const NO_CONNECTIONS: FixtureOptions = { platformDefault: true, connections: false };
export const ConnectorsUnavailable: Story = () => <Live options={NO_CONNECTIONS} settled={CONNECTORS_AT} />;
ConnectorsUnavailable.storyName = "Connectors: not served here";

const SESSION_AT: readonly ("models" | "connectors")[] = ["models", "connectors"];
export const FirstSession: Story = () => <Live options={WITH_DEFAULT} settled={SESSION_AT} />;
FirstSession.storyName = "First session";

export const FirstSessionNoModel: Story = () => <Live options={FRESH} settled={SESSION_AT} />;
FirstSessionNoModel.storyName = "First session: no model yet";

export const NotAdmin: Story = () => <Live options={WITH_DEFAULT} canChange={false} />;
NotAdmin.storyName = "Someone who isn't an admin";
