/**
 * Connections (epic #322): how people and organisations connect agents to outside services, by OAuth or by key,
 * without an agent ever seeing a secret. The vault stays the encrypted store underneath: a connection's token or key is
 * a vault item's value, and nothing but the egress path ever opens it.
 *
 * Records:
 * - **Provider template** (#325): a catalogue entry describing a service, held as data. Shipped with Kantel, added by
 *   a deployment, or private to an organisation.
 * - **OAuth client** (#326): an OAuth app registration, owned at a tenancy level: the deployment (`platform`), an
 *   organisation, a project or a person. Its secret is write-only.
 * - **Connection**: one authorisation against a provider or a remote MCP server (#338), by OAuth (#327), by key
 *   (#330), or open (no auth). Several connections to one provider may coexist, each with its own owner and its own
 *   usage scope (who may use it, where, and in which sessions).
 * - **Connect attempt**: one OAuth sign-in in progress, with its single-use state.
 * - **Connection use**: which connection a session used, at which step, and who could see that session. It is how
 *   Kantel keeps a person's private connection out of sessions others can see (#335).
 *
 * Rules every implementation keeps:
 * - No read, list, event, log or error carries a secret: tokens, keys and client secrets are write-only. A credential
 *   shows as `set` and, for a key or client secret, its last four characters.
 * - Every credential is bound to its hosts and goes out only over https.
 * - An OAuth connection stays pinned to the client that minted it; refreshes always use that client.
 * - Agents never create, change or delete connections, clients or templates; they use connections through tools.
 */

import type { AuditEvent } from "./audit.ts";
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
import type { SessionVisibility } from "./session.ts";
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

/** How Kantel gets an OAuth client for a connect, in the order it tries them (#326, #338). */
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
	/**
	 * Where a disconnect revokes the connection's tokens (#329): an RFC 7009 revocation endpoint, or the provider's own
	 * endpoint for `revocationStyle`. For `discovery: "mcp"` the authorisation server's metadata names it
	 * (`revocation_endpoint`) and this is not needed. `{client_id}` is replaced with the connection's client ID.
	 */
	readonly revocationUrl?: string;
	/**
	 * How `revocationUrl` is called. `rfc7009` (the default): a form POST of the token with the client's authentication.
	 * `github_grant`: GitHub's `DELETE /applications/{client_id}/grant`, which needs the client's secret.
	 */
	readonly revocationStyle?: RevocationStyle;
	/** Default a space. */
	readonly scopeSeparator?: string;
	/** Such as `{ "access_type": "offline", "prompt": "consent" }`. */
	readonly extraAuthorizationParams?: { readonly [name: string]: string };
	readonly pkce: boolean;
	/** Refresh this many seconds before the access token expires. Default 300 (#328). */
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

/** A provider template: everything Kantel needs to connect a service and inject for it, with no provider code. */
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
	/** `shipped` with Kantel, added or overridden by the `deployment`, or an `organisation`'s private template. */
	readonly source: "shipped" | "deployment" | "organisation";
	/** Short provider-specific notes for whoever registers an OAuth app for it (#340). */
	readonly clientGuidance?: string;
	/**
	 * Which built-in guide to registering an app applies (#326): `github_app_manifest` (GitHub can create the app from
	 * Kantel's manifest in one click, or it is registered by hand) or `google` (a Google Cloud OAuth client).
	 */
	readonly guide?: "github_app_manifest" | "google";
	/**
	 * The provider's own page where a person removes an app's access, such as Google's
	 * `https://myaccount.google.com/connections`. A disconnect that couldn't revoke upstream points there (#329).
	 */
	readonly manageAccessUrl?: string;
}

/** How a provider's revocation endpoint is called (#329). */
export type RevocationStyle = "rfc7009" | "github_grant";

