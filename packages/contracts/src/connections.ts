/**
 * Connections (epic #322): how people and organisations connect agents to outside services, by OAuth or by key,
 * without an agent ever seeing a secret. The vault stays the encrypted store underneath: a connection's token or key is
 * a vault item's value, and nothing but the egress path ever opens it.
 *
 * Records:
 * - **Provider template** (#325): a catalogue entry describing a service, held as data. Shipped with Harbour, added by
 *   a deployment, or private to an organisation.
 * - **OAuth client** (#326): an OAuth app registration, owned at a tenancy level: the deployment (`platform`), an
 *   organisation, a project or a person. Its secret is write-only.
 * - **Connection**: one authorisation against a provider or a remote MCP server (#338), by OAuth (#327), by key
 *   (#330), or open (no auth). Several connections to one provider may coexist, each with its own owner and its own
 *   usage scope (who may use it, where, and in which sessions).
 * - **Connect attempt**: one OAuth sign-in in progress, with its single-use state.
 * - **Connection use**: which connection a session used, at which step, and who could see that session. It is how
 *   Harbour keeps a person's private connection out of sessions others can see (#335).
 *
 * Rules every implementation keeps:
 * - No read, list, event, log or error carries a secret: tokens, keys and client secrets are write-only. A credential
 *   shows as `set` and, for a key or client secret, its last four characters.
 * - Every credential is bound to its hosts and goes out only over https.
 * - An OAuth connection stays pinned to the client that minted it; refreshes always use that client.
 * - Agents never create, change or delete connections, clients or templates; they use connections through tools.
 */
import type {
	Actor,
	AgentId,
	CallContext,
	OrganisationId,
	OwnerRef,
	Page,
	PageRequest,
	ProjectId,
	SessionId,
	SystemContext,
	Timestamp,
	UserId,
} from "./common.ts";
import type {
	ConnectionCeiling,
	ConnectionDecision,
	ConnectionDecisionSource,
	ConnectionRule,
	ConnectionRuleAction,
	ConnectionRuleInput,
	ConnectionRules,
	DryRunConnectionRequest,
	UpdateConnectionRuleInput,
	UpdateConnectionRulesInput,
} from "./connection-rules.ts";
import type { ApprovalRequestInput, HttpMethod, Proposal, RouteScope } from "./vault.ts";

// Catalogue (#325).

/** How a connection authenticates. A template lists the ones it supports. */
export type ConnectionAuthType =
	/** OAuth 2 authorisation code, with PKCE where the provider supports it. */
	| "oauth2"
	/** OAuth 2 client credentials: a machine-to-machine token from a client the owner registers. */
	| "oauth2_client_credentials"
	/** A key sent as `Authorization: Bearer <key>`. */
	| "bearer"
	/** A key in a named header, with an optional prefix. */
	| "header"
	/** A key in a query parameter. */
	| "query"
	/** HTTP basic auth. */
	| "basic"
	/** A header built from a template, such as `token {key}`. */
	| "header_template"
	/** No credential: an open remote MCP server or API. */
	| "none";

export const CONNECTION_AUTH_TYPES: readonly ConnectionAuthType[] = [
	"oauth2",
	"oauth2_client_credentials",
	"bearer",
	"header",
	"query",
	"basic",
	"header_template",
	"none",
];

/** Where a template sits in the catalogue. */
export type ProviderCategory =
	| "developer"
	| "productivity"
	| "communication"
	| "knowledge"
	| "project_management"
	| "crm"
	| "payments"
	| "ai"
	| "cloud"
	| "data"
	| "design"
	| "other";

export const PROVIDER_CATEGORIES: readonly ProviderCategory[] = [
	"developer",
	"productivity",
	"communication",
	"knowledge",
	"project_management",
	"crm",
	"payments",
	"ai",
	"cloud",
	"data",
	"design",
	"other",
];

/** `mcp`: a remote MCP server the agent calls tools on. `http`: an HTTP API the agent sends requests to. */
export type ConnectionKind = "mcp" | "http";

/** Whether a scope set, endpoint or tool reads or writes. Default rules (#332) build on it: reads allow, writes ask. */
export type AccessKind = "read" | "write";

/** A named group of scopes. A connect asks for the default sets unless a person picks more. */
export interface ScopeSet {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly access: AccessKind;
	readonly scopes: readonly string[];
	/** Part of the minimum a connect asks for when nobody picks. */
	readonly default?: boolean;
}

/** A method and path pattern marked read or write. `*` in a path matches one segment; a trailing `/**` the rest. */
export interface EndpointHint {
	readonly method: HttpMethod | "*";
	readonly path: string;
	readonly access: AccessKind;
}

/** How a key goes out on a request. */
export type KeyInjection =
	| { readonly kind: "bearer" }
	| { readonly kind: "header"; readonly header: string; readonly prefix?: string }
	| { readonly kind: "query"; readonly param: string }
	| { readonly kind: "basic" }
	| { readonly kind: "header_template"; readonly header: string; readonly template: string };

/** What a provider's keys look like, for suggesting a template when a key is pasted (#330). It only suggests. */
export interface KeyShape {
	readonly label: string;
	readonly prefix?: string;
	/** A regular expression the whole key matches. */
	readonly pattern?: string;
}

