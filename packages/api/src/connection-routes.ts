/**
 * The Connections API's routes (epic #322): the provider catalogue (#325), connections and their uses (#335), the
 * OAuth connect flow (#327) for templates and remote MCP servers (#338), key connections (#330) and OAuth clients per
 * tenancy level (#326). Every route works headless: the console is one client of them (#150).
 *
 * Two browser routes sit beside these and outside the JSON API, because they answer a person's browser rather than a
 * client: `GET /v1/connections/authorize/{attemptId}` (a connect URL: checks who opened it, then redirects to the
 * provider) and `GET /v1/connections/callback` (the provider's redirect back: a page saying how it went, or a redirect
 * to the attempt's `returnTo`). `GET /v1/connections/oauth/client-metadata.json` is the deployment's client ID metadata
 * document, which authorisation servers fetch without signing in.
 *
 * The GitHub App manifest flow (#326) has two more: `GET /v1/connections/github-app/{setupId}/start?state=…` (the page
 * that posts the manifest on to GitHub; the state is the capability) and `GET /v1/connections/github-app/callback`
 * (GitHub's redirect back: converts the code, stores the client and redirects to the flow's `returnTo`).
 *
 * Specific paths come before `/connections/{connectionId}`: the router takes the first route that matches.
 */
import {
	AttemptPath,
	CataloguePage,
	CatalogueQuery,
	ConnectAttempt,
	Connection,
	ConnectionCeiling,
	ConnectionDecision,
	ConnectionPage,
	ConnectionPath,
	ConnectionReach,
	ConnectionRemoval,
	ConnectionRule,
	ConnectionRuleBody,
	ConnectionRuleFromApprovalBody,
	ConnectionRules,
	ConnectionSharePath,
	ConnectionsSettings,
	ConnectionUsePage,
	ConnectKeyBody,
	CreateOAuthClientBody,
	DiscoverMcpBody,
	DryRunConnectionBody,
	GitHubAppPath,
	GitHubAppSetup,
	ListConnectionsQuery,
	ListConnectionUsesQuery,
	ListOAuthClientsQuery,
	McpDiscovery,
	OAuthClient,
	OAuthClientPage,
	OAuthClientPath,
	ProviderTemplate,
	RotateKeyBody,
	RulePath,
	SessionConnectionsAnswer,
	SessionConnectionsQuery,
	SetConnectionCeilingBody,
	ShareConnectionBody,
	StartConnectBody,
	StartGitHubAppBody,
	TemplatePath,
	UpdateConnectionBody,
	UpdateConnectionRuleBody,
	UpdateConnectionRulesBody,
	UpdateOAuthClientBody,
} from "./connections-schema.ts";
import { defineRoute } from "./route.ts";

const tag = "connections";
const readErrors = ["invalid", "forbidden", "not_found"] as const;
const changeErrors = ["invalid", "forbidden", "not_found", "conflict", "refused"] as const;

export const getConnectionsSettings = defineRoute({
	operationId: "getConnectionsSettings",
	method: "GET",
	path: "/connections/settings",
	tag,
	summary: "Get how this deployment runs connections",
	description:
		"Whether a person's own connections work in every session acting for them (`personal`, a deployment with one " +
		"person), or only where they are shared, since a session is seen by its project. A client can warn before " +
		"someone makes a connection no session could use. Anyone signed in may read it.",
	answer: { status: 200, description: "The deployment's connection settings.", schema: ConnectionsSettings },
	errors: ["forbidden"],
});

export const listCatalogue = defineRoute({
	operationId: "listCatalogue",
	method: "GET",
	path: "/connections/catalogue",
	tag,
	summary: "List the provider catalogue",
	description:
		"The provider templates the caller can use: Kantel's, the deployment's and the organisation's own, filtered by " +
		"category, auth type, kind or a search. Each says whether the caller can connect it now (`setup: ready`) or " +
		"needs an OAuth app registered first (`needs_client`, with the tiers that could register one). No secrets.",
	query: CatalogueQuery,
	answer: { status: 200, description: "A page of catalogue entries.", schema: CataloguePage },
	errors: ["invalid", "forbidden"],
});

