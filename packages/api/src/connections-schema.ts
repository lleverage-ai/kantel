/**
 * The Connections API's wire shapes (epic #322), each mirroring a type in `@harbour/contracts`'s `connections.ts`.
 * `test/types.test.ts` checks that each matches its contract type. No shape here carries a secret value except the
 * write-only inputs (`ConnectKeyBody.value`, `RotateKeyBody.value`, the OAuth client bodies' `clientSecret`).
 */
import Type from "typebox";
import { Actor, OwnerRef, Timestamp } from "./schema.ts";

const id = (description: string) => Type.String({ minLength: 1, description });
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }));
const cursor = Type.Optional(Type.String({ description: "A previous page's `nextCursor`." }));
const nextCursor = Type.Optional(Type.String({ description: "Present when more items follow." }));
const strings = (description?: string) => Type.Array(Type.String(), description === undefined ? {} : { description });

export const HttpMethodSchema = Type.Union(
	[
		Type.Literal("GET"),
		Type.Literal("HEAD"),
		Type.Literal("POST"),
		Type.Literal("PUT"),
		Type.Literal("PATCH"),
		Type.Literal("DELETE"),
		Type.Literal("OPTIONS"),
	],
	{ title: "HttpMethod" },
);

export const ConnectionAuthType = Type.Union(
	[
		Type.Literal("oauth2"),
		Type.Literal("oauth2_client_credentials"),
		Type.Literal("bearer"),
		Type.Literal("header"),
		Type.Literal("query"),
		Type.Literal("basic"),
		Type.Literal("header_template"),
		Type.Literal("none"),
	],
	{ title: "ConnectionAuthType", description: "How a connection authenticates." },
);

export const ProviderCategory = Type.Union(
	[
		Type.Literal("developer"),
		Type.Literal("productivity"),
		Type.Literal("communication"),
		Type.Literal("knowledge"),
		Type.Literal("project_management"),
		Type.Literal("crm"),
		Type.Literal("payments"),
		Type.Literal("ai"),
		Type.Literal("cloud"),
		Type.Literal("data"),
		Type.Literal("design"),
		Type.Literal("other"),
	],
	{ title: "ProviderCategory" },
);

export const ConnectionKind = Type.Union([Type.Literal("mcp"), Type.Literal("http")], {
	title: "ConnectionKind",
	description: "`mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API.",
});

const AccessKind = Type.Union([Type.Literal("read"), Type.Literal("write")], { title: "AccessKind" });

export const ScopeSet = Type.Object(
	{
		id: Type.String(),
		label: Type.String(),
		description: Type.Optional(Type.String()),
		access: AccessKind,
		scopes: strings(),
		default: Type.Optional(Type.Boolean({ description: "Asked for when nobody picks." })),
	},
	{ title: "ScopeSet", description: "A named group of scopes, marked read or write." },
);

export const EndpointHint = Type.Object(
	{
		method: Type.Union([HttpMethodSchema, Type.Literal("*")]),
		path: Type.String({ description: "`*` matches one segment; a trailing `/**` the rest." }),
		access: AccessKind,
	},
	{ title: "EndpointHint" },
);

export const KeyInjection = Type.Union(
	[
		Type.Object({ kind: Type.Literal("bearer") }),
		Type.Object({ kind: Type.Literal("header"), header: Type.String(), prefix: Type.Optional(Type.String()) }),
		Type.Object({ kind: Type.Literal("query"), param: Type.String() }),
		Type.Object({ kind: Type.Literal("basic") }),
		Type.Object({
			kind: Type.Literal("header_template"),
			header: Type.String(),
			template: Type.String({ description: "Contains `{key}`." }),
		}),
	],
	{ title: "KeyInjection", description: "How a key goes out on a request." },
);

export const KeyShape = Type.Object(
	{ label: Type.String(), prefix: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()) },
	{ title: "KeyShape" },
);