/** A cheap call that proves a credential works and says whose it is. */
export interface TestRequest {
	readonly method: HttpMethod;
	/** An absolute https URL on one of the template's API hosts. */
	readonly url: string;
	/** Dotted paths into the JSON answer for the account's identity, such as `login` or `user.email`. */
	readonly account?: { readonly id?: string; readonly name?: string; readonly email?: string };
}

/** How Harbour gets an OAuth client for a connect, in the order it tries them (#326, #338). */
export type ClientRegistration =
	/** A pre-registered OAuth client a person, project, organisation or the deployment supplies. */
	| "client"
	/** The deployment's published client ID metadata document: its URL is the client ID. */
	| "cimd"
	/** Dynamic client registration (RFC 7591), once per deployment and authorisation server. A fallback. */
	| "dcr";

export interface ProviderOAuth {
	/**
	 * `static`: the endpoints below. `mcp`: discovered from the MCP server's protected-resource metadata and its
	 * authorisation server's metadata (RFC 9728, RFC 8414), as the MCP authorisation spec says.
	 */
	readonly discovery: "static" | "mcp";
	readonly authorizationUrl?: string;
	readonly tokenUrl?: string;
	readonly revocationUrl?: string;
	/** Default a space. */
	readonly scopeSeparator?: string;
	/** Such as `{ "access_type": "offline", "prompt": "consent" }`. */
	readonly extraAuthorizationParams?: { readonly [name: string]: string };
	readonly pkce: boolean;
	/** Refresh this many seconds before the access token expires. Default 60. */
	readonly refreshBufferSeconds?: number;
	readonly rotatesRefreshTokens?: boolean;
	/** The ways a client may be had for this provider, in the order tried. Only `client` needs an app registered. */
	readonly registration: readonly ClientRegistration[];
	/**
	 * The device authorisation endpoint (RFC 8628), such as GitHub's `https://github.com/login/device/code`. With a
	 * public client (no secret) a connect signs in with a code the person types at the provider instead of a redirect.
	 */
	readonly deviceAuthorizationUrl?: string;
}

/** A provider template: everything Harbour needs to connect a service and inject for it, with no provider code. */
export interface ProviderTemplate {
	/** Stable, lower case, such as `github` or `linear-mcp`. */
	readonly id: string;
	/** Bumped on every change. A connection records the version it was made with. */
	readonly version: number;
	readonly name: string;
	readonly description: string;
	/** An https URL or a `data:image/svg+xml` URI. */
	readonly icon: string;
	readonly docsUrl: string;
	readonly category: ProviderCategory;
	readonly kind: ConnectionKind;
	readonly authTypes: readonly ConnectionAuthType[];
	/** Hosts the credential may be sent to, never empty. Injection never goes beyond them, whatever a rule says. */
	readonly apiHosts: readonly string[];
	/** For `kind: "mcp"`: the remote MCP server's Streamable HTTP endpoint. */
	readonly mcp?: { readonly url: string };
	readonly oauth?: ProviderOAuth;
	/** For key auth types: how the key goes out, and what keys look like. */
	readonly key?: { readonly injection: KeyInjection; readonly shapes?: readonly KeyShape[] };
	readonly scopeSets: readonly ScopeSet[];
	readonly endpointHints: readonly EndpointHint[];
	readonly testRequest?: TestRequest;
	/** `shipped` with Harbour, added or overridden by the `deployment`, or an `organisation`'s private template. */
	readonly source: "shipped" | "deployment" | "organisation";
	/** Short provider-specific notes for whoever registers an OAuth app for it (#340). */
	readonly clientGuidance?: string;
	/**
	 * Which built-in guide to registering an app applies (#326): `github_app_manifest` (GitHub can create the app from
	 * Harbour's manifest in one click, or it is registered by hand) or `google` (a Google Cloud OAuth client).
	 */
	readonly guide?: "github_app_manifest" | "google";
}

/**
 * How a template connects for a caller, by the setup tiers in #325. No build ships a confidential client secret, so a
 * provider with no automatic registration needs a public client, an app someone registers, or a client provided:
 * - `none`: nothing to set up: an open server, or one Harbour registers with itself through CIMD or DCR. Tier 1.
 * - `public_client`: a client ID the deployment supplies with no secret, signing in with a code (the device flow) or
 *   with PKCE alone. Tier 2.
 * - `own_app`: a client the person or their project registered, or one still to register (with a guide where Harbour
 *   has one). Tier 3.
 * - `host_client`: a confidential client the deployment (the platform) or the organisation supplies. Tier 4.
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
 * How to register an app for a template (tier 3), with this deployment's redirect URI and the template's scopes in its
 * steps. `github_app_manifest`: Harbour can also have GitHub create the app in one click (`startGitHubApp`).
 */
export interface SetupGuide {
	readonly kind: "github_app_manifest" | "steps";
	/** Where the app is registered: "Google Cloud", "GitHub". */
	readonly provider: string;
	readonly redirectUri: string;
	readonly steps: readonly SetupStep[];
	readonly notes?: readonly { readonly level: "info" | "warning"; readonly text: string }[];
}

/** The OAuth client a new connect to a template would use, as the catalogue resolves it for the caller. No secret. */
export interface ResolvedClientInfo {
	readonly tier: OAuthClientTier;
	/** Whose it is, in words: the deployment's name, "your organisation", "your project" or "you". */
	readonly ownerLabel: string;
	/** The client's own label. */
	readonly label?: string;
	/** A public client: it has no secret, so it signs in with a code or with PKCE alone. */
	readonly public: boolean;
}

