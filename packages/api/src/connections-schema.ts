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

export const RevocationStyle = Type.Union([Type.Literal("rfc7009"), Type.Literal("github_grant")], {
	title: "RevocationStyle",
	description:
		"How a provider's revocation endpoint is called: `rfc7009` (a form POST of the token), or `github_grant` (GitHub's `DELETE /applications/{client_id}/grant`).",
});

export const ProviderOAuth = Type.Object(
	{
		discovery: Type.Union([Type.Literal("static"), Type.Literal("mcp")]),
		authorizationUrl: Type.Optional(Type.String()),
		tokenUrl: Type.Optional(Type.String()),
		revocationUrl: Type.Optional(
			Type.String({
				description:
					"Where a disconnect revokes the connection's tokens: RFC 7009, or the provider's own endpoint for `revocationStyle`. `{client_id}` is the connection's client ID.",
			}),
		),
		revocationStyle: Type.Optional(RevocationStyle),
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
		manageAccessUrl: Type.Optional(
			Type.String({ description: "The provider's own page where a person removes an app's access." }),
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

export const GitHubAppInfo = Type.Object(
	{
		slug: Type.String(),
		appId: Type.Integer(),
		htmlUrl: Type.String({ description: "The app's settings page on GitHub." }),
		installUrl: Type.String({ description: "Where to install it on accounts and repositories." }),
	},
	{ title: "GitHubAppInfo", description: "A GitHub App GitHub created from Kantel's manifest." },
);

export const ResolvedClientInfo = Type.Object(
	{
		tier: OAuthClientTier,
		ownerLabel: Type.String({ description: "Whose it is, in words: the deployment's name, `your organisation`, …" }),
		label: Type.Optional(Type.String()),
		public: Type.Boolean({ description: "A public client: no secret, so it signs in with a code or PKCE alone." }),
		githubApp: Type.Optional(GitHubAppInfo),
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

export const ConnectionHealth = Type.Object(
	{
		state: Type.Union([Type.Literal("ok"), Type.Literal("refresh_failing"), Type.Literal("needs_reconnect")], {
			description:
				"`ok`: the last refresh worked. `refresh_failing`: the last refresh failed in a way that may pass (no answer, a 5xx, a rate limit); the connection stays active and Kantel retries with backoff. `needs_reconnect`: the provider refused the refresh token; requests are refused with `connection_reconnect_required` until a person connects it again.",
		}),
		since: Timestamp,
		reason: Type.Optional(Type.String({ description: "The last failure, in plain words. Never a secret." })),
		failures: Type.Optional(Type.Integer({ minimum: 0, description: "Refreshes that failed in a row." })),
		retryAt: Type.Optional(Type.Integer({ description: "When Kantel tries again. Epoch milliseconds, UTC." })),
		refreshedAt: Type.Optional(Type.Integer({ description: "When a refresh last worked. Epoch milliseconds, UTC." })),
	},
	{
		title: "ConnectionHealth",
		description: "A connection's health, which Kantel sets from its token refreshes (#328), apart from its status.",
	},
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

export const ConnectionShare = Type.Object(
	{
		projectId: id("The project it is shared with."),
		sharedBy: Actor,
		sharedAt: Timestamp,
	},
	{
		title: "ConnectionShare",
		description: "A person's connection shared with a project (#335): explicit, audited and revocable.",
	},
);

export const ShareConnectionBody = Type.Object({ projectId: id("The project to share it with.") });

export const ConnectionSharePath = Type.Object({
	connectionId: id("The connection."),
	projectId: id("The project it is shared with."),
});

const ConnectionStatus = Type.Union(
	[Type.Literal("active"), Type.Literal("needs_reauth"), Type.Literal("failing_test"), Type.Literal("disabled")],
	{ title: "ConnectionStatus" },
);

export const EgressRefusalCode = Type.Union(
	[
		Type.Literal("host_not_bound"),
		Type.Literal("raw_secret"),
		Type.Literal("unknown_placeholder"),
		Type.Literal("ambiguous_placeholder"),
		Type.Literal("connection_not_usable"),
		Type.Literal("needs_reauth"),
		Type.Literal("https_required"),
		Type.Literal("rule_denied"),
		Type.Literal("approval_pending"),
		Type.Literal("egress_denied"),
		Type.Literal("egress_unavailable"),
	],
	{
		title: "EgressRefusalCode",
		description:
			"Why the egress gate refused a sandbox's request (#331): `host_not_bound` (the placeholder's connection is not for that host), `raw_secret` (a stored secret's own value, not its placeholder), `unknown_placeholder`, `ambiguous_placeholder`, `connection_not_usable`, `needs_reauth`, `https_required`, `rule_denied`, `approval_pending`, `egress_denied` or `egress_unavailable`.",
	},
);

export const EgressRefusal = Type.Object(
	{
		error: EgressRefusalCode,
		message: Type.String({ description: "Why, in a sentence. Never carries a secret." }),
		fix: Type.Optional(
			Type.Object({
				action: Type.Union([
					Type.Literal("use_placeholder"),
					Type.Literal("change_host"),
					Type.Literal("use_https"),
					Type.Literal("request_connection"),
					Type.Literal("ask_approval"),
					Type.Literal("reconnect"),
					Type.Literal("none"),
				]),
				message: Type.String(),
				link: Type.Optional(Type.String()),
			}),
		),
		connectionId: Type.Optional(Type.String()),
		approvalId: Type.Optional(Type.String()),
		digest: Type.Optional(Type.String()),
		link: Type.Optional(Type.String()),
		bindingCode: Type.Optional(Type.String()),
		expiresAt: Type.Optional(Type.Number()),
	},
	{
		title: "EgressRefusal",
		description:
			"The JSON body of the 403 the egress gate answers a sandbox's outbound request with when it refuses it (#331). `approval_pending` adds the approval to wait on.",
	},
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
		placeholder: Type.Optional(
			Type.String({
				pattern: "^kantel-cn-[0-9a-f]{32}$",
				description:
					"What a sandbox sends where the credential goes (#331). Not a secret: the egress gate swaps it for the credential, only for a session that may use the connection, only to one of its hosts.",
			}),
		),
		account: Type.Optional(ConnectionAccount),
		scopes: Type.Object({ requested: strings(), granted: strings() }),
		client: Type.Optional(ConnectionClientRef),
		usage: ConnectionUsage,
		shares: Type.Optional(
			Type.Array(ConnectionShare, {
				description:
					"For a person's connection: the projects its owner shared it with (#335). Any attended session there may use it.",
			}),
		),
		status: ConnectionStatus,
		health: Type.Optional(ConnectionHealth),
		credential: CredentialState,
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "Connection", description: "One authorisation against a provider or remote MCP server. No secret." },
);

export const ConnectionPage = Type.Object({ items: Type.Array(Connection), nextCursor }, { title: "ConnectionPage" });

export const RevocationOutcome = Type.Union(
	[Type.Literal("revoked"), Type.Literal("unsupported"), Type.Literal("failed"), Type.Literal("none")],
	{
		title: "RevocationOutcome",
		description:
			"What a disconnect did at the provider: `revoked`, `unsupported` (the provider gives Kantel no way to revoke, or it is a key), `failed` (the provider refused or didn't answer; the connection is removed all the same) or `none` (nothing to revoke).",
	},
);

export const ConnectionRevocation = Type.Object(
	{
		outcome: RevocationOutcome,
		endpoint: Type.Optional(Type.String({ description: "The endpoint Kantel called. Never carries a token." })),
		reason: Type.Optional(Type.String({ description: "Why it is `unsupported` or `failed`, in plain words." })),
		manageUrl: Type.Optional(Type.String({ description: "The provider's page for removing an app's access." })),
	},
	{ title: "ConnectionRevocation" },
);

export const ConnectionRemoval = Type.Object(
	{
		connectionId: Type.String(),
		revocation: ConnectionRevocation,
		rulesRemoved: Type.Integer({ minimum: 0, description: "Standing access rules removed with it." }),
		approvalsWithdrawn: Type.Integer({
			minimum: 0,
			description: "Approvals of exact requests not yet used, withdrawn or stopped with it.",
		}),
	},
	{ title: "ConnectionRemoval", description: "What a disconnect did, in Kantel and at the provider." },
);

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
		unattended: Type.Optional(
			Type.Literal(true, {
				description:
					"Made in a session no person was watching, a schedule's run. With `actingUserId`, the run acted for that person.",
			}),
		),
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
		viaShare: Type.Optional(
			Type.Boolean({
				description: "A person's connection used in a project it is shared with, not by its owner's own session.",
			}),
		),
		egress: Type.Optional(
			Type.Literal(true, {
				description: "Sent by the sandbox through the egress gate with the connection's placeholder (#331).",
			}),
		),
		refusal: Type.Optional(EgressRefusalCode),
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
					state: Type.Union(
						[
							Type.Literal("pending"),
							Type.Literal("used"),
							Type.Literal("approved"),
							Type.Literal("denied"),
							Type.Literal("expired"),
							Type.Literal("withdrawn"),
						],
						{
							description:
								"`used` once it let the request out, `pending` while a person has yet to decide; a held use whose approval has since ended says how (#481).",
						},
					),
				},
				{ description: "When a rule said ask: the approval this use waited on or used (#333)." },
			),
		),
		at: Timestamp,
	},
	{ title: "ConnectionUse", description: "Which connection a session used, at which step, and who could see it." },
);

