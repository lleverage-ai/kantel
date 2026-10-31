/**
 * The Connections API's wire shapes (epic #322), each mirroring a type in `@kantel/contracts`'s `connections.ts`.
 * `test/types.test.ts` checks that each matches its contract type. No shape here carries a secret value except the
 * write-only inputs (`ConnectKeyBody.value`, `RotateKeyBody.value`, the OAuth client bodies' `clientSecret`).
 */
import Type, { type TSchema } from "typebox";
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
		"How Kantel gets an OAuth client: a pre-registered `client`, the deployment's client ID metadata document (`cimd`), or dynamic registration (`dcr`).",
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
		deviceAuthorizationUrl: Type.Optional(
			Type.String({
				description:
					"The device authorisation endpoint (RFC 8628). With a public client a connect signs in with a code typed at the provider.",
			}),
		),
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
		clientGuidance: Type.Optional(
			Type.String({ description: "Short notes for whoever registers an OAuth app for it." }),
		),
		guide: Type.Optional(
			Type.Union([Type.Literal("github_app_manifest"), Type.Literal("google")], {
				description: "Which built-in guide to registering an app applies.",
			}),
		),
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

export const SetupTier = Type.Union(
	[
		Type.Literal("none"),
		Type.Literal("public_client"),
		Type.Literal("own_app"),
		Type.Literal("host_client"),
		Type.Literal("key"),
	],
	{
		title: "SetupTier",
		description:
			"How a template connects for the caller: `none` (nothing to set up), `public_client` (the deployment's client with " +
			"no secret), `own_app` (an app the person or project registers), `host_client` (the deployment's or the " +
			"organisation's client) or `key`.",
	},
);

export const SetupStep = Type.Object(
	{
		title: Type.String(),
		detail: Type.String(),
		link: Type.Optional(Type.Object({ label: Type.String(), url: Type.String() })),
		values: Type.Optional(
			Type.Array(Type.Object({ label: Type.String(), value: Type.String() }), {
				description: "Values to copy exactly, such as the redirect URI.",
			}),
		),
	},
	{ title: "SetupStep", description: "One step of registering an app at a provider." },
);

export const SetupGuide = Type.Object(
	{
		kind: Type.Union([Type.Literal("github_app_manifest"), Type.Literal("steps")], {
			description: "`github_app_manifest`: Kantel can also have GitHub create the app (`startGitHubApp`).",
		}),
		provider: Type.String({ description: "Where the app is registered, such as `Google Cloud`." }),
		redirectUri: Type.String({ description: "This deployment's redirect URI, to register exactly." }),
		steps: Type.Array(SetupStep),
		notes: Type.Optional(
			Type.Array(
				Type.Object({ level: Type.Union([Type.Literal("info"), Type.Literal("warning")]), text: Type.String() }),
			),
		),
	},
	{ title: "SetupGuide", description: "How to register an app for a template, with this deployment's values in it." },
);