/**
 * Whether a caller can connect a template now:
 * - `ready`: nothing to set up (an open server, a key, CIMD or DCR), or an OAuth client resolves for the caller.
 * - `needs_client`: it needs an OAuth app someone must register first (#326); `clientTiers` says who may.
 */
export type CatalogueSetup = "ready" | "needs_client";

/** A template as the catalogue lists it. */
export interface CatalogueEntry {
	readonly id: string;
	readonly version: number;
	readonly name: string;
	readonly description: string;
	readonly icon: string;
	readonly docsUrl: string;
	readonly category: ProviderCategory;
	readonly kind: ConnectionKind;
	readonly authTypes: readonly ConnectionAuthType[];
	readonly mcpUrl?: string;
	readonly source: ProviderTemplate["source"];
	readonly setup: CatalogueSetup;
	/** For `needs_client`: the tenancy levels whose OAuth client would make it ready, for this caller. */
	readonly clientTiers?: readonly OAuthClientTier[];
	/** The setup tier it connects through for this caller. */
	readonly tier: SetupTier;
	/** For a ready OAuth connect: in a browser window, or by typing a code at the provider (the device flow). */
	readonly signIn?: "browser" | "device";
	readonly scopeSets: readonly ScopeSet[];
	readonly clientGuidance?: string;
	/** The client a connect would use now, if one resolves. */
	readonly client?: ResolvedClientInfo;
	/** How to register an app for it, when one is needed or wanted. */
	readonly guide?: SetupGuide;
}

export interface CatalogueQuery {
	readonly category?: ProviderCategory;
	readonly authType?: ConnectionAuthType;
	readonly kind?: ConnectionKind;
	/** Matches the name, ID, description and category, case-insensitively. */
	readonly q?: string;
}

/** What Harbour learnt about a remote MCP server from its URL, before connecting (#338). */
export interface McpDiscovery {
	readonly url: string;
	/** `oauth`: it needs a sign-in. `none`: it answered without one. `unknown`: it refused and named no sign-in. */
	readonly auth: "oauth" | "none" | "unknown";
	/** The protected resource the tokens are for (RFC 9728 `resource`). */
	readonly resource?: string;
	readonly authorizationServer?: string;
	/** The ways a client can be had from that authorisation server, in the order Harbour would try them. */
	readonly registration: readonly ClientRegistration[];
	/** `scopes_supported` from the server's metadata. */
	readonly scopes?: readonly string[];
	/** The catalogue template for this server, when there is one. */
	readonly templateId?: string;
}

// Connections (#327, #330, #335, #338).

/** Who owns a connection: an organisation, a project, or a person. */
export type ConnectionOwner = Extract<OwnerRef, { readonly kind: "organisation" | "project" | "user" }>;

/**
 * Who may see a session: only the person it acts for (`private`), or more people than that (`shared`): the project's
 * or the organisation's members, a share, a supervisor or a host app. Harbour derives it from the session; a session
 * with no acting person is `shared`. In a deployment with one person (a personal agent such as Sal or Erys) every
 * session that acts for that person is `private`, so personal connections work everywhere there.
 */
export type SessionAudience = { readonly kind: "private"; readonly userId: UserId } | { readonly kind: "shared" };

/**
 * Where a connection may be used, by whom and in which sessions. Every condition given must hold; an absent one does
 * not narrow. The owner always bounds it: a project's connection never leaves its project, a person's never leaves
 * sessions acting for that person unless they share it (#335).
 */
export interface ConnectionUsage {
	/** For an organisation's connection: only sessions in these projects. Absent: any project and organisation sessions. */
	readonly projects?: readonly ProjectId[];
	/**
	 * Only sessions acting for one of these people (`SessionRecord.userId`). A person's connection is always limited to
	 * that person, whatever is set here.
	 */
	readonly actingUsers?: readonly UserId[];
	/** Only sessions of these agent profiles. */
	readonly agents?: readonly AgentId[];
	/** Whether sessions with no person behind them (schedules, triggers, webhooks) may use it. Never for a person's. */
	readonly unattended: boolean;
	/**
	 * `private`: data from it may only reach sessions nobody but the acting person can see (`SessionAudience` private).
	 * `shared`: any session the rest allows. Default `private` for a person's connection, `shared` otherwise.
	 */
	readonly visibility: "private" | "shared";
}

export type ConnectionStatus =
	/** Working as far as Harbour knows. */
	| "active"
	/** The token was refused or can't be refreshed: someone must connect again. */
	| "needs_reauth"
	/** Stored, but the service refused it (401 or 403) on the template's test request. Still usable. */
	| "failing_test"
	| "disabled";

/** A credential's state, never its value. */
export interface CredentialState {
	readonly set: boolean;
	/** A key's or client secret's last four characters. Never shown for OAuth tokens. */
	readonly last4?: string;
	/** When the access token expires, if the provider said. */
	readonly expiresAt?: Timestamp;
	/** Whether Harbour holds a refresh token for it. */
	readonly refreshable: boolean;
	readonly updatedAt?: Timestamp;
}

/** Whose account the credential belongs to, from the token response or the template's test request. */
export interface ConnectionAccount {
	readonly id?: string;
	readonly name?: string;
	readonly email?: string;
}