export const TestRequest = Type.Object(
	{
		method: HttpMethodSchema,
		url: Type.String({ description: "An absolute https URL on one of the template's API hosts." }),
		account: Type.Optional(
			Type.Object({
				id: Type.Optional(Type.String()),
				name: Type.Optional(Type.String()),
				email: Type.Optional(Type.String()),
			}),
		),
	},
	{ title: "TestRequest" },
);

export const ClientRegistration = Type.Union([Type.Literal("client"), Type.Literal("cimd"), Type.Literal("dcr")], {
	title: "ClientRegistration",
	description:
		"How Harbour gets an OAuth client: a pre-registered `client`, the deployment's client ID metadata document (`cimd`), or dynamic registration (`dcr`).",
});

export const ProviderOAuth = Type.Object(
	{
		discovery: Type.Union([Type.Literal("static"), Type.Literal("mcp")]),
		authorizationUrl: Type.Optional(Type.String()),
		tokenUrl: Type.Optional(Type.String()),
		revocationUrl: Type.Optional(Type.String()),
		scopeSeparator: Type.Optional(Type.String()),
		extraAuthorizationParams: Type.Optional(Type.Record(Type.String(), Type.String())),
		pkce: Type.Boolean(),
		refreshBufferSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
		rotatesRefreshTokens: Type.Optional(Type.Boolean()),
		registration: Type.Array(ClientRegistration),
	},
	{ title: "ProviderOAuth" },
);

const templateSource = Type.Union([Type.Literal("shipped"), Type.Literal("deployment"), Type.Literal("organisation")]);

export const ProviderTemplate = Type.Object(
	{
		id: id("The template's ID, such as `github`."),
		version: Type.Integer({ minimum: 1 }),
		name: Type.String(),
		description: Type.String(),
		icon: Type.String({ description: "An https URL or a `data:image/svg+xml` URI." }),
		docsUrl: Type.String(),
		category: ProviderCategory,
		kind: ConnectionKind,
		authTypes: Type.Array(ConnectionAuthType),
		apiHosts: strings("Hosts the credential may be sent to. Never empty."),
		mcp: Type.Optional(Type.Object({ url: Type.String() })),
		oauth: Type.Optional(ProviderOAuth),
		key: Type.Optional(Type.Object({ injection: KeyInjection, shapes: Type.Optional(Type.Array(KeyShape)) })),
		scopeSets: Type.Array(ScopeSet),
		endpointHints: Type.Array(EndpointHint),
		testRequest: Type.Optional(TestRequest),
		source: templateSource,
	},
	{ title: "ProviderTemplate", description: "A catalogue entry: how a service authenticates and where it is reached." },
);

const OAuthClientTier = Type.Union(
	[Type.Literal("platform"), Type.Literal("organisation"), Type.Literal("project"), Type.Literal("user")],
	{
		title: "OAuthClientTier",
		description: "The tenancy level an OAuth client belongs to; `platform` is the deployment.",
	},
);

export const CatalogueEntry = Type.Object(
	{
		id: Type.String(),
		version: Type.Integer(),
		name: Type.String(),
		description: Type.String(),
		icon: Type.String(),
		docsUrl: Type.String(),
		category: ProviderCategory,
		kind: ConnectionKind,
		authTypes: Type.Array(ConnectionAuthType),
		mcpUrl: Type.Optional(Type.String()),
		source: templateSource,
		setup: Type.Union([Type.Literal("ready"), Type.Literal("needs_client")], {
			description:
				"`ready`: the caller can connect now. `needs_client`: it needs an OAuth app someone must register first.",
		}),
		clientTiers: Type.Optional(Type.Array(OAuthClientTier)),
	},
	{ title: "CatalogueEntry" },
);

export const CataloguePage = Type.Object({ items: Type.Array(CatalogueEntry), nextCursor }, { title: "CataloguePage" });