export const RedactedConnectionUse = Type.Object(
	{
		id: Type.String(),
		connectionId: Type.String(),
		organisationId: Type.String(),
		redacted: Type.Literal(true),
		actingUserId: Type.String({ description: "The person the session acted for." }),
		audience: Type.Object({ kind: Type.Literal("private"), userId: Type.String() }),
		outcome: Type.Union([Type.Literal("allowed"), Type.Literal("denied"), Type.Literal("held")]),
		at: Timestamp,
	},
	{
		title: "RedactedConnectionUse",
		description:
			"A use in a private session the caller can't open (#335): when, how it ended and for whom. No session, step, " +
			"agent, project, request or reason.",
	},
);

export const ConnectionUsePage = Type.Object(
	{ items: Type.Array(Type.Union([ConnectionUse, RedactedConnectionUse])), nextCursor },
	{ title: "ConnectionUsePage" },
);

export const UsableConnection = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		kind: ConnectionKind,
		templateId: Type.Optional(Type.String()),
		owner: Type.Union([Type.Literal("organisation"), Type.Literal("project"), Type.Literal("user")]),
		account: Type.Optional(ConnectionAccount),
		hosts: strings(),
		mcpUrl: Type.Optional(Type.String()),
		placeholder: Type.Optional(
			Type.String({ description: "The connection's placeholder (#331), sent in the credential's place." }),
		),
		env: Type.Optional(
			Type.String({ description: "The sandbox's environment variable holding it, such as KANTEL_CONNECTION_GITHUB." }),
		),
	},
	{ title: "UsableConnection", description: "A connection as a session sees it: no credential." },
);