/** The OAuth client an OAuth connection is pinned to. */
export interface ConnectionClientRef {
	readonly via: ClientRegistration;
	/** The public client ID the provider knows. */
	readonly clientId: string;
	/** For `via: "client"`: the `OAuthClient` record and its tier. */
	readonly oauthClientId?: string;
	readonly tier?: OAuthClientTier;
}

export interface Connection {
	readonly id: string;
	readonly organisationId: OrganisationId;
	readonly owner: ConnectionOwner;
	readonly name: string;
	/** The template it was made from; absent for a remote MCP server or a custom API with no template. */
	readonly templateId?: string;
	readonly templateVersion?: number;
	readonly kind: ConnectionKind;
	readonly auth: "oauth2" | "key" | "none";
	/** For `kind: "mcp"`: the server's endpoint and the protected resource its tokens are for. */
	readonly mcp?: { readonly url: string; readonly resource?: string };
	/** Hosts the credential may be sent to. */
	readonly hosts: readonly string[];
	readonly account?: ConnectionAccount;
	/** Scopes asked for and scopes the provider actually granted. */
	readonly scopes: { readonly requested: readonly string[]; readonly granted: readonly string[] };
	readonly client?: ConnectionClientRef;
	readonly usage: ConnectionUsage;
	readonly status: ConnectionStatus;
	readonly credential: CredentialState;
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

export interface ConnectionFilter {
	readonly ownerKind?: ConnectionOwner["kind"];
	/** The owner's organisation, project or user ID, with `ownerKind`. */
	readonly ownerId?: string;
	readonly templateId?: string;
	readonly kind?: ConnectionKind;
}

export interface UpdateConnectionInput {
	readonly name?: string;
	readonly usage?: ConnectionUsage;
	/** `disabled` stops every use at once; `active` turns it back on. */
	readonly status?: "active" | "disabled";
}

/** Starting an OAuth connect (#327): from a template or a remote MCP server's URL. */
export interface StartConnectInput {
	/** A catalogue template. Give this or `mcpUrl`. */
	readonly templateId?: string;
	/** A remote MCP server's endpoint, for a server with no template. */
	readonly mcpUrl?: string;
	readonly owner: ConnectionOwner;
	readonly name?: string;
	/** Scope sets to ask for; default the template's default sets. */
	readonly scopeSets?: readonly string[];
	/** Explicit scopes, added to the sets'. */
	readonly scopes?: readonly string[];
	readonly usage?: ConnectionUsage;
	/**
	 * A handover link: the person who must complete it, such as a shared mailbox's owner. Default the caller when a
	 * person; a host app (a service) must name one.
	 */
	readonly forUserId?: UserId;
	/** Reconnect or widen an existing connection: it keeps its ID, rules and history. */
	readonly connectionId?: string;
	/** Where the final page sends the person afterwards: a path on this deployment, or an https URL. */
	readonly returnTo?: string;
}

export type ConnectAttemptStatus = "pending" | "completed" | "failed" | "expired";

/** Why a connect failed, for the caller and the final page. */
export type ConnectFailureCode =
	/** Someone other than the person the link was made for completed it. Nothing was stored. */
	| "user_mismatch"
	/** No OAuth client resolves for this template: `clientTiers` on the catalogue entry says who may register one. */
	| "no_client"
	/** The person declined at the provider, or the provider refused. */
	| "denied"
	/** The state was replayed, expired or from another deployment. Nothing was stored. */
	| "invalid_state"
	| "exchange_failed"
	| "discovery_failed"
	| "registration_failed";

/** One OAuth sign-in in progress. The connect URL and its state expire after 15 minutes and can be used once. */
export interface ConnectAttempt {
	readonly id: string;
	readonly organisationId: OrganisationId;
	readonly status: ConnectAttemptStatus;
	/**
	 * The URL to open, on this deployment: it checks who opens it and sends them on to the provider. Present while
	 * `pending`; the final page reports the result.
	 */
	readonly connectUrl?: string;
	readonly owner: ConnectionOwner;
	readonly templateId?: string;
	readonly mcpUrl?: string;
	/** The person who must complete it. */
	readonly forUserId?: UserId;
	/** Set once `completed`. */
	readonly connectionId?: string;
	readonly failure?: { readonly code: ConnectFailureCode; readonly message: string };
	/**
	 * A sign-in with a code (the OAuth device flow, RFC 8628), while `pending`: the code the person types at
	 * `verificationUri` (which is also the `connectUrl`), and how many seconds apart to ask after the attempt. The device
	 * code itself never leaves Harbour. Each `getAttempt` asks the provider, at most once per `interval`.
	 */
	readonly device?: { readonly userCode: string; readonly verificationUri: string; readonly interval: number };
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly expiresAt: Timestamp;
	readonly completedAt?: Timestamp;
}

/** A key connection (#330): for a template, or a custom service described here. */
export interface ConnectKeyInput {
	/** A catalogue template with a key auth type. Give this or `custom`. */
	readonly templateId?: string;
	readonly custom?: {
		readonly kind: ConnectionKind;
		/** https hosts the key may be sent to; at least one. */
		readonly hosts: readonly string[];
		readonly injection: KeyInjection;
		/** For `kind: "mcp"`: the server's endpoint, on one of `hosts`. */
		readonly mcpUrl?: string;
	};
	readonly owner: ConnectionOwner;
	readonly name?: string;
	/**
	 * The key. Write-only: stored in the vault and never returned. For `basic` injection it is `username:password`,
	 * split at the first colon; with no colon it is the user name and the password is empty.
	 */
	readonly value: string;
	readonly usage?: ConnectionUsage;
}

/** Replacing a key's value in place: the connection keeps its ID, usage and history. */
export interface RotateKeyInput {
	readonly value: string;
}

// OAuth clients (#326).

/** The tenancy level an OAuth client belongs to; `platform` is the deployment. */
export type OAuthClientTier = OwnerRef["kind"];

export interface OAuthClient {
	readonly id: string;
	readonly owner: OwnerRef;
	/** The template it is for; or `issuer` for a remote MCP server's authorisation server with no template. */
	readonly templateId?: string;
	readonly issuer?: string;
	readonly label: string;
	/** The public client ID. */
	readonly clientId: string;
	/** Write-only: only whether one is set and its last four characters. */
	readonly secret: CredentialState;
	/** The scopes it may ask for; absent: any the template offers. */
	readonly scopes?: readonly string[];
	/** A custom domain the provider sees in the redirect URI, which forwards to Harbour's callback with a 308. */
	readonly redirectDomain?: string;
	/** The redirect URI to register with the provider. */
	readonly redirectUri: string;
	/** A disabled client makes no new connections; existing ones keep working. */
	readonly disabled: boolean;
	/** How many connections are pinned to it. */
	readonly connections: number;
	/** A public client: no secret is set, so it signs in with a code or with PKCE alone. */
	readonly public?: boolean;
	/** A GitHub App GitHub created from Harbour's manifest (`startGitHubApp`). */
	readonly githubApp?: GitHubAppInfo;
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

/** A GitHub App GitHub made from Harbour's manifest: its slug and ID, its settings page and where to install it. */
export interface GitHubAppInfo {
	readonly slug: string;
	readonly appId: number;
	readonly htmlUrl: string;
	readonly installUrl: string;
}

/**
 * Having GitHub create a GitHub App for Harbour from a manifest (tier 3), as an OAuth client for the `github` template
 * owned at `owner`'s tier: the caller's organisation (its admin), a project (`projectId`, its admin) or the caller.
 */
export interface StartGitHubAppInput {
	readonly owner: Exclude<OAuthClientTier, "platform">;
	/** For `owner: "project"`. */
	readonly projectId?: ProjectId;
	/** The GitHub organisation to create it in; the person's own GitHub account when absent. */
	readonly githubOrganisation?: string;
	/** Where GitHub's redirect back ends up: a path on this deployment, or an https URL. Default the console's page. */
	readonly returnTo?: string;
}

/** A GitHub App manifest flow. It must be finished within an hour, as GitHub requires. */
export interface GitHubAppSetup {
	readonly id: string;
	readonly status: "pending" | "created" | "failed" | "expired";
	/**
	 * Harbour's page that posts the manifest on to GitHub, with the flow's single-use state in it. Only in the answer to
	 * `startGitHubApp`: Harbour keeps a hash of the state, never the state itself.
	 */
	readonly url?: string;
	/** The `OAuthClient` record made, once `created`. */
	readonly clientId?: string;
	readonly githubApp?: GitHubAppInfo;
	readonly failure?: { readonly message: string };
	readonly expiresAt: Timestamp;
	readonly createdAt: Timestamp;
}

export interface OAuthClientFilter {
	readonly templateId?: string;
	readonly tier?: OAuthClientTier;
}

export interface CreateOAuthClientInput {
	readonly owner: OwnerRef;
	readonly templateId?: string;
	readonly issuer?: string;
	readonly label: string;
	readonly clientId: string;
	/** Write-only. A public client (PKCE only) has none. */
	readonly clientSecret?: string;
	readonly scopes?: readonly string[];
	readonly redirectDomain?: string;
}

export interface UpdateOAuthClientInput {
	readonly label?: string;
	/** Replaces the secret. Write-only. */
	readonly clientSecret?: string;
	readonly scopes?: readonly string[];
	readonly redirectDomain?: string;
	readonly disabled?: boolean;
}

// Uses: which connection was used where (#335).

export type ConnectionUseKind = "mcp_tools" | "mcp_call" | "http";

/**
 * How a use ended: `allowed` went out, `denied` was refused, `held` waits for a person to approve the exact request
 * (#333). A held use sent nothing; the approval's decision is the vault's (`connections.decision.*`), and an approved
 * request that then goes out is a use of its own, `allowed`.
 */
export type ConnectionUseOutcome = "allowed" | "denied" | "held";

/**
 * One use of a connection by a session: which connection, in which session and step, acting for whom, and who could
 * see the session then. Written before the credential goes out, and again when it is refused.
 */
export interface ConnectionUse {
	readonly id: string;
	readonly connectionId: string;
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly sessionId: SessionId;
	readonly agentId?: AgentId;
	/** The person the session acted for, if any. */
	readonly actingUserId?: UserId;
	/** The tool call (step) that used it. */
	readonly toolCallId?: string;
	readonly kind: ConnectionUseKind;
	readonly method: HttpMethod;
	readonly host: string;
	readonly path: string;
	/** For `mcp_call`: the tool's name. */
	readonly tool?: string;
	readonly audience: SessionAudience;
	readonly outcome: ConnectionUseOutcome;
	readonly reason?: string;
	/**
	 * What the access rules answered (#332), when the request got as far as them: absent for a use refused by the owner,
	 * usage or connection checks first, or recorded before rules.
	 */
	readonly decision?: ConnectionRuleAction;
	/** What decided it: a rule, `unmatched`, the ceiling, the usage layer or the connection itself. */
	readonly decidedBy?: ConnectionDecisionSource["kind"];
	/** The deciding rule, when one did. */
	readonly ruleId?: string;
	readonly rulesVersion?: number;
	/** For an `ask` someone approved (#333): the approval this use spent. */
	readonly approvalId?: string;
	/**
	 * When a rule said `ask` (#333): the approval (a vault proposal of kind `request`) and the exact request's digest.
	 * `used` once the approval let it out, `pending` while it waits for a person.
	 */
	readonly approval?: { readonly id: string; readonly digest: string; readonly state: "pending" | "used" };
	readonly at: Timestamp;
}

export interface ConnectionUseFilter {
	readonly connectionId?: string;
	readonly sessionId?: SessionId;
}

// The agent side: choosing a connection for a session.

/** What decides which connections a session may use: where it runs, who it acts for and who can see it. */
export interface ConnectionSessionScope {
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly sessionId: SessionId;
	readonly agentId: AgentId;
	/** The person the session acts for; absent for an unattended session. */
	readonly actingUserId?: UserId;
	readonly audience: SessionAudience;
}

/** A connection a session may use, as its agent sees it: no credential, no other person's details. */
export interface UsableConnection {
	readonly id: string;
	readonly name: string;
	readonly kind: ConnectionKind;
	readonly templateId?: string;
	readonly owner: ConnectionOwner["kind"];
	readonly account?: ConnectionAccount;
	readonly hosts: readonly string[];
	readonly mcpUrl?: string;
}

/** The outbound request an agent's tool makes through a connection. The credential is added on the way out. */
export interface ConnectionRequest {
	readonly method: HttpMethod;
	readonly url: string;
	readonly headers?: { readonly [name: string]: string };
	readonly body?: string;
	readonly kind: ConnectionUseKind;
	readonly tool?: string;
	readonly toolCallId?: string;
}

export interface ConnectionResponse {
	readonly status: number;
	readonly headers: { readonly [name: string]: string };
	/** The body as text, with any credential value cut out. */
	readonly body: string;
}

/** How this deployment runs connections, for a client deciding what to offer. No secrets. */
export interface ConnectionsSettings {
	/**
	 * Every session acting for a person is that person's alone (a deployment with one person, `SessionAudience`), so
	 * their personal connections work in all their sessions. When false a session is seen by its project, and a
	 * person's connection, `private` by default, is refused in it unless they share it.
	 */
	readonly personal: boolean;
}

export interface Connections {
	/** How this deployment runs connections. Anyone signed in may read it. */
	settings(ctx: CallContext): Promise<ConnectionsSettings>;

