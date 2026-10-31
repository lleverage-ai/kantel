// A service's own page in the catalogue (#325, #327): what it is, what agents can do with it, where its requests go,
// the viewer's connections to it already, and a prominent Connect with its two choices: who the connection is for, and
// which permissions to ask for beyond the defaults. Connect runs the OAuth round trip in place (connect-flow.tsx).

import { useId, useState } from "react";
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
	type ConnectionsViewer,
	type ConnectStart,
	connectionsFor,
	connectRoute,
	defaultOwner,
	type GitHubAppInput,
	type OAuthClient,
	type OAuthClientInput,
	type OwnerChoice,
	type ProviderTemplate,
	takesKey,
	tierLabel,
	usageText,
} from "./connections-model.ts";
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
	/** Has GitHub create a GitHub App from Harbour's manifest. */
	readonly onCreateGitHubApp?: ((input: GitHubAppInput) => Promise<unknown>) | undefined;
	/** Choices to start with, for stories. */
	readonly initial?: {
		readonly owner?: OwnerChoice;
		readonly scopeSets?: readonly string[];
		readonly guide?: "choose" | "manual";
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
	initial,
}: ProviderDetailProps) {
	const id = useId();
	const [owner, setOwner] = useState<OwnerChoice>(() => initial?.owner ?? defaultOwner(viewer));
	const [extra, setExtra] = useState<readonly string[]>(initial?.scopeSets ?? []);
	const route = connectRoute(template);
	const existing = connectionsFor(connections, template.id);
	const mcp = template.authTypes.includes("mcp_oauth");
	const running = flow.state.phase !== "idle";
	const tier = tierLabel(template, viewer);
	const guide = route === "needs_client" && onSaveClient !== undefined ? template.guide : undefined;
	const guided = guide === undefined ? undefined : { ...template, guide };

	const connect = () =>
		flow.run(() =>
			onConnect({
				templateId: template.id,
				owner,
				scopeSets: [...template.scopeSets.filter((set) => set.default === true).map((set) => set.id), ...extra],
			}),
		);

	const through = mcp
		? `Through ${template.name}'s own MCP server. Harbour signs in and holds the token.`
		: template.client === undefined
			? undefined
			: template.client.tier === "deployment"
				? `Through ${template.client.ownerLabel}'s ${template.name} app.`
				: `Through ${template.client.ownerLabel}'s own ${template.name} app.`;

	return (
		<div className="flex min-w-0 flex-col gap-6">
			<nav aria-label="Breadcrumb">
				<ol className="m-0 flex list-none items-center gap-1.5 p-0 text-xs text-muted">
					<li>
						<button
							type="button"
							onClick={onBack}
							className="hb-focusable m-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-muted hover:text-fg hover:underline"
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

			<header className="flex min-w-0 items-start gap-4">
				<ProviderLogo name={template.name} icon={template.icon} size="lg" />
				<div className="flex min-w-0 flex-col gap-1.5">
					<h2 className="m-0 text-display font-strong leading-tight text-fg">{template.name}</h2>
					<p className="m-0 text-sm text-muted">{template.summary}</p>
					<div className="flex flex-wrap items-center gap-2 text-xs text-muted">
						<Badge>{template.category}</Badge>
						<SetupTierLabel template={template} viewer={viewer} variant="pill" label={tier} />
						{mcp ? <Badge tone="accent">MCP server</Badge> : null}
						{template.publisher === undefined ? null : <span>By {template.publisher}</span>}
						<a
							href={template.docsUrl}
							target="_blank"
							rel="noreferrer"
							className="hb-focusable inline-flex items-center gap-1 rounded-xs text-accent-text no-underline hover:underline"
						>
							Docs
							<ExternalLinkIcon size="sm" />
						</a>
					</div>
				</div>
			</header>

			<div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_var(--hb-connect-width)]">
				{/* Connect first on a narrow screen: it's what the page is for. */}
				<section
					aria-labelledby={`${id}-connect`}
					className="flex min-w-0 flex-col gap-4 rounded-panel border border-border-strong bg-panel p-5 lg:sticky lg:top-0 lg:order-2"
				>
					<h3 id={`${id}-connect`} className="m-0 text-md font-strong text-fg">
						{existing.length === 0 ? `Connect ${template.name}` : "Connect another account"}
					</h3>
					{running ? (
						<ConnectProgress
							flow={flow}
							name={template.name}
							icon={template.icon}
							connectedText={(connection) =>
								`${connection.account === undefined ? "" : `Connected as ${connection.account}. `}${usageText(connection, viewer, people)}`
							}
							onRetry={connect}
						/>
					) : guided !== undefined ? (
						<>
							<p className="m-0 text-sm text-muted">
								{guided.guide.kind === "github_app_manifest"
									? `Create your own ${template.name} app first. GitHub makes it for you in a click; once it's installed, Connect signs in through it.`
									: `Create your own ${template.name} app first, by following the steps. Once it's saved, Connect signs in through it.`}
							</p>
							<Button variant="primary" size="lg" icon={<PlugIcon />} disabled className="w-full justify-center">
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
								{viewer.admin
									? "Add your organisation's app once and everyone can connect."
									: "Ask an admin to add one."}
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
								{template.name} connects with a key. You enter it once; Harbour sends it only to{" "}
								{template.apiHosts.join(" and ")}.
							</p>
							<Button variant="primary" size="lg" icon={<KeyRoundIcon />} onClick={() => onUseKey(template)}>
								Connect with an API key
							</Button>
						</>
					) : (
						<>
							<OwnerField viewer={viewer} value={owner} onChange={setOwner} />
							{template.scopeSets.length === 0 ? null : (
								<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
									<legend className="mb-2 p-0 text-sm font-medium text-fg">What agents can do</legend>
									{template.scopeSets.map((set) => (
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
							<Button
								variant="primary"
								size="lg"
								icon={<PlugIcon />}
								onClick={connect}
								className="w-full justify-center"
							>
								{`Connect ${template.name}`}
							</Button>
							<p className="m-0 text-xs text-muted">
								{through === undefined ? "" : `${through} `}You sign in on {template.name}; Harbour keeps the token and
								agents never see it.
							</p>
							{takesKey(template) ? (
								<button
									type="button"
									onClick={() => onUseKey(template)}
									className="hb-focusable m-0 cursor-pointer self-start rounded-xs border-0 bg-transparent p-0 text-xs text-accent-text hover:underline"
								>
									Use an API key instead
								</button>
							) : null}
						</>
					)}
				</section>

				<div className="flex min-w-0 flex-col gap-6 lg:order-1">
					{guided === undefined || onSaveClient === undefined ? null : (
						<div className="rounded-panel border border-border-strong bg-panel p-5">
							<GuidedSetup
								template={guided}
								viewer={viewer}
								onSaveClient={onSaveClient}
								onCreateGitHubApp={onCreateGitHubApp}
								{...(initial?.guide === undefined ? {} : { initialMode: initial.guide })}
							/>
						</div>
					)}
					{template.description === undefined ? null : (
						<p className="m-0 max-w-content text-sm leading-prose text-fg">{template.description}</p>
					)}

					{existing.length === 0 ? null : (
						<section aria-labelledby={`${id}-yours`} className="flex min-w-0 flex-col gap-3">
							<h3 id={`${id}-yours`} className="m-0 text-sm font-strong text-fg">
								Connected already
							</h3>
							<ul className="m-0 flex list-none flex-col rounded-panel border border-border bg-panel p-4">
								{existing.map((connection) => (
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

					{template.scopeSets.length === 0 ? null : (
						<section aria-labelledby={`${id}-scopes`} className="flex min-w-0 flex-col gap-3">
							<h3 id={`${id}-scopes`} className="m-0 text-sm font-strong text-fg">
								Permissions it can ask for
							</h3>
							<ul className="m-0 flex list-none flex-col gap-2 p-0">
								{template.scopeSets.map((set) => (
									<li key={set.id} className="flex min-w-0 flex-col gap-1 text-sm">
										<span className="text-fg">{set.label}</span>
										<span className="flex flex-wrap gap-1.5">
											{set.scopes.map((scope) => (
												<code key={scope} className="hb-mono rounded-xs bg-sunken px-1.5 text-muted wrap-anywhere">
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
							Harbour adds the credential only to requests for these hosts, over https. Each request is checked against
							the connection's rules and written to the audit log.
						</p>
						<span className="flex flex-wrap gap-1.5">
							{(template.mcpUrl === undefined ? template.apiHosts : [template.mcpUrl]).map((host) => (
								<code key={host} className="hb-mono hb-selectable rounded-xs bg-sunken px-1.5 wrap-anywhere">
									{host}
								</code>
							))}
						</span>
					</section>
				</div>
			</div>
		</div>
	);
}
