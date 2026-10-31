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
	GITHUB_OWN_APP,
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

/** Opened with nothing chosen: the page goes to what's connected, since something is. */
export const Opening: Story = () => <Scenario />;

/** Opened with nothing connected: the catalogue. */
export const OpeningEmpty: Story = () => <Scenario options={{ connections: [] }} />;

/** The catalogue: every service, by category, with what's connected already marked. */
export const Catalogue: Story = () => <Scenario view={{ name: "browse" }} />;

/** A search narrows the grid. */
export const Search: Story = () => <Scenario view={{ name: "browse" }} query="mail" />;

/** A search with nothing in the catalogue offers the two ways to connect anything else. */
export const SearchNoResults: Story = () => <Scenario view={{ name: "browse" }} query="Acme status page" />;

/** The catalogue while it loads. */
export const CatalogueLoading: Story = () => <Scenario view={{ name: "browse" }} options={{ hang: true }} />;

/** The catalogue when Kantel can't be reached. */
export const CatalogueError: Story = () => <Scenario view={{ name: "browse" }} options={{ fail: true }} />;

/** GitHub's page: two connections already, a third can be added for a project. */
export const ProviderGitHub: Story = () => <Scenario view={{ name: "service", templateId: "github" }} />;

/** Tier 3, guided: Gmail needs your own Google app, and the page walks through making one. */
export const ProviderGoogleGuided: Story = () => <Scenario view={{ name: "service", templateId: "gmail" }} />;

/** Tier 3 on GitHub: have GitHub create the app from Kantel's manifest, or register it by hand. */
export const ProviderGitHubCreateApp: Story = () => (
	<Scenario
		options={{ catalogue: CATALOGUE.map((t) => (t.id === "github" ? GITHUB_OWN_APP : t)), connections: [] }}
		view={{ name: "service", templateId: "github" }}
	/>
);

/** GitHub by hand: the steps, with the callback URL to copy. */
export const ProviderGitHubAppByHand: Story = () => (
	<ProviderDetail
		template={GITHUB_OWN_APP}
		connections={[]}
		viewer={VIEWER}
		people={people}
		now={FIXTURE_NOW}
		flow={still({ phase: "idle" })}
		onConnect={never}
		onBack={noop}
		onUseKey={noop}
		onSaveClient={never}
		onCreateGitHubApp={never}
		initial={{ guide: "manual" }}
	/>
);

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

/** Tier 2: GitHub signs in with a code, through the host's public client. No app to register. */
export const FlowDeviceCode: Story = () => (
	<DetailWith
		state={{
			phase: "waiting",
			start: {
				attemptId: "att_1",
				url: "https://github.com/login/device",
				expiresAt: FIXTURE_NOW,
				device: { userCode: "WDJB-MJHT" },
			},
			window: "blocked",
		}}
	/>
);

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

// ---------------------------------------------------------------------------------------------------------------------
// Who a new connection is for: the project open by default, and a warning for "Just me" where sessions are the
// project's (`GET /v1/connections/settings` answering `personal: false`).

const projectSessions = { ...VIEWER, projectId: "proj_billing", personal: false };

/** A new MCP server starts on the project open (Billing), which every deployment's sessions can use. */
export const OwnerDefaultsToProject: Story = () => (
	<McpServerForm
		viewer={projectSessions}
		flow={still({ phase: "idle" })}
		onAdd={never}
		onKey={never}
		onDone={noop}
		onCancel={noop}
		initialUrl="https://example-server.modelcontextprotocol.io/mcp"
	/>
);

/** "Just me" on a deployment where every session is seen by its project: agents couldn't use it, so the form says so. */
export const OwnerJustMeWarning: Story = () => (
	<McpServerForm
		viewer={projectSessions}
		flow={still({ phase: "idle" })}
		onAdd={never}
		onKey={never}
		onDone={noop}
		onCancel={noop}
		initialUrl="https://example-server.modelcontextprotocol.io/mcp"
		initialOwner={{ kind: "user" }}
	/>
);

/** "Just me" where the deployment has personal mode on: no warning. */
export const OwnerJustMePersonal: Story = () => (
	<McpServerForm
		viewer={{ ...projectSessions, personal: true }}
		flow={still({ phase: "idle" })}
		onAdd={never}
		onKey={never}
		onDone={noop}
		onCancel={noop}
		initialUrl="https://example-server.modelcontextprotocol.io/mcp"
		initialOwner={{ kind: "user" }}
	/>
);

/** The same warning on a key connection. */
export const KeyJustMeWarning: Story = () => (
	<KeyConnectionForm
		viewer={projectSessions}
		catalogue={CATALOGUE}
		onSave={never}
		onDone={noop}
		onCancel={noop}
		initialOwner={{ kind: "user" }}
	/>
);

/** And on a catalogue service's Connect. */
export const ProviderJustMeWarning: Story = () =>
	github === undefined ? null : (
		<ProviderDetail
			template={github}
			connections={CONNECTIONS}
			viewer={projectSessions}
			people={people}
			now={FIXTURE_NOW}
			flow={still({ phase: "idle" })}
			onConnect={never}
			onBack={noop}
			onUseKey={noop}
			initial={{ owner: { kind: "user" } }}
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
