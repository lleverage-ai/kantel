import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { KeyConnectionForm, McpServerForm } from "./add-forms.tsx";
import type { ConnectFlow, ConnectFlowState } from "./connect-flow.tsx";
import type { Connection } from "./connections-model.ts";
import { ConnectionsPage, type ConnectionsView, fakeWindow } from "./connections-page.tsx";
import {
	CATALOGUE,
	CONNECTIONS,
	createConnectionsScenario,
	FIXTURE_NOW,
	MEMBER_VIEWER,
	PEOPLE,
	REDIRECT_URI,
	type ScenarioOptions,
	VIEWER,
} from "./fixtures.ts";
import { ProviderDetail } from "./provider-detail.tsx";

export default { title: "Connections/Connections page" } satisfies StoryDefault;

const people = (userId: string) => PEOPLE[userId];
const noop = () => {};
const never = () => new Promise<never>(() => {});

// Each story keeps its own source, so connecting, disconnecting and adding clients change what it lists.
function Scenario({
	view,
	options,
	admin = true,
	query,
}: {
	view?: ConnectionsView;
	options?: ScenarioOptions;
	admin?: boolean;
	query?: string;
}) {
	const viewer = admin ? VIEWER : MEMBER_VIEWER;
	const [source] = useState(() => createConnectionsScenario(options, viewer));
	return (
		<ConnectionsPage
			source={source}
			viewer={viewer}
			people={people}
			redirectUri={REDIRECT_URI}
			now={FIXTURE_NOW}
			openWindow={fakeWindow()}
			{...(view === undefined ? {} : { initialView: view })}
			{...(query === undefined ? {} : { initialQuery: query })}
		/>
	);
}

/** The catalogue: every service, by category, with what's connected already marked. */
export const Catalogue: Story = () => <Scenario />;

/** A search narrows the grid. */
export const Search: Story = () => <Scenario query="mail" />;

/** A search with nothing in the catalogue offers the two ways to connect anything else. */
export const SearchNoResults: Story = () => <Scenario query="Acme status page" />;

/** The catalogue while it loads. */
export const CatalogueLoading: Story = () => <Scenario options={{ hang: true }} />;

/** The catalogue when Harbour can't be reached. */
export const CatalogueError: Story = () => <Scenario options={{ fail: true }} />;

/** GitHub's page: two connections already, a third can be added for a project. */
export const ProviderGitHub: Story = () => <Scenario view={{ name: "service", templateId: "github" }} />;

/** Linear connects through its own MCP server. */
export const ProviderMcp: Story = () => <Scenario view={{ name: "service", templateId: "linear" }} />;

/** A service with no OAuth client yet, seen by an admin. */
export const ProviderNeedsClient: Story = () => <Scenario view={{ name: "service", templateId: "salesforce" }} />;

/** The same, seen by a member: ask an admin, or use a key. */
export const ProviderNeedsClientMember: Story = () => (
	<Scenario admin={false} view={{ name: "service", templateId: "salesforce" }} />
);

/** Every connection, grouped by whose it is, with the ones that need attention first. */
export const Connected: Story = () => <Scenario view={{ name: "connected" }} />;

/** Nothing connected yet. */
export const ConnectedEmpty: Story = () => <Scenario options={{ connections: [] }} view={{ name: "connected" }} />;

/** One connection's page: account, scopes, hosts, client and rules. */
export const ConnectionPage: Story = () => (
	<Scenario view={{ name: "connection", connectionId: CONNECTIONS[0]?.id ?? "" }} />
);

/** A connection that needs reconnecting. */
export const ConnectionNeedsReauth: Story = () => {
	const expired = CONNECTIONS.find((c) => c.health === "needs_reconnect");
	return <Scenario view={{ name: "connection", connectionId: expired?.id ?? "" }} />;
};

/** Add a remote MCP server by URL. */
export const CustomMcpServer: Story = () => <Scenario view={{ name: "mcp" }} />;