/**
 * How a template connects for a caller, by the setup tiers in #325. No build ships a confidential client secret, so a
 * provider with no automatic registration needs a public client, an app someone registers, or a client provided:
 * - `none`: nothing to set up: an open server, or one Kantel registers with itself through CIMD or DCR. Tier 1.
 * - `public_client`: a client ID the deployment supplies with no secret, signing in with a code (the device flow) or
 *   with PKCE alone. Tier 2.
 * - `own_app`: a client the person or their project registered, or one still to register (with a guide where Kantel
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
 * steps. `github_app_manifest`: Kantel can also have GitHub create the app in one click (`startGitHubApp`).
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

/** What Kantel learnt about a remote MCP server from its URL, before connecting (#338). */
export interface McpDiscovery {
	readonly url: string;
	/** `oauth`: it needs a sign-in. `none`: it answered without one. `unknown`: it refused and named no sign-in. */
	readonly auth: "oauth" | "none" | "unknown";
	/** The protected resource the tokens are for (RFC 9728 `resource`). */
	readonly resource?: string;
	readonly authorizationServer?: string;
	/** The ways a client can be had from that authorisation server, in the order Kantel would try them. */
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
 * or the organisation's members, a share, a supervisor or a host app. Kantel derives it from the session; a session
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
	/** Working as far as Kantel knows. */
	| "active"
	/**
	 * The token was refused or can't be refreshed: someone must connect again. Kept beside `health.state:
	 * "needs_reconnect"` (#328), which says the same, for clients that read only the status.
	 */
	| "needs_reauth"
	/** Stored, but the service refused it (401 or 403) on the template's test request. Still usable. */
	| "failing_test"
	| "disabled";

/**
 * A connection's health, which Kantel sets (#328), apart from its `status`, which people set:
 * - `ok`: its last refresh, or the connect, worked.
 * - `refresh_failing`: the last refresh failed in a way that may pass (no answer, a 5xx, a rate limit). The connection
 *   stays active and Kantel tries again with backoff; a request it can't send meanwhile is refused as `retryable`.
 * - `needs_reconnect`: the provider refused the refresh token (`invalid_grant`, revoked) or the token itself. Requests
 *   are refused with `connection_reconnect_required` until a person connects it again, which keeps its ID and rules.
 */
export type ConnectionHealthState = "ok" | "refresh_failing" | "needs_reconnect";

export interface ConnectionHealth {
	readonly state: ConnectionHealthState;
	/** Since when it has been in this state. */
	readonly since: Timestamp;
	/** The last failure, in plain words, such as `The token endpoint answered 503`. Never a secret. */
	readonly reason?: string;
	/** Refreshes that failed in a row. */
	readonly failures?: number;
	/** For `refresh_failing`: when Kantel tries again. */
	readonly retryAt?: Timestamp;
	/** When a refresh last worked. */
	readonly refreshedAt?: Timestamp;
}

/**
 * Why a request through a connection was refused before it went out (#328), in `KantelError.details`:
 * - `connection_reconnect_required`: its health is `needs_reconnect`. A person must connect it again at `link`;
 *   retrying won't help (`retryable: false`).
 * - `connection_refresh_failing`: its token has expired and the refresh is failing for now. Try again after `retryAt`
 *   (`retryable: true`).
 */
export interface ConnectionUnavailable {
	readonly error: "connection_reconnect_required" | "connection_refresh_failing";
	readonly connectionId: string;
	readonly retryable: boolean;
	/** For a person: the connection's page in the console, where Reconnect is. */
	readonly link?: string;
	readonly retryAt?: Timestamp;
	readonly reason?: string;
}

/** A credential's state, never its value. */
export interface CredentialState {
	readonly set: boolean;
	/** A key's or client secret's last four characters. Never shown for OAuth tokens. */
	readonly last4?: string;
	/** When the access token expires, if the provider said. */
	readonly expiresAt?: Timestamp;
	/** Whether Kantel holds a refresh token for it. */
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
	/**
	 * What a sandbox puts where the credential goes (#331): `kantel-cn-` and 32 hex digits, random and stable for the
	 * connection's life. Not a secret: the egress gate swaps it for the credential, only for a session that may use the
	 * connection, only to one of its `hosts`. Absent for a connection with no credential, and on one made before #331
	 * until a session first lists it.
	 */
	readonly placeholder?: string;
	readonly account?: ConnectionAccount;
	/** Scopes asked for and scopes the provider actually granted. */
	readonly scopes: { readonly requested: readonly string[]; readonly granted: readonly string[] };
	readonly client?: ConnectionClientRef;
	readonly usage: ConnectionUsage;
	/**
	 * For a person's connection: the projects its owner shared it with (#335). Every attended session in such a project
	 * may use it, whoever it acts for and whoever can see it; its rules still decide each request. Absent or empty: none.
	 */
	readonly shares?: readonly ConnectionShare[];
	readonly status: ConnectionStatus;
	/** Set by Kantel from its refreshes (#328). Absent: `ok`, or never refreshed. */
	readonly health?: ConnectionHealth;
	readonly credential: CredentialState;
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

/**
 * What a disconnect did at the provider (#329):
 * - `revoked`: the provider accepted the revocation of the tokens Kantel held.
 * - `unsupported`: the provider gives Kantel no way to revoke them: no revocation endpoint, a public client where the
 *   provider needs a secret, or a key, which only the service itself can revoke. Remove the access there.
 * - `failed`: Kantel asked and the provider refused or didn't answer. Kantel removed the connection all the same.
 * - `none`: there was nothing to revoke: an open connection, or one with no credential left.
 */
export type RevocationOutcome = "revoked" | "unsupported" | "failed" | "none";

export interface ConnectionRevocation {
	readonly outcome: RevocationOutcome;
	/** The endpoint Kantel called, for `revoked` and `failed`. Never carries a token. */
	readonly endpoint?: string;
	/** Why it is `unsupported` or `failed`, in plain words, such as `The provider answered 503`. No secret. */
	readonly reason?: string;
	/** The provider's page for removing an app's access, when the catalogue knows it. */
	readonly manageUrl?: string;
}

/** What `remove` did (#329): the answer to `DELETE /connections/{id}`, and the `connections.connection.removed` event. */
export interface ConnectionRemoval {
	readonly connectionId: string;
	readonly revocation: ConnectionRevocation;
	/** The connection's standing access rules removed with it. */
	readonly rulesRemoved: number;
	/** Approvals of exact requests (#333) not yet used, withdrawn or stopped with it. */
	readonly approvalsWithdrawn: number;
}

/**
 * A person's connection shared with a project (#335): explicit, audited (`connections.connection.shared` and
 * `.unshared`) and revocable, and the person stays its owner. Only the owner shares it, into a project where they may
 * run sessions (operator); the owner or an admin of the project stops it.
 */
export interface ConnectionShare {
	readonly projectId: ProjectId;
	readonly sharedBy: Actor;
	readonly sharedAt: Timestamp;
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
	 * code itself never leaves Kantel. Each `getAttempt` asks the provider, at most once per `interval`.
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
	/** A custom domain the provider sees in the redirect URI, which forwards to Kantel's callback with a 308. */
	readonly redirectDomain?: string;
	/** The redirect URI to register with the provider. */
	readonly redirectUri: string;
	/** A disabled client makes no new connections; existing ones keep working. */
	readonly disabled: boolean;
	/** How many connections are pinned to it. */
	readonly connections: number;
	/** A public client: no secret is set, so it signs in with a code or with PKCE alone. */
	readonly public?: boolean;
	/** A GitHub App GitHub created from Kantel's manifest (`startGitHubApp`). */
	readonly githubApp?: GitHubAppInfo;
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

/** A GitHub App GitHub made from Kantel's manifest: its slug and ID, its settings page and where to install it. */
export interface GitHubAppInfo {
	readonly slug: string;
	readonly appId: number;
	readonly htmlUrl: string;
	readonly installUrl: string;
}

/**
 * Having GitHub create a GitHub App for Kantel from a manifest (tier 3), as an OAuth client for the `github` template
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
	 * Kantel's page that posts the manifest on to GitHub, with the flow's single-use state in it. Only in the answer to
	 * `startGitHubApp`: Kantel keeps a hash of the state, never the state itself.
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
 * Where an `ask` use's approval stands (#333, #481): `used` once it let the request out, `pending` while a person has yet
 * to decide, and for a held use whose approval has since ended, how it ended.
 */
export type ConnectionUseApprovalState = "pending" | "used" | "approved" | "denied" | "expired" | "withdrawn";

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
	/**
	 * Made in a session no person was watching, a schedule's run (`ConnectionSessionScope.unattended`). With
	 * `actingUserId`, the scheduled run acted for that person.
	 */
	readonly unattended?: true;
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
	/** A person's connection used in a project it is shared with (#335), rather than by its owner's own session. */
	readonly viaShare?: boolean;
	/** Sent by the sandbox through the egress gate with the connection's placeholder (#331), not by a connection tool. */
	readonly egress?: true;
	/** For a use the egress gate refused (#331): the refusal's code, such as `host_not_bound` or `raw_secret`. */
	readonly refusal?: EgressRefusalCode;
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
	 * `used` once the approval let it out, `pending` while it waits for a person. A held use is listed with how its
	 * approval ended once it has (#481): `approved` (the agent sends the identical request again, a use of its own),
	 * `denied`, `expired` or `withdrawn`.
	 */
	readonly approval?: { readonly id: string; readonly digest: string; readonly state: ConnectionUseApprovalState };
	readonly at: Timestamp;
}

/**
 * A use made in a private session the caller can't open (#335), as `listUses` lists it to them: that the connection
 * was used, when, how it ended and for whom, and nothing from inside the session. No session or step, no agent or
 * project, no method, host, path or tool, and no reason or rule, which can quote the request. The connection's owner,
 * the person the session acted for and whoever may open the session see the whole `ConnectionUse` instead.
 */
export interface RedactedConnectionUse {
	readonly id: string;
	readonly connectionId: string;
	readonly organisationId: OrganisationId;
	readonly redacted: true;
	/** The person the session acted for: a private session always has one. */
	readonly actingUserId: UserId;
	readonly audience: { readonly kind: "private"; readonly userId: UserId };
	readonly outcome: ConnectionUseOutcome;
	readonly at: Timestamp;
}

/** A use as `listUses` lists it: the whole record, or redacted for a private session the caller can't open. */
export type ListedConnectionUse = ConnectionUse | RedactedConnectionUse;

/** Whether a listed use is redacted (#335). */
export function isRedactedUse(use: ListedConnectionUse): use is RedactedConnectionUse {
	return (use as Partial<RedactedConnectionUse>).redacted === true;
}

/**
 * A use made in a private session, as listed to someone who can't open that session: the time, the outcome and who
 * it acted for, nothing more (#335).
 */
export function redactUse(
	use: ConnectionUse,
	audience: { readonly kind: "private"; readonly userId: UserId },
): RedactedConnectionUse {
	return {
		id: use.id,
		connectionId: use.connectionId,
		organisationId: use.organisationId,
		redacted: true,
		actingUserId: audience.userId,
		audience: { kind: "private", userId: audience.userId },
		outcome: use.outcome,
		at: use.at,
	};
}

/** The actor a redacted audit event names in place of the private session's agent (#335). */
export const PRIVATE_SESSION_ACTOR = { kind: "system", component: "private-session" } as const;

/**
 * A Connections audit event from a private session the reader can't open (#335), as the audit log shows it to them:
 * what kind of event, when, which connection and who the session acted for, as `redactUse` does for Recent uses. No
 * session, project, agent or step, and nothing from its data (method, host, path, tool, reason, digest, route), which
 * can quote the request. Marked `data.redacted`.
 */
export function redactAuditEvent(
	event: AuditEvent,
	actingUserId: UserId | undefined,
	connectionId: string | undefined,
): AuditEvent {
	return {
		id: event.id,
		seq: event.seq,
		recordedAt: event.recordedAt,
		at: event.at,
		source: event.source,
		type: event.type,
		actor: PRIVATE_SESSION_ACTOR,
		organisationId: event.organisationId,
		...(connectionId === undefined ? {} : { subject: { kind: "connection", id: connectionId } }),
		data: {
			redacted: true,
			...(actingUserId === undefined ? {} : { actingUserId }),
			...(connectionId === undefined ? {} : { connectionId }),
		},
	};
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
	/** The person the session acts for; absent for an unattended session with no person behind it. */
	readonly actingUserId?: UserId;
	/**
	 * No person is watching: a schedule started the session (`SessionRecord.unattended`). With `actingUserId` it is a
	 * scheduled run acting for the person who made the schedule, which may use that person's own connections; without
	 * one, an unattended session as before. Absent and no `actingUserId`: unattended too.
	 */
	readonly unattended?: true;
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
	/** The connection's placeholder (#331), for the sandbox to send in its place; absent with no credential. */
	readonly placeholder?: string;
	/** The sandbox's environment variable holding the placeholder, such as `KANTEL_CONNECTION_GITHUB`. */
	readonly env?: string;
}

// Placeholder-gated injection (#331).

/** A connection's placeholder: `kantel-cn-` and 32 lower-case hex digits. */
export const CONNECTION_PLACEHOLDER_PATTERN = /^kantel-cn-[0-9a-f]{32}$/;

/**
 * Why the egress gate refused a sandbox's request (#331), as the 403's `error`:
 * - `host_not_bound`: the placeholder's connection is not for the request's host.
 * - `raw_secret`: the request carries a stored secret's own value, not its placeholder.
 * - `unknown_placeholder`: no connection in the organisation has that placeholder (removed, or never one).
 * - `ambiguous_placeholder`: placeholders of more than one connection in one request.
 * - `connection_not_usable`: the session may not use the connection (its owner, usage or visibility, #335).
 * - `needs_reauth`: the connection must be reconnected first.
 * - `https_required`: a credential only goes over https.
 * - `rule_denied`: the connection's rules or the organisation's ceiling refused it (#332).
 * - `approval_pending`: a rule asks, and a person has yet to approve this exact request (#333).
 * - `egress_denied`: nothing names a connection and the target lets no such request out.
 * - `egress_unavailable`: the gate could not decide (the connections service is not there).
 */
export const EGRESS_REFUSAL_CODES = [
	"host_not_bound",
	"raw_secret",
	"unknown_placeholder",
	"ambiguous_placeholder",
	"connection_not_usable",
	"needs_reauth",
	"https_required",
	"rule_denied",
	"approval_pending",
	"egress_denied",
	"egress_unavailable",
] as const;
export type EgressRefusalCode = (typeof EGRESS_REFUSAL_CODES)[number];

/** The next step a refusal suggests. */
export interface EgressRefusalFix {
	readonly action:
		| "use_placeholder"
		| "change_host"
		| "use_https"
		| "request_connection"
		| "ask_approval"
		| "reconnect"
		| "none";
	readonly message: string;
	readonly link?: string;
}

/**
 * The JSON body of the egress gate's 403 (#331). `approval_pending` adds the approval to wait on, as
 * `ApprovalPending` does. Never carries a secret.
 */
export interface EgressRefusal {
	readonly error: EgressRefusalCode;
	readonly message: string;
	readonly fix?: EgressRefusalFix;
	readonly connectionId?: string;
	readonly approvalId?: string;
	readonly digest?: string;
	readonly link?: string;
	readonly bindingCode?: string;
	readonly expiresAt?: number;
}

/**
 * One connection as a session's visibility would let it use it, or why not (#335): what `connectionUsableIn` answers
 * for the session with that visibility. For a session's own page: which connections it may pick, and why not the rest.
 */
export interface SessionConnectionEligibility {
	readonly connection: UsableConnection;
	/** Whose it is, by ID: the owner's user ID or project ID, absent for the organisation's. */
	readonly ownerId?: string;
	readonly usable: boolean;
	readonly reason?: string;
	/** Usable because its owner shared it with the session's project. */
	readonly viaShare?: boolean;
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
	/**
	 * Disconnects it (#329): stops every use at once, asks the provider to revoke its tokens where the provider can,
	 * destroys the stored credential, and removes the connection with its rules and any approvals not yet used. Its uses
	 * and audit history stay. A revoke the provider refuses still removes it; the answer says what happened upstream.
	 */
	remove(ctx: CallContext, connectionId: string): Promise<ConnectionRemoval>;

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
	/**
	 * Uses, newest first. A use in a private session the caller can't open is redacted (`RedactedConnectionUse`) unless
	 * they own the connection or are the person the session acted for (#335); naming such a session is `forbidden`.
	 */
	listUses(ctx: CallContext, filter?: ConnectionUseFilter, page?: PageRequest): Promise<Page<ListedConnectionUse>>;