export const getProviderTemplate = defineRoute({
	operationId: "getProviderTemplate",
	method: "GET",
	path: "/connections/catalogue/{templateId}",
	tag,
	summary: "Get a provider template",
	params: TemplatePath,
	answer: { status: 200, description: "The template.", schema: ProviderTemplate },
	errors: readErrors,
});

export const discoverMcpServer = defineRoute({
	operationId: "discoverMcpServer",
	method: "POST",
	path: "/connections/discover",
	tag,
	summary: "Inspect a remote MCP server",
	description:
		"Reads a remote MCP server's protected-resource metadata and its authorisation server's metadata, without " +
		"sending any credential: whether it needs a sign-in, and how Kantel would get a client (a pre-registered " +
		"client, the deployment's client ID metadata document, or dynamic registration).",
	body: DiscoverMcpBody,
	answer: { status: 200, description: "What the server said about itself.", schema: McpDiscovery },
	errors: ["invalid", "forbidden", "unavailable"],
});

export const startConnect = defineRoute({
	operationId: "startConnect",
	method: "POST",
	path: "/connections/connect",
	tag,
	summary: "Start an OAuth connect",
	description:
		"Starts connecting a template or a remote MCP server for an owner (an organisation, a project or a person). " +
		"Answers a pending attempt with a `connectUrl` on this deployment that expires after 15 minutes and works once; " +
		"the person it is for opens it and signs in at the provider. An open server is connected at once (`completed`). " +
		"`refused` with `no_client` when the template needs an OAuth app nobody has registered. Creating needs admin on " +
		"the owner, or being the person for their own.",
	body: StartConnectBody,
	answer: { status: 201, description: "The attempt.", schema: ConnectAttempt },
	errors: [...changeErrors, "unavailable"],
});

export const getConnectAttempt = defineRoute({
	operationId: "getConnectAttempt",
	method: "GET",
	path: "/connections/connect/{attemptId}",
	tag,
	summary: "Get a connect attempt",
	description: "Its status: pending, completed (with the connection), failed (with why) or expired.",
	params: AttemptPath,
	answer: { status: 200, description: "The attempt.", schema: ConnectAttempt },
	errors: readErrors,
});

export const connectKey = defineRoute({
	operationId: "connectKey",
	method: "POST",
	path: "/connections/keys",
	tag,
	summary: "Connect with a key",
	description:
		"Stores a key connection for a template with a key auth type, or a custom service with its https hosts and how the " +
		"key goes out. The key is write-only: no answer, event or log carries it.",
	body: ConnectKeyBody,
	answer: { status: 201, description: "The connection.", schema: Connection },
	errors: changeErrors,
});

export const listConnectionUses = defineRoute({
	operationId: "listConnectionUses",
	method: "GET",
	path: "/connections/uses",
	tag,
	summary: "List connection uses",
	description:
		"Which connection a session used, at which step, acting for whom, and who could see the session then; filtered " +
		"by connection or session, newest first. A use in a private session is listed whole only to the connection's " +
		"owner, the person the session acted for and whoever may open the session now. Anyone else, an organisation or " +
		"project admin included, gets it as a `RedactedConnectionUse`: when, how it ended and for whom, with no session, " +
		"step or request. Naming the session is `forbidden` to them.",
	query: ListConnectionUsesQuery,
	answer: { status: 200, description: "A page of uses.", schema: ConnectionUsePage },
	errors: readErrors,
});

export const listSessionConnections = defineRoute({
	operationId: "listSessionConnections",
	method: "GET",
	path: "/connections/eligible",
	tag,
	summary: "Which connections a session may use",
	description:
		"Each connection that could reach the session (its organisation's, its project's, its person's and people's shared " +
		"with its project), whether the session may use it, and if not, why: the same check every request goes through " +
		"(#335). `visibility` answers as if the session had it, for a page offering the choice. Needs viewer on the " +
		"session; another person's connection that doesn't reach it shows no account.",
	query: SessionConnectionsQuery,
	answer: { status: 200, description: "The connections, usable first.", schema: SessionConnectionsAnswer },
	errors: [...readErrors, "unavailable"],
});