/** Connect any HTTP API with a key. */
export const ApiKeyCustom: Story = () => <Scenario view={{ name: "key" }} />;

/** Connect a catalogue service with a key. */
export const ApiKeyTemplate: Story = () => <Scenario view={{ name: "key", templateId: "stripe" }} />;

/** OAuth clients: the host's, the organisation's and a personal one, and which wins for new connections. */
export const OAuthClients: Story = () => <Scenario view={{ name: "clients" }} />;

/** Registering a client for Google: the redirect URI to copy, then the ID and secret. */
export const OAuthClientAdd: Story = () => <Scenario view={{ name: "clients", templateId: "google-drive" }} />;

/** A member sees the organisation's clients read-only and can add a personal one. */
export const OAuthClientsMember: Story = () => <Scenario admin={false} view={{ name: "clients" }} />;

/** Click Connect: a sign-in that fails because the person declined. */
export const ConnectDenied: Story = () => (
	<Scenario options={{ connectOutcome: "denied", signInTime: 1200 }} view={{ name: "service", templateId: "github" }} />
);

// ---------------------------------------------------------------------------------------------------------------------
// The round trip's states, held still for screenshots.

const still = (state: ConnectFlowState): ConnectFlow => ({ state, run: noop, reopen: noop, cancel: noop, reset: noop });

const github = CATALOGUE.find((t) => t.id === "github");
const connected: Connection | undefined = CONNECTIONS.find((c) => c.templateId === "github");

function DetailWith({ state }: { state: ConnectFlowState }) {
	if (github === undefined) return null;
	return (
		<ProviderDetail
			template={github}
			connections={CONNECTIONS}
			viewer={VIEWER}
			people={people}
			now={FIXTURE_NOW}
			flow={still(state)}
			onConnect={never}
			onBack={noop}
			onUseKey={noop}
		/>
	);
}

const START = {
	attemptId: "att_1",
	url: "https://harbour.example/v1/connections/connect/att_1",
	expiresAt: FIXTURE_NOW,
};

/** Waiting for the sign-in window. */
export const FlowWaiting: Story = () => <DetailWith state={{ phase: "waiting", start: START, window: "open" }} />;

/** The browser blocked the window: open it from the page instead. */
export const FlowBlocked: Story = () => <DetailWith state={{ phase: "waiting", start: START, window: "blocked" }} />;

/** Connected. */
export const FlowConnected: Story = () =>
	connected === undefined ? null : <DetailWith state={{ phase: "connected", connection: connected }} />;

/** Signed in as a different account from the connection's. */
export const FlowUserMismatch: Story = () => <DetailWith state={{ phase: "failed", reason: "user_mismatch" }} />;

/** An MCP server that's waiting on its sign-in. */
export const McpServerWaiting: Story = () => (
	<McpServerForm
		viewer={VIEWER}
		flow={still({ phase: "waiting", start: START, window: "open" })}
		onAdd={never}
		onKey={never}
		onDone={noop}
		onCancel={noop}
		initialUrl="https://mcp.notion.com/mcp"
	/>
);

/** A pasted key that looks like Stripe's offers the template. */
export const KeySuggestsTemplate: Story = () => (
	<KeyConnectionForm
		viewer={VIEWER}
		catalogue={CATALOGUE}
		onSave={never}
		onDone={noop}
		onCancel={noop}
		initialKey="sk_live_51Hx0000000000000000000000"
	/>
);

/** A custom key saved, but its test request failed. */
export const KeySavedTestFailed: Story = () => {
	const sample = CONNECTIONS.find((c) => c.kind === "key");
	if (sample === undefined) return null;
	return (
		<KeyConnectionForm
			viewer={VIEWER}
			custom={{ name: "Status API" }}
			onSave={never}
			onDone={noop}
			onCancel={noop}
			initialResult={{
				connection: { ...sample, name: "Status API", health: "failing_test" },
				test: { ok: false, message: "The test request returned 401 Unauthorized." },
			}}
		/>
	);
};
