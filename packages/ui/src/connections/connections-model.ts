// The Connections page's model (issue #322): the catalogue of provider templates, the connections made from them, the
// OAuth clients they connect through, and the calls the page makes. The shapes follow the tickets (#325 catalogue,
// #326 clients, #327 connect flow, #330 key connections, #335 ownership, #338 remote MCP servers) and stand in for the
// public API's contract until it lands; the console binds `ConnectionsSource` to the real routes, stories to fixtures.
//
// Nothing here ever holds a secret value. A key or a client secret goes out once, in the call that stores it, and
// comes back only as "set" with its last four characters.

import type {
	ConnectionCeiling,
	ConnectionDecision,
	ConnectionRule,
	ConnectionRuleInput,
	ConnectionRules,
	DryRunConnectionRequest,
	OwnerRef,
	UpdateConnectionRuleInput,
	UpdateConnectionRulesInput,
} from "@kantel/contracts";
import { duration } from "../primitives/format.ts";

/** How a template's credential is obtained and sent (#325). */
export type AuthType =
	| "oauth2"
	| "oauth2_client_credentials"
	| "bearer"
	| "header"
	| "query"
	| "basic"
	| "header_template"
	| "mcp_oauth";

/** The auth types a person enters a key for. */
export const KEY_AUTH_TYPES: readonly AuthType[] = ["bearer", "header", "query", "basic", "header_template"];

export const CATEGORIES = [
	"Developer tools",
	"Productivity",
	"Communication",
	"Sales and support",
	"Finance",
	"AI models",
	"Data",
] as const;
export type Category = (typeof CATEGORIES)[number] | (string & {});

/** A named group of scopes a template may ask for. Only `default` sets are asked for unless a person picks more. */
export interface ScopeSet {
	readonly id: string;
	readonly label: string;
	/** What it lets an agent do, in a line. */
	readonly description: string;
	readonly access: "read" | "write";
	readonly scopes: readonly string[];
	readonly default?: boolean;
}

/** Patterns that recognise a provider's keys, for suggesting the template when a key is pasted (#330). */
export interface KeyShape {
	/** What the key is, as the suggestion says it: "a GitHub fine-grained token". */
	readonly label: string;
	readonly prefix?: string;
	/** A whole-key pattern, as a regular expression source. */
	readonly pattern?: string;
}

/** The client a new OAuth connection to a template would go through, as the catalogue resolves it (#326). */
export interface ResolvedClient {
	readonly tier: ClientTier;
	/** Whose client it is, in words: "Lleverage", "Acme", "Tom Davies". */
	readonly ownerLabel: string;
	/** The client's own label: "Acme GitHub app". */
	readonly label?: string;
	/** A public client: no secret, so it signs in with a code or with PKCE alone (tier 2). */
	readonly public?: boolean;
}

/**
 * How a template connects, by the setup tiers in #325. No build ships a confidential client secret, so a provider
 * that offers no automatic registration needs a public client the deployment supplies, an app someone registers, or a
 * client a host app provides:
 * - `none`: nothing to set up: an open server, or one that registers Kantel itself (CIMD or DCR). Tier 1.
 * - `public_client`: a client ID the deployment supplies with no secret, signing in with a code (GitHub's device flow)
 *   or with PKCE alone. Tier 2.
 * - `own_app`: an app the person, their project or their organisation registers, guided where Kantel has a guide.
 *   Tier 3.
 * - `host_client`: a client the host app or the organisation supplies. Tier 4.
 * - `key`: no OAuth: a key.
 */
export type SetupTier = "none" | "public_client" | "own_app" | "host_client" | "key";

/** One step of registering an app at a provider, with the values to copy exactly. */
export interface SetupStep {
	readonly title: string;
	readonly detail: string;
	readonly link?: { readonly label: string; readonly url: string };
	readonly values?: readonly { readonly label: string; readonly value: string }[];
}

/**
 * How to register an app for a template (tier 3), from the catalogue: steps with this deployment's redirect URI and the
 * template's scopes in them. `github_app_manifest`: Kantel can also have GitHub create the app in one click.
 */
export interface SetupGuide {
	readonly kind: "github_app_manifest" | "steps";
	/** Where the app is registered: "Google Cloud", "GitHub". */
	readonly provider: string;
	readonly redirectUri: string;
	readonly steps: readonly SetupStep[];
	readonly notes?: readonly { readonly level: "info" | "warning"; readonly text: string }[];
}

/** A provider template from the catalogue (#325), as the catalogue route lists it: no client secrets. */
export interface ProviderTemplate {
	readonly id: string;
	readonly name: string;
	/** One line on what the service is, for its card. */
	readonly summary: string;
	/** A few sentences for its own page. */
	readonly description?: string;
	readonly category: Category;
	/** The logo: an https or data: URL. Without one the card shows the name's first letter. */
	readonly icon?: string;
	readonly docsUrl: string;
	/** Who makes the service, if not the name: "Google". */
	readonly publisher?: string;
	readonly authTypes: readonly AuthType[];
	/** Host patterns the credential may be sent to. Injection never goes beyond these. */
	readonly apiHosts: readonly string[];
	readonly scopeSets: readonly ScopeSet[];
	readonly keyShapes?: readonly KeyShape[];
	/** Where to make a key, for a key template: "Settings, Developer settings, Personal access tokens". */
	readonly keyHelp?: string;
	/** The client a new OAuth connection would use. Absent on an OAuth template: no client is set up yet. */
	readonly client?: ResolvedClient;
	/**
	 * Whether a person can connect it now, when the API says so rather than naming the client (`CatalogueEntry.setup`):
	 * `needs_client` puts it behind an OAuth client whatever `client` says.
	 */
	readonly setup?: "ready" | "needs_client";
	/** Short provider-specific notes for whoever registers an OAuth app (#340). */
	readonly clientGuidance?: string;
	/** The setup tier it connects through for this viewer (#325). Absent: worked out from `setup` and `client`. */
	readonly tier?: SetupTier;
	/** How a ready OAuth connect signs in: in a browser window, or by typing a code at the provider. */
	readonly signIn?: "browser" | "device";
	/** How to register an app for it, when one is needed or wanted. */
	readonly guide?: SetupGuide;
	/** A remote MCP server's URL, for a catalogued MCP server (#338). */
	readonly mcpUrl?: string;
	/** A remote MCP server that answers without signing in (DeepWiki, Cloudflare's docs): no OAuth client to register. */
	readonly open?: boolean;
	readonly version?: number;
}