export const listOAuthClients = defineRoute({
	operationId: "listOAuthClients",
	method: "GET",
	path: "/connections/clients",
	tag,
	summary: "List OAuth clients",
	description:
		"The OAuth app registrations the caller may see: the deployment's, the organisation's, its projects' and their own. " +
		"Each shows only whether a secret is set and its last four characters, and the redirect URI to register.",
	query: ListOAuthClientsQuery,
	answer: { status: 200, description: "A page of OAuth clients.", schema: OAuthClientPage },
	errors: ["invalid", "forbidden"],
});

export const createOAuthClient = defineRoute({
	operationId: "createOAuthClient",
	method: "POST",
	path: "/connections/clients",
	tag,
	summary: "Register an OAuth client",
	description:
		"Registers an OAuth app at a tenancy level, for a template or an authorisation server. The deployment's need a " +
		"system or deployment operator, an organisation's its admin, a project's its admin, a person's that person.",
	body: CreateOAuthClientBody,
	answer: { status: 201, description: "The client.", schema: OAuthClient },
	errors: changeErrors,
});

export const getOAuthClient = defineRoute({
	operationId: "getOAuthClient",
	method: "GET",
	path: "/connections/clients/{oauthClientId}",
	tag,
	summary: "Get an OAuth client",
	params: OAuthClientPath,
	answer: { status: 200, description: "The client.", schema: OAuthClient },
	errors: readErrors,
});

export const updateOAuthClient = defineRoute({
	operationId: "updateOAuthClient",
	method: "PATCH",
	path: "/connections/clients/{oauthClientId}",
	tag,
	summary: "Change an OAuth client",
	description:
		"Its label, scopes, redirect domain, secret (write-only) or whether it is disabled. Disabling stops new " +
		"connections through it; connections pinned to it keep working and refreshing.",
	params: OAuthClientPath,
	body: UpdateOAuthClientBody,
	answer: { status: 200, description: "The client.", schema: OAuthClient },
	errors: changeErrors,
});

export const removeOAuthClient = defineRoute({
	operationId: "removeOAuthClient",
	method: "DELETE",
	path: "/connections/clients/{oauthClientId}",
	tag,
	summary: "Remove an OAuth client",
	description: "`conflict`, naming how many, while any connection is pinned to it.",
	params: OAuthClientPath,
	answer: { status: 204, description: "Removed." },
	errors: changeErrors,
});

export const startGitHubApp = defineRoute({
	operationId: "startGitHubApp",
	method: "POST",
	path: "/connections/github-app",
	tag,
	summary: "Have GitHub create a GitHub App",
	description:
		"Starts GitHub's app manifest flow: answers `url`, a page on this deployment that posts a manifest for a GitHub " +
		"App to GitHub (on the person's account, or `githubOrganisation`'s). Once the person chooses Create there, GitHub " +
		"sends them back and Kantel stores the app's client as an OAuth client for the `github` template at `owner`'s " +
		"tier, its secret write-only. A person only, with the same rights as registering that client by hand. The flow " +
		"must finish within an hour; `url` holds its single-use state and is only in this answer.",
	body: StartGitHubAppBody,
	answer: { status: 201, description: "The flow, with the page to open.", schema: GitHubAppSetup },
	errors: [...changeErrors, "unavailable"],
});

export const getGitHubApp = defineRoute({
	operationId: "getGitHubApp",
	method: "GET",
	path: "/connections/github-app/{setupId}",
	tag,
	summary: "Get a GitHub App manifest flow",
	description: "Where it has got to: pending, created (with the OAuth client and the app), failed or expired.",
	params: GitHubAppPath,
	answer: { status: 200, description: "The flow.", schema: GitHubAppSetup },
	errors: readErrors,
});