	// Catalogue.
	listCatalogue(ctx: CallContext, query?: CatalogueQuery, page?: PageRequest): Promise<Page<CatalogueEntry>>;
	getTemplate(ctx: CallContext, templateId: string): Promise<ProviderTemplate>;
	/** Reads a remote MCP server's metadata. Sends no credential. */
	discoverMcp(ctx: CallContext, url: string): Promise<McpDiscovery>;

	// Connections. Viewing needs viewer on the owner; changing needs admin on it, or being the person for their own.
	list(ctx: CallContext, filter?: ConnectionFilter, page?: PageRequest): Promise<Page<Connection>>;
	get(ctx: CallContext, connectionId: string): Promise<Connection>;
	update(ctx: CallContext, connectionId: string, input: UpdateConnectionInput): Promise<Connection>;
	/** Removes the connection and its stored credential. Its uses stay in the record. */
	remove(ctx: CallContext, connectionId: string): Promise<void>;

	// OAuth connect.
	/**
	 * Starts a connect. An open server (no auth) is connected at once and the attempt is `completed`; otherwise it is
	 * `pending` with a `connectUrl`. `no_client` is refused with `refused` and names the tiers that could supply one.
	 */
	startConnect(ctx: CallContext, input: StartConnectInput): Promise<ConnectAttempt>;
	getAttempt(ctx: CallContext, attemptId: string): Promise<ConnectAttempt>;
	/**
	 * The person opening the connect URL: checks they are the one it was made for and returns the provider's
	 * authorisation URL to send them to. `user_mismatch` fails the attempt.
	 */
	authorize(ctx: CallContext, attemptId: string): Promise<{ readonly url: string }>;
	/** The provider's redirect back: uses up the state, exchanges the code and stores the connection. */
	completeConnect(
		ctx: CallContext,
		callback: {
			readonly state: string;
			readonly code?: string;
			readonly error?: string;
			readonly errorDescription?: string;
		},
	): Promise<ConnectAttempt>;