export const ResolvedClientInfo = Type.Object(
	{
		tier: OAuthClientTier,
		ownerLabel: Type.String({ description: "Whose it is, in words: the deployment's name, `your organisation`, …" }),
		label: Type.Optional(Type.String()),
		public: Type.Boolean({ description: "A public client: no secret, so it signs in with a code or PKCE alone." }),
	},
	{ title: "ResolvedClientInfo", description: "The OAuth client a new connect would use. No secret." },
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
		tier: SetupTier,
		signIn: Type.Optional(
			Type.Union([Type.Literal("browser"), Type.Literal("device")], {
				description: "For a ready OAuth connect: in a browser window, or by typing a code at the provider.",
			}),
		),
		scopeSets: Type.Array(ScopeSet),
		clientGuidance: Type.Optional(Type.String()),
		client: Type.Optional(ResolvedClientInfo),
		guide: Type.Optional(SetupGuide),
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

export const ConnectionsSettings = Type.Object(
	{
		personal: Type.Boolean({
			description:
				"Every session acting for a person is that person's alone (a deployment with one person), so their personal " +
				"connections work in all their sessions. False: a session is seen by its project, and a person's connection " +
				"is refused in it unless they share it with the project.",
		}),
	},
	{ title: "ConnectionsSettings", description: "How this deployment runs connections. No secrets." },
);

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
	{ title: "McpDiscovery", description: "What Kantel learnt about a remote MCP server from its URL." },
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
		device: Type.Optional(
			Type.Object(
				{
					userCode: Type.String({ description: "The code the person types at `verificationUri`." }),
					verificationUri: Type.String(),
					interval: Type.Integer({ minimum: 1, description: "Seconds between asking after the attempt." }),
				},
				{
					description:
						"A sign-in with a code (the OAuth device flow), while pending. Each read of the attempt asks the provider, at most once per interval.",
				},
			),
		),
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

export const GitHubAppInfo = Type.Object(
	{
		slug: Type.String(),
		appId: Type.Integer(),
		htmlUrl: Type.String({ description: "The app's settings page on GitHub." }),
		installUrl: Type.String({ description: "Where to install it on accounts and repositories." }),
	},
	{ title: "GitHubAppInfo", description: "A GitHub App GitHub created from Kantel's manifest." },
);

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
		public: Type.Optional(
			Type.Boolean({ description: "A public client: no secret, so it signs in with a code or PKCE alone." }),
		),
		githubApp: Type.Optional(GitHubAppInfo),
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "OAuthClient", description: "An OAuth app registration at a tenancy level. Its secret is write-only." },
);

export const StartGitHubAppBody = Type.Object({
	owner: Type.Union([Type.Literal("organisation"), Type.Literal("project"), Type.Literal("user")], {
		description: "Whose client the app becomes: the caller's organisation, a project (`projectId`) or the caller.",
	}),
	projectId: Type.Optional(Type.String({ minLength: 1 })),
	githubOrganisation: Type.Optional(
		Type.String({
			pattern: "^[A-Za-z0-9-]{1,39}$",
			description: "The GitHub organisation to create it in; the person's own GitHub account when absent.",
		}),
	),
	returnTo: Type.Optional(
		Type.String({ description: "Where GitHub's redirect back ends up: a path on this deployment, or an https URL." }),
	),
});

export const GitHubAppSetup = Type.Object(
	{
		id: id("The flow's ID."),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("created"),
			Type.Literal("failed"),
			Type.Literal("expired"),
		]),
		url: Type.Optional(
			Type.String({
				description:
					"Kantel's page that posts the manifest on to GitHub, with the single-use state in it. Only in the answer that starts the flow.",
			}),
		),
		clientId: Type.Optional(Type.String({ description: "The OAuth client record made, once created." })),
		githubApp: Type.Optional(GitHubAppInfo),
		failure: Type.Optional(Type.Object({ message: Type.String() })),
		expiresAt: Timestamp,
		createdAt: Timestamp,
	},
	{ title: "GitHubAppSetup", description: "A GitHub App manifest flow; GitHub requires it finished within an hour." },
);

export const GitHubAppPath = Type.Object({ setupId: Type.String({ minLength: 1 }) });

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
		outcome: Type.Union([Type.Literal("allowed"), Type.Literal("denied"), Type.Literal("held")], {
			description:
				"`allowed` went out, `denied` was refused, `held` waits for a person to approve the exact request and sent nothing (#333).",
		}),
		reason: Type.Optional(Type.String()),
		decision: Type.Optional(
			Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")], {
				description: "What the access rules answered, when the request got as far as them.",
			}),
		),
		decidedBy: Type.Optional(
			Type.Union(
				[
					Type.Literal("rule"),
					Type.Literal("unmatched"),
					Type.Literal("usage"),
					Type.Literal("connection"),
					Type.Literal("ceiling"),
					Type.Literal("listing"),
				],
				{ description: "What decided it." },
			),
		),
		ruleId: Type.Optional(Type.String({ description: "The deciding rule, when one did." })),
		rulesVersion: Type.Optional(Type.Integer({ minimum: 0 })),
		approvalId: Type.Optional(Type.String({ description: "For an approved `ask` (#333): the approval it spent." })),
		approval: Type.Optional(
			Type.Object(
				{
					id: Type.String({ description: "The approval: a connection request of kind `request`." }),
					digest: Type.String({ description: "The exact request's digest." }),
					state: Type.Union([Type.Literal("pending"), Type.Literal("used")]),
				},
				{ description: "When a rule said ask: the approval this use waited on or used (#333)." },
			),
		),
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