/**
 * A connection's health (#328, #330). `refresh_failing`: Kantel couldn't refresh its token for now and is trying again;
 * no one needs to act yet. `needs_reconnect`: the provider refused it, so someone must connect again. `disabled`: an
 * admin stopped every use of it.
 */
export type ConnectionHealth =
	| "healthy"
	| "refresh_failing"
	| "needs_reconnect"
	| "error"
	| "failing_test"
	| "disabled";

/** The owners a connection can have (#335): never the platform. */
export type ConnectionOwner = Extract<OwnerRef, { kind: "organisation" | "project" | "user" }>;

/** How a connection was made. */
export type ConnectionKind = "oauth" | "key" | "mcp";

/** A key's or secret's presence, never its value. */
export interface SecretHint {
	readonly set: true;
	readonly last4: string;
}

/** One authorisation against a provider (#327, #330, #338). An owner may hold several for one template. */
export interface Connection {
	readonly id: string;
	readonly templateId: string;
	/** The template's name, or the name given to a custom service or MCP server. */
	readonly name: string;
	readonly icon?: string;
	readonly kind: ConnectionKind;
	/** Who it connects as, from the template's test request: "tvdavies", "ops@acme.com", "Acme workspace". */
	readonly account?: string;
	/** A person's own label, to tell two connections to one provider apart: "Work", "Personal". */
	readonly label?: string;
	readonly owner: ConnectionOwner;
	/**
	 * The projects a person's own connection is shared with (#335): sessions there may use it, whoever they act for and
	 * whoever can see them, under its rules. The person stays the owner.
	 */
	readonly shares?: readonly ConnectionShareView[];
	/** For an organisation's connection: only sessions in these projects (`ConnectionUsage.projects`). */
	readonly onlyProjects?: readonly string[];
	/** Where else it narrows (`ConnectionUsage`): who can see the session, unattended runs, agents and people. */
	readonly usage?: ConnectionUsageView;
	readonly health: ConnectionHealth;
	/** The last refresh or test error, in plain words. */
	readonly lastError?: string;
	/** For `refresh_failing`: when Kantel tries to refresh again. */
	readonly retryAt?: number;
	readonly lastUsedAt?: number;
	readonly createdAt: number;
	/** Who made it, by name. */
	readonly createdBy?: string;
	readonly scopes?: readonly string[];
	readonly hosts: readonly string[];
	/** The client an OAuth connection is pinned to. */
	readonly client?: { readonly id: string; readonly label: string };
	readonly key?: SecretHint;
	/** A remote MCP server's URL and how many tools it lists. */
	readonly mcp?: { readonly url: string; readonly tools?: number };
	/** One line on its access rules, until the rules editor (#341): "Reads allowed, writes ask". */
	readonly rulesSummary?: string;
	/** The placeholders an agent writes for the credential, which the egress proxy swaps (#331). */
	readonly placeholders?: readonly string[];
}

/** One project a person's connection is shared with (#335), and who shared it when. */
export interface ConnectionShareView {
	readonly projectId: string;
	/** Who shared it, by name. */
	readonly sharedBy?: string;
	readonly sharedAt: number;
}

/** Who can see a session (#335): only the person it acts for, or more people than that. */
export type Visibility = "private" | "shared";

/** A connection's usage (`ConnectionUsage`), as the page shows it. */
export interface ConnectionUsageView {
	/** `private`: only in sessions nobody but the person they act for can see. `shared`: any session the rest allows. */
	readonly visibility: Visibility;
	/** Whether scheduled, triggered and webhook runs (no person behind them) may use it. */
	readonly unattended: boolean;
	/** Only sessions of these agent profiles. */
	readonly agents?: readonly string[];
	/** Only sessions acting for these people. */
	readonly actingUsers?: readonly string[];
}

/** How one use of a connection ended (#335, #333): sent, refused, or held for a person's approval. */
export type ConnectionUseOutcome = "allowed" | "denied" | "held";

/** Where a held use's approval stands (#481): still waiting on a person, or how it ended. */
export type HeldApproval = "waiting" | "approved" | "denied" | "expired" | "withdrawn";

/** One use of a connection: which session and step, for whom, who could see it, and why it was refused. */
export interface ConnectionUseView {
	readonly id: string;
	readonly at: number;
	readonly sessionId: string;
	/** The session's title, when the host knows it. */
	readonly sessionTitle?: string;
	/** The tool call (step) that used it. */
	readonly toolCallId?: string;
	/** What it asked for: "GET api.github.com/repos/acme/web" or "echo" for an MCP tool. */
	readonly what: string;
	/** The person the session acted for, by name; absent for an unattended run. */
	readonly actingFor?: string;
	/** Who could see the session then. */
	readonly audience: Visibility;
	readonly outcome: ConnectionUseOutcome;
	/**
	 * For a held use: where its approval now stands (#481). `waiting` until a person decides; then how it ended. An
	 * approved request that went out is a use of its own.
	 */
	readonly approval?: HeldApproval;
	/** Why it was refused or held, in the API's words. */
	readonly reason?: string;
	/** `sandbox`: sent from the session's shell with the connection's placeholder, through the egress gate (#331). */
	readonly via?: "sandbox";
	/** The egress gate's refusal code (`host_not_bound`, `raw_secret`, ...), as the sandbox got it in its 403. */
	readonly refusal?: string;
}