	// Keys.
	connectKey(ctx: CallContext, input: ConnectKeyInput): Promise<Connection>;
	rotateKey(ctx: CallContext, connectionId: string, input: RotateKeyInput): Promise<Connection>;

	// OAuth clients. The deployment's need a system or deployment operator, an organisation's its admin, a project's
	// its admin, a person's that person.
	listClients(ctx: CallContext, filter?: OAuthClientFilter, page?: PageRequest): Promise<Page<OAuthClient>>;
	getClient(ctx: CallContext, oauthClientId: string): Promise<OAuthClient>;
	createClient(ctx: CallContext, input: CreateOAuthClientInput): Promise<OAuthClient>;
	updateClient(ctx: CallContext, oauthClientId: string, input: UpdateOAuthClientInput): Promise<OAuthClient>;
	/** Refused with `conflict`, naming how many, while any connection is pinned to it. */
	removeClient(ctx: CallContext, oauthClientId: string): Promise<void>;

	// GitHub App manifest flow (#326, tier 3).
	/** Starts it: a person, with the same rights as registering a client at that tier. Answers the page to open. */
	startGitHubApp(ctx: CallContext, input: StartGitHubAppInput): Promise<GitHubAppSetup>;
	getGitHubApp(ctx: CallContext, setupId: string): Promise<GitHubAppSetup>;
	/**
	 * The page the flow's URL opens, served without a call context: the state is the capability. Checks the state (it
	 * stays usable for GitHub's redirect back) and answers a small HTML page that posts the manifest to GitHub.
	 */
	gitHubAppManifestPage(setupId: string, state: string): Promise<string>;
	/**
	 * GitHub's redirect back, without a call context: uses the state up, converts the code into the app's credentials and
	 * stores its client (the secret write-only, in the vault). Answers where to send the browser, success or failure.
	 */
	completeGitHubApp(input: { readonly code: string; readonly state: string }): Promise<{ readonly redirectTo: string }>;