export const SessionConnectionEligibility = Type.Object(
	{
		connection: UsableConnection,
		ownerId: Type.Optional(
			Type.String({ description: "The owner's user or project ID; absent for the organisation's." }),
		),
		usable: Type.Boolean(),
		reason: Type.Optional(Type.String({ description: "Why the session may not use it." })),
		viaShare: Type.Optional(Type.Boolean({ description: "Usable because its owner shared it with the project." })),
	},
	{
		title: "SessionConnectionEligibility",
		description: "Whether a session may use one connection, and if not, why (#335).",
	},
);

export const ConnectionReachInstallation = Type.Object(
	{
		id: Type.Integer({ description: "GitHub's installation ID." }),
		account: Type.Object({
			login: Type.String(),
			type: Type.Union([Type.Literal("User"), Type.Literal("Organization")]),
		}),
		repositorySelection: Type.Union([Type.Literal("all"), Type.Literal("selected")], {
			description: "`all`: every repository the account has. `selected`: only those chosen at install.",
		}),
		manageUrl: Type.String({ description: "The installation's settings page on GitHub." }),
	},
	{ title: "ConnectionReachInstallation", description: "One installation of the GitHub App the person can reach." },
);

export const ConnectionReachRepository = Type.Object(
	{
		fullName: Type.String({ description: "`owner/name`." }),
		owner: Type.String(),
		private: Type.Boolean(),
	},
	{ title: "ConnectionReachRepository" },
);

export const ConnectionReach = Type.Object(
	{
		connectionId: Type.String(),
		installations: Type.Array(ConnectionReachInstallation),
		repositories: Type.Array(ConnectionReachRepository),
		total: Type.Integer({ description: "How many repositories GitHub counts in all, listed or not." }),
		truncated: Type.Boolean({ description: "GitHub has more than were listed (at most 300)." }),
		manageUrl: Type.Optional(Type.String({ description: "Where to choose the repositories on GitHub." })),
		checkedAt: Timestamp,
	},
	{
		title: "ConnectionReach",
		description:
			"What a connection can reach at its provider (#461), read through it now: for GitHub, the app's installations and their repositories. Never a secret.",
	},
);

export const SessionConnectionsAnswer = Type.Object(
	{ items: Type.Array(SessionConnectionEligibility) },
	{ title: "SessionConnections" },
);

export const SessionConnectionsQuery = Type.Object({
	sessionId: id("The session."),
	visibility: Type.Optional(
		Type.Union([Type.Literal("private"), Type.Literal("shared")], {
			description: "Answer as if the session had this visibility. Default its own.",
		}),
	),
});

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
		defaults: Type.Optional(
			Type.Object(
				{
					reason: Type.Union([Type.Literal("created"), Type.Literal("migrated"), Type.Literal("reset")], {
						description:
							"`created` with the connection, `migrated` from a connection made before rules (which let every request through), or `reset` by a person.",
					}),
					at: Timestamp,
				},
				{ description: "The last time Kantel set these rules to the template's defaults, and why." },
			),
		),
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
				"Replace the `default` rules with the template's (reads allow, writes ask, deletes deny) and set `unmatched` to ask.",
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
