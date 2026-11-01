// The Connections page (#339): browse the catalogue and connect, see what's connected and whether it's healthy, and
// manage the OAuth clients people sign in through (#340). Every call goes through the `ConnectionsSource` the host
// binds to the public API; stories bind it to fixtures. The page's views are plain state the host can mirror in its
// address (`view` and `onViewChange`), so a service's page or a connection's page has a link of its own.

import { type ReactNode, useCallback, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { ChevronRightIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { KeyConnectionForm, McpServerForm } from "./add-forms.tsx";
import { Catalogue } from "./catalogue.tsx";
import { ConnectProgress, type OpenWindow, useConnectFlow } from "./connect-flow.tsx";
import {
	ConnectionDetail,
	ConnectionList,
	DisconnectDialog,
	disconnectText,
	type PeopleNames,
} from "./connection-list.tsx";
import { ConnectionRulesSection } from "./connection-rules.tsx";
import { ConnectionSharingSection, ConnectionUsesSection } from "./connection-sharing.tsx";
import {
	accountText,
	type Connection,
	type ConnectionsSource,
	type ConnectionsViewer,
	canManage,
	needsAttention,
	usageText,
} from "./connections-model.ts";
import { OAuthClients } from "./oauth-clients.tsx";
import { ProviderDetail } from "./provider-detail.tsx";

/** Where the page is. */
export type ConnectionsView =
	| { readonly name: "browse" }
	| { readonly name: "service"; readonly templateId: string }
	| { readonly name: "connected" }
	| { readonly name: "connection"; readonly connectionId: string }
	| { readonly name: "mcp" }
	| { readonly name: "key"; readonly templateId?: string; readonly serviceName?: string }
	| { readonly name: "clients"; readonly templateId?: string };

type Tab = "browse" | "connected" | "clients";

const tabOf = (view: ConnectionsView): Tab =>
	view.name === "connected" || view.name === "connection"
		? "connected"
		: view.name === "clients"
			? "clients"
			: "browse";

export interface ConnectionsPageProps {
	readonly source: ConnectionsSource;
	readonly viewer: ConnectionsViewer;
	readonly people?: PeopleNames;
	/** The redirect URI OAuth clients register, from the host. */
	readonly redirectUri: string;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Opens the sign-in window; stories pass a stand-in. */
	readonly openWindow?: OpenWindow;
	/** The view, when the host keeps it in its address. */
	readonly view?: ConnectionsView;
	readonly onViewChange?: (view: ConnectionsView) => void;
	/**
	 * Where to start, when the page keeps its own view. Without one, the page opens on what's connected if anything is,
	 * and on the catalogue if nothing is, as Claude.ai's Settings > Connectors lists yours above Browse. It waits to know
	 * which before it shows either, so it never opens on one and moves to the other.
	 */
	readonly initialView?: ConnectionsView;
	/** A search to start the catalogue with, for stories. */
	readonly initialQuery?: string;
	/** Whether the page has its own heading. The console's shell may give it one. */
	readonly heading?: boolean;
	/**
	 * Back from GitHub's app manifest flow: the setup's ID, from the `githubApp` query parameter GitHub's redirect
	 * carries. The page opens GitHub's service page, on its next step (install the app, then connect), or says why
	 * GitHub didn't make it.
	 */
	readonly gitHubAppSetup?: string | undefined;
	/** Opens a session from a connection's recent uses. */
	readonly onOpenSession?: (sessionId: string) => void;
	/** Starts a new session in a project with a prompt ready to send: Try it on GitHub's page (#461). */
	readonly onStartSession?: (projectId: string, prompt: string) => void;
}

export function ConnectionsPage({
	source,
	viewer,
	people,
	redirectUri,
	now: fixedNow,
	openWindow,
	view: controlled,
	onViewChange,
	initialView,
	initialQuery,
	heading = true,
	gitHubAppSetup,
	onOpenSession,
	onStartSession,
}: ConnectionsPageProps) {
	// The view the page keeps itself: undefined until it is chosen, by the person, by a starting view, or by the page
	// once it knows whether anything is connected.
	const [own, setOwn] = useState<ConnectionsView | undefined>(
		gitHubAppSetup === undefined ? initialView : { name: "service", templateId: "github" },
	);
	const gitHubApp = useLoad(
		async () =>
			gitHubAppSetup === undefined || source.gitHubApp === undefined ? undefined : source.gitHubApp(gitHubAppSetup),
		[source, gitHubAppSetup],
	);
	const go = useCallback(
		(next: ConnectionsView) => {
			setOwn(next);
			onViewChange?.(next);
		},
		[onViewChange],
	);
	const now = fixedNow ?? Date.now();

	const catalogue = useLoad(() => source.catalogue(), [source]);
	const connections = useLoad(() => source.connections(), [source]);
	// Nothing chosen yet: the page picks once the connections are in (the catalogue if they can't be read), in this
	// render, so the first view on screen is the one it keeps. Until then it shows neither (`pending` below).
	let view = controlled ?? own;
	if (view === undefined && connections.state.status !== "loading") {
		view =
			connections.state.status === "ready" && connections.state.value.length > 0
				? { name: "connected" }
				: { name: "browse" };
		setOwn(view);
	}
	const tab = view === undefined ? undefined : tabOf(view);
	const clients = useLoad(async () => (tab === "clients" ? source.clients() : undefined), [source, tab === "clients"]);

	const reloadConnections = connections.reload;
	const flow = useConnectFlow({
		poll: (attemptId) => source.attempt(attemptId),
		cancelAttempt: source.cancelAttempt?.bind(source),
		openWindow,
		onConnected: () => reloadConnections(),
	});
	// The connection a reconnect is for, while its round trip runs on the Connected view.
	const [reconnecting, setReconnecting] = useState<Connection>();
	const [disconnecting, setDisconnecting] = useState<Connection>();
	const [disconnectBusy, setDisconnectBusy] = useState(false);
	const [disconnectError, setDisconnectError] = useState<string>();
	const [notice, setNotice] = useState<string>();

	const templates = catalogue.state.status === "ready" ? catalogue.state.value : [];
	const list = connections.state.status === "ready" ? connections.state.value : [];
	const attention = needsAttention(list);
	const loadError = (state: { status: string }, what: string) =>
		state.status === "error" ? `Couldn't load ${what}. Check your connection and try again.` : undefined;

	const reconnect = (connection: Connection) => {
		setReconnecting(connection);
		flow.run(() => source.reconnect(connection.id));
	};

	const leave = (next: ConnectionsView, then?: string) => {
		// Leaving a view abandons any sign-in it started, so a late result can't land on another view.
		if (flow.state.phase === "starting" || flow.state.phase === "waiting") flow.cancel();
		else flow.reset();
		setReconnecting(undefined);
		// A notice belongs to the view it was said on, unless it is what the next view is for (a disconnect's outcome).
		setNotice(then);
		go(next);
	};

	const tabs = [
		{ value: "browse" as const, label: "Browse" },
		{ value: "connected" as const, label: "Connected", ...(list.length === 0 ? {} : { count: list.length }) },
		{ value: "clients" as const, label: "OAuth clients" },
	];

	// A service's page, and its key form, want the template in full: the catalogue may list only summaries.
	const fullId = view?.name === "service" || view?.name === "key" ? view.templateId : undefined;
	const full = useLoad(
		async () => (fullId === undefined || source.template === undefined ? undefined : source.template(fullId)),
		[source, fullId],
	);
	const fullLoading = fullId !== undefined && source.template !== undefined && full.state.status === "loading";
	const findTemplate = (templateId: string | undefined) =>
		(full.state.status === "ready" && full.state.value?.id === templateId ? full.state.value : undefined) ??
		templates.find((t) => t.id === templateId);

	let body: ReactNode;
	if (view === undefined) {
		// Not yet known whether anything is connected: a neutral placeholder, neither the catalogue nor the list.
		body = (
			<div className="kt-connections-pending flex min-w-0 flex-col gap-4" aria-busy="true">
				<Skeleton width="40%" />
				<Skeleton lines={2} />
				<Skeleton lines={2} />
			</div>
		);
	} else if (view.name === "browse") {
		body = (
			<Catalogue
				templates={templates}
				connections={list}
				viewer={viewer}
				loading={catalogue.state.status === "loading"}
				error={loadError(catalogue.state, "the catalogue")}
				onRetry={catalogue.reload}
				onOpen={(template) => leave({ name: "service", templateId: template.id })}
				onAddMcpServer={() => leave({ name: "mcp" })}
				onAddKey={(serviceName) => leave({ name: "key", ...(serviceName === undefined ? {} : { serviceName }) })}
				{...(initialQuery === undefined ? {} : { initialQuery })}
			/>
		);
	} else if (view.name === "service") {
		const template = findTemplate(view.templateId);
		const made = view.templateId === "github" && gitHubApp.state.status === "ready" ? gitHubApp.state.value : undefined;
		// A made app shows as GitHub's next step on its page (install it, then connect); only a failure needs saying.
		const madeNotice = made?.status === "failed" ? <Notice level="error">{made.message}</Notice> : null;
		body =
			template === undefined || fullLoading ? (
				catalogue.state.status === "loading" || fullLoading ? null : (
					<EmptyState
						title="That service isn't in the catalogue"
						action={<Button onClick={() => leave({ name: "browse" })}>Browse services</Button>}
					>
						It may have been removed, or it's private to another organisation.
					</EmptyState>
				)
			) : (
				<ProviderDetail
					key={template.id}
					template={template}
					connections={list}
					viewer={viewer}
					people={people}
					now={now}
					flow={flow}
					onConnect={(input) => source.connect(input)}
					onBack={() => leave({ name: "browse" })}
					onUseKey={(t) => leave({ name: "key", templateId: t.id })}
					onSetUpClient={(t) => leave({ name: "clients", templateId: t.id })}
					onOpenConnection={(c) => leave({ name: "connection", connectionId: c.id })}
					onSaveClient={async (input) => {
						const made = await source.createClient(input);
						// The template now resolves to the new client, and Connect is ready.
						full.reload();
						catalogue.reload();
						setNotice(`Saved ${made.label}. Connect ${template.name} through it now.`);
						return made;
					}}
					gitHubApp={made}
					reach={
						source.reach === undefined
							? undefined
							: (connectionId) => source.reach?.(connectionId) ?? Promise.resolve(undefined)
					}
					rules={source.rules}
					onTry={onStartSession}
					onCreateGitHubApp={
						source.createGitHubApp === undefined
							? undefined
							: async (input) => {
									const start = await source.createGitHubApp?.(input);
									// Kantel's page posts the manifest on to GitHub, which comes back here when the app is made.
									if (start !== undefined) window.location.assign(start.url);
								}
					}
				/>
			);
		if (madeNotice !== null)
			body = (
				<div className="flex min-w-0 flex-col gap-4">
					{madeNotice}
					{body}
				</div>
			);
	} else if (view.name === "mcp") {
		body = (
			<McpServerForm
				viewer={viewer}
				flow={flow}
				onAdd={(input) => source.addMcpServer(input)}
				onKey={async (input) => {
					const result = await source.connectKey(input);
					reloadConnections();
					return result;
				}}
				onDone={() => leave({ name: "connected" })}
				onCancel={() => leave({ name: "browse" })}
			/>
		);
	} else if (view.name === "key") {
		body = fullLoading ? null : (
			<KeyConnectionForm
				key={view.templateId ?? "custom"}
				viewer={viewer}
				catalogue={templates}
				template={findTemplate(view.templateId)}
				{...(view.serviceName === undefined ? {} : { custom: { name: view.serviceName } })}
				onSave={async (input) => {
					const result = await source.connectKey(input);
					reloadConnections();
					return result;
				}}
				onDone={() => leave({ name: "connected" })}
				onCancel={() =>
					leave(view.templateId === undefined ? { name: "browse" } : { name: "service", templateId: view.templateId })
				}
			/>
		);
	} else if (view.name === "connected") {
		body = (
			<div className="flex min-w-0 flex-col gap-4">
				{notice === undefined ? null : <Notice level="info">{notice}</Notice>}
				{reconnecting !== undefined && flow.state.phase !== "idle" ? (
					<section
						aria-label={`Reconnecting ${reconnecting.name}`}
						className="rounded-panel border border-border-strong bg-panel p-5"
					>
						<ConnectProgress
							flow={flow}
							name={reconnecting.name}
							icon={reconnecting.icon}
							connectedText={(c) =>
								`${accountText(c) === undefined ? "" : `${accountText(c)} is working again. `}${usageText(c, viewer, people)}`
							}
							onDone={() => setReconnecting(undefined)}
							onRetry={() => reconnect(reconnecting)}
						/>
					</section>
				) : attention > 0 ? (
					<Notice level="warning" announce={false}>
						{attention === 1 ? "One connection needs" : `${attention} connections need`} attention. Agents can't use
						them until they're reconnected or fixed.
					</Notice>
				) : null}
				<ConnectionList
					connections={list}
					viewer={viewer}
					people={people}
					now={now}
					loading={connections.state.status === "loading"}
					error={loadError(connections.state, "your connections")}
					onRetry={connections.reload}
					onOpen={(c) => leave({ name: "connection", connectionId: c.id })}
					onReconnect={reconnect}
					onDisconnect={async (c) => {
						const result = await source.disconnect(c.id);
						reloadConnections();
						return result;
					}}
					onBrowse={() => leave({ name: "browse" })}
					reconnecting={flow.state.phase === "starting" ? reconnecting?.id : undefined}
				/>
			</div>
		);
	} else if (view.name === "connection") {
		const connection = list.find((c) => c.id === view.connectionId);
		body = (
			<div className="flex min-w-0 flex-col gap-5">
				<nav aria-label="Breadcrumb">
					<ol className="m-0 flex list-none items-center gap-1.5 p-0 text-xs text-muted">
						<li>
							<button
								type="button"
								onClick={() => leave({ name: "connected" })}
								className="kt-focusable m-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-muted hover:text-fg hover:underline"
							>
								Connected
							</button>
						</li>
						<li aria-hidden="true" className="flex text-faint">
							<ChevronRightIcon size="sm" />
						</li>
						<li aria-current="page" className="text-fg">
							{connection?.name ?? "Connection"}
						</li>
					</ol>
				</nav>
				{notice === undefined ? null : <Notice level="info">{notice}</Notice>}
				{connection === undefined ? (
					connections.state.status === "loading" ? null : (
						<EmptyState
							title="There's no such connection"
							action={<Button onClick={() => leave({ name: "connected" })}>See your connections</Button>}
						>
							It may have been disconnected.
						</EmptyState>
					)
				) : (
					<ConnectionDetail
						connection={connection}
						viewer={viewer}
						people={people}
						now={now}
						reconnecting={flow.state.phase === "starting"}
						onReconnect={reconnect}
						onDisconnect={(c) => setDisconnecting(c)}
						sharing={
							<ConnectionSharingSection
								key={`sharing:${connection.id}`}
								connection={connection}
								viewer={viewer}
								people={people}
								now={now}
								source={source.sharing}
								onChange={() => reloadConnections()}
							/>
						}
						uses={
							source.uses === undefined ? undefined : (
								<ConnectionUsesSection
									key={`uses:${connection.id}`}
									connectionId={connection.id}
									load={(id) => source.uses?.(id) ?? Promise.resolve([])}
									now={now}
									onOpenSession={onOpenSession}
								/>
							)
						}
						rules={
							source.rules === undefined ? undefined : (
								<ConnectionRulesSection
									key={`rules:${connection.id}`}
									connection={connection}
									source={source.rules}
									viewer={viewer}
									canManage={canManage(connection, viewer)}
									now={now}
								/>
							)
						}
						progress={
							reconnecting?.id === connection.id && flow.state.phase !== "idle" ? (
								<div className="rounded-panel border border-border-strong bg-panel p-5">
									<ConnectProgress
										flow={flow}
										name={connection.name}
										icon={connection.icon}
										onDone={() => setReconnecting(undefined)}
										onRetry={() => reconnect(connection)}
									/>
								</div>
							) : undefined
						}
					/>
				)}
				<DisconnectDialog
					connection={disconnecting}
					busy={disconnectBusy}
					error={disconnectError}
					onCancel={() => {
						setDisconnecting(undefined);
						setDisconnectError(undefined);
					}}
					onConfirm={async () => {
						if (disconnecting === undefined) return;
						setDisconnectBusy(true);
						setDisconnectError(undefined);
						try {
							const result = await source.disconnect(disconnecting.id);
							setDisconnecting(undefined);
							reloadConnections();
							// It's gone, so its page has nothing left to show: back to the list, which says what became of it (#482).
							leave({ name: "connected" }, disconnectText(disconnecting, result));
						} catch (caught) {
							setDisconnectError(caught instanceof Error ? caught.message : "Couldn't disconnect it. Try again.");
						} finally {
							setDisconnectBusy(false);
						}
					}}
				/>
			</div>
		);
	} else {
		body = (
			<OAuthClients
				key={view.templateId ?? "all"}
				clients={clients.state.status === "ready" ? (clients.state.value ?? []) : []}
				catalogue={templates}
				viewer={viewer}
				redirectUri={redirectUri}
				loading={clients.state.status === "loading" || catalogue.state.status === "loading"}
				error={loadError(clients.state, "the OAuth clients")}
				onRetry={clients.reload}
				onCreate={async (input) => {
					const made = await source.createClient(input);
					clients.reload();
					catalogue.reload();
					return made;
				}}
				onSetDisabled={async (client, disabled) => {
					await source.setClientDisabled(client.id, disabled);
					clients.reload();
				}}
				onDelete={async (client) => {
					await source.deleteClient(client.id);
					clients.reload();
				}}
				initialTemplateId={view.templateId}
			/>
		);
	}

	const showTabs = view === undefined || view.name === "browse" || view.name === "connected" || view.name === "clients";
	return (
		<div className="kt-connections-page flex w-full max-w-[calc(var(--kt-content-width)_+_var(--kt-sidebar-width))] min-w-0 flex-col gap-6 text-sm leading-normal text-fg">
			{/* Just the title, as Claude.ai's Settings > Connectors: the catalogue says what the page is for. */}
			{heading ? <PageHeader title="Connections" /> : null}
			{showTabs ? (
				<SegmentedControl<Tab>
					label="Connections view"
					options={tabs}
					value={tab}
					onChange={(next) => leave({ name: next })}
				/>
			) : null}
			{body}
		</div>
	);
}

/** A stand-in sign-in window for stories and tests: never navigates, closes when told. */
export function fakeWindow(): OpenWindow {
	return () => {
		const stub = { closed: false, location: { href: "" }, close: () => (stub.closed = true), focus: () => {} };
		return stub as unknown as Window;
	};
}