export const CatalogueQuery = Type.Object({
	category: Type.Optional(ProviderCategory),
	authType: Type.Optional(ConnectionAuthType),
	kind: Type.Optional(ConnectionKind),
	q: Type.Optional(Type.String({ description: "Matches the name, ID, description and category." })),
	limit,
	cursor,
});

export const TemplatePath = Type.Object({ templateId: Type.String({ minLength: 1 }) });

export const McpDiscovery = Type.Object(
	{
		url: Type.String(),
		auth: Type.Union([Type.Literal("oauth"), Type.Literal("none"), Type.Literal("unknown")]),
		resource: Type.Optional(Type.String()),
		authorizationServer: Type.Optional(Type.String()),
		registration: Type.Array(ClientRegistration),
		scopes: Type.Optional(strings()),
		templateId: Type.Optional(Type.String()),
	},
	{ title: "McpDiscovery", description: "What Harbour learnt about a remote MCP server from its URL." },
);

export const DiscoverMcpBody = Type.Object({
	url: Type.String({ minLength: 1, description: "The server's Streamable HTTP endpoint, https." }),
});

export const ConnectionOwner = Type.Union(
	[
		Type.Object({ kind: Type.Literal("organisation"), organisationId: Type.String() }),
		Type.Object({ kind: Type.Literal("project"), organisationId: Type.String(), projectId: Type.String() }),
		Type.Object({ kind: Type.Literal("user"), organisationId: Type.String(), userId: Type.String() }),
	],
	{ title: "ConnectionOwner", description: "Who owns a connection: an organisation, a project or a person." },
);

export const SessionAudience = Type.Union(
	[
		Type.Object({ kind: Type.Literal("private"), userId: Type.String() }),
		Type.Object({ kind: Type.Literal("shared") }),
	],
	{
		title: "SessionAudience",
		description: "Who could see a session: only the person it acts for (`private`), or more people (`shared`).",
	},
);

export const ConnectionUsage = Type.Object(
	{
		projects: Type.Optional(strings("Only sessions in these projects (an organisation's connection).")),
		actingUsers: Type.Optional(strings("Only sessions acting for these people.")),
		agents: Type.Optional(strings("Only sessions of these agent profiles.")),
		unattended: Type.Boolean({ description: "Whether sessions with no person behind them may use it." }),
		visibility: Type.Union([Type.Literal("private"), Type.Literal("shared")], {
			description: "`private`: only in sessions nobody but the acting person can see.",
		}),
	},
	{ title: "ConnectionUsage", description: "Where a connection may be used, by whom and in which sessions." },
);

export const CredentialState = Type.Object(
	{
		set: Type.Boolean(),
		last4: Type.Optional(Type.String({ description: "A key's or client secret's last four characters." })),
		expiresAt: Type.Optional(Timestamp),
		refreshable: Type.Boolean(),
		updatedAt: Type.Optional(Timestamp),
	},
	{ title: "CredentialState", description: "A credential's state. Never its value." },
);

export const ConnectionAccount = Type.Object(
	{ id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), email: Type.Optional(Type.String()) },
	{ title: "ConnectionAccount" },
);

export const ConnectionClientRef = Type.Object(
	{
		via: ClientRegistration,
		clientId: Type.String(),
		oauthClientId: Type.Optional(Type.String()),
		tier: Type.Optional(OAuthClientTier),
	},
	{ title: "ConnectionClientRef", description: "The OAuth client a connection is pinned to." },
);

const ConnectionStatus = Type.Union(
	[Type.Literal("active"), Type.Literal("needs_reauth"), Type.Literal("failing_test"), Type.Literal("disabled")],
	{ title: "ConnectionStatus" },
);