/**
 * A use in a private session the viewer can't open (#335): when, how it ended and who it acted for. Nothing from inside
 * the session: no session, step, request or reason.
 */
export interface PrivateUseView {
	readonly id: string;
	readonly at: number;
	readonly redacted: true;
	readonly outcome: ConnectionUseOutcome;
	/** The person the session acted for, by name. */
	readonly actingFor?: string;
}

/** A row of Recent uses: the whole use, or one in a private session the viewer can't open. */
export type RecentUseView = ConnectionUseView | PrivateUseView;

/** Whether a row of Recent uses is a private session's, redacted for this viewer. */
export const isPrivateUse = (use: RecentUseView): use is PrivateUseView => "redacted" in use && use.redacted;

/** Sharing a person's connection with projects (#335): one route each. The answer is the connection as it now is. */
export interface ConnectionSharingSource {
	share(connectionId: string, projectId: string): Promise<Connection>;
	unshare(connectionId: string, projectId: string): Promise<Connection>;
}

/** Where an OAuth client is registered (#326), narrowest last. A narrower client wins for a new connection. */
export type ClientTier = "deployment" | "organisation" | "project" | "user";

/** An OAuth app registration (#326). */
export interface OAuthClient {
	readonly id: string;
	readonly templateId: string;
	readonly tier: ClientTier;
	/** Whose it is, in words: the host's name for a deployment client, else the organisation, project or person. */
	readonly ownerLabel: string;
	readonly label?: string;
	readonly clientId: string;
	/** Absent for a public client, which signs in with PKCE alone. */
	readonly secret?: SecretHint;
	readonly scopes: readonly string[];
	readonly redirectUri: string;
	readonly redirectDomain?: string;
	readonly disabled?: boolean;
	/** Connections pinned to it. A client with any can't be deleted. */
	readonly pinnedConnections: number;
	readonly createdAt: number;
	/** A GitHub App GitHub created from Kantel's manifest: where to install it and its settings page. */
	readonly githubApp?: { readonly slug: string; readonly installUrl: string; readonly appUrl: string };
}

/** What a connection is for, as a person picks it when connecting. */
export type OwnerChoice =
	| { readonly kind: "user" }
	| { readonly kind: "project"; readonly projectId: string }
	| { readonly kind: "organisation" };

export interface ConnectInput {
	readonly templateId: string;
	/** The scope sets picked; the template's defaults when absent. */
	readonly scopeSets?: readonly string[];
	readonly owner: OwnerChoice;
	/** For more scopes on an existing connection: it keeps its ID (#327). */
	readonly connectionId?: string;
}

/** A started OAuth round trip: the URL to open, on Kantel's domain, and how to ask after it. */
export interface ConnectStart {
	readonly attemptId: string;
	/** The page to open: Kantel's connect URL, or for a sign-in with a code, the provider's page to type it on. */
	readonly url: string;
	readonly expiresAt: number;
	/** A sign-in with a code (OAuth device flow): the code the person types at `url`. */
	readonly device?: { readonly userCode: string };
	/** Set when it needed no sign-in (a server that answers without one): the connection, made already. */
	readonly connected?: Connection;
}

/** Why a connect attempt failed, as the connect URL's final page or the attempt reports it (#326, #327, #338). */
export type ConnectFailure =
	| "denied"
	| "expired"
	| "user_mismatch"
	| "no_client"
	| "discovery_failed"
	| "test_failed"
	| "provider_error";

export type ConnectAttemptState =
	| { readonly status: "pending" }
	| { readonly status: "connected"; readonly connection: Connection }
	| { readonly status: "failed"; readonly reason: ConnectFailure; readonly message?: string };

/** How a key goes out on a custom service (#330). */
export type Injection =
	| { readonly kind: "bearer" }
	| { readonly kind: "header"; readonly name: string; readonly prefix?: string }
	| { readonly kind: "query"; readonly name: string }
	| { readonly kind: "basic" };

export interface KeyConnectionInput {
	/** A catalogue template, or none for a custom service. */
	readonly templateId?: string;
	/** A custom service's name. */
	readonly name?: string;
	/** A custom service's hosts. A template's are fixed. */
	readonly hosts?: readonly string[];
	readonly injection?: Injection;
	readonly owner: OwnerChoice;
	readonly label?: string;
	/** For basic auth: the user name that goes with the key. */
	readonly username?: string;
	/** For a remote MCP server that takes a key: its endpoint, on one of `hosts`. */
	readonly mcpUrl?: string;
	/** The key itself: sent once, here, and never returned. */
	readonly key: string;
}

/** A stored key connection and its test's result (#330). */
export interface KeyConnectionResult {
	readonly connection: Connection;
	readonly test?: { readonly ok: boolean; readonly account?: string; readonly message?: string };
}

export interface McpServerInput {
	readonly url: string;
	readonly name?: string;
	readonly owner: OwnerChoice;
	/** A pre-registered client of the person's own, tried first (#338). The secret goes once, here. */
	readonly client?: { readonly clientId: string; readonly clientSecret?: string };
}

/** Adding an MCP server either starts an OAuth round trip or, for a server that takes a key, asks for it. */
export type McpServerStart =
	| ({ readonly auth: "oauth"; readonly serverName: string } & ConnectStart)
	| { readonly auth: "key"; readonly serverName: string; readonly header: string };

/** What Disconnect did upstream (#329). */
export interface DisconnectResult {
	/**
	 * `true`: the provider revoked the access. `false`: Kantel asked and the provider refused or didn't answer.
	 * `unsupported`: the provider gives Kantel no way to revoke it (or it's a key). `none`: there was nothing to revoke.
	 * `unknown`: the API didn't say.
	 */
	readonly revoked: boolean | "unsupported" | "none" | "unknown";
	/** Where to revoke by hand when Kantel couldn't. */
	readonly revokeUrl?: string;
	/** Why the provider didn't revoke it, in plain words. */
	readonly reason?: string;
}