// Access rules (#332).

export const ConnectionRuleAction = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")], {
	title: "ConnectionRuleAction",
	description: "What a rule answers. `ask` goes to an approval (#333).",
});

export const ConnectionRuleWho = Type.Union(
	[
		Type.Object({ kind: Type.Literal("any") }),
		Type.Object({ kind: Type.Literal("organisation") }),
		Type.Object({ kind: Type.Literal("project"), projectId: id("The project.") }),
		Type.Object({ kind: Type.Literal("agent"), agentId: id("The agent profile.") }),
		Type.Object({ kind: Type.Literal("session"), sessionId: id("The session.") }),
	],
	{
		title: "ConnectionRuleWho",
		description:
			"Who a rule is for: any agent, organisation-level agents (sessions in no project), a project, an agent profile " +
			"or one session.",
	},
);

export const ConnectionRuleWhat = Type.Union(
	[
		Type.Object({ kind: Type.Literal("any") }),
		Type.Object({
			kind: Type.Literal("endpoint"),
			method: Type.Union([HttpMethodSchema, Type.Literal("*")]),
			path: Type.String({
				minLength: 1,
				description: "A path pattern of whole segments: `*` is one segment, a trailing `/**` any rest.",
			}),
			host: Type.Optional(Type.String({ description: "One of the connection's hosts. Default any of them." })),
		}),
		Type.Object({ kind: Type.Literal("tool"), tool: id("An MCP tool's exact name.") }),
	],
	{
		title: "ConnectionRuleWhat",
		description: "What a rule covers: any request, an API endpoint by method and path pattern, or one MCP tool.",
	},
);

export const ConnectionRule = Type.Object(
	{
		id: Type.String(),
		connectionId: Type.String(),
		who: ConnectionRuleWho,
		what: ConnectionRuleWhat,
		action: ConnectionRuleAction,
		expiresAt: Type.Optional(Timestamp),
		maxUses: Type.Optional(Type.Integer({ minimum: 1, description: "It stops matching once `uses` reaches this." })),
		uses: Type.Integer({ minimum: 0, description: "Requests it has allowed." }),
		source: Type.Union(
			[Type.Literal("default"), Type.Literal("person"), Type.Literal("approval"), Type.Literal("migrated")],
			{ description: "The template's defaults, a person, an approval's \"always allow\", or a migrated vault policy." },
		),
		approvalId: Type.Optional(Type.String({ description: 'The approval whose "always allow" saved it.' })),
		note: Type.Optional(Type.String()),
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "ConnectionRule", description: "One access rule on a connection." },
);

export const ConnectionRules = Type.Object(
	{
		connectionId: Type.String(),
		rules: Type.Array(ConnectionRule),
		unmatched: ConnectionRuleAction,
		version: Type.Integer({
			minimum: 0,
			description: "Goes up on every change to the rules, not on a use. Part of an approval's digest (#333).",
		}),
		updatedAt: Type.Optional(Timestamp),
	},
	{
		title: "ConnectionRules",
		description: "A connection's rules, and what a request no rule matches gets (`unmatched`).",
	},
);

const ruleFields = {
	expiresAt: Timestamp,
	maxUses: Type.Integer({ minimum: 1 }),
	note: Type.String({ maxLength: 500 }),
};

export const ConnectionRuleBody = Type.Object({
	who: ConnectionRuleWho,
	what: ConnectionRuleWhat,
	action: ConnectionRuleAction,
	expiresAt: Type.Optional(ruleFields.expiresAt),
	maxUses: Type.Optional(ruleFields.maxUses),
	note: Type.Optional(ruleFields.note),
});