	// Uses.
	listUses(ctx: CallContext, filter?: ConnectionUseFilter, page?: PageRequest): Promise<Page<ConnectionUse>>;

	// Access rules (#332, connection-rules.ts). Viewing needs viewer on the connection's owner; changing needs admin on
	// it, or being the person for their own. Agents are always refused. A change takes effect on the next request
	// through any instance: nothing caches a rule.
	getRules(ctx: CallContext, connectionId: string): Promise<ConnectionRules>;
	/** Sets what an unmatched request gets, or resets the defaults to the template's. */
	updateRules(ctx: CallContext, connectionId: string, input: UpdateConnectionRulesInput): Promise<ConnectionRules>;
	/**
	 * Refused (`refused`) when an `allow` or `ask` rule reaches outside the organisation's ceiling, or names a project or
	 * agent the connection's usage never admits; `invalid` for a bad pattern, a tool rule on an API connection or an
	 * endpoint rule on an MCP server.
	 */
	createRule(ctx: CallContext, connectionId: string, input: ConnectionRuleInput): Promise<ConnectionRule>;
	updateRule(
		ctx: CallContext,
		connectionId: string,
		ruleId: string,
		input: UpdateConnectionRuleInput,
	): Promise<ConnectionRule>;
	removeRule(ctx: CallContext, connectionId: string, ruleId: string): Promise<void>;
	/**
	 * What the proxy would do with this request from a session like the one described, and which rule decides it: the
	 * same function as the real decision. Writes no use and opens no secret. Needs viewer on the connection's owner.
	 */
	dryRun(ctx: CallContext, connectionId: string, request: DryRunConnectionRequest): Promise<ConnectionDecision>;
	/** The organisation's ceiling, which bounds every rule. Anyone in the organisation may read it. */
	getCeiling(ctx: CallContext): Promise<ConnectionCeiling>;
	/** Replaces the ceiling (organisation admin). Rules already saved stay; requests outside it are denied at once. */
	setCeiling(ctx: CallContext, routes: readonly RouteScope[]): Promise<ConnectionCeiling>;