export interface OAuthClientInput {
	readonly templateId: string;
	readonly tier: Exclude<ClientTier, "deployment">;
	/** The project, for a project's client. */
	readonly projectId?: string;
	readonly label?: string;
	readonly clientId: string;
	/** Sent once, here, and never returned. */
	readonly clientSecret: string;
	readonly scopes?: readonly string[];
}

/** Having GitHub create a GitHub App for Kantel from a manifest (tier 3): whose it is, and which GitHub account. */
export interface GitHubAppInput {
	readonly tier: Exclude<ClientTier, "deployment">;
	readonly projectId?: string;
	/** A GitHub organisation to create it in; the person's own account when absent. */
	readonly githubOrganisation?: string;
}

/** A manifest flow started: Kantel's page to open, which sends the manifest on to GitHub. */
export interface GitHubAppStart {
	readonly id: string;
	readonly url: string;
	readonly expiresAt: number;
}

/** Where a manifest flow has got to. `created`: GitHub made the app and Kantel holds its client. */
export type GitHubAppState =
	| { readonly status: "pending" }
	| { readonly status: "created"; readonly client: OAuthClient; readonly installUrl: string; readonly appUrl: string }
	| { readonly status: "failed"; readonly message: string };

/** The calls the page makes, bound to the viewer by the host. */
export interface ConnectionsSource {
	catalogue(): Promise<readonly ProviderTemplate[]>;
	/**
	 * One template in full, for its page, when the catalogue lists only summaries (no scope sets or hosts). Without it,
	 * the catalogue's entries are taken as complete.
	 */
	template?(templateId: string): Promise<ProviderTemplate>;
	connections(): Promise<readonly Connection[]>;
	/** Starts an OAuth round trip (#327). */
	connect(input: ConnectInput): Promise<ConnectStart>;
	/** Where a round trip has got to. The page asks until it settles or the person stops waiting. */
	attempt(attemptId: string): Promise<ConnectAttemptState>;
	/** Gives up on a round trip, so its URL stops working. */
	cancelAttempt?(attemptId: string): Promise<void>;
	connectKey(input: KeyConnectionInput): Promise<KeyConnectionResult>;
	addMcpServer(input: McpServerInput): Promise<McpServerStart>;
	disconnect(connectionId: string): Promise<DisconnectResult>;
	reconnect(connectionId: string): Promise<ConnectStart>;
	clients(): Promise<readonly OAuthClient[]>;
	createClient(input: OAuthClientInput): Promise<OAuthClient>;
	setClientDisabled(clientId: string, disabled: boolean): Promise<OAuthClient>;
	deleteClient(clientId: string): Promise<void>;
	/** Starts GitHub's app manifest flow (tier 3). Without it, the page offers only the manual steps. */
	createGitHubApp?(input: GitHubAppInput): Promise<GitHubAppStart>;
	gitHubApp?(id: string): Promise<GitHubAppState>;
	/**
	 * A connection's access rules (#341). Without them, a connection's page shows `rulesSummary` and no editor. Each
	 * is one route of `/v1/connections/{id}/rules`.
	 */
	rules?: ConnectionRulesSource;
	/** Sharing a person's connection with projects (#335). Without it, the page shows the shares and no controls. */
	sharing?: ConnectionSharingSource;
	/** A connection's latest uses, newest first (#335): which session and step used it, and why one was refused. */
	uses?(connectionId: string): Promise<readonly RecentUseView[]>;
}

/** The rules editor's calls: the public API's, one each. */
export interface ConnectionRulesSource {
	get(connectionId: string): Promise<ConnectionRules>;
	update(connectionId: string, input: UpdateConnectionRulesInput): Promise<ConnectionRules>;
	create(connectionId: string, input: ConnectionRuleInput): Promise<ConnectionRule>;
	updateRule(connectionId: string, ruleId: string, input: UpdateConnectionRuleInput): Promise<ConnectionRule>;
	remove(connectionId: string, ruleId: string): Promise<void>;
	/** "Try a request": the decision a request would get, from the function the real send uses. */
	dryRun(connectionId: string, request: DryRunConnectionRequest): Promise<ConnectionDecision>;
	/** The organisation's ceiling, which bounds every allow and ask rule. */
	ceiling(): Promise<ConnectionCeiling>;
}