export const getConnectionCeiling = defineRoute({
	operationId: "getConnectionCeiling",
	method: "GET",
	path: "/connections/ceiling",
	tag,
	summary: "Get the organisation's ceiling",
	description:
		"The hosts, methods and paths any connection may reach in this organisation. No rule may allow or ask outside " +
		"it, and a request outside it is denied whatever a rule says. `set: false` when there is none. Anyone in the " +
		"organisation may read it.",
	answer: { status: 200, description: "The ceiling.", schema: ConnectionCeiling },
	errors: ["forbidden"],
});

export const setConnectionCeiling = defineRoute({
	operationId: "setConnectionCeiling",
	method: "PUT",
	path: "/connections/ceiling",
	tag,
	summary: "Set the organisation's ceiling",
	description:
		"Replaces the ceiling. Rules already saved stay, but a request outside the new ceiling is denied from the next " +
		"one. Needs organisation admin; agents are refused. `not_supported` where the deployment keeps no ceiling.",
	body: SetConnectionCeilingBody,
	answer: { status: 200, description: "The ceiling.", schema: ConnectionCeiling },
	errors: ["invalid", "forbidden", "not_supported", "unavailable"],
});

export const listConnections = defineRoute({
	operationId: "listConnections",
	method: "GET",
	path: "/connections",
	tag,
	summary: "List connections",
	description:
		"The connections the caller may see: the organisation's, its projects' and their own, with their owner, account, " +
		"usage and credential state. Never a secret.",
	query: ListConnectionsQuery,
	answer: { status: 200, description: "A page of connections.", schema: ConnectionPage },
	errors: ["invalid", "forbidden"],
});

export const getConnection = defineRoute({
	operationId: "getConnection",
	method: "GET",
	path: "/connections/{connectionId}",
	tag,
	summary: "Get a connection",
	params: ConnectionPath,
	answer: { status: 200, description: "The connection.", schema: Connection },
	errors: readErrors,
});

export const updateConnection = defineRoute({
	operationId: "updateConnection",
	method: "PATCH",
	path: "/connections/{connectionId}",
	tag,
	summary: "Change a connection",
	description:
		"Its name, usage (where, by whom and in which sessions it may be used) or whether it is disabled. Takes effect on " +
		"the next use. Needs admin on the owner, or being the person for their own.",
	params: ConnectionPath,
	body: UpdateConnectionBody,
	answer: { status: 200, description: "The connection.", schema: Connection },
	errors: changeErrors,
});

export const removeConnection = defineRoute({
	operationId: "removeConnection",
	method: "DELETE",
	path: "/connections/{connectionId}",
	tag,
	summary: "Disconnect a connection",
	description:
		"Stops every use at once, asks the provider to revoke its tokens where the provider can (RFC 7009, or the provider's own endpoint), destroys the stored credential, and removes the connection with its rules and any approvals not yet used. A revoke the provider refuses still removes it: `revocation` says what happened upstream, and the `connections.connection.removed` audit event records the same. Its uses and audit history stay.",
	params: ConnectionPath,
	answer: { status: 200, description: "Removed, and what happened at the provider.", schema: ConnectionRemoval },
	errors: readErrors,
});

export const shareConnection = defineRoute({
	operationId: "shareConnection",
	method: "POST",
	path: "/connections/{connectionId}/shares",
	tag,
	summary: "Share a person's connection with a project",
	description:
		"Only its owner, as a person, into a project where they hold operator. Every attended session in the project may " +
		"then use it, whoever it acts for and whoever can see it; its rules still decide each request, and unattended " +
		"sessions never get it. Sharing again changes nothing. Audited as `connections.connection.shared` (#335).",
	params: ConnectionPath,
	body: ShareConnectionBody,
	answer: { status: 200, description: "The connection with its shares.", schema: Connection },
	errors: changeErrors,
});