	// Worker calls: the session's tools, through Harbour's egress. Only `system` may make them.
	/** The connections a session may use, most specific owner first (person, project, organisation). */
	usable(ctx: SystemContext, scope: ConnectionSessionScope): Promise<readonly UsableConnection[]>;
	/**
	 * Sends one request through a connection the session may use: records the use, refreshes the token if it is due,
	 * has the vault inject the credential for the request's host, and returns the answer with the credential cut out.
	 * Refused (`forbidden`) when the session may not use it, and recorded as `denied`.
	 */
	send(
		ctx: SystemContext,
		scope: ConnectionSessionScope,
		connectionId: string,
		request: ConnectionRequest,
	): Promise<ConnectionResponse>;
}

/** The default usage for a new connection of `owner`: a person's is private and attended only. */
export function defaultConnectionUsage(owner: ConnectionOwner): ConnectionUsage {
	return owner.kind === "user"
		? { actingUsers: [owner.userId], unattended: false, visibility: "private" }
		: { unattended: true, visibility: "shared" };
}

/**
 * Whether a session may use a connection, and if not, why. The one rule every target applies, in order:
 * 1. The organisation must match.
 * 2. The owner bounds it: a project's connection only in that project's sessions; a person's only in sessions acting
 *    for that person.
 * 3. The usage narrows it: projects, acting people, agents, and unattended sessions.
 * 4. Visibility: a `private` connection only in a session whose audience is that acting person alone.
 */
export function connectionUsableIn(
	connection: Pick<Connection, "organisationId" | "owner" | "usage" | "status">,
	scope: ConnectionSessionScope,
): { readonly usable: true } | { readonly usable: false; readonly reason: string } {
	const no = (reason: string) => ({ usable: false, reason }) as const;
	if (connection.organisationId !== scope.organisationId) return no("It belongs to another organisation");
	if (connection.status === "disabled") return no("It is disabled");
	const { owner, usage } = connection;
	if (owner.kind === "project" && owner.projectId !== scope.projectId) return no("It belongs to another project");
	if (owner.kind === "user" && owner.userId !== scope.actingUserId) {
		return no("It is a person's own connection and this session does not act for them");
	}
	if (usage.projects !== undefined && (scope.projectId === undefined || !usage.projects.includes(scope.projectId))) {
		return no("It is not available in this project");
	}
	if (scope.actingUserId === undefined && (!usage.unattended || owner.kind === "user")) {
		return no("It is not available to sessions with no person behind them");
	}
	if (
		usage.actingUsers !== undefined &&
		(scope.actingUserId === undefined || !usage.actingUsers.includes(scope.actingUserId))
	) {
		return no("It is not available to sessions acting for this person");
	}
	if (usage.agents !== undefined && !usage.agents.includes(scope.agentId))
		return no("It is not available to this agent");
	if (usage.visibility === "private") {
		if (scope.audience.kind !== "private" || scope.audience.userId !== scope.actingUserId) {
			return no("It is private, and other people can see this session");
		}
	}
	return { usable: true };
}

/** Most specific owner first: a person's own, then the project's, then the organisation's. */
export const CONNECTION_OWNER_ORDER: readonly ConnectionOwner["kind"][] = ["user", "project", "organisation"];

// The vault's side: where connection secrets live.

/**
 * One call on the vault's connection secrets: access and refresh tokens, keys and OAuth client secrets, as vault items
 * the connections service keeps. A worker call: only `system` may make it.
 * - `put`: stores a new secret bound to `hosts` and answers its item ID.
 * - `replace`: a refreshed token or rotated key, in place (the item's value version goes up).
 * - `open`: the value, for one request to `host`, which must be one of the item's hosts and the item's organisation the
 *   one named; refused for a blocked or ended session. Recorded as a vault use either way.
 * - `clear`: drops the value; the item stays, empty, for the record.
 */
export type ConnectionSecretCall =
	| {
			readonly op: "put";
			readonly owner: OwnerRef;
			readonly name: string;
			readonly hosts: readonly string[];
			readonly value: string;
	  }
	| { readonly op: "replace"; readonly itemId: string; readonly value: string }
	| {
			readonly op: "open";
			readonly itemId: string;
			readonly host: string;
			/** The organisation the use is for; a platform item may be opened for any. */
			readonly organisationId: OrganisationId;
			readonly session?: {
				readonly sessionId: SessionId;
				readonly projectId?: ProjectId;
				readonly agentId?: AgentId;
			};
			/** Why, for the vault's use record, such as `connection conn_1: tools/call`. */
			readonly purpose: string;
	  }
	| { readonly op: "clear"; readonly itemId: string };

export interface ConnectionSecretResult {
	readonly itemId?: string;
	/** Only for `open`. */
	readonly value?: string;
}

export interface ConnectionSecrets {
	connectionSecret(ctx: SystemContext, call: ConnectionSecretCall): Promise<ConnectionSecretResult>;
}

// The vault's side: approvals bound to the exact request (#333).

/** The session a connection approval is asked for and used in. */
export interface ConnectionApprovalScope {
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly sessionId: SessionId;
	readonly agentId: AgentId;
	/** The person the session acts for, if any. */
	readonly actingUserId?: UserId;
}

/**
 * One call on the vault's exact-request approvals, made by the connections service when a rule says `ask`. A worker
 * call: only `system` may make it.
 * - `use`: freezes the request and computes its digest. If an approved, unused approval for that digest exists for this
 *   agent and session, it is used up there and then (one conditional commit, so of two sends at once only one gets
 *   it) and the call answers `approved`. Otherwise it answers `pending` with the open proposal for that digest,
 *   proposing it first if there is none. The proposal is a vault proposal of kind `request`: decided on the connection
 *   request page with its binding code and passkey, and waited on with `waitForOutcome`.
 * - `release`: gives back an approval `use` took, when the request never reached the upstream (DNS, connect, TLS).
 * - `status`: the proposal as it stands, for the session's tool waiting on it.
 */
export type ConnectionApprovalCall =
	| {
			readonly op: "use";
			readonly scope: ConnectionApprovalScope;
			readonly request: ApprovalRequestInput;
			/** Why the agent is sending it, for the approver. */
			readonly reason: string;
	  }
	| {
			readonly op: "release";
			readonly organisationId: OrganisationId;
			readonly grantId: string;
			readonly digest: string;
	  }
	| { readonly op: "status"; readonly organisationId: OrganisationId; readonly proposalId: string };

export type ConnectionApprovalResult =
	| {
			readonly outcome: "approved";
			readonly proposalId: string;
			readonly grantId: string;
			readonly digest: string;
	  }
	| { readonly outcome: "pending"; readonly proposal: Proposal; readonly digest: string }
	| { readonly outcome: "released" }
	| { readonly outcome: "status"; readonly proposal: Proposal };

export interface ConnectionApprovals {
	connectionApproval(ctx: SystemContext, call: ConnectionApprovalCall): Promise<ConnectionApprovalResult>;
}

/**
 * What a refused request tells the agent when it needs a person's approval first (#333): `error.details` of the
 * `refused` error, and the body of the 403 a proxy answers with. The agent sends the identical request again once it
 * is approved.
 */
export interface ApprovalPending {
	readonly error: "approval_pending";
	readonly approvalId: string;
	readonly digest: string;
	/** The connection request page, for people. */
	readonly link: string;
	readonly bindingCode: string;
	readonly expiresAt: Timestamp;
}