/** Who is looking, and where they may put a connection. */
export interface ConnectionsViewer {
	readonly userId: string;
	readonly name: string;
	readonly organisation: string;
	/** Projects the viewer may connect for. */
	readonly projects: readonly { readonly id: string; readonly name: string }[];
	/** An organisation admin: may connect for the organisation and manage its OAuth clients. */
	readonly admin: boolean;
	/** The host's name, for its own clients: "Lleverage". */
	readonly host?: string;
	/** The project the viewer has open: a new connection is for it unless they pick another owner. */
	readonly projectId?: string;
	/**
	 * Whether the deployment keeps every session acting for a person theirs alone, so a "Just me" connection works in
	 * all their sessions (`GET /v1/connections/settings`). `false`: a session is seen by its project, and a personal
	 * connection is refused in it. Absent: not known, so nothing is said.
	 */
	readonly personal?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Words

export const HEALTH_LABELS: Record<ConnectionHealth, string> = {
	healthy: "Connected",
	refresh_failing: "Refresh failing",
	needs_reconnect: "Needs reconnecting",
	error: "Error",
	failing_test: "Test failing",
	disabled: "Disabled",
};

export const TIER_LABELS: Record<ClientTier, string> = {
	deployment: "Host",
	organisation: "Organisation",
	project: "Project",
	user: "Personal",
};

const projectName = (viewer: ConnectionsViewer, projectId: string): string =>
	viewer.projects.find((project) => project.id === projectId)?.name ?? projectId;

/** A person's name from the viewer, or the ID. Only the viewer's own name is known to the page. */
const personName = (viewer: ConnectionsViewer, userId: string, people?: (id: string) => string | undefined) =>
	userId === viewer.userId ? viewer.name : (people?.(userId) ?? userId);

/** Who owns it, short: "You", "Support project", "Acme". */
export function ownerText(
	owner: ConnectionOwner,
	viewer: ConnectionsViewer,
	people?: (id: string) => string | undefined,
): string {
	switch (owner.kind) {
		case "organisation":
			return viewer.organisation;
		case "project":
			return `${projectName(viewer, owner.projectId)} project`;
		case "user":
			return owner.userId === viewer.userId ? "You" : personName(viewer, owner.userId, people);
	}
}

/**
 * Where a connection may be used, in a sentence (#335): the line that tells two connections to one provider apart.
 * "Personal to Tom Davies, only in sessions acting as Tom Davies." "Shared with the Support project."
 */
export function usageText(
	connection: Pick<Connection, "owner" | "shares" | "onlyProjects">,
	viewer: ConnectionsViewer,
	people?: (id: string) => string | undefined,
): string {
	const { owner } = connection;
	switch (owner.kind) {
		case "organisation": {
			const only = connection.onlyProjects ?? [];
			if (only.length > 0)
				return `Shared across ${viewer.organisation}, only in the ${listText(only.map((id) => projectName(viewer, id)))} ${only.length === 1 ? "project" : "projects"}.`;
			return `Shared across ${viewer.organisation}: organisation agents, and project agents its rules allow.`;
		}
		case "project":
			return `Shared with the ${projectName(viewer, owner.projectId)} project: its agents can use it.`;
		case "user": {
			const name = personName(viewer, owner.userId, people);
			const shares = connection.shares ?? [];
			const base = `Personal to ${name}, only in sessions acting as ${name}`;
			if (shares.length === 0) return `${base}.`;
			const names = shares.map((share) => projectName(viewer, share.projectId));
			return `${base}, and shared with the ${listText(names)} ${shares.length === 1 ? "project" : "projects"}.`;
		}
	}
}

/** What an owner choice means, for the picker's hint. */
export function ownerChoiceHint(choice: OwnerChoice, viewer: ConnectionsViewer): string {
	switch (choice.kind) {
		case "user":
			return `Only sessions acting as you can use it. You can share it with a project later.`;
		case "project":
			return `Every agent in ${projectName(viewer, choice.projectId)} can use it, including scheduled runs.`;
		case "organisation":
			return `Organisation agents can use it, and project agents where its rules allow.`;
	}
}

export function ownerChoiceKey(choice: OwnerChoice): string {
	return choice.kind === "project" ? `project:${choice.projectId}` : choice.kind;
}

/**
 * Who a new connection is for until the viewer picks: the project they have open, else their first project, else just
 * them. A project's connection works in that project's sessions on any deployment; a personal one may not.
 */
export function defaultOwner(viewer: ConnectionsViewer): OwnerChoice {
	const project = viewer.projects.find((candidate) => candidate.id === viewer.projectId) ?? viewer.projects.at(0);
	return project === undefined ? { kind: "user" } : { kind: "project", projectId: project.id };
}

/** Why a choice of owner would make a connection no session can use, or undefined. */
export function ownerChoiceWarning(choice: OwnerChoice, viewer: ConnectionsViewer): string | undefined {
	if (choice.kind !== "user" || viewer.personal !== false) return undefined;
	return "Agents can't use this yet. On this deployment every session is seen by its project, and a connection that's just yours only works in sessions nobody else can see. Pick a project instead, or share it with one later.";
}

/** The owners a viewer may connect for: themselves, their projects, and the organisation for an admin. */
export function ownerChoices(
	viewer: ConnectionsViewer,
): readonly { value: string; label: string; choice: OwnerChoice }[] {
	return [
		{ value: "user", label: `Just me (${viewer.name})`, choice: { kind: "user" } },
		...viewer.projects.map((project) => ({
			value: `project:${project.id}`,
			label: `${project.name} project`,
			choice: { kind: "project", projectId: project.id } as const,
		})),
		...(viewer.admin
			? [{ value: "organisation", label: viewer.organisation, choice: { kind: "organisation" } as const }]
			: []),
	];
}

/** "a", "a and b", "a, b and c". */
export function listText(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** How a template connects, for its card: one click, needs a client set up, or a key. */
export type ConnectRoute = "one_click" | "needs_client" | "key";

export function connectRoute(template: ProviderTemplate): ConnectRoute {
	const oauth = template.authTypes.includes("oauth2") || template.authTypes.includes("mcp_oauth");
	if (!oauth) return "key";
	if (template.setup !== undefined) return template.setup === "ready" ? "one_click" : "needs_client";
	if (template.authTypes.includes("mcp_oauth") || template.client !== undefined) return "one_click";
	return "needs_client";
}

export function takesKey(template: ProviderTemplate): boolean {
	return template.authTypes.some((type) => KEY_AUTH_TYPES.includes(type));
}

export function routeText(template: ProviderTemplate): string {
	switch (connectRoute(template)) {
		case "one_click":
			return "Sign in";
		case "needs_client":
			return "Needs an OAuth client";
		case "key":
			return "API key";
	}
}

/** The setup tier a template connects through, from the catalogue or, for an older API, from `setup` and `client`. */
export function setupTierOf(template: ProviderTemplate): SetupTier {
	if (template.tier !== undefined) return template.tier;
	const route = connectRoute(template);
	if (route === "key") return "key";
	if (template.authTypes.includes("mcp_oauth") && template.client === undefined) return "none";
	if (template.client === undefined) return "own_app";
	if (template.client.public === true) return "public_client";
	return template.client.tier === "deployment" || template.client.tier === "organisation" ? "host_client" : "own_app";
}

/**
 * A template's setup tier as its label says it: the words, and the look. `guided` and `needs_app` are tier 3 still to
 * do; `own` is tier 3 done.
 */
export type TierLook = "none" | "code" | "browser" | "provided" | "own" | "guided" | "needs_app" | "key";

export interface TierLabel {
	readonly look: TierLook;
	readonly text: string;
	/** A sentence on what it means, for the label's title and the service's page. */
	readonly detail: string;
}

export function tierLabel(template: ProviderTemplate, viewer?: Pick<ConnectionsViewer, "host">): TierLabel {
	const tier = setupTierOf(template);
	const ready = connectRoute(template) !== "needs_client";
	switch (tier) {
		case "key":
			return { look: "key", text: "API key", detail: `${template.name} connects with a key you paste once.` };
		case "none":
			return {
				look: "none",
				text: "No setup",
				detail: template.authTypes.includes("mcp_oauth")
					? `${template.name}'s server registers Kantel itself: sign in and it's connected.`
					: "Nothing to set up first.",
			};
		case "public_client":
			return template.signIn === "device"
				? {
						look: "code",
						text: "Sign in with code",
						detail: `Type a short code on ${template.name} to connect. No app to register.`,
					}
				: { look: "browser", text: "Sign in", detail: `Sign in on ${template.name}. No app to register.` };
		case "host_client": {
			const organisation = template.client?.tier === "organisation";
			const who = organisation ? "your organisation" : (template.client?.ownerLabel ?? viewer?.host ?? "your host");
			return {
				look: "provided",
				text: `Provided by ${who}`,
				detail: `Through ${organisation ? `${template.client?.ownerLabel ?? "your organisation"}'s` : `${who}'s`} ${template.name} app: sign in and it's connected.`,
			};
		}
		case "own_app":
			if (ready)
				return {
					look: "own",
					text: template.client?.tier === "project" ? "Project's own app" : "Your own app",
					detail: `Through ${template.client?.label ?? `your own ${template.name} app`}.`,
				};
			return template.guide === undefined
				? {
						look: "needs_app",
						text: "Needs an OAuth app",
						detail: `${template.name} needs an OAuth app registered with it before anyone can sign in.`,
					}
				: {
						look: "guided",
						text: "Create your own app",
						detail:
							template.guide.kind === "github_app_manifest"
								? `Kantel has ${template.guide.provider} create an app in your account in one click.`
								: `Kantel walks you through registering your own app in ${template.guide.provider}.`,
					};
	}
}

export const FAILURE_TEXT: Record<ConnectFailure, string> = {
	denied: "The sign-in was cancelled or access was refused, so nothing was connected.",
	expired: "The sign-in link expired before it was finished. Start again.",
	user_mismatch:
		"Someone other than the person this sign-in was for finished it, so nothing was stored. Sign in as yourself and try again.",
	no_client: "There's no OAuth client for this service yet. An admin can add one in OAuth clients.",
	discovery_failed: "The server didn't say how to sign in. Check the URL, or connect it with a key instead.",
	test_failed: "Signed in, but the test request failed.",
	provider_error: "The service returned an error during sign-in. Try again in a moment.",
};

// ---------------------------------------------------------------------------------------------------------------------
// Catalogue

/** Templates matching a search and a category, by name first, then summary and category. */
export function searchCatalogue(
	templates: readonly ProviderTemplate[],
	query: string,
	category?: string,
): readonly ProviderTemplate[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const inCategory = category === undefined ? templates : templates.filter((t) => t.category === category);
	if (words.length === 0) return inCategory;
	const scored = inCategory
		.map((template) => {
			const name = template.name.toLowerCase();
			const rest = `${template.summary} ${template.category} ${template.publisher ?? ""} ${template.id}`.toLowerCase();
			let score = 0;
			for (const word of words) {
				if (name.startsWith(word)) score += 4;
				else if (name.includes(word)) score += 3;
				else if (rest.includes(word)) score += 1;
				else return undefined;
			}
			return { template, score };
		})
		.filter((entry) => entry !== undefined);
	return scored
		.sort((a, b) => b.score - a.score || a.template.name.localeCompare(b.template.name))
		.map((e) => e.template);
}

/** The categories the catalogue uses, in the page's order, with counts. */
export function categoryCounts(templates: readonly ProviderTemplate[]): readonly { category: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const template of templates) counts.set(template.category, (counts.get(template.category) ?? 0) + 1);
	const known = CATEGORIES.filter((category) => counts.has(category));
	const other = [...counts.keys()].filter((category) => !(CATEGORIES as readonly string[]).includes(category)).sort();
	return [...known, ...other].map((category) => ({ category, count: counts.get(category) ?? 0 }));
}

/** The templates a pasted key looks like, from their key shapes (#330). Suggests only; the person confirms. */
export function detectKey(
	templates: readonly ProviderTemplate[],
	key: string,
): { template: ProviderTemplate; shape: KeyShape } | undefined {
	const value = key.trim();
	if (value.length < 8) return undefined;
	let best: { template: ProviderTemplate; shape: KeyShape; length: number } | undefined;
	for (const template of templates) {
		for (const shape of template.keyShapes ?? []) {
			const prefixOk = shape.prefix === undefined || value.startsWith(shape.prefix);
			const patternOk = shape.pattern === undefined || safeTest(shape.pattern, value);
			if (!prefixOk || !patternOk || (shape.prefix === undefined && shape.pattern === undefined)) continue;
			// The longest prefix wins: `github_pat_` over `gh`.
			const length = shape.prefix?.length ?? 0;
			if (best === undefined || length > best.length) best = { template, shape, length };
		}
	}
	return best === undefined ? undefined : { template: best.template, shape: best.shape };
}

function safeTest(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern).test(value);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation

/** Why an MCP server URL can't be used, or undefined when it can. https only (#338). */
export function mcpUrlError(value: string): string | undefined {
	const text = value.trim();
	if (text === "") return "Paste the server's URL.";
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return "That isn't a URL. It should look like https://mcp.example.com/mcp.";
	}
	if (url.protocol === "http:") return "Use https. Kantel sends credentials only over https.";
	if (url.protocol !== "https:") return "Use an https URL.";
	if (url.username !== "" || url.password !== "")
		return "Leave the credentials out of the URL. Kantel signs in for you.";
	return undefined;
}

