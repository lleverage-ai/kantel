// A service's own page in the catalogue (#325, #327): what it is, then Connect, the page's one action, with its two
// choices (who the connection is for, and which permissions to ask for beyond the defaults), then the viewer's
// connections to it already, what agents can do with it and where its requests go. One column: Connect sits in the
// flow under the header, not in a sidebar. Connect runs the OAuth round trip in place (connect-flow.tsx).
//
// GitHub's page has three states, one primary action each (#461, github-page.tsx): not set up (set up the
// organisation's GitHub App), app made (install it, then connect) and connected (led by the connection).

import { type ReactNode, useId, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField } from "../primitives/controls.tsx";
import { CheckIcon, ChevronRightIcon } from "../primitives/icons.tsx";
import { AppWindowIcon, ExternalLinkIcon, KeyRoundIcon, PlugIcon } from "../primitives/lucide.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { OwnerField } from "./add-forms.tsx";
import { type ConnectFlow, ConnectProgress } from "./connect-flow.tsx";
import { ConnectionRow, type PeopleNames } from "./connection-list.tsx";
import {
	type ConnectInput,
	type Connection,
	type ConnectionReachView,
	type ConnectionRulesSource,
	type ConnectionsViewer,
	type ConnectStart,
	connectionsFor,
	connectRoute,
	defaultOwner,
	type GitHubAppInput,
	type GitHubAppState,
	HEALTH_LABELS,
	type OAuthClient,
	type OAuthClientInput,
	type OwnerChoice,
	type ProviderTemplate,
	takesKey,
	tierLabel,
	usageText,
} from "./connections-model.ts";
import { GitHubAppPermissions, GitHubOverview, GitHubSetupSteps } from "./github-page.tsx";
import { gitHubAppOf, gitHubPageState, leadConnection } from "./github-page-model.ts";
import { GuidedSetup } from "./guided-setup.tsx";
import { ProviderLogo } from "./provider-logo.tsx";
import { SetupTierLabel } from "./setup-tier.tsx";

export interface ProviderDetailProps {
	readonly template: ProviderTemplate;
	readonly connections: readonly Connection[];
	readonly viewer: ConnectionsViewer;
	readonly people?: PeopleNames | undefined;
	readonly now: number;
	readonly flow: ConnectFlow;
	/** Starts the round trip (`ConnectionsSource.connect`). */
	readonly onConnect: (input: ConnectInput) => Promise<ConnectStart>;
	readonly onBack: () => void;
	/** Connects it with a key instead. */
	readonly onUseKey: (template: ProviderTemplate) => void;
	/** The OAuth clients settings, for a service with no client yet. Only for an admin. */
	readonly onSetUpClient?: ((template: ProviderTemplate) => void) | undefined;
	readonly onOpenConnection?: ((connection: Connection) => void) | undefined;
	/** Saves a client registered by following the service's setup guide (tier 3). Without it, no guide shows. */
	readonly onSaveClient?: ((input: OAuthClientInput) => Promise<OAuthClient>) | undefined;
	/** Has GitHub create a GitHub App from Kantel's manifest. */
	readonly onCreateGitHubApp?: ((input: GitHubAppInput) => Promise<unknown>) | undefined;
	/** Back from GitHub's manifest flow: what became of the app it made. */
	readonly gitHubApp?: GitHubAppState | undefined;
	/** Asks what a connection reaches (`ConnectionsSource.reach`), for GitHub's connected state. */
	readonly reach?: ((connectionId: string) => Promise<ConnectionReachView | undefined>) | undefined;
	/** A connection's rules, for the summary of what agents may do on GitHub's connected state. */
	readonly rules?: ConnectionRulesSource | undefined;
	/** Starts a session in a project with a prompt ready to send: GitHub's Try it. */
	readonly onTry?: ((projectId: string, prompt: string) => void) | undefined;
	/** Choices to start with, for stories. */
	readonly initial?: {
		readonly owner?: OwnerChoice;
		readonly scopeSets?: readonly string[];
		readonly guide?: "choose" | "manual";
		/** GitHub's connected state with its connect form open. */
		readonly another?: boolean;
	};
}