export const unshareConnection = defineRoute({
	operationId: "unshareConnection",
	method: "DELETE",
	path: "/connections/{connectionId}/shares/{projectId}",
	tag,
	summary: "Stop sharing a connection with a project",
	description:
		"Its owner, or an admin of the project. The project's next request through it is refused and recorded as denied. " +
		"Audited as `connections.connection.unshared` (#335).",
	params: ConnectionSharePath,
	answer: { status: 200, description: "The connection with its shares.", schema: Connection },
	errors: changeErrors,
});

export const rotateConnectionKey = defineRoute({
	operationId: "rotateConnectionKey",
	method: "POST",
	path: "/connections/{connectionId}/key",
	tag,
	summary: "Replace a connection's key",
	description: "Replaces a key connection's value in place: its ID, usage and history stay. Write-only.",
	params: ConnectionPath,
	body: RotateKeyBody,
	answer: { status: 200, description: "The connection.", schema: Connection },
	errors: changeErrors,
});

export const getConnectionReach = defineRoute({
	operationId: "getConnectionReach",
	method: "GET",
	path: "/connections/{connectionId}/reach",
	tag,
	summary: "What a connection can reach",
	description:
		"Asks the provider, through the connection, what it can reach now (#461). For GitHub: the installations of the " +
		"app the person can reach (`GET /user/installations`) and each one's repositories, at most 300, with `truncated` " +
		"when there are more. Only someone who manages the connection (admin on its owner, or the person for their own); " +
		"never an agent. `not_supported` for a provider Kantel can't ask. Never answers a secret.",
	params: ConnectionPath,
	answer: { status: 200, description: "What it reaches.", schema: ConnectionReach },
	errors: [...readErrors, "refused", "unavailable", "not_supported"],
});

export const getConnectionRules = defineRoute({
	operationId: "getConnectionRules",
	method: "GET",
	path: "/connections/{connectionId}/rules",
	tag,
	summary: "List a connection's access rules",
	description:
		"Who may use it for what, and on what terms (`allow`, `ask` or `deny`), with what a request no rule matches gets " +
		"(`unmatched`) and the rules' version. A connection made before rules is given its template's defaults (reads " +
		"allow, writes ask, deletes deny, `unmatched` ask) the first time its rules are read, and `defaults` says when. " +
		"Needs viewer on the connection's owner.",
	params: ConnectionPath,
	answer: { status: 200, description: "The rules.", schema: ConnectionRules },
	errors: readErrors,
});

export const updateConnectionRules = defineRoute({
	operationId: "updateConnectionRules",
	method: "PATCH",
	path: "/connections/{connectionId}/rules",
	tag,
	summary: "Change what unmatched requests get, or reset the defaults",
	description:
		"Sets `unmatched`, or with `reset: template` replaces the template's default rules (reads allow, writes ask, " +
		"deletes deny) and " +
		"sets `unmatched` to ask, keeping people's own rules. Needs admin on the owner, or being the person for their own.",
	params: ConnectionPath,
	body: UpdateConnectionRulesBody,
	answer: { status: 200, description: "The rules.", schema: ConnectionRules },
	errors: changeErrors,
});

export const createConnectionRule = defineRoute({
	operationId: "createConnectionRule",
	method: "POST",
	path: "/connections/{connectionId}/rules",
	tag,
	summary: "Add an access rule",
	description:
		"Adds a rule naming who (any agent, organisation-level agents, a project, an agent or a session), what (any " +
		"request, a method and path pattern, or an MCP tool) and the terms, with an optional expiry and use limit. " +
		"`refused` when an allow or ask rule reaches outside the organisation's ceiling or names a project or agent the " +
		"connection's usage never admits. Takes effect on the next request. Needs admin on the owner, or being the " +
		"person for their own; agents are refused.",
	params: ConnectionPath,
	body: ConnectionRuleBody,
	answer: { status: 201, description: "The rule.", schema: ConnectionRule },
	errors: changeErrors,
});