export const Connection = Type.Object(
	{
		id: id("The connection's ID."),
		organisationId: Type.String(),
		owner: ConnectionOwner,
		name: Type.String(),
		templateId: Type.Optional(Type.String()),
		templateVersion: Type.Optional(Type.Integer()),
		kind: ConnectionKind,
		auth: Type.Union([Type.Literal("oauth2"), Type.Literal("key"), Type.Literal("none")]),
		mcp: Type.Optional(Type.Object({ url: Type.String(), resource: Type.Optional(Type.String()) })),
		hosts: strings("Hosts the credential may be sent to."),
		account: Type.Optional(ConnectionAccount),
		scopes: Type.Object({ requested: strings(), granted: strings() }),
		client: Type.Optional(ConnectionClientRef),
		usage: ConnectionUsage,
		status: ConnectionStatus,
		credential: CredentialState,
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "Connection", description: "One authorisation against a provider or remote MCP server. No secret." },
);

export const ConnectionPage = Type.Object({ items: Type.Array(Connection), nextCursor }, { title: "ConnectionPage" });

export const ListConnectionsQuery = Type.Object({
	ownerKind: Type.Optional(Type.Union([Type.Literal("organisation"), Type.Literal("project"), Type.Literal("user")])),
	ownerId: Type.Optional(Type.String()),
	templateId: Type.Optional(Type.String()),
	kind: Type.Optional(ConnectionKind),
	limit,
	cursor,
});

export const ConnectionPath = Type.Object({ connectionId: Type.String({ minLength: 1 }) });

export const UpdateConnectionBody = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	usage: Type.Optional(ConnectionUsage),
	status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("disabled")])),
});

export const StartConnectBody = Type.Object({
	templateId: Type.Optional(Type.String({ description: "A catalogue template. Give this or `mcpUrl`." })),
	mcpUrl: Type.Optional(Type.String({ description: "A remote MCP server's endpoint, for a server with no template." })),
	owner: ConnectionOwner,
	name: Type.Optional(Type.String()),
	scopeSets: Type.Optional(strings("Scope sets to ask for; default the template's default sets.")),
	scopes: Type.Optional(strings("Explicit scopes, added to the sets'.")),
	usage: Type.Optional(ConnectionUsage),
	forUserId: Type.Optional(
		Type.String({ description: "A handover link: the person who must complete it. Default the caller." }),
	),
	connectionId: Type.Optional(Type.String({ description: "Reconnect or widen this connection, keeping its ID." })),
	returnTo: Type.Optional(Type.String({ description: "Where the final page sends the person afterwards." })),
});

const ConnectFailureCode = Type.Union(
	[
		Type.Literal("user_mismatch"),
		Type.Literal("no_client"),
		Type.Literal("denied"),
		Type.Literal("invalid_state"),
		Type.Literal("exchange_failed"),
		Type.Literal("discovery_failed"),
		Type.Literal("registration_failed"),
	],
	{ title: "ConnectFailureCode" },
);

export const ConnectAttempt = Type.Object(
	{
		id: id("The attempt's ID."),
		organisationId: Type.String(),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("expired"),
		]),
		connectUrl: Type.Optional(
			Type.String({ description: "Open this to sign in. Present while pending; it expires and works once." }),
		),
		owner: ConnectionOwner,
		templateId: Type.Optional(Type.String()),
		mcpUrl: Type.Optional(Type.String()),
		forUserId: Type.Optional(Type.String()),
		connectionId: Type.Optional(Type.String({ description: "Set once completed." })),
		failure: Type.Optional(Type.Object({ code: ConnectFailureCode, message: Type.String() })),
		createdBy: Actor,
		createdAt: Timestamp,
		expiresAt: Timestamp,
		completedAt: Type.Optional(Timestamp),
	},
	{ title: "ConnectAttempt", description: "One OAuth sign-in in progress." },
);

export const AttemptPath = Type.Object({ attemptId: Type.String({ minLength: 1 }) });

