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
 * Specific paths come before `/connections/{connectionId}`: the router takes the first route that matches.
 */
import {
	AttemptPath,
	CataloguePage,
	CatalogueQuery,
	ConnectAttempt,
	Connection,
	ConnectionPage,
	ConnectionPath,
	ConnectionsSettings,
	ConnectionUsePage,
	ConnectKeyBody,
	CreateOAuthClientBody,
	DiscoverMcpBody,
	ListConnectionsQuery,
	ListConnectionUsesQuery,
	ListOAuthClientsQuery,
	McpDiscovery,
	OAuthClient,
	OAuthClientPage,
	OAuthClientPath,
	ProviderTemplate,
	RotateKeyBody,
	StartConnectBody,
	TemplatePath,
	UpdateConnectionBody,
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
		"The provider templates the caller can use: Harbour's, the deployment's and the organisation's own, filtered by " +
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
		"sending any credential: whether it needs a sign-in, and how Harbour would get a client (a pre-registered " +
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
		"by connection or session, newest first.",
	query: ListConnectionUsesQuery,
	answer: { status: 200, description: "A page of uses.", schema: ConnectionUsePage },
	errors: readErrors,
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
	summary: "Remove a connection",
	description: "Deletes its stored credential at once; its uses stay in the record.",
	params: ConnectionPath,
	answer: { status: 204, description: "Removed." },
	errors: readErrors,
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

export const connectionRoutes = {
	getConnectionsSettings,
	listCatalogue,
	getProviderTemplate,
	discoverMcpServer,
	startConnect,
	getConnectAttempt,
	connectKey,
	listConnectionUses,
	listOAuthClients,
	createOAuthClient,
	getOAuthClient,
	updateOAuthClient,
	removeOAuthClient,
	listConnections,
	getConnection,
	updateConnection,
	removeConnection,
	rotateConnectionKey,
} as const;

/** The browser routes beside the JSON API, under `/v1`. */
export const CONNECTION_BROWSER_PATHS = {
	/** A connect URL: `GET /v1/connections/authorize/{attemptId}`. */
	authorize: "/connections/authorize",
	/** The provider's redirect back: `GET /v1/connections/callback?state=…&code=…`. */
	callback: "/connections/callback",
	/** The deployment's client ID metadata document, fetched by authorisation servers without signing in. */
	clientMetadata: "/connections/oauth/client-metadata.json",
} as const;