export function ProviderDetail({
	template,
	connections,
	viewer,
	people,
	now,
	flow,
	onConnect,
	onBack,
	onUseKey,
	onSetUpClient,
	onOpenConnection,
	onSaveClient,
	onCreateGitHubApp,
	gitHubApp,
	reach,
	rules,
	onTry,
	initial,
}: ProviderDetailProps) {
	const id = useId();
	const route = connectRoute(template);
	// Signing in connects a person's own account: theirs alone until they share it (#461).
	const identity = route === "one_click" && template.authTypes.includes("oauth2");
	const [owner, setOwner] = useState<OwnerChoice>(
		() => initial?.owner ?? defaultOwner(viewer, identity ? "identity" : "credential"),
	);
	const [extra, setExtra] = useState<readonly string[]>(initial?.scopeSets ?? []);
	const [another, setAnother] = useState(initial?.another === true);
	const existing = connectionsFor(connections, template.id);
	const mcp = template.authTypes.includes("mcp_oauth");
	const running = flow.state.phase !== "idle";
	const tier = tierLabel(template, viewer);
	const guide = route === "needs_client" && onSaveClient !== undefined ? template.guide : undefined;
	const guided = guide === undefined ? undefined : { ...template, guide };
	// GitHub's three states, and the app it signs in through: a GitHub App's permissions are fixed, so no scopes apply.
	const github = template.id === "github" ? gitHubPageState(template, connections, gitHubApp) : undefined;
	const app = github === undefined ? undefined : gitHubAppOf(template, gitHubApp);
	const lead = github === "connected" ? leadConnection(connections, viewer) : undefined;
	const scopeSets = app === undefined ? template.scopeSets : [];
	const others = lead === undefined ? existing : existing.filter((connection) => connection.id !== lead.id);

	const connect = () =>
		flow.run(() =>
			onConnect({
				templateId: template.id,
				owner,
				scopeSets: [...scopeSets.filter((set) => set.default === true).map((set) => set.id), ...extra],
			}),
		);

	const through = mcp
		? `Through ${template.name}'s own MCP server. Kantel signs in and holds the token.`
		: app !== undefined
			? `Through ${app.slug}, ${template.client?.ownerLabel ?? viewer.organisation}'s GitHub App.`
			: template.client === undefined
				? undefined
				: template.client.tier === "deployment"
					? `Through ${template.client.ownerLabel}'s ${template.name} app.`
					: `Through ${template.client.ownerLabel}'s own ${template.name} app.`;

	const progress = (
		<ConnectProgress
			flow={flow}
			name={template.name}
			icon={template.icon}
			connectedText={(connection) =>
				`${connection.account === undefined ? "" : `Connected as ${connection.account}. `}${usageText(connection, viewer, people)}`
			}
			// Where a person's connection can't reach the project's sessions, sharing it is the next step (#335).
			connectedAction={(connection) =>
				connection.owner.kind === "user" && viewer.personal === false && onOpenConnection !== undefined ? (
					<Button onClick={() => onOpenConnection(connection)}>Share it with a project</Button>
				) : null
			}
			onRetry={connect}
		/>
	);

	// Who it's for, the permissions to ask for (or the GitHub App's, fixed) and Connect: a sign-in's form.
	const signInForm = (
		<>
			<OwnerField viewer={viewer} value={owner} onChange={setOwner} />
			{scopeSets.length === 0 ? null : (
				<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
					<legend className="mb-2 p-0 text-sm font-medium text-fg">What agents can do</legend>
					{scopeSets.map((set) => (
						<div key={set.id} className="flex min-w-0 items-start justify-between gap-2">
							{set.default === true ? (
								<span className="flex min-w-0 items-start gap-2 text-sm">
									<span className="mt-0.5 text-status-done" aria-hidden="true">
										<CheckIcon size="sm" />
									</span>
									<span className="flex min-w-0 flex-col">
										<span className="text-fg">{set.label}</span>
										<span className="text-xs text-muted">{set.description} Always asked for.</span>
									</span>
								</span>
							) : (
								<CheckboxField
									label={set.label}
									hint={set.description}
									checked={extra.includes(set.id)}
									onChange={(event) =>
										setExtra(event.target.checked ? [...extra, set.id] : extra.filter((x) => x !== set.id))
									}
								/>
							)}
							<Badge tone={set.access === "write" ? "approval" : "neutral"}>
								{set.access === "write" ? "Write" : "Read"}
							</Badge>
						</div>
					))}
				</fieldset>
			)}
			<Button variant="primary" size="lg" icon={<PlugIcon />} onClick={connect} className="self-start">
				{`Connect ${template.name}`}
			</Button>
			<p className="m-0 text-xs text-muted">
				{through === undefined ? "" : `${through} `}You sign in on {template.name}; Kantel keeps the token and agents
				never see it.
			</p>
			{takesKey(template) ? (
				<button
					type="button"
					onClick={() => onUseKey(template)}
					className="kt-focusable m-0 cursor-pointer self-start rounded-xs border-0 bg-transparent p-0 text-xs text-accent-text hover:underline"
				>
					Use an API key instead
				</button>
			) : null}
		</>
	);

	const textLink =
		"kt-focusable m-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-accent-text no-underline hover:underline";

	// The generic Connect panel: a sign-in, a guide to follow first, an OAuth client to set up, or a key.
	const connectPanel = (
		<section
			aria-labelledby={`${id}-connect`}
			className="flex min-w-0 flex-col gap-4 rounded-panel border border-border-strong bg-panel p-5"
		>
			<h3 id={`${id}-connect`} className="m-0 text-md font-strong text-fg">
				{existing.length === 0 ? `Connect ${template.name}` : "Connect another account"}
			</h3>
			{running ? (
				progress
			) : guided !== undefined ? (
				<>
					<p className="m-0 text-sm text-muted">
						{guided.guide.kind === "github_app_manifest"
							? `Create your own ${template.name} app first, below. GitHub makes it for you in a click; once it's installed, Connect signs in through it.`
							: `Create your own ${template.name} app first, by following the steps below. Once it's saved, Connect signs in through it.`}
					</p>
					<Button variant="primary" size="lg" icon={<PlugIcon />} disabled className="self-start">
						{`Connect ${template.name}`}
					</Button>
					{takesKey(template) ? (
						<Button size="md" icon={<KeyRoundIcon size="sm" />} onClick={() => onUseKey(template)}>
							Use an API key instead
						</Button>
					) : null}
				</>
			) : route === "needs_client" ? (
				<>
					<Notice level="warning" announce={false}>
						{template.name} needs an OAuth app registered with it before anyone can sign in.{" "}
						{viewer.admin ? "Add your organisation's app once and everyone can connect." : "Ask an admin to add one."}
					</Notice>
					{viewer.admin && onSetUpClient !== undefined ? (
						<Button
							variant="primary"
							size="md"
							icon={<AppWindowIcon size="sm" />}
							onClick={() => onSetUpClient(template)}
						>
							Set up an OAuth client
						</Button>
					) : null}
					{takesKey(template) ? (
						<Button size="md" icon={<KeyRoundIcon size="sm" />} onClick={() => onUseKey(template)}>
							Use an API key instead
						</Button>
					) : null}
				</>
			) : route === "key" ? (
				<>
					<p className="m-0 text-sm text-muted">
						{template.name} connects with a key. You enter it once; Kantel sends it only to{" "}
						{template.apiHosts.join(" and ")}.
					</p>
					<Button variant="primary" size="lg" icon={<KeyRoundIcon />} onClick={() => onUseKey(template)}>
						Connect with an API key
					</Button>
				</>
			) : (
				signInForm
			)}
		</section>
	);

	const guidePanel =
		guided === undefined || onSaveClient === undefined ? null : (
			<div className="rounded-panel border border-border-strong bg-panel p-5">
				<GuidedSetup
					template={guided}
					viewer={viewer}
					onSaveClient={onSaveClient}
					onCreateGitHubApp={onCreateGitHubApp}
					{...(initial?.guide === undefined ? {} : { initialMode: initial.guide })}
				/>
			</div>
		);

	let main: ReactNode;
	if (github === "connected" && lead !== undefined) {
		// Led by the connection: what it reaches, what agents may do and a session to try it in. Another account is a
		// quiet choice under it.
		main = (
			<>
				{running ? (
					<section
						aria-label={`Connecting ${template.name}`}
						className="rounded-panel border border-border-strong bg-panel p-5"
					>
						{progress}
					</section>
				) : null}
				<GitHubOverview
					connection={lead}
					viewer={viewer}
					now={now}
					app={app?.slug}
					reach={reach}
					rules={rules}
					onEditRules={onOpenConnection}
					onTry={onTry}
				/>
				{running || route !== "one_click" ? null : another ? (
					<section
						aria-labelledby={`${id}-connect`}
						className="flex min-w-0 flex-col gap-4 rounded-panel border border-border-strong bg-panel p-5"
					>
						<div className="flex min-w-0 items-center justify-between gap-3">
							<h3 id={`${id}-connect`} className="m-0 text-md font-strong text-fg">
								Connect another {template.name} account
							</h3>
							<Button variant="ghost" onClick={() => setAnother(false)}>
								Cancel
							</Button>
						</div>
						{signInForm}
					</section>
				) : (
					<button type="button" onClick={() => setAnother(true)} className={`${textLink} self-start text-sm`}>
						Connect another {template.name} account
					</button>
				)}
			</>
		);
	} else if (github === "app_made" && route === "one_click") {
		// The app is made: install it on repositories, then connect through it.
		main = (
			<section
				aria-labelledby={`${id}-connect`}
				className="flex min-w-0 flex-col gap-5 rounded-panel border border-border-strong bg-panel p-5"
			>
				<h3 id={`${id}-connect`} className="m-0 text-md font-strong text-fg">
					Connect {template.name}
				</h3>
				{running ? progress : <GitHubSetupSteps app={app?.slug} installUrl={app?.installUrl} connect={signInForm} />}
			</section>
		);
	} else if (github === "not_set_up" && guidePanel !== null) {
		// Nothing to sign in through yet: the one thing to do is set up the organisation's GitHub App.
		main = guidePanel;
	} else {
		main = (
			<>
				{/* Connect straight under the header: it's what the page is for. */}
				{connectPanel}
				{guidePanel}
			</>
		);
	}

	return (
		<div className="flex min-w-0 max-w-content flex-col gap-6">
			<nav aria-label="Breadcrumb">
				<ol className="m-0 flex list-none items-center gap-1.5 p-0 text-xs text-muted">
					<li>
						<button
							type="button"
							onClick={onBack}
							className="kt-focusable m-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-muted hover:text-fg hover:underline"
						>
							Browse
						</button>
					</li>
					<li aria-hidden="true" className="flex text-faint">
						<ChevronRightIcon size="sm" />
					</li>
					<li aria-current="page" className="text-fg">
						{template.name}
					</li>
				</ol>
			</nav>

			{lead !== undefined ? (
				<header className="flex min-w-0 items-start gap-4">
					<ProviderLogo name={template.name} icon={template.icon} size="lg" />
					<div className="flex min-w-0 flex-col gap-1.5">
						<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
							<h2 className="m-0 text-display font-strong leading-tight text-fg">{template.name}</h2>
							{lead.health === "healthy" ? (
								<Badge tone="done">{lead.account === undefined ? "Connected" : `Connected as ${lead.account}`}</Badge>
							) : (
								<Badge tone="error">{HEALTH_LABELS[lead.health]}</Badge>
							)}
						</div>
						<p className="m-0 text-sm leading-prose text-muted">
							{usageText(lead, viewer, people)}
							{onOpenConnection === undefined ? null : (
								<>
									{" "}
									<button
										type="button"
										aria-label="Change who can use it"
										onClick={() => onOpenConnection(lead)}
										className={textLink}
									>
										Change
									</button>
								</>
							)}
						</p>
					</div>
				</header>
			) : (
				<header className="flex min-w-0 items-start gap-4">
					<ProviderLogo name={template.name} icon={template.icon} size="lg" />
					<div className="flex min-w-0 flex-col gap-1.5">
						<h2 className="m-0 text-display font-strong leading-tight text-fg">{template.name}</h2>
						{/* The whole description here, once: the summary is its first sentence, for the card. */}
						<p className="m-0 text-sm leading-prose text-muted">{template.description ?? template.summary}</p>
						<div className="flex flex-wrap items-center gap-2 text-xs text-muted">
							<Badge>{template.category}</Badge>
							<SetupTierLabel template={template} viewer={viewer} variant="pill" label={tier} />
							{mcp ? <Badge tone="accent">MCP server</Badge> : null}
							{template.publisher === undefined ? null : <span>By {template.publisher}</span>}
							<a
								href={template.docsUrl}
								target="_blank"
								rel="noreferrer"
								className="kt-focusable inline-flex items-center gap-1 rounded-xs text-accent-text no-underline hover:underline"
							>
								Docs
								<ExternalLinkIcon size="sm" />
							</a>
						</div>
					</div>
				</header>
			)}

			{main}

			{others.length === 0 ? null : (
				<section aria-labelledby={`${id}-yours`} className="flex min-w-0 flex-col gap-3">
					<h3 id={`${id}-yours`} className="m-0 text-sm font-strong text-fg">
						{lead === undefined ? "Connected already" : `Other ${template.name} connections`}
					</h3>
					<ul className="m-0 flex list-none flex-col rounded-panel border border-border bg-panel p-4">
						{others.map((connection) => (
							<ConnectionRow
								key={connection.id}
								connection={connection}
								viewer={viewer}
								people={people}
								now={now}
								onOpen={onOpenConnection}
							/>
						))}
					</ul>
				</section>
			)}

			{github !== undefined && (app !== undefined || github === "not_set_up") ? (
				<GitHubAppPermissions app={app?.slug} />
			) : scopeSets.length === 0 ? null : (
				<section aria-labelledby={`${id}-scopes`} className="flex min-w-0 flex-col gap-3">
					<h3 id={`${id}-scopes`} className="m-0 text-sm font-strong text-fg">
						Permissions it can ask for
					</h3>
					<ul className="m-0 flex list-none flex-col gap-2 p-0">
						{scopeSets.map((set) => (
							<li key={set.id} className="flex min-w-0 flex-col gap-1 text-sm">
								<span className="text-fg">{set.label}</span>
								<span className="flex flex-wrap gap-1.5">
									{set.scopes.map((scope) => (
										<code key={scope} className="kt-mono rounded-xs bg-sunken px-1.5 text-muted wrap-anywhere">
											{scope}
										</code>
									))}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			<section aria-labelledby={`${id}-hosts`} className="flex min-w-0 flex-col gap-2">
				<h3 id={`${id}-hosts`} className="m-0 text-sm font-strong text-fg">
					Where requests go
				</h3>
				<p className="m-0 text-xs text-muted">
					Kantel adds the credential only to requests for these hosts, over https. Each request is checked against the
					connection's rules and written to the audit log.
				</p>
				<span className="flex flex-wrap gap-1.5">
					{(template.mcpUrl === undefined ? template.apiHosts : [template.mcpUrl]).map((host) => (
						<code key={host} className="kt-mono kt-selectable rounded-xs bg-sunken px-1.5 wrap-anywhere">
							{host}
						</code>
					))}
				</span>
			</section>
		</div>
	);
}