export const createConnectionRuleFromApproval = defineRoute({
	operationId: "createConnectionRuleFromApproval",
	method: "POST",
	path: "/connections/{connectionId}/rules/from-approval",
	tag,
	summary: "Always allow requests like an approved one",
	description:
		"Saves an allow rule from an approval of one exact request (#333), marked `source: approval` with its ID, as its " +
		"own act the person can see and stop. The approval must be for a request through this connection, still open or " +
		"approved, and the rule must cover that request. Checked as adding a rule is, with the same rights: admin on the " +
		"owner, or being the person for their own. The approval itself is decided apart, on the connection request.",
	params: ConnectionPath,
	body: ConnectionRuleFromApprovalBody,
	answer: { status: 201, description: "The rule.", schema: ConnectionRule },
	errors: changeErrors,
});

export const dryRunConnectionRequest = defineRoute({
	operationId: "dryRunConnectionRequest",
	method: "POST",
	path: "/connections/{connectionId}/rules/dry-run",
	tag,
	summary: "Try a request against a connection's rules",
	description:
		"What the proxy would do with this request from a session like the one described, and what decides it: a rule, " +
		"`unmatched`, the ceiling, or the connection's owner and usage. The same function as the real decision. Writes no " +
		"use and opens no secret. Needs viewer on the connection's owner.",
	params: ConnectionPath,
	body: DryRunConnectionBody,
	answer: { status: 200, description: "The decision.", schema: ConnectionDecision },
	errors: readErrors,
});

export const updateConnectionRule = defineRoute({
	operationId: "updateConnectionRule",
	method: "PATCH",
	path: "/connections/{connectionId}/rules/{ruleId}",
	tag,
	summary: "Change an access rule",
	description:
		"Changes a rule's who, what, terms, expiry, use limit or note; `null` clears an expiry, limit or note. Checked as " +
		"a new rule is. Takes effect on the next request.",
	params: RulePath,
	body: UpdateConnectionRuleBody,
	answer: { status: 200, description: "The rule.", schema: ConnectionRule },
	errors: changeErrors,
});

export const removeConnectionRule = defineRoute({
	operationId: "removeConnectionRule",
	method: "DELETE",
	path: "/connections/{connectionId}/rules/{ruleId}",
	tag,
	summary: "Remove an access rule",
	description: "Takes effect on the next request through any instance.",
	params: RulePath,
	answer: { status: 204, description: "Removed." },
	errors: changeErrors,
});

export const connectionRoutes = {
	getConnectionsSettings,
	listCatalogue,
	getProviderTemplate,
	discoverMcpServer,
	startConnect,
	getConnectAttempt,
	connectKey,
	listConnectionUses,
	listSessionConnections,
	listOAuthClients,
	createOAuthClient,
	getOAuthClient,
	updateOAuthClient,
	removeOAuthClient,
	startGitHubApp,
	getGitHubApp,
	getConnectionCeiling,
	setConnectionCeiling,
	listConnections,
	getConnection,
	updateConnection,
	removeConnection,
	rotateConnectionKey,
	shareConnection,
	unshareConnection,
	getConnectionReach,
	getConnectionRules,
	updateConnectionRules,
	createConnectionRule,
	createConnectionRuleFromApproval,
	dryRunConnectionRequest,
	updateConnectionRule,
	removeConnectionRule,
} as const;

/** The browser routes beside the JSON API, under `/v1`. */
export const CONNECTION_BROWSER_PATHS = {
	/** A connect URL: `GET /v1/connections/authorize/{attemptId}`. */
	authorize: "/connections/authorize",
	/** The provider's redirect back: `GET /v1/connections/callback?state=…&code=…`. */
	callback: "/connections/callback",
	/** The deployment's client ID metadata document, fetched by authorisation servers without signing in. */
	clientMetadata: "/connections/oauth/client-metadata.json",
	/** The GitHub App flows' pages: `GET /v1/connections/github-app/{setupId}/start?state=…` posts the manifest on. */
	gitHubApp: "/connections/github-app",
	/** GitHub's redirect back once the app is made: `GET /v1/connections/github-app/callback?code=…&state=…`. */
	gitHubAppCallback: "/connections/github-app/callback",
} as const;