export const ConnectKeyBody = Type.Object({
	templateId: Type.Optional(Type.String({ description: "A template with a key auth type. Give this or `custom`." })),
	custom: Type.Optional(
		Type.Object({
			kind: ConnectionKind,
			hosts: Type.Array(Type.String(), { minItems: 1, description: "https hosts the key may be sent to." }),
			injection: KeyInjection,
			mcpUrl: Type.Optional(Type.String()),
		}),
	),
	owner: ConnectionOwner,
	name: Type.Optional(Type.String()),
	value: Type.String({
		minLength: 1,
		description:
			"The key. Write-only: never returned. For `basic` injection, `username:password` (split at the first colon; " +
			"no colon: the user name with an empty password).",
	}),
	usage: Type.Optional(ConnectionUsage),
});

export const RotateKeyBody = Type.Object({
	value: Type.String({ minLength: 1, description: "The new key. Write-only: never returned." }),
});

export const OAuthClient = Type.Object(
	{
		id: id("The OAuth client record's ID."),
		owner: OwnerRef,
		templateId: Type.Optional(Type.String()),
		issuer: Type.Optional(
			Type.String({ description: "An authorisation server's issuer, for a server with no template." }),
		),
		label: Type.String(),
		clientId: Type.String({ description: "The public client ID." }),
		secret: CredentialState,
		scopes: Type.Optional(strings()),
		redirectDomain: Type.Optional(Type.String()),
		redirectUri: Type.String({ description: "The redirect URI to register with the provider." }),
		disabled: Type.Boolean(),
		connections: Type.Integer({ minimum: 0, description: "How many connections are pinned to it." }),
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "OAuthClient", description: "An OAuth app registration at a tenancy level. Its secret is write-only." },
);

export const OAuthClientPage = Type.Object(
	{ items: Type.Array(OAuthClient), nextCursor },
	{ title: "OAuthClientPage" },
);

export const ListOAuthClientsQuery = Type.Object({
	templateId: Type.Optional(Type.String()),
	tier: Type.Optional(OAuthClientTier),
	limit,
	cursor,
});

export const OAuthClientPath = Type.Object({ oauthClientId: Type.String({ minLength: 1 }) });

export const CreateOAuthClientBody = Type.Object({
	owner: OwnerRef,
	templateId: Type.Optional(Type.String()),
	issuer: Type.Optional(Type.String()),
	label: Type.String({ minLength: 1 }),
	clientId: Type.String({ minLength: 1 }),
	clientSecret: Type.Optional(Type.String({ minLength: 1, description: "Write-only. A public client has none." })),
	scopes: Type.Optional(strings()),
	redirectDomain: Type.Optional(Type.String()),
});

export const UpdateOAuthClientBody = Type.Object({
	label: Type.Optional(Type.String({ minLength: 1 })),
	clientSecret: Type.Optional(Type.String({ minLength: 1, description: "Replaces the secret. Write-only." })),
	scopes: Type.Optional(strings()),
	redirectDomain: Type.Optional(Type.String()),
	disabled: Type.Optional(Type.Boolean()),
});

export const ConnectionUse = Type.Object(
	{
		id: Type.String(),
		connectionId: Type.String(),
		organisationId: Type.String(),
		projectId: Type.Optional(Type.String()),
		sessionId: Type.String(),
		agentId: Type.Optional(Type.String()),
		actingUserId: Type.Optional(Type.String()),
		toolCallId: Type.Optional(Type.String({ description: "The tool call (step) that used it." })),
		kind: Type.Union([Type.Literal("mcp_tools"), Type.Literal("mcp_call"), Type.Literal("http")]),
		method: HttpMethodSchema,
		host: Type.String(),
		path: Type.String(),
		tool: Type.Optional(Type.String()),
		audience: SessionAudience,
		outcome: Type.Union([Type.Literal("allowed"), Type.Literal("denied")]),
		reason: Type.Optional(Type.String()),
		at: Timestamp,
	},
	{ title: "ConnectionUse", description: "Which connection a session used, at which step, and who could see it." },
);

export const ConnectionUsePage = Type.Object(
	{ items: Type.Array(ConnectionUse), nextCursor },
	{ title: "ConnectionUsePage" },
);

export const ListConnectionUsesQuery = Type.Object({
	connectionId: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	limit,
	cursor,
});