const clearable = <T extends TSchema>(schema: T, description: string) =>
	Type.Optional(Type.Union([schema, Type.Null()], { description }));

export const ConnectionRuleFromApprovalBody = Type.Object({
	approvalId: Type.String({
		minLength: 1,
		description: "The approval of one exact request through this connection, still open or approved.",
	}),
	rule: Type.Object(
		{
			who: ConnectionRuleWho,
			what: ConnectionRuleWhat,
			action: Type.Literal("allow"),
			expiresAt: Type.Optional(ruleFields.expiresAt),
			maxUses: Type.Optional(ruleFields.maxUses),
			note: Type.Optional(ruleFields.note),
		},
		{ description: "An allow rule that covers the approved request, for the agent and session that sent it." },
	),
});

export const UpdateConnectionRuleBody = Type.Object({
	who: Type.Optional(ConnectionRuleWho),
	what: Type.Optional(ConnectionRuleWhat),
	action: Type.Optional(ConnectionRuleAction),
	expiresAt: clearable(ruleFields.expiresAt, "When it stops matching, or `null` for never."),
	maxUses: clearable(ruleFields.maxUses, "A use limit, or `null` for none."),
	note: clearable(ruleFields.note, "A note, or `null` to clear it."),
});

export const UpdateConnectionRulesBody = Type.Object({
	unmatched: Type.Optional(ConnectionRuleAction),
	reset: Type.Optional(
		Type.Literal("template", {
			description:
				"Replace the `default` rules with the template's (reads allow, writes ask) and set `unmatched` to ask.",
		}),
	),
});

export const RulePath = Type.Object({ connectionId: id("The connection."), ruleId: id("The rule.") });

export const DryRunConnectionBody = Type.Object({
	method: HttpMethodSchema,
	url: Type.Optional(Type.String({ description: "The full URL. For an MCP connection, default its server's." })),
	tool: Type.Optional(Type.String({ description: "For an MCP connection: the tool to call. Without it, listing." })),
	agentId: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	actingUserId: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description: "The person the session acts for. Default the caller; `null` for an unattended session.",
		}),
	),
	audience: Type.Optional(
		Type.Union([Type.Literal("private"), Type.Literal("shared")], {
			description: "Who can see the session. Default `private` in a one-person deployment, else `shared`.",
		}),
	),
});

export const ConnectionDecisionSource = Type.Union(
	[
		Type.Object({ kind: Type.Literal("rule"), ruleId: Type.String() }),
		Type.Object({ kind: Type.Literal("unmatched") }),
		Type.Object({ kind: Type.Literal("usage") }),
		Type.Object({ kind: Type.Literal("connection") }),
		Type.Object({ kind: Type.Literal("ceiling") }),
		Type.Object({ kind: Type.Literal("listing") }),
	],
	{ title: "ConnectionDecisionSource", description: "What decided a request." },
);

export const ConnectionDecision = Type.Object(
	{
		action: ConnectionRuleAction,
		by: ConnectionDecisionSource,
		rule: Type.Optional(ConnectionRule),
		reason: Type.String(),
		rulesVersion: Type.Integer({ minimum: 0 }),
	},
	{ title: "ConnectionDecision", description: "What the proxy does with one request, and why." },
);

export const RouteScopeSchema = Type.Object(
	{
		host: Type.String({ minLength: 1, description: "An exact host name, lower case." }),
		methods: Type.Array(HttpMethodSchema),
		pathPrefix: Type.String({ description: "Whole segments: `/repos` covers `/repos/x`, never `/repositories`." }),
	},
	{ title: "RouteScope" },
);

export const ConnectionCeiling = Type.Object(
	{
		set: Type.Boolean({ description: "`false`: the organisation has no ceiling, and nothing is bounded." }),
		routes: Type.Array(RouteScopeSchema),
	},
	{ title: "ConnectionCeiling", description: "The organisation's ceiling: no rule may allow or ask outside it." },
);

export const SetConnectionCeilingBody = Type.Object({ routes: Type.Array(RouteScopeSchema) });