	// Sharing a person's connection (#335).
	/**
	 * Shares a person's connection with a project. Only its owner, as a person (never an agent or an admin), into a
	 * project where they hold operator; `invalid` for a connection that isn't a person's. Sharing again is a no-op.
	 * Audited as `connections.connection.shared`. Takes effect on the next request.
	 */
	share(ctx: CallContext, connectionId: string, projectId: ProjectId): Promise<Connection>;
	/**
	 * Stops a share: its owner, or an admin of the project. Audited as `connections.connection.unshared`. The project's
	 * next request through it is refused, and recorded as `denied`.
	 */
	unshare(ctx: CallContext, connectionId: string, projectId: ProjectId): Promise<Connection>;
	/**
	 * Which connections a session may use, and why not the rest: those of its organisation, its project, the person it
	 * acts for, and people's shared with its project. `visibility` asks as if the session had it, for a page offering the
	 * choice. Needs viewer on the session. Another person's connection that doesn't reach the session shows no account.
	 */
	sessionConnections(
		ctx: CallContext,
		sessionId: SessionId,
		options?: { readonly visibility?: SessionVisibility },
	): Promise<readonly SessionConnectionEligibility[]>;

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

	// Worker calls: the session's tools, through Kantel's egress. Only `system` may make them.
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
 *
 * A person's connection shared with the session's project (#335) is the one exception to 2 and 4: any attended session
 * there may use it, whoever it acts for and whoever can see it, because its owner chose that. Its agents and the
 * rules still apply; unattended sessions still never get it.
 *
 * A scheduled run acting for the person who made the schedule (`scope.unattended` with `actingUserId`, a one-person
 * deployment) may use that person's own connections, private ones included while the run is private to them. It is
 * otherwise unattended: the organisation's and projects' connections only when marked `unattended`, and never
 * another person's, shared or not.
 */
export function connectionUsableIn(
	connection: Pick<Connection, "organisationId" | "owner" | "usage" | "status" | "shares">,
	scope: ConnectionSessionScope,
): { readonly usable: true; readonly viaShare?: boolean } | { readonly usable: false; readonly reason: string } {
	const no = (reason: string) => ({ usable: false, reason }) as const;
	if (connection.organisationId !== scope.organisationId) return no("It belongs to another organisation");
	if (connection.status === "disabled") return no("It is disabled");
	const { owner, usage } = connection;
	if (owner.kind === "project" && owner.projectId !== scope.projectId) {
		return no(
			scope.projectId === undefined
				? "It belongs to a project, and this is an organisation session"
				: "It belongs to another project",
		);
	}
	// A scheduled run acting for its person: its own connections, not as a share, so the checks below apply.
	const scheduledOwn = scope.unattended === true && owner.kind === "user" && owner.userId === scope.actingUserId;
	const shared =
		!scheduledOwn &&
		owner.kind === "user" &&
		scope.projectId !== undefined &&
		(connection.shares ?? []).some((share) => share.projectId === scope.projectId);
	if (shared) {
		if (scope.actingUserId === undefined || scope.unattended === true)
			return no("It is not available to sessions with no person behind them");
		if (usage.agents !== undefined && !usage.agents.includes(scope.agentId))
			return no("It is not available to this agent");
		return { usable: true, viaShare: owner.userId !== scope.actingUserId || scope.audience.kind !== "private" };
	}
	if (owner.kind === "user" && owner.userId !== scope.actingUserId) {
		return no("It is a person's own connection, this session does not act for them, and it isn't shared here");
	}
	if (usage.projects !== undefined && (scope.projectId === undefined || !usage.projects.includes(scope.projectId))) {
		return no(
			scope.projectId === undefined
				? "It is only for sessions in some projects, and this is an organisation session"
				: "It is not available in this project",
		);
	}
	if (scope.actingUserId === undefined && (!usage.unattended || owner.kind === "user")) {
		return no("It is not available to sessions with no person behind them");
	}
	// A scheduled run acting for its person: their own connection is theirs to use; anything else must allow unattended.
	if (scope.unattended === true && !scheduledOwn && !usage.unattended) {
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
			/**
			 * The request it is opened for, for the vault's use record (#483): its method and path, without the query, which
			 * can carry the credential. Without one the use reads `POST /`.
			 */
			readonly request?: { readonly method: HttpMethod; readonly path: string };
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
	| { readonly op: "status"; readonly organisationId: OrganisationId; readonly proposalId: string }
	/**
	 * A disconnect (#329): withdraws every pending approval for the connection and stops every approved one not yet used,
	 * so none outlives it. Answers how many.
	 */
	| { readonly op: "forget"; readonly organisationId: OrganisationId; readonly connectionId: string };

export type ConnectionApprovalResult =
	| {
			readonly outcome: "approved";
			readonly proposalId: string;
			readonly grantId: string;
			readonly digest: string;
	  }
	| { readonly outcome: "pending"; readonly proposal: Proposal; readonly digest: string }
	| { readonly outcome: "released" }
	| { readonly outcome: "status"; readonly proposal: Proposal }
	| { readonly outcome: "forgotten"; readonly withdrawn: number; readonly stopped: number };

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