/** Why a host pattern can't be used, or undefined (#330): a host or `*.host`, no scheme, path or plain http. */
export function hostPatternError(value: string): string | undefined {
	const text = value.trim();
	if (text === "") return "Add at least one host.";
	if (/^http:\/\//i.test(text)) return "Plain http isn't allowed. Kantel sends keys only over https.";
	const host = text.replace(/^https:\/\//i, "");
	if (/[/?#\s]/.test(host)) return "Just the host, such as api.example.com, without a path.";
	if (!/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?$/i.test(host))
		return "That isn't a host name, such as api.example.com.";
	return undefined;
}

/** The hosts in a comma- or line-separated list, without a scheme. */
export function parseHosts(value: string): readonly string[] {
	return value
		.split(/[\s,]+/)
		.map((host) => host.trim().replace(/^https:\/\//i, ""))
		.filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------------
// Connections

export interface ConnectionGroup {
	readonly key: string;
	readonly title: string;
	readonly connections: readonly Connection[];
}

/** Connections grouped by owner (#339): the viewer's own, then each project's, then the organisation's. */
export function groupConnections(
	connections: readonly Connection[],
	viewer: ConnectionsViewer,
	people?: (id: string) => string | undefined,
): readonly ConnectionGroup[] {
	const groups = new Map<string, { title: string; order: number; connections: Connection[] }>();
	for (const connection of connections) {
		const { owner } = connection;
		const [key, title, order] =
			owner.kind === "user"
				? owner.userId === viewer.userId
					? ["mine", "Yours", 0]
					: [`user:${owner.userId}`, `${personName(viewer, owner.userId, people)}'s`, 1]
				: owner.kind === "project"
					? [`project:${owner.projectId}`, `${projectName(viewer, owner.projectId)} project`, 2]
					: ["organisation", viewer.organisation, 3];
		const group = groups.get(key) ?? { title, order, connections: [] };
		group.connections.push(connection);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.sort(([, a], [, b]) => a.order - b.order || a.title.localeCompare(b.title))
		.map(([key, group]) => ({
			key,
			title: group.title,
			connections: group.connections.sort(
				(a, b) => attention(b) - attention(a) || a.name.localeCompare(b.name) || a.createdAt - b.createdAt,
			),
		}));
}

const attention = (connection: Connection): number => (connection.health === "healthy" ? 0 : 1);

/**
 * How many connections need someone to act: the navigation's badge. A refresh that is failing for now isn't one:
 * Kantel retries it, and it becomes `needs_reconnect` if the provider refuses.
 */
export function needsAttention(connections: readonly Connection[]): number {
	return connections.filter((connection) => connection.health !== "healthy" && connection.health !== "refresh_failing")
		.length;
}

/**
 * What's wrong with a connection that isn't healthy, in a sentence or two: its last error, and for a failing refresh
 * when Kantel tries again. Undefined when there's nothing to say.
 */
export function healthText(connection: Connection, now: number): string | undefined {
	if (connection.health === "healthy") return undefined;
	if (connection.health === "refresh_failing") {
		const why = (connection.lastError ?? "Kantel couldn't refresh the token").replace(/\.$/, "");
		const wait = connection.retryAt === undefined ? 0 : connection.retryAt - now;
		return wait > 0
			? `${why}. Kantel tries again in ${duration(Math.max(wait, 1000))}; nobody needs to do anything yet.`
			: `${why}. Kantel is trying again; nobody needs to do anything yet.`;
	}
	if (connection.health === "needs_reconnect")
		return connection.lastError ?? `${connection.name} stopped accepting Kantel's sign-in. Reconnect to sign in again.`;
	return connection.lastError;
}

/** The viewer's connections to one template, for its page. */
export function connectionsFor(connections: readonly Connection[], templateId: string): readonly Connection[] {
	return connections.filter((connection) => connection.templateId === templateId);
}

/** A connection's name with its account, so two to one provider read apart: "GitHub", "tvdavies". */
export function accountText(connection: Connection): string | undefined {
	if (connection.label !== undefined && connection.account !== undefined)
		return `${connection.label}, ${connection.account}`;
	return connection.label ?? connection.account;
}

/** The client tier that wins for a template (#326): the narrowest enabled one. */
export function winningClient(clients: readonly OAuthClient[], templateId: string): OAuthClient | undefined {
	const order: readonly ClientTier[] = ["user", "project", "organisation", "deployment"];
	const enabled = clients.filter((client) => client.templateId === templateId && client.disabled !== true);
	for (const tier of order) {
		const found = enabled.find((client) => client.tier === tier);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * The templates an OAuth client can be registered for: an OAuth API, or a remote MCP server that signs in with OAuth.
 * Slack's and GitHub's MCP servers offer no dynamic registration, so they only connect through a registered client. A
 * server that needs no sign-in (DeepWiki, Cloudflare's docs) has nothing to register, so it isn't offered.
 */
export function clientTemplates(catalogue: readonly ProviderTemplate[]): readonly ProviderTemplate[] {
	return catalogue.filter(
		(template) =>
			template.open !== true && (template.authTypes.includes("oauth2") || template.authTypes.includes("mcp_oauth")),
	);
}

/** The client secret's or key's presence in words: "Set, ends in 4f2a". */
export function secretText(secret: SecretHint): string {
	return `Set, ends in ${secret.last4}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sharing and reach (#335)

/** Only the person a connection belongs to may share it: an organisation admin sees it but can't share or use it. */
export function canShare(connection: Pick<Connection, "owner">, viewer: ConnectionsViewer): boolean {
	return connection.owner.kind === "user" && connection.owner.userId === viewer.userId;
}

/** Who may stop a share: the person who owns the connection, or an admin (the API checks the project's admins too). */
export function canUnshare(connection: Pick<Connection, "owner">, viewer: ConnectionsViewer): boolean {
	return canShare(connection, viewer) || viewer.admin;
}

/** The viewer's projects a person's connection isn't shared with yet. */
export function shareableProjects(
	connection: Pick<Connection, "shares">,
	viewer: ConnectionsViewer,
): readonly { readonly id: string; readonly name: string }[] {
	const shared = new Set((connection.shares ?? []).map((share) => share.projectId));
	return viewer.projects.filter((project) => !shared.has(project.id));
}

/** One line of where a connection can be used: a short label and what it allows, `closed` when it shuts a door. */
export interface ReachFact {
	readonly label: string;
	readonly text: string;
	readonly closed?: boolean;
}

/**
 * Where a connection can be used, line by line (#335): which sessions, who may see them, unattended runs and agents.
 * The owner bounds it; the usage narrows it; a share opens a person's connection to a project's sessions.
 */
export function reachFacts(
	connection: Pick<Connection, "owner" | "shares" | "onlyProjects" | "usage">,
	viewer: ConnectionsViewer,
	people?: (id: string) => string | undefined,
): readonly ReachFact[] {
	const { owner } = connection;
	const usage = connection.usage;
	const visibility = usage?.visibility ?? (owner.kind === "user" ? "private" : "shared");
	const shares = owner.kind === "user" ? (connection.shares ?? []) : [];
	const sharedNames = listText(shares.map((share) => projectName(viewer, share.projectId)));
	const projectsWord = shares.length === 1 ? "project" : "projects";
	const facts: ReachFact[] = [];

	switch (owner.kind) {
		case "user": {
			const name = owner.userId === viewer.userId ? "you" : personName(viewer, owner.userId, people);
			facts.push({
				label: "Sessions",
				text:
					shares.length === 0
						? `Only sessions acting for ${name}.`
						: `Sessions acting for ${name}, and any session in the ${sharedNames} ${projectsWord}.`,
			});
			break;
		}
		case "project":
			facts.push({ label: "Sessions", text: `Any session in the ${projectName(viewer, owner.projectId)} project.` });
			break;
		case "organisation": {
			const only = connection.onlyProjects ?? [];
			facts.push({
				label: "Sessions",
				text:
					only.length === 0
						? `Any session in ${viewer.organisation}.`
						: `Only sessions in the ${listText(only.map((id) => projectName(viewer, id)))} ${only.length === 1 ? "project" : "projects"}.`,
			});
		}
	}

	if (visibility === "private") {
		facts.push({
			label: "Seen by",
			text:
				shares.length === 0
					? "Only sessions nobody else can see, so what it returns never reaches anyone else."
					: `Only sessions nobody else can see, except in ${sharedNames}, where its members can see what it returns.`,
			closed: shares.length === 0,
		});
	} else {
		facts.push({ label: "Seen by", text: "Any session, including ones other people can see." });
	}

	if (owner.kind === "user" || usage?.unattended === false) {
		facts.push({
			label: "Unattended runs",
			text:
				owner.kind === "user"
					? "Never. Scheduled and triggered runs have no person behind them."
					: "No. Scheduled and triggered runs can't use it.",
			closed: true,
		});
	} else {
		facts.push({ label: "Unattended runs", text: "Yes. Scheduled and triggered runs can use it." });
	}

	if (usage?.agents !== undefined && usage.agents.length > 0) {
		facts.push({ label: "Agents", text: `Only ${listText(usage.agents)}.` });
	}
	if (owner.kind !== "user" && usage?.actingUsers !== undefined && usage.actingUsers.length > 0) {
		facts.push({
			label: "Acting for",
			text: `Only sessions acting for ${listText(usage.actingUsers.map((id) => personName(viewer, id, people)))}.`,
		});
	}
	return facts;
}

/** What sharing with a project lets happen, for the confirmation before it. */
export function shareConsequence(connection: Pick<Connection, "name">, projectName: string): string {
	return `Every agent in ${projectName} can use ${connection.name} through your account, in any session there, including ones other people can see. Its rules still decide each request, and you can stop sharing at any time.`;
}

/** A share's line: "Shared by Tom Davies 3d ago". */
export function shareText(share: ConnectionShareView, now: number, age: (at: number, now: number) => string): string {
	const when = age(share.sharedAt, now);
	return `Shared${share.sharedBy === undefined ? "" : ` by ${share.sharedBy}`} ${when === "now" ? "just now" : `${when} ago`}`;
}

/**
 * The egress gate's refusals (#331), in a word or two for a use's badge. The sandbox gets the code itself, so the row
 * shows it too; a code this console doesn't know shows as it is.
 */
export const EGRESS_REFUSAL_LABELS: Readonly<Record<string, string>> = {
	host_not_bound: "Wrong host",
	raw_secret: "Raw secret",
	unknown_placeholder: "Unknown placeholder",
	ambiguous_placeholder: "Two placeholders",
	connection_not_usable: "Not for this session",
	needs_reauth: "Needs reconnecting",
	https_required: "Not https",
	rule_denied: "Rule denied",
	approval_pending: "Needs approval",
	egress_denied: "Not sent",
	egress_unavailable: "Gate unavailable",
};

export const USE_OUTCOME_LABELS: Record<ConnectionUseOutcome, string> = {
	allowed: "Used",
	denied: "Refused",
	held: "Held for approval",
};

/** A held use's approval, in a word or two beside "Held for approval" (#481). */
export const HELD_APPROVAL_LABELS: Record<HeldApproval, string> = {
	waiting: "Waiting",
	approved: "Approved",
	denied: "Denied",
	expired: "Expired",
	withdrawn: "Withdrawn",
};

/** What became of a held request once its approval ended, for the use's line in place of "waiting" (#481). */
export const HELD_APPROVAL_REASONS: Record<Exclude<HeldApproval, "waiting">, string> = {
	approved: "A person approved this exact request; the agent's next identical send is its own use",
	denied: "A person denied this exact request, so nothing was sent",
	expired: "Nobody decided in time, so the approval expired and nothing was sent",
	withdrawn: "The approval was withdrawn, so nothing was sent",
};
