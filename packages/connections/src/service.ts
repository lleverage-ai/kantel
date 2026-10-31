/**
 * The connections service (epic #322): the `Connections` contract over a `ConnectionsRepository` (records, no secret),
 * a `CredentialStore` (the vault: every token, key and client secret) and a `Fetch` (the network).
 *
 * The OAuth connect (#327, #338):
 * 1. `startConnect` resolves where to sign in (a static template, or a remote MCP server's discovered authorisation
 *    server) and an OAuth client, in order: a pre-registered client (the owner's own tier first, then up to the
 *    deployment), the deployment's client ID metadata document (CIMD), then dynamic registration (DCR). It answers a
 *    pending attempt with a connect URL on this deployment.
 * 2. `authorize`: the person opening the connect URL must be the one it was made for. Makes a single-use state and a
 *    PKCE pair and answers the provider's authorisation URL.
 * 3. `completeConnect`: uses up the state, exchanges the code (with the PKCE verifier and, for an MCP server, the RFC 8707
 *    resource), stores the tokens in the vault bound to the connection's hosts (the refresh token to the token
 *    endpoint's host only), and makes or updates the connection, pinned to its client.
 *
 * With a public client (no secret) and a template with a device authorisation endpoint, `startConnect` starts the
 * device flow instead (RFC 8628, tier 2): the attempt carries the code the person types at the provider, and each
 * `getAttempt` asks the token endpoint (at most once per interval, one caller at a time) until it settles.
 *
 * The GitHub App manifest flow (#326, tier 3): `startGitHubApp` makes a single-use state and the URL of a page
 * (`gitHubAppManifestPage`) that posts a manifest to GitHub; `completeGitHubApp` takes GitHub's redirect back, converts
 * the code into the app's client ID and secret, and stores them as an OAuth client like `createClient` does.
 *
 * The agent side: `usable` lists what a session may use (`connectionUsableIn`), and `send`, `listTools` and `callTool`
 * make one request through a connection: the use is recorded first, the token refreshed if due, the vault opens the
 * credential for the request's host only, and the answer comes back with the credential cut out.
 */
import {
	type Actor,
	type ApprovalPending,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type CatalogueEntry,
	type ClientRegistration,
	type Clock,
	CONNECTION_OWNER_ORDER,
	type ConnectAttempt,
	type ConnectFailureCode,
	type Connection,
	type ConnectionApprovals,
	type ConnectionCeiling,
	type ConnectionDecision,
	type ConnectionHealth,
	type ConnectionHealthState,
	type ConnectionOwner,
	type ConnectionRemoval,
	type ConnectionRequest,
	type ConnectionResponse,
	type ConnectionRevocation,
	type ConnectionRule,
	type ConnectionRuleInput,
	type ConnectionRules,
	type ConnectionSessionScope,
	type Connections,
	type ConnectionUnavailable,
	type ConnectionUsage,
	type ConnectionUse,
	type ConnectionUseApprovalState,
	type ConnectionUseKind,
	type ConnectionUseOutcome,
	type ConnectKeyInput,
	type CreateOAuthClientInput,
	connectionUsableIn,
	DEFAULT_UNMATCHED,
	decideConnectionRules,
	defaultConnectionUsage,
	defaultRuleInputs,
	defaultToolRuleInputs,
	describeRule,
	type EgressRefusal,
	type EgressRefusalCode,
	type GitHubAppInfo,
	type GitHubAppSetup,
	type HttpMethod,
	isKantelError,
	isRedactedUse,
	type JsonValue,
	KantelError,
	type KeyInjection,
	type ListedConnectionUse,
	type McpDiscovery,
	type OAuthClient,
	type OAuthClientTier,
	type OwnerRef,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type Proposal,
	type ProviderTemplate,
	type ResolvedClientInfo,
	type RevocationStyle,
	redactUse,
	requireSystem,
	type SessionAudience,
	type SessionConnectionEligibility,
	type SessionDirectory,
	type SessionRecord,
	type StartConnectInput,
	type SystemContext,
	sessionAudienceOf,
	systemClock,
	systemContext,
	type UsableConnection,
} from "@kantel/contracts";
import { buildCatalogue, templateById, templateForMcpUrl } from "./catalogue.ts";
import {
	type EgressDraft,
	fingerprintsOf,
	placeholderEnvName,
	placeholdersIn,
	rawSecretIn,
	rawSecretRefusal,
	redactBytes,
	redactionsOf,
	redactText,
	refusal,
	type Substitution,
	substitute,
} from "./egress-gate.ts";
import {
	type ConvertedGitHubApp,
	convertManifestCode,
	GITHUB_APP_TTL_MS,
	GITHUB_LOGIN,
	gitHubAppFormAction,
	gitHubAppManifest,
	gitHubAppManifestHtml,
	gitHubAppName,
} from "./github-app.ts";
import { setupGuide } from "./guides.ts";
import { callMcpTool, listMcpTools, type McpPost, type McpTool, type McpToolResult } from "./mcp.ts";
import {
	authServerMetadata,
	DEVICE_FLOW_DISABLED,
	type DeviceAuthorization,
	type DevicePollResult,
	deviceAuthorization,
	devicePoll,
	discoverMcpAuth,
	idTokenAccount,
	pkcePair,
	publicUrl,
	REVOKE_TIMEOUT_MS,
	randomToken,
	registerClient,
	revokeToken,
	sha256,
	type TokenClient,
	type TokenSet,
	tokenRequest,
} from "./oauth.ts";
import type { ConnectionsDeployment, CredentialStore, Fetch, PlatformOAuthClient } from "./ports.ts";
import type { ConnectionsRepository, StoredRecord } from "./repository.ts";
import {
	assertRoom,
	type CeilingStore,
	ceilingFor,
	changeRules,
	checkRule,
	decideUse,
	MAX_RULES,
	newRule,
	readRules,
	validateRoutes,
} from "./rules.ts";

/** How long a connect URL and its state stay usable. */
export const ATTEMPT_TTL_MS = 15 * 60 * 1000;
/** Connections the sweep reads at a time. */
const SWEEP_PAGE = 200;
/** How long before an access token expires Kantel refreshes it, unless the template says (#328). */
export const DEFAULT_REFRESH_BUFFER_SECONDS = 300;
/** The wait before retrying a failing refresh: 30 s, doubling each failure in a row, at most 30 minutes (#328). */
export function refreshBackoffMs(failures: number): number {
	return Math.min(30_000 * 2 ** Math.max(0, failures - 1), 30 * 60_000);
}
/**
 * How long one device-flow poll holds an attempt before another caller may poll it: long enough to store the tokens,
 * so a second poll never spends the device code again while the first is finishing.
 */
export const DEVICE_POLL_LEASE_MS = 60 * 1000;
/** The template the GitHub App manifest flow makes clients for. */
const GITHUB_TEMPLATE = "github";
/** The most of a response body a tool gets back. */
export const RESPONSE_LIMIT = 2 * 1024 * 1024;
const METHOD_NAMES: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export interface ConnectionsOptions {
	readonly repository: ConnectionsRepository;
	readonly credentials: CredentialStore;
	readonly deployment: ConnectionsDeployment;
	readonly access: ProjectAccess | (() => ProjectAccess);
	readonly fetch?: Fetch;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
	/** Templates the deployment adds or overrides (same ID replaces a shipped one). */
	readonly templates?: readonly ProviderTemplate[];
	/** Tests only: allow http and local hosts for discovery and tokens. */
	readonly allowInsecureUrls?: boolean;
	readonly newId?: (prefix: string) => string;
	/** The organisation's ceiling, which bounds every rule (the vault's). Absent: no ceiling, and it can't be set. */
	readonly ceiling?: CeilingStore;
	/**
	 * The sessions, read with a system context, for `sessionConnections` (#335): which connections a session may pick.
	 * A function when the runtime is built after the service. Absent: that call is `unavailable`.
	 */
	readonly sessions?: Pick<SessionDirectory, "get"> | (() => Pick<SessionDirectory, "get"> | undefined);
	/**
	 * Approvals bound to the exact request (#333), kept in the vault (`connectionApproval`). A rule's `ask` freezes the
	 * request there and refuses it as `approval_pending` until a person approves it. Without them an `ask` is refused.
	 */
	readonly approvals?: ConnectionApprovals;
	/** Token refresh (#328): how gateways over one database take turns, and who is told when one is next due. */
	readonly refresh?: RefreshOptions;
}

/**
 * Token refresh across processes (#328). Each refresh takes a lease on the connection (a `refresh_lease` record, written
 * only if unchanged since read), so gateways over one database refresh it one at a time; within a process the
 * refreshes of one connection are one promise.
 */
export interface RefreshOptions {
	/** This process's name on a lease. Default a random one. */
	readonly holder?: string;
	/** How long a lease holds before another process may take it over: a holder that died. Default 30 s. */
	readonly leaseMs?: number;
	/**
	 * How long a request waits for another process's refresh of its connection before it is refused as retryable.
	 * Default 35 s. The sweep never waits: it leaves a connection being refreshed to whoever is doing it.
	 */
	readonly leaseWaitMs?: number;
	/** How often a waiting request looks at the lease again. Default 50 ms. */
	readonly pollMs?: number;
	/**
	 * Told when a connection next falls due for a refresh: after a connect, a refresh or a failed one. A deployment with an
	 * alarm (Cloudflare's stack object) arms it for then, so the sweep runs on time without polling.
	 */
	readonly onDue?: (at: number) => void;
}

/** What one sweep did (#328). */
export interface RefreshSweep {
	/** Connections looked at. */
	readonly checked: number;
	readonly refreshed: number;
	/** Refreshes that failed: `refresh_failing` or `needs_reconnect` now. */
	readonly failed: number;
	/** When the next connection falls due, if any will. */
	readonly nextDueAt?: number;
}

/** How a refresh went: not needed, done, failed for now, refused for good, or left to another process holding it. */
type RefreshOutcome = "fresh" | "refreshed" | "failed" | "needs_reconnect" | "busy";

/** The service: the contract, plus MCP calls the session tools make. */
export interface ConnectionsService extends Connections {
	/** The tools a remote MCP connection offers, as the session sees them. Recorded as an `mcp_tools` use. */
	listTools(
		ctx: SystemContext,
		scope: ConnectionSessionScope,
		connectionId: string,
		step?: { readonly toolCallId?: string },
	): Promise<McpTool[]>;
	/** Calls one tool on a remote MCP connection. Recorded as an `mcp_call` use naming the tool. */
	callTool(
		ctx: SystemContext,
		scope: ConnectionSessionScope,
		connectionId: string,
		call: { readonly name: string; readonly arguments?: unknown; readonly toolCallId?: string },
	): Promise<McpToolResult>;
	/**
	 * For approvals (#333): "always allow requests like this" saves the rule as its own visible act, marked with the
	 * approval's ID (`source: "approval"`). Checked as `createRule` is, with the same rights.
	 */
	createRuleFromApproval(
		ctx: CallContext,
		connectionId: string,
		input: ConnectionRuleInput,
		approvalId: string,
	): Promise<ConnectionRule>;
	/**
	 * An approval a session's request is waiting on (#333), as it stands: for the session's tool, which waits for a
	 * person to decide and then sends the identical request again. Only the session that asked may read it.
	 */
	approvalStatus(ctx: SystemContext, scope: ConnectionSessionScope, approvalId: string): Promise<Proposal>;
	/**
	 * The refresh sweep (#328): refreshes every OAuth connection within its template's buffer of expiring, and retries each
	 * failing one whose backoff has passed, so a connection nobody uses doesn't go stale. Safe to run from every process at
	 * once. System only.
	 */
	sweep(ctx: SystemContext): Promise<RefreshSweep>;
	/** When the next connection falls due for a refresh, without refreshing anything. System only. */
	nextRefreshAt(ctx: SystemContext): Promise<number | undefined>;
	/**
	 * Placeholder-gated injection (#331): one outbound request a session's sandbox made, through the egress gate. Screened
	 * for a stored secret's own value (`raw_secret`), then: no placeholder, `pass` (the target sends it as it is, with no
	 * credential); a placeholder, decided as `send` decides (session, host binding, https, rules, approvals), sent with
	 * the credential in the placeholder's place and the credential cut out of the answer. Every refusal is an
	 * `EgressRefusal`, recorded as a use of the connection when one is named.
	 */
	egress(ctx: SystemContext, session: EgressSession, request: EgressDraft): Promise<EgressOutcome>;
	/**
	 * The sandbox's environment for a session (#331): each connection it may use as `KANTEL_CONNECTION_<NAME>` set to
	 * its placeholder. Never a secret. Empty for a session that can't be read.
	 */
	egressEnvironment(ctx: SystemContext, session: EgressSession): Promise<Record<string, string>>;
	/** The deployment's client ID metadata document, served without signing in. */
	clientMetadata(): Record<string, unknown>;
	/** The callback URL every provider redirects to. */
	readonly redirectUri: string;
}

/** The session a sandbox's request comes from (#331). Its scope is read for every request, as the tools' is. */
export interface EgressSession {
	readonly organisationId: string;
	readonly sessionId: string;
	readonly toolCallId?: string;
}

/** What the egress gate did with one request (#331). */
export type EgressOutcome =
	/** No placeholder and no raw secret: no credential goes on, and the target's own network rules apply. */
	| { readonly kind: "pass" }
	| { readonly kind: "refused"; readonly refusal: EgressRefusal }
	| {
			readonly kind: "sent";
			readonly connectionId: string;
			readonly status: number;
			readonly statusText: string;
			readonly headers: Readonly<Record<string, string>>;
			/** At most `EGRESS_RESPONSE_LIMIT` bytes, every credential that went out cut out. */
			readonly body: Uint8Array;
			readonly url: string;
			/** How many times a credential was cut out of the answer. */
			readonly redactions: number;
	  };

/** The most of an answer the egress gate reads back to the sandbox. */
export const EGRESS_RESPONSE_LIMIT = 10 * 1024 * 1024;

/** Request headers the egress gate never forwards: hop-by-hop, and the sandbox's proxy credentials and cookies. */
const EGRESS_DROPPED_HEADERS = new Set([
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"proxy-connection",
	"proxy-authorization",
	"te",
	"transfer-encoding",
	"upgrade",
]);

/** The headers the egress gate forwards, by lower-case name: what an approval of an egress request binds. */
function egressHeaders(headers: { readonly [name: string]: string }): { [name: string]: string } {
	const out: { [name: string]: string } = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (!EGRESS_DROPPED_HEADERS.has(lower)) out[lower] = lower in out ? `${out[lower]}, ${value}` : value;
	}
	return out;
}

/** A body as an approval binds it: its text, or `base64:` and its bytes when it isn't UTF-8, so no two bodies match. */
function exactBody(body: Uint8Array): string {
	try {
		// A byte-order mark is kept: with and without one are different bytes on the wire, so different requests.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
	} catch {
		let binary = "";
		for (const byte of body) binary += String.fromCharCode(byte);
		return `base64:${btoa(binary)}`;
	}
}

interface StoredFingerprints {
	readonly fingerprints: readonly string[];
}

// Stored shapes: the contract records plus what only the service reads. No secret value is ever in one.

interface StoredConnection {
	readonly connection: Connection;
	/** Vault item IDs. */
	readonly secrets: { readonly access?: string; readonly refresh?: string; readonly key?: string };
	readonly injection?: KeyInjection;
	readonly oauth?: {
		readonly tokenUrl: string;
		readonly issuer?: string;
		readonly resource?: string;
		readonly client: ClientPlan;
		readonly refreshBufferSeconds?: number;
		/** Where a disconnect revokes its tokens (#329), as the template or the authorisation server said at connect. */
		readonly revocation?: Revocation;
	};
}

/** A connection's refresh lease (#328): which process is refreshing it, until when. `until: 0` is released. */
interface StoredLease {
	readonly holder: string;
	readonly until: number;
}

/**
 * Why a refresh is asked for (#328): `due`, its buffer before expiry has come (or its backoff has passed); `sweep`, the
 * same from the sweep, which never waits for another process's lease; `rejected`, the upstream refused the token stored
 * at `seen` (the credential's `updatedAt`), so it is refreshed early unless it has moved on.
 */
type RefreshWant =
	| { readonly reason: "due" }
	| { readonly reason: "sweep" }
	| { readonly reason: "rejected"; readonly seen: number | undefined };

/** A revocation endpoint and how it is called (#329). */
interface Revocation {
	readonly url: string;
	readonly style: RevocationStyle;
}

interface ClientPlan {
	readonly via: ClientRegistration;
	readonly clientId: string;
	readonly oauthClientId?: string;
	readonly tier?: OAuthClientTier;
	/** The vault item holding its secret, for a stored client or a DCR client with one. */
	readonly secretRef?: string;
	/** A deployment client from configuration: its secret is read from there. */
	readonly platform?: boolean;
	/** A public client: no secret, so its token requests carry only its client ID (and it may use the device flow). */
	readonly public?: boolean;
	readonly authMethod?: string;
	/** A stored client registered on its own redirect domain: the redirect URI it was registered with. */
	readonly redirectUri?: string;
}

interface ConnectPlan {
	readonly authorizationUrl: string;
	readonly tokenUrl: string;
	readonly issuer?: string;
	readonly resource?: string;
	readonly scopes: readonly string[];
	readonly scopeSeparator: string;
	readonly extraParams: { readonly [name: string]: string };
	readonly pkce: boolean;
	readonly client: ClientPlan;
	readonly redirectUri: string;
	readonly hosts: readonly string[];
	readonly kind: Connection["kind"];
	readonly mcpUrl?: string;
	readonly templateId?: string;
	readonly templateVersion?: number;
	readonly refreshBufferSeconds?: number;
	readonly testRequest?: ProviderTemplate["testRequest"];
	readonly revocation?: Revocation;
}

interface StoredAttempt {
	readonly attempt: ConnectAttempt;
	readonly input: StartConnectInput;
	readonly plan?: ConnectPlan;
	readonly verifier?: string;
	readonly returnTo?: string;
	/** Set when the provider's callback used the state up: the code is being exchanged, so no new sign-in starts. */
	readonly exchanging?: true;
	/**
	 * A device-flow sign-in (RFC 8628): the device code (never in any answer; dropped once the attempt settles), the
	 * seconds between polls, when the next poll may go, and since when a poll holds the attempt.
	 */
	readonly device?: {
		readonly deviceCode: string;
		readonly interval: number;
		readonly nextPollAt: number;
		readonly pollingSince?: number;
	};
}

/** A GitHub App manifest flow. Keyed by its state's hash until GitHub's redirect back uses the state up. */
interface StoredGitHubApp {
	readonly setup: Omit<GitHubAppSetup, "url">;
	readonly owner: ConnectionOwner;
	readonly createdBy: Actor;
	readonly githubOrganisation?: string;
	readonly returnTo?: string;
	/** A few random characters for the app's name, which must be unique across GitHub. */
	readonly suffix: string;
}

interface StoredClient {
	readonly client: Omit<OAuthClient, "connections" | "redirectUri">;
	readonly secretRef?: string;
	readonly tokenHosts: readonly string[];
}

interface StoredRegistration {
	readonly issuer: string;
	readonly redirectUri: string;
	readonly clientId: string;
	readonly secretRef?: string;
	readonly authMethod: string;
	readonly at: number;
}

const SELF = systemContext("connections");
/** Who gives a connection its template's defaults (#332): Kantel itself, not a person or an agent. */
const RULES_ACTOR: Actor = { kind: "system", component: "connections" };

/** The scope a session's connections are checked against (`connectionTools` builds the same one). */
function sessionScopeOf(record: SessionRecord, audience: SessionAudience): ConnectionSessionScope {
	return {
		organisationId: record.organisationId,
		...(record.projectId === undefined ? {} : { projectId: record.projectId }),
		sessionId: record.id,
		agentId: record.agentId,
		...(record.userId === undefined ? {} : { actingUserId: record.userId }),
		audience,
	};
}

/** An approval of an exact request (#333) a send used: given back if the send never reached the upstream. */
interface UsedApproval {
	readonly proposalId: string;
	readonly grantId: string;
	readonly digest: string;
}

/** The headers as `deliver` sends them: those it drops (credentials, transport) are never part of an approval. */
function sentHeaders(headers: { readonly [name: string]: string }): { [name: string]: string } {
	const out: { [name: string]: string } = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!DROPPED_HEADERS.has(name.toLowerCase())) out[name.toLowerCase()] = value;
	}
	return out;
}

function withoutHeader(
	headers: { readonly [name: string]: string },
	name: string | undefined,
): { [name: string]: string } {
	const out = { ...headers };
	if (name !== undefined) delete out[name];
	return out;
}

/** JSON with object keys sorted, so the same tool call is the same text however its arguments were ordered. */
export function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
	const record = value as { readonly [key: string]: unknown };
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

/**
 * What the connection is, for an approval's digest: its owner, hosts, usage and server. A refreshed token or a new
 * name leaves it as it is; an edit that changes who may use it, or where it sends, changes it.
 */
async function connectionVersion(connection: Connection): Promise<string> {
	return sha256(
		stableJson({
			owner: connection.owner,
			hosts: connection.hosts,
			usage: connection.usage,
			auth: connection.auth,
			...(connection.mcp === undefined ? {} : { mcp: connection.mcp.url }),
		}),
	);
}

/**
 * Whether a failed fetch never reached the upstream: no address (DNS), no connection, or no TLS session. Only then is
 * an approval the request used given back; any other failure may have sent bytes, so the approval stays used.
 */
export function notConnected(error: unknown): boolean {
	// `publicFetch` refuses a private or unknown name before connecting.
	if (isKantelError(error)) return true;
	const codes: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") codes.push(code);
		current = (current as { cause?: unknown }).cause;
	}
	return codes.some((code) =>
		/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_CONNECT|ERR_TLS_.*|CERT_.*|UNABLE_TO_.*|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/.test(
			code,
		),
	);
}
const MANAGE_REFUSAL = "Agents cannot change connections or OAuth clients";

function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new KantelError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

const hostOf = (url: string) => new URL(url).hostname.toLowerCase();
/** The request a secret is opened for, for the vault's use record (#483): method and path, never the query. */
const sentTo = (method: HttpMethod, url: string | URL) => ({ method, path: new URL(url).pathname });
const last4 = (value: string) => (value.length > 8 ? value.slice(-4) : undefined);

/** Header names a tool may not set: the credential goes on here, and hop-by-hop headers are the fetch's. */
/** Never sent from the agent: its own credentials, and the hop-by-hop headers an exact request's digest leaves out. */
const DROPPED_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"proxy-connection",
	"te",
	"transfer-encoding",
	"upgrade",
]);

/** A key is a non-empty string long enough to find and cut out of an answer that echoes it. */
function checkKey(value: unknown): void {
	if (typeof value !== "string" || value.trim().length === 0) throw new KantelError("invalid", "The key is empty");
	if (value.trim().length < 8) throw new KantelError("invalid", "The key is shorter than 8 characters");
}

/** Up to `limit` bytes of a response's body; the rest is not read. */
async function readLimited(
	response: Response,
	limit: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
	const reader = response.body?.getReader();
	if (reader === undefined) return { bytes: new Uint8Array(0), truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	// One byte past the limit says whether there was more: a body cut short is redacted of a credential cut short too.
	while (size <= limit) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
	}
	await reader.cancel().catch(() => undefined);
	const out = new Uint8Array(Math.min(size, limit));
	let offset = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, Math.max(0, out.length - offset));
		out.set(part, offset);
		offset += part.byteLength;
	}
	return { bytes: out, truncated: size > limit };
}

/** Cuts every occurrence of each secret out of `text`. */
function redact(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
	return out;
}

function ownerOrganisation(owner: OwnerRef): string | undefined {
	return owner.kind === "platform" ? undefined : owner.organisationId;
}

function sameOwner(a: OwnerRef, b: OwnerRef): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function validateUsage(usage: ConnectionUsage): void {
	if (typeof usage !== "object" || usage === null) throw new KantelError("invalid", "A usage is an object");
	if (typeof usage.unattended !== "boolean")
		throw new KantelError("invalid", "A usage says whether unattended sessions may use it");
	if (usage.visibility !== "private" && usage.visibility !== "shared") {
		throw new KantelError("invalid", "A usage's visibility is private or shared");
	}
}

/** Base64 of a string's UTF-8 bytes: `btoa` alone throws on anything outside Latin-1. */
function base64Utf8(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * The headers (or query parameter) a key goes out in. For `basic` the key is `username:password`, split at the first
 * colon as RFC 7617 says; a key with no colon is the user name with an empty password, as Stripe-style keys are sent.
 */
function injectionHeaders(
	injection: KeyInjection,
	value: string,
): { headers: Record<string, string>; query?: [string, string] } {
	switch (injection.kind) {
		case "bearer":
			return { headers: { authorization: `Bearer ${value}` } };
		case "header":
			return { headers: { [injection.header.toLowerCase()]: `${injection.prefix ?? ""}${value}` } };
		case "basic":
			return { headers: { authorization: `Basic ${base64Utf8(value.includes(":") ? value : `${value}:`)}` } };
		case "header_template":
			return { headers: { [injection.header.toLowerCase()]: injection.template.split("{key}").join(value) } };
		case "query":
			return { headers: {}, query: [injection.param, value] };
	}
}

/** A query segment's name as written, and decoded, so `api_key` and `api%5Fkey` are the same parameter. */
function segmentNamed(segment: string, name: string): boolean {
	const raw = segment.split("=", 1)[0] ?? "";
	if (raw === name) return true;
	try {
		return decodeURIComponent(raw.replaceAll("+", " ")) === name;
	} catch {
		return false;
	}
}

/**
 * The URL without any `name` parameter the agent wrote, the rest of the query untouched. `URLSearchParams` would
 * re-encode every parameter (`a%20b` to `a+b`), so an exact request would not go out as approved.
 */
export function withoutQueryParam(url: URL, name: string): URL {
	const out = new URL(url.href);
	const kept = url.search
		.slice(1)
		.split("&")
		.filter((segment) => segment.length > 0 && !segmentNamed(segment, name));
	out.search = kept.length === 0 ? "" : `?${kept.join("&")}`;
	return out;
}

/** The URL with `name=value` set: any the agent wrote taken out, the new one added last, the rest as written. */
export function withQueryParam(url: URL, name: string, value: string): URL {
	const out = withoutQueryParam(url, name);
	const added = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
	out.search = out.search === "" ? `?${added}` : `${out.search}&${added}`;
	return out;
}

function assertInjection(injection: KeyInjection): void {
	const ok =
		injection.kind === "bearer" ||
		injection.kind === "basic" ||
		(injection.kind === "header" && typeof injection.header === "string" && injection.header.trim() !== "") ||
		(injection.kind === "query" && typeof injection.param === "string" && injection.param.trim() !== "") ||
		(injection.kind === "header_template" &&
			typeof injection.header === "string" &&
			injection.header.trim() !== "" &&
			typeof injection.template === "string" &&
			injection.template.includes("{key}"));
	if (!ok) throw new KantelError("invalid", "The key's injection is incomplete");
}

/** A dotted path into JSON, for a test request's account fields. */
function pick(value: unknown, path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	let current: unknown = value;
	for (const part of path.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return typeof current === "string" || typeof current === "number" ? String(current) : undefined;
}

export function createConnections(options: ConnectionsOptions): ConnectionsService {
	const { repository: repo, deployment } = options;
	const clock = options.clock ?? systemClock;
	/**
	 * The vault, with each secret's fingerprints (#331) kept beside its reference as it is stored or replaced, so the
	 * egress gate can screen a request for a raw secret without opening one. No value is kept.
	 */
	const credentials: CredentialStore = {
		async put(input) {
			const ref = await options.credentials.put(input);
			const organisationId = ownerOrganisation(input.owner);
			if (organisationId !== undefined) await keepFingerprints(organisationId, ref, input.value);
			return ref;
		},
		async replace(ref, value) {
			await options.credentials.replace(ref, value);
			const found = await repo.get<StoredFingerprints>("fingerprint", ref);
			if (found !== undefined) await keepFingerprints(found.organisationId, ref, value);
		},
		open: (input) => options.credentials.open(input),
		async remove(ref) {
			await options.credentials.remove(ref);
			await repo.remove("fingerprint", ref);
		},
	};
	/** Writes a secret's fingerprints, replacing any it had. Best effort: screening is defence in depth. */
	const keepFingerprints = async (organisationId: string, ref: string, value: string): Promise<void> => {
		try {
			const fingerprints = await fingerprintsOf(value);
			const found = await repo.get<StoredFingerprints>("fingerprint", ref);
			if (found === undefined) {
				await repo.insert("fingerprint", {
					id: ref,
					organisationId,
					value: { fingerprints },
					createdAt: clock.now(),
				});
			} else {
				await repo.update("fingerprint", ref, found.revision, { fingerprints });
			}
		} catch {
			// A secret with no fingerprints is still placeholder-gated; it just can't be caught going out raw.
		}
	};
	const fetch: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const access = (): ProjectAccess => (typeof options.access === "function" ? options.access() : options.access);
	const newId = options.newId ?? ((prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`);
	const catalogue = buildCatalogue(options.templates);
	const allowHttp = options.allowInsecureUrls === true;
	const origin = deployment.origin.replace(/\/+$/, "");
	const redirectUri = `${origin}/v1/connections/callback`;
	const cimdClientId = `${origin}/v1/connections/oauth/client-metadata.json`;
	const clientName = deployment.clientName ?? "Kantel";
	const platformClients = deployment.platformClients ?? [];
	const refreshing = new Map<string, Promise<RefreshOutcome>>();

	// Audit.

	const audit = async (
		ctx: { readonly actor: Actor; readonly organisationId?: string },
		organisationId: string,
		event: Omit<AuditEventInput, "at" | "source" | "actor" | "organisationId" | "id"> & { readonly id?: string },
	) => {
		if (options.audit === undefined) return;
		try {
			await options.audit.append(SELF, [
				{
					id: event.id ?? `connections:${newId("ev")}`,
					...event,
					at: clock.now(),
					source: "connections",
					actor: ctx.actor,
					organisationId,
				},
			]);
		} catch {
			// An audit outage never fails a connect; the vault records every secret's use on its own.
		}
	};

	// Access.

	const forbidAgent = (ctx: CallContext) => {
		if (ctx.actor.kind === "agent") throw new KantelError("forbidden", MANAGE_REFUSAL);
	};

	const sameOrganisation = (ctx: CallContext, owner: OwnerRef) => {
		const organisation = ownerOrganisation(owner);
		if (organisation !== undefined && organisation !== ctx.organisationId) {
			throw new KantelError("invalid", "The owner must be in the caller's organisation");
		}
	};

	/** Admin on the owner, or the person themselves for their own. */
	const requireManage = async (ctx: CallContext, owner: OwnerRef, operation: string, subject?: string) => {
		forbidAgent(ctx);
		sameOrganisation(ctx, owner);
		const sub = subject === undefined ? {} : { subject: { kind: "connection", id: subject } };
		switch (owner.kind) {
			case "platform":
				await requireSystem(ctx, operation);
				return;
			case "organisation":
				await access().require(ctx, { needed: "admin", operation, ...sub });
				return;
			case "project":
				await access().require(ctx, { projectId: owner.projectId, needed: "admin", operation, ...sub });
				return;
			case "user":
				await access().require(ctx, { userId: owner.userId, needed: "admin", operation, ...sub });
				return;
		}
	};

	const canView = async (ctx: CallContext, owner: OwnerRef): Promise<boolean> => {
		if (ctx.actor.kind === "system") return true;
		switch (owner.kind) {
			case "platform":
				return true;
			case "organisation":
				return owner.organisationId === ctx.organisationId && access().allows(ctx, { needed: "viewer" });
			case "project":
				return (
					owner.organisationId === ctx.organisationId &&
					access().allows(ctx, { projectId: owner.projectId, needed: "viewer" })
				);
			case "user":
				return (
					owner.organisationId === ctx.organisationId &&
					access().allows(ctx, { userId: owner.userId, needed: "viewer" })
				);
		}
	};

	// Templates and clients.

	const template = (id: string): ProviderTemplate => {
		const found = templateById(catalogue, id);
		if (found === undefined) throw new KantelError("not_found", `No template ${id}`);
		return found;
	};

	/** The redirect URI a stored client is registered with: on its own redirect domain, or the deployment's. */
	const redirectUriOf = (client: Pick<OAuthClient, "redirectDomain">): string =>
		client.redirectDomain === undefined ? redirectUri : `https://${client.redirectDomain}/v1/connections/callback`;

	/** A connect's plan for a stored client: its ID, tier and secret, and the redirect URI it was registered with. */
	const storedClientPlan = (stored: { readonly client: StoredClient["client"]; readonly secretRef?: string }) =>
		({
			via: "client",
			clientId: stored.client.clientId,
			oauthClientId: stored.client.id,
			tier: stored.client.owner.kind,
			...(stored.secretRef === undefined ? { public: true } : { secretRef: stored.secretRef }),
			...(stored.client.redirectDomain === undefined ? {} : { redirectUri: redirectUriOf(stored.client) }),
		}) satisfies ClientPlan;

	/** A connect's plan for one of the deployment's clients from its configuration. */
	const platformClientPlan = (client: PlatformOAuthClient): ClientPlan => ({
		via: "client",
		clientId: client.clientId,
		tier: "platform",
		platform: true,
		...(client.clientSecret === undefined ? { public: true } : {}),
	});

	const clientView = async (stored: StoredClient): Promise<OAuthClient> => {
		const pinned = (
			await repo.list<StoredConnection>("connection", { organisationId: ownerOrganisation(stored.client.owner) ?? "" })
		).filter((record) => record.value.connection.client?.oauthClientId === stored.client.id).length;
		return {
			...stored.client,
			redirectUri: redirectUriOf(stored.client),
			connections: pinned,
			...(stored.secretRef === undefined ? { public: true } : {}),
		};
	};

	const platformClientView = (client: PlatformOAuthClient, index: number): OAuthClient => ({
		id: `platform:${client.templateId ?? client.issuer ?? index}`,
		owner: { kind: "platform" },
		...(client.templateId === undefined ? {} : { templateId: client.templateId }),
		...(client.issuer === undefined ? {} : { issuer: client.issuer }),
		label: client.label ?? "The deployment's client",
		clientId: client.clientId,
		secret: {
			set: client.clientSecret !== undefined,
			...(client.clientSecret === undefined ? {} : { last4: last4(client.clientSecret) }),
			refreshable: false,
		},
		...(client.scopes === undefined ? {} : { scopes: client.scopes }),
		redirectUri,
		disabled: false,
		connections: 0,
		...(client.clientSecret === undefined ? { public: true } : {}),
		createdBy: { kind: "system", component: "deployment" },
		createdAt: 0,
		updatedAt: 0,
	});

	/** The stored clients an owner's connect may use, most specific tier first, for a template or an issuer. */
	const storedClientsFor = async (
		organisationId: string,
		owner: ConnectionOwner,
		match: { readonly templateId?: string; readonly issuer?: string },
	): Promise<StoredClient[]> =>
		pickStoredClients(
			(await repo.list<StoredClient>("client", { organisationId })).map((record) => record.value),
			owner,
			match,
		);

	/** `storedClientsFor` over clients already read, so the catalogue reads them once for every entry. */
	const pickStoredClients = (
		all: readonly StoredClient[],
		owner: ConnectionOwner,
		match: { readonly templateId?: string; readonly issuer?: string },
	): StoredClient[] => {
		const matches = (stored: StoredClient) =>
			!stored.client.disabled &&
			((match.templateId !== undefined && stored.client.templateId === match.templateId) ||
				(match.issuer !== undefined && stored.client.issuer === match.issuer));
		const tiers: ((stored: StoredClient) => boolean)[] = [];
		if (owner.kind === "user")
			tiers.push((s) => s.client.owner.kind === "user" && s.client.owner.userId === owner.userId);
		if (owner.kind === "project") {
			tiers.push((s) => s.client.owner.kind === "project" && s.client.owner.projectId === owner.projectId);
		}
		tiers.push((s) => s.client.owner.kind === "organisation");
		const out: StoredClient[] = [];
		for (const tier of tiers) out.push(...all.filter((stored) => matches(stored) && tier(stored)));
		return out;
	};

	const platformClientFor = (match: { readonly templateId?: string; readonly issuer?: string }) =>
		platformClients.find(
			(client) =>
				(match.templateId !== undefined && client.templateId === match.templateId) ||
				(match.issuer !== undefined && client.issuer === match.issuer),
		);

	/**
	 * How a template connects for the caller (#325), by the client a connect would use, in the order `planConnect` tries
	 * them: the caller's or their organisation's stored client, then the deployment's, then CIMD or DCR. A person's or
	 * project's own client is `own_app`; an organisation's, or the deployment's with a secret, is `host_client`; the
	 * deployment's with no secret is `public_client`. `clients`: the organisation's stored clients, read once.
	 */
	const setupOf = (
		ctx: CallContext,
		entry: ProviderTemplate,
		clients: readonly StoredClient[],
	): Pick<CatalogueEntry, "setup" | "clientTiers" | "tier" | "signIn" | "client" | "guide"> => {
		const oauth = entry.authTypes.includes("oauth2") ? entry.oauth : undefined;
		if (oauth === undefined) return { setup: "ready", tier: entry.authTypes.includes("none") ? "none" : "key" };
		const guide = setupGuide(entry, redirectUri);
		const withGuide = guide === undefined ? {} : { guide };
		const registration = oauth.registration;
		const signIn = (isPublic: boolean) =>
			isPublic && oauth.deviceAuthorizationUrl !== undefined ? ("device" as const) : ("browser" as const);
		if (registration.includes("client")) {
			const stored = pickStoredClients(clients, callerOwner(ctx), { templateId: entry.id })[0];
			if (stored !== undefined) {
				const owner = stored.client.owner.kind;
				const isPublic = stored.secretRef === undefined;
				const client: ResolvedClientInfo = {
					tier: owner,
					ownerLabel: owner === "organisation" ? "your organisation" : owner === "project" ? "your project" : "you",
					label: stored.client.label,
					public: isPublic,
				};
				return {
					setup: "ready",
					tier: owner === "organisation" ? "host_client" : "own_app",
					signIn: signIn(isPublic),
					client,
					...withGuide,
				};
			}
			const platform = platformClientFor({ templateId: entry.id });
			if (platform !== undefined) {
				const isPublic = platform.clientSecret === undefined;
				return {
					setup: "ready",
					tier: isPublic ? "public_client" : "host_client",
					signIn: signIn(isPublic),
					client: {
						tier: "platform",
						ownerLabel: clientName,
						...(platform.label === undefined ? {} : { label: platform.label }),
						public: isPublic,
					},
					...withGuide,
				};
			}
		}
		if (registration.includes("dcr") || (registration.includes("cimd") && deployment.clientMetadataPublic)) {
			return { setup: "ready", tier: "none", signIn: "browser" };
		}
		return {
			setup: "needs_client",
			clientTiers: ["platform", "organisation", "project", "user"],
			tier: "own_app",
			...withGuide,
		};
	};

	/** Whose connection a catalogue or discovery read is for: the person's own, or the organisation's for a service. */
	const callerOwner = (ctx: CallContext): ConnectionOwner =>
		ctx.actor.kind === "human"
			? { kind: "user", organisationId: ctx.organisationId, userId: ctx.actor.userId }
			: { kind: "organisation", organisationId: ctx.organisationId };

	/** A client's secret, for a token request: from the deployment's configuration, or opened from the vault. */
	const clientSecretFor = async (
		plan: ClientPlan,
		tokenUrl: string,
		organisationId: string,
	): Promise<string | undefined> => {
		if (plan.platform === true)
			return platformClients.find((client) => client.clientId === plan.clientId)?.clientSecret;
		if (plan.secretRef === undefined) return undefined;
		return credentials.open({
			ref: plan.secretRef,
			host: hostOf(tokenUrl),
			organisationId,
			purpose: `OAuth client ${plan.clientId}: token request`,
			request: sentTo("POST", tokenUrl),
		});
	};

	const tokenClient = async (plan: ClientPlan, tokenUrl: string, organisationId: string): Promise<TokenClient> => {
		const secret = await clientSecretFor(plan, tokenUrl, organisationId);
		return {
			clientId: plan.clientId,
			...(secret === undefined ? {} : { clientSecret: secret }),
			...(plan.authMethod === undefined ? {} : { authMethod: plan.authMethod }),
		};
	};

	/** The deployment's DCR client at an authorisation server, registered once and reused. */
	const dcrClient = async (issuer: string, endpoint: string, tokenUrl: string): Promise<ClientPlan> => {
		const key = `${issuer} ${redirectUri}`;
		const existing = await repo.findByKey<StoredRegistration>("registration", key);
		if (existing !== undefined) {
			const value = existing.value;
			return {
				via: "dcr",
				clientId: value.clientId,
				...(value.secretRef === undefined ? {} : { secretRef: value.secretRef }),
				authMethod: value.authMethod,
			};
		}
		const registered = await registerClient(fetch, endpoint, { redirectUri, clientName, origin }, { allowHttp });
		const secretRef =
			registered.clientSecret === undefined
				? undefined
				: await credentials.put({
						owner: { kind: "platform" },
						name: `oauth-client-${hostOf(tokenUrl)}`,
						hosts: [hostOf(tokenUrl)],
						value: registered.clientSecret,
						createdBy: SELF.actor,
					});
		const record: StoredRegistration = {
			issuer,
			redirectUri,
			clientId: registered.clientId,
			...(secretRef === undefined ? {} : { secretRef }),
			authMethod: registered.tokenEndpointAuthMethod,
			at: clock.now(),
		};
		const inserted = await repo.insert("registration", {
			id: (await sha256(key)).slice(0, 32),
			organisationId: "",
			key,
			value: record,
			createdAt: clock.now(),
		});
		if (!inserted) {
			// Another gateway registered first: use theirs.
			if (secretRef !== undefined) await credentials.remove(secretRef).catch(() => undefined);
			return dcrClient(issuer, endpoint, tokenUrl);
		}
		return {
			via: "dcr",
			clientId: registered.clientId,
			...(secretRef === undefined ? {} : { secretRef }),
			authMethod: registered.tokenEndpointAuthMethod,
		};
	};

	const fail = (code: ConnectFailureCode, message: string): never => {
		throw new KantelError(
			code === "no_client" ? "refused" : code === "discovery_failed" ? "unavailable" : "refused",
			message,
			{
				failure: code,
			},
		);
	};

	/** Where to sign in and with which client, for a template or an MCP server. */
	const planConnect = async (
		ctx: CallContext,
		input: StartConnectInput,
		entry: ProviderTemplate | undefined,
		mcpUrl: string | undefined,
	): Promise<{
		readonly plan?: ConnectPlan;
		readonly open?: { readonly hosts: readonly string[]; readonly resource?: string };
	}> => {
		const owner = input.owner;
		const scopesFrom = (fallback: readonly string[] | undefined): string[] => {
			const sets = entry?.scopeSets ?? [];
			const picked =
				input.scopeSets === undefined
					? sets.filter((set) => set.default === true)
					: sets.filter((set) => input.scopeSets!.includes(set.id));
			if (input.scopeSets !== undefined && picked.length !== input.scopeSets.length) {
				throw new KantelError("invalid", "One of the scope sets is not the template's");
			}
			const scopes = new Set([...picked.flatMap((set) => set.scopes), ...(input.scopes ?? [])]);
			if (scopes.size === 0) for (const scope of fallback ?? []) scopes.add(scope);
			return [...scopes];
		};

		if (entry !== undefined && entry.oauth?.discovery === "static") {
			const oauth = entry.oauth;
			const stored = await storedClientsFor(ctx.organisationId, owner, { templateId: entry.id });
			const platform = platformClientFor({ templateId: entry.id });
			let client: ClientPlan | undefined;
			if (stored[0] !== undefined) {
				client = storedClientPlan(stored[0]);
			} else if (platform !== undefined) {
				client = platformClientPlan(platform);
			}
			if (client === undefined) {
				return fail(
					"no_client",
					`${entry.name} needs an OAuth app registered first (organisation, project, person or deployment)`,
				);
			}
			return {
				plan: {
					authorizationUrl: oauth.authorizationUrl!,
					tokenUrl: oauth.tokenUrl!,
					scopes: scopesFrom(undefined),
					scopeSeparator: oauth.scopeSeparator ?? " ",
					extraParams: oauth.extraAuthorizationParams ?? {},
					pkce: oauth.pkce,
					client,
					redirectUri: client.redirectUri ?? redirectUri,
					hosts: entry.apiHosts,
					kind: entry.kind,
					templateId: entry.id,
					templateVersion: entry.version,
					...(oauth.refreshBufferSeconds === undefined ? {} : { refreshBufferSeconds: oauth.refreshBufferSeconds }),
					...(entry.testRequest === undefined ? {} : { testRequest: entry.testRequest }),
					...(oauth.revocationUrl === undefined
						? {}
						: { revocation: { url: oauth.revocationUrl, style: oauth.revocationStyle ?? "rfc7009" } }),
				},
			};
		}

		const url = mcpUrl ?? entry?.mcp?.url;
		if (url === undefined) throw new KantelError("invalid", "Give a template with OAuth, or an MCP server's URL");
		let discovered: Awaited<ReturnType<typeof discoverMcpAuth>>;
		try {
			discovered = await discoverMcpAuth(fetch, url, { allowHttp });
		} catch (error) {
			if (isKantelError(error, "invalid")) throw error;
			return fail("discovery_failed", `Kantel could not reach the MCP server at ${hostOf(url)}`);
		}
		const host = hostOf(discovered.url);
		const hosts = entry?.apiHosts ?? [host];
		if (discovered.auth === "none") {
			return { open: { hosts, ...(discovered.resource === undefined ? {} : { resource: discovered.resource }) } };
		}
		const server = discovered.server;
		if (server === undefined)
			return fail("discovery_failed", `The MCP server at ${host} named no authorisation server Kantel could read`);
		const issuer = server.issuer ?? new URL(server.authorization_endpoint).origin;
		const allowed = entry?.oauth?.registration ?? ["client", "cimd", "dcr"];
		const match = { ...(entry === undefined ? {} : { templateId: entry.id }), issuer };
		let client: ClientPlan | undefined;
		if (allowed.includes("client")) {
			const stored = (await storedClientsFor(ctx.organisationId, owner, match))[0];
			const platform = platformClientFor(match);
			if (stored !== undefined) {
				client = storedClientPlan(stored);
			} else if (platform !== undefined) {
				client = platformClientPlan(platform);
			}
		}
		if (
			client === undefined &&
			allowed.includes("cimd") &&
			deployment.clientMetadataPublic &&
			server.client_id_metadata_document_supported === true
		) {
			client = { via: "cimd", clientId: cimdClientId, authMethod: "none" };
		}
		if (client === undefined && allowed.includes("dcr") && server.registration_endpoint !== undefined) {
			try {
				client = await dcrClient(issuer, server.registration_endpoint, server.token_endpoint);
			} catch (error) {
				return fail("registration_failed", isKantelError(error) ? error.message : "Dynamic client registration failed");
			}
		}
		if (client === undefined) {
			return fail(
				"no_client",
				`The MCP server at ${host} needs an OAuth app registered first: it offers neither CIMD nor DCR`,
			);
		}
		return {
			plan: {
				authorizationUrl: server.authorization_endpoint,
				tokenUrl: server.token_endpoint,
				issuer,
				...(discovered.resource === undefined ? {} : { resource: discovered.resource }),
				scopes: scopesFrom(discovered.scopes),
				scopeSeparator: " ",
				extraParams: {},
				pkce: true,
				client,
				redirectUri: client.redirectUri ?? redirectUri,
				hosts,
				kind: "mcp",
				mcpUrl: discovered.url,
				...(entry === undefined ? {} : { templateId: entry.id, templateVersion: entry.version }),
				...(typeof server.revocation_endpoint === "string"
					? { revocation: { url: server.revocation_endpoint, style: "rfc7009" as const } }
					: {}),
			},
		};
	};

	// Connections.

	const connectionRecord = async (connectionId: string): Promise<StoredRecord<StoredConnection>> => {
		const found = await repo.get<StoredConnection>("connection", connectionId);
		if (found === undefined) throw new KantelError("not_found", `No connection ${connectionId}`);
		return found;
	};

	/**
	 * Whether the caller may see a connection: viewer on its owner. A person's connection is also seen (never used or
	 * shared) by an organisation admin, and by the members of each project it is shared with (#335).
	 */
	const canSee = async (ctx: CallContext, connection: Pick<Connection, "owner" | "shares">): Promise<boolean> => {
		if (await canView(ctx, connection.owner)) return true;
		if (connection.owner.kind !== "user" || connection.owner.organisationId !== ctx.organisationId) return false;
		if (ctx.actor.kind === "agent") return false;
		if (await access().allows(ctx, { needed: "admin" })) return true;
		for (const share of connection.shares ?? []) {
			if (await access().allows(ctx, { projectId: share.projectId, needed: "viewer" })) return true;
		}
		return false;
	};

	/**
	 * Whether a use may be listed to the caller whole, as far as its session's privacy goes (#335). A use in a private
	 * session is that session's business: it shows to the connection's owner (a person's connection is theirs to account
	 * for), to the person the session acted for, and to whoever may open the session now (the service that made it, say).
	 * Anyone else, an organisation or project admin included, gets it redacted (`redactUse`): when and how it ended, not
	 * its session's ID or anything from inside it. `opens` caches, per session, whether the caller may open it.
	 */
	const privateUseShown = async (
		ctx: CallContext,
		use: ConnectionUse,
		connectionOf: (id: string) => Promise<Pick<Connection, "owner"> | undefined>,
		opens: Map<string, boolean>,
	): Promise<boolean> => {
		if (use.audience.kind !== "private" || ctx.actor.kind === "system") return true;
		const caller = ctx.actor.kind === "human" ? ctx.actor.userId : undefined;
		if (caller !== undefined && caller === use.audience.userId) return true;
		let open = opens.get(use.sessionId);
		if (open === undefined) {
			open = await access().allows(ctx, { sessionId: use.sessionId, needed: "viewer" });
			opens.set(use.sessionId, open);
		}
		if (open) return true;
		if (caller === undefined) return false;
		const owner = (await connectionOf(use.connectionId))?.owner;
		return owner?.kind === "user" && owner.userId === caller;
	};

	const visibleConnection = async (ctx: CallContext, connectionId: string): Promise<StoredRecord<StoredConnection>> => {
		const found = await repo.get<StoredConnection>("connection", connectionId);
		if (
			found === undefined ||
			found.organisationId !== ctx.organisationId ||
			!(await canSee(ctx, found.value.connection))
		) {
			throw new KantelError("not_found", `No connection ${connectionId}`);
		}
		return found;
	};

	/** Writes a connection's next state from the stored one, read again after a lost race. */
	const changeConnection = async (
		connectionId: string,
		next: (stored: StoredConnection) => StoredConnection | undefined,
	): Promise<StoredConnection> => {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const found = await connectionRecord(connectionId);
			const changed = next(found.value);
			if (changed === undefined) return found.value;
			if (await repo.update("connection", connectionId, found.revision, changed)) return changed;
		}
		throw new KantelError("conflict", `Connection ${connectionId} changed while it was being updated; try again`);
	};

	/** Stores a new connection, with its placeholder when it has a credential (#331). Resolves the connection as stored. */
	const saveNewConnection = async (given: StoredConnection): Promise<Connection> => {
		// Its placeholder (#331), for a connection with a credential: indexed first, so it always names this connection.
		const placeholder =
			given.connection.auth === "none" ? undefined : await indexPlaceholder(given.connection, newPlaceholder());
		const stored = placeholder === undefined ? given : { ...given, connection: { ...given.connection, placeholder } };
		const inserted = await repo.insert("connection", {
			id: stored.connection.id,
			organisationId: stored.connection.organisationId,
			key: `${stored.connection.owner.kind}:${stored.connection.owner.kind === "organisation" ? stored.connection.owner.organisationId : stored.connection.owner.kind === "project" ? stored.connection.owner.projectId : stored.connection.owner.userId}`,
			value: stored,
			createdAt: stored.connection.createdAt,
		});
		if (!inserted) {
			if (placeholder !== undefined) await repo.remove("placeholder", placeholder);
			throw new KantelError("conflict", "That connection ID is taken");
		}
		// It starts with its template's defaults (#332): reads allow, writes ask, deletes deny.
		await ensureRules(stored.connection, "created", stored.connection.createdBy);
		return stored.connection;
	};

	/** A fresh placeholder: `kantel-cn-` and 128 random bits in hex. */
	const newPlaceholder = (): string => {
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		return `kantel-cn-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	};

	/** Records which connection a placeholder names. Resolves the placeholder. */
	const indexPlaceholder = async (connection: Connection, placeholder: string): Promise<string> => {
		const inserted = await repo.insert("placeholder", {
			id: placeholder,
			organisationId: connection.organisationId,
			key: connection.id,
			value: { connectionId: connection.id },
			createdAt: clock.now(),
		});
		// 128 random bits don't collide; if they ever did, the placeholder would name two connections, so it is refused.
		if (!inserted) throw new KantelError("conflict", "Kantel could not issue the connection's placeholder; try again");
		return placeholder;
	};

	/**
	 * A connection's placeholder, given to one made before #331 the first time a session lists it. Two instances racing
	 * settle on the one the record keeps; the other's index entry is removed.
	 */
	const ensurePlaceholder = async (stored: StoredRecord<StoredConnection>): Promise<Connection> => {
		const { connection } = stored.value;
		if (connection.placeholder !== undefined || connection.auth === "none") return connection;
		const placeholder = await indexPlaceholder(connection, newPlaceholder());
		const updated = await changeConnection(connection.id, (current) =>
			current.connection.placeholder === undefined
				? { ...current, connection: { ...current.connection, placeholder } }
				: undefined,
		);
		if (updated.connection.placeholder !== placeholder) await repo.remove("placeholder", placeholder);
		return updated.connection;
	};

	const connectionEvent = (type: string, connection: Connection, extra: Record<string, JsonValue> = {}) => ({
		type,
		...(connection.owner.kind === "project" ? { projectId: connection.owner.projectId } : {}),
		subject: { kind: "connection", id: connection.id },
		data: {
			name: connection.name,
			owner: connection.owner.kind,
			kind: connection.kind,
			auth: connection.auth,
			...(connection.templateId === undefined ? {} : { templateId: connection.templateId }),
			hosts: [...connection.hosts],
			...extra,
		},
	});

	/** Makes the connection for a finished OAuth exchange, or updates the one being reconnected. */
	const storeTokens = async (
		stored: StoredAttempt,
		plan: ConnectPlan,
		tokens: TokenSet,
		actor: Actor,
	): Promise<Connection> => {
		const { attempt, input } = stored;
		const owner = input.owner;
		const now = clock.now();
		const account = {
			...(idTokenAccount(tokens.idToken) ?? {}),
			...((await testAccount(plan, tokens.accessToken)) ?? {}),
		};
		const putSecret = (name: string, hosts: readonly string[], value: string) =>
			credentials.put({ owner, name, hosts, value, createdBy: actor });
		const slug = (plan.templateId ?? hostOf(plan.mcpUrl ?? plan.tokenUrl)).replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
		const oauth: StoredConnection["oauth"] = {
			tokenUrl: plan.tokenUrl,
			...(plan.issuer === undefined ? {} : { issuer: plan.issuer }),
			...(plan.resource === undefined ? {} : { resource: plan.resource }),
			client: plan.client,
			...(plan.refreshBufferSeconds === undefined ? {} : { refreshBufferSeconds: plan.refreshBufferSeconds }),
			...(plan.revocation === undefined ? {} : { revocation: plan.revocation }),
		};
		const credential = {
			set: true,
			...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
			refreshable: tokens.refreshToken !== undefined,
			updatedAt: now,
		};
		const scopes = { requested: [...plan.scopes], granted: [...(tokens.scopes ?? plan.scopes)] };
		const clientRef = {
			via: plan.client.via,
			clientId: plan.client.clientId,
			...(plan.client.oauthClientId === undefined ? {} : { oauthClientId: plan.client.oauthClientId }),
			...(plan.client.tier === undefined ? {} : { tier: plan.client.tier }),
		};

		if (input.connectionId !== undefined) {
			const previous = await connectionRecord(input.connectionId);
			const access = await putSecret(`${slug}-access`, plan.hosts, tokens.accessToken);
			const refresh =
				tokens.refreshToken === undefined
					? undefined
					: await putSecret(`${slug}-refresh`, [hostOf(plan.tokenUrl)], tokens.refreshToken);
			const updated = await changeConnection(input.connectionId, (current) => ({
				...current,
				secrets: { access, ...(refresh === undefined ? {} : { refresh }) },
				oauth,
				connection: {
					...current.connection,
					hosts: [...plan.hosts],
					...(Object.keys(account).length === 0 ? {} : { account }),
					scopes,
					client: clientRef,
					status: "active",
					// A reconnect ends `refresh_failing` and `needs_reconnect` (#328); its ID, rules and history stay.
					health: { state: "ok", since: now, refreshedAt: now },
					credential,
					updatedAt: now,
				},
			}));
			for (const ref of [previous.value.secrets.access, previous.value.secrets.refresh]) {
				if (ref !== undefined) await credentials.remove(ref).catch(() => undefined);
			}
			announceDue(updated);
			return updated.connection;
		}

		const access = await putSecret(`${slug}-access`, plan.hosts, tokens.accessToken);
		const refresh =
			tokens.refreshToken === undefined
				? undefined
				: await putSecret(`${slug}-refresh`, [hostOf(plan.tokenUrl)], tokens.refreshToken);
		const entry = plan.templateId === undefined ? undefined : templateById(catalogue, plan.templateId);
		const connection: Connection = {
			id: newId("conn"),
			organisationId: attempt.organisationId,
			owner,
			name: input.name ?? entry?.name ?? hostOf(plan.mcpUrl ?? plan.authorizationUrl),
			...(plan.templateId === undefined ? {} : { templateId: plan.templateId }),
			...(plan.templateVersion === undefined ? {} : { templateVersion: plan.templateVersion }),
			kind: plan.kind,
			auth: "oauth2",
			...(plan.mcpUrl === undefined
				? {}
				: { mcp: { url: plan.mcpUrl, ...(plan.resource === undefined ? {} : { resource: plan.resource }) } }),
			hosts: [...plan.hosts],
			...(Object.keys(account).length === 0 ? {} : { account }),
			scopes,
			client: clientRef,
			usage: input.usage ?? defaultConnectionUsage(owner),
			status: "active",
			health: { state: "ok", since: now, refreshedAt: now },
			credential,
			createdBy: attempt.createdBy,
			createdAt: now,
			updatedAt: now,
		};
		const saved: StoredConnection = {
			connection,
			secrets: { access, ...(refresh === undefined ? {} : { refresh }) },
			oauth,
		};
		const made = await saveNewConnection(saved);
		announceDue(saved);
		return made;
	};

	/**
	 * A template's test request with a credential, sent the way that credential goes out (a token as a bearer, a key by
	 * its injection). Best effort: `refused` only when the service answered 401 or 403, never for a network error or
	 * another status; `account` when it answered and the template says where the account is. The credential only goes to
	 * one of the template's own API hosts over https: a test URL anywhere else is skipped.
	 */
	const runTest = async (
		test: NonNullable<ProviderTemplate["testRequest"]>,
		hosts: readonly string[],
		injection: KeyInjection,
		value: string,
	): Promise<{ readonly refused: boolean; readonly account?: Connection["account"] }> => {
		const injected = injectionHeaders(injection, value);
		try {
			const url = new URL(test.url);
			if (url.protocol !== "https:" || !hosts.includes(url.hostname)) return { refused: false };
			if (injected.query !== undefined) url.searchParams.set(injected.query[0], injected.query[1]);
			const response = await fetch(url.href, {
				method: test.method,
				headers: { accept: "application/json", "user-agent": "Kantel", ...injected.headers },
				redirect: "manual",
			});
			if (response.status === 401 || response.status === 403) {
				await response.body?.cancel().catch(() => undefined);
				return { refused: true };
			}
			if (!response.ok || test.account === undefined) {
				await response.body?.cancel().catch(() => undefined);
				return { refused: false };
			}
			const json = await response.json();
			const id = pick(json, test.account.id);
			const name = pick(json, test.account.name);
			const email = pick(json, test.account.email);
			const account = {
				...(id === undefined ? {} : { id }),
				...(name === undefined ? {} : { name }),
				...(email === undefined ? {} : { email }),
			};
			return { refused: false, ...(Object.keys(account).length === 0 ? {} : { account }) };
		} catch {
			return { refused: false };
		}
	};

	/** Whose account a fresh token is, from the template's test request. Best effort; never fails a connect. */
	const testAccount = async (
		plan: { readonly testRequest?: ProviderTemplate["testRequest"]; readonly hosts: readonly string[] },
		token: string,
	) => {
		const test = plan.testRequest;
		if (test?.account === undefined) return undefined;
		return (await runTest(test, plan.hosts, { kind: "bearer" }, token)).account;
	};

	// Attempts.

	const attemptRecord = async (attemptId: string): Promise<StoredRecord<StoredAttempt>> => {
		const found = await repo.get<StoredAttempt>("attempt", attemptId);
		if (found === undefined) throw new KantelError("not_found", `No connect attempt ${attemptId}`);
		return found;
	};

	/** The attempt as of now: a pending one past its expiry reads as expired. */
	const attemptView = (stored: StoredAttempt): ConnectAttempt => {
		const attempt = stored.attempt;
		if (attempt.status === "pending" && clock.now() >= attempt.expiresAt) {
			const { connectUrl: _url, device: _device, ...rest } = attempt;
			return { ...rest, status: "expired" };
		}
		return attempt;
	};

	/** An attempt settled: no connect URL, no device code, no verifier left in it. */
	const settled = (stored: StoredAttempt, attempt: Partial<ConnectAttempt>): StoredAttempt => {
		const { connectUrl: _url, device: _device, ...rest } = stored.attempt;
		const { verifier: _verifier, device: _code, ...keep } = stored;
		return { ...keep, attempt: { ...rest, ...attempt, completedAt: clock.now() } };
	};

	const settleAttempt = async (
		attemptId: string,
		settle: (stored: StoredAttempt) => StoredAttempt,
		key: string | null = null,
	): Promise<StoredAttempt> => {
		for (let tries = 0; tries < 5; tries += 1) {
			const found = await attemptRecord(attemptId);
			const next = settle(found.value);
			if (await repo.update("attempt", attemptId, found.revision, next, key)) return next;
		}
		throw new KantelError("conflict", `Connect attempt ${attemptId} changed while it was being settled`);
	};

	const failAttempt = async (attemptId: string, code: ConnectFailureCode, message: string) =>
		settleAttempt(attemptId, (stored) => settled(stored, { status: "failed", failure: { code, message } }));

	/** Records a finished OAuth sign-in: the connection made or updated, the attempt completed, the event audited. */
	const finishConnect = async (
		attemptId: string,
		stored: StoredAttempt,
		plan: ConnectPlan,
		tokens: TokenSet,
		actor: Actor,
	): Promise<StoredAttempt> => {
		const connection = await storeTokens(stored, plan, tokens, actor);
		const done = await settleAttempt(attemptId, (current) =>
			settled(current, { status: "completed", connectionId: connection.id }),
		);
		await audit(
			{ actor },
			connection.organisationId,
			connectionEvent(
				stored.input.connectionId === undefined
					? "connections.connection.created"
					: "connections.connection.reconnected",
				connection,
				{ client: plan.client.via, ...(stored.device === undefined ? {} : { signIn: "device" }) },
			),
		);
		return done;
	};

	/** The device code's next poll: no sooner than `interval` seconds from now, and nobody holding the attempt. */
	const releaseDevice = (attemptId: string, interval: number) =>
		settleAttempt(attemptId, (current) =>
			current.device === undefined
				? current
				: {
						...current,
						attempt:
							current.attempt.device === undefined
								? current.attempt
								: { ...current.attempt, device: { ...current.attempt.device, interval } },
						device: { deviceCode: current.device.deviceCode, interval, nextPollAt: clock.now() + interval * 1000 },
					},
		);

	/**
	 * Asks the provider once whether a device-flow attempt has been authorised, when its interval has passed and no other
	 * caller holds it. The hold is taken with a revision-checked write first, so two gateways polling one attempt never
	 * both spend the device code; a hold left by a crashed poll lapses after `DEVICE_POLL_LEASE_MS`.
	 */
	const pollDevice = async (found: StoredRecord<StoredAttempt>): Promise<StoredAttempt> => {
		const stored = found.value;
		const { device, plan } = stored;
		const now = clock.now();
		if (device === undefined || plan === undefined || stored.attempt.status !== "pending") return stored;
		if (now >= stored.attempt.expiresAt || now < device.nextPollAt) return stored;
		if (device.pollingSince !== undefined && now < device.pollingSince + DEVICE_POLL_LEASE_MS) return stored;
		const held: StoredAttempt = { ...stored, device: { ...device, pollingSince: now } };
		if (!(await repo.update("attempt", found.id, found.revision, held))) return (await attemptRecord(found.id)).value;
		let result: DevicePollResult;
		try {
			// Given up well inside the hold, so a slow answer never overlaps the next poll's.
			result = await devicePoll(fetch, plan.tokenUrl, plan.client.clientId, device.deviceCode, {
				allowHttp,
				now: clock.now(),
				signal: AbortSignal.timeout(DEVICE_POLL_LEASE_MS / 3),
			});
		} catch {
			// The provider did not answer: still pending, asked again after the interval.
			return releaseDevice(found.id, device.interval);
		}
		if ("pending" in result) return releaseDevice(found.id, device.interval);
		// RFC 8628 section 3.5: slow down by at least five seconds, whatever interval the provider names.
		if ("slowDown" in result) return releaseDevice(found.id, Math.max(device.interval + 5, result.interval ?? 0));
		if ("tokens" in result) {
			try {
				return await finishConnect(found.id, held, plan, result.tokens, stored.attempt.createdBy);
			} catch (error) {
				const message = isKantelError(error) ? error.message : "Kantel could not store the connection";
				return failAttempt(found.id, "exchange_failed", message);
			}
		}
		switch (result.error) {
			case "expired_token":
			case "token_expired":
				return settleAttempt(found.id, (current) => settled(current, { status: "expired" }));
			case "access_denied":
				return failAttempt(found.id, "denied", "The sign-in was declined at the provider");
			case "device_flow_disabled":
				return failAttempt(found.id, "exchange_failed", DEVICE_FLOW_DISABLED);
			default:
				return failAttempt(
					found.id,
					"exchange_failed",
					`The provider said ${result.error}${result.description === undefined ? "" : `: ${result.description}`}`,
				);
		}
	};

	// GitHub App manifest flows.

	/** A flow as of now: a pending one past its hour reads as expired. */
	const gitHubAppView = (stored: StoredGitHubApp): GitHubAppSetup =>
		stored.setup.status === "pending" && clock.now() >= stored.setup.expiresAt
			? { ...stored.setup, status: "expired" }
			: stored.setup;

	/** Where GitHub's redirect back sends the browser: the flow's `returnTo`, or the console's connections page. */
	const gitHubAppReturn = (stored: StoredGitHubApp | undefined, flags: Record<string, string>): string => {
		const back = stored?.returnTo ?? "/connections";
		const url = new URL(back.startsWith("/") ? `${origin}${back}` : back);
		for (const [name, value] of Object.entries(flags)) url.searchParams.set(name, value);
		return url.href;
	};

	const failGitHubApp = async (found: StoredRecord<StoredGitHubApp>, message: string): Promise<void> => {
		for (let tries = 0; tries < 5; tries += 1) {
			const current = (await repo.get<StoredGitHubApp>("github_app", found.id)) ?? found;
			const next: StoredGitHubApp = {
				...current.value,
				setup: { ...current.value.setup, status: "failed", failure: { message } },
			};
			if (await repo.update("github_app", found.id, current.revision, next, null)) return;
		}
	};

	// Sending through a connection.

	const recordUse = async (
		connection: Connection,
		scope: ConnectionSessionScope,
		use: {
			readonly kind: ConnectionUseKind;
			readonly method: HttpMethod;
			readonly url: URL;
			readonly tool?: string;
			readonly toolCallId?: string;
			readonly outcome: ConnectionUseOutcome;
			readonly reason?: string;
			readonly decision?: ConnectionDecision;
			readonly approval?: ConnectionUse["approval"];
			readonly egress?: true;
			readonly refusal?: EgressRefusalCode;
		},
	): Promise<void> => {
		const decision = use.decision;
		const reach = connectionUsableIn(connection, scope);
		const viaShare = reach.usable && reach.viaShare === true;
		const record: ConnectionUse = {
			id: newId("cu"),
			connectionId: connection.id,
			organisationId: scope.organisationId,
			...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
			sessionId: scope.sessionId,
			agentId: scope.agentId,
			...(scope.actingUserId === undefined ? {} : { actingUserId: scope.actingUserId }),
			...(use.toolCallId === undefined ? {} : { toolCallId: use.toolCallId }),
			kind: use.kind,
			method: use.method,
			host: use.url.hostname.toLowerCase(),
			path: use.url.pathname,
			...(use.tool === undefined ? {} : { tool: use.tool }),
			audience: scope.audience,
			outcome: use.outcome,
			...(use.reason === undefined ? {} : { reason: use.reason }),
			...(viaShare ? { viaShare: true } : {}),
			...(use.egress === true ? { egress: true as const } : {}),
			...(use.refusal === undefined ? {} : { refusal: use.refusal }),
			...(decision === undefined
				? {}
				: {
						decision: decision.action,
						decidedBy: decision.by.kind,
						...(decision.by.kind === "rule" ? { ruleId: decision.by.ruleId } : {}),
						rulesVersion: decision.rulesVersion,
					}),
			...(use.approval === undefined ? {} : { approval: use.approval }),
			...(use.approval?.state === "used" ? { approvalId: use.approval.id } : {}),
			at: clock.now(),
		};
		await repo.insert("use", {
			id: record.id,
			organisationId: scope.organisationId,
			key: connection.id,
			ref: scope.sessionId,
			value: record,
			createdAt: record.at,
		});
		await audit(
			{ actor: { kind: "agent", agentId: scope.agentId, sessionId: scope.sessionId } },
			scope.organisationId,
			{
				id: `connections:use:${record.id}`,
				type: `connections.use.${use.outcome}`,
				...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
				sessionId: scope.sessionId,
				agentId: scope.agentId,
				subject: { kind: "connection", id: connection.id },
				data: {
					kind: record.kind,
					method: record.method,
					host: record.host,
					path: record.path,
					...(record.tool === undefined ? {} : { tool: record.tool }),
					...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
					audience: record.audience.kind,
					...(record.reason === undefined ? {} : { reason: record.reason }),
					...(viaShare ? { viaShare: true } : {}),
					...(record.egress === true ? { egress: true } : {}),
					...(record.refusal === undefined ? {} : { refusal: record.refusal }),
					...(record.decision === undefined ? {} : { decision: record.decision }),
					...(record.decidedBy === undefined ? {} : { decidedBy: record.decidedBy }),
					...(record.ruleId === undefined ? {} : { ruleId: record.ruleId }),
					...(record.rulesVersion === undefined ? {} : { rulesVersion: record.rulesVersion }),
					// The approval and the exact request's digest, never its body (#333).
					...(record.approval === undefined
						? {}
						: {
								approvalId: record.approval.id,
								digest: record.approval.digest,
								approval: record.approval.state,
							}),
				},
			},
		);
	};

	// Token refresh (#328).

	/** Its health as Kantel knows it: a connection from before #328 marked `needs_reauth` needs a reconnect too. */
	const healthOf = (connection: Connection): ConnectionHealthState =>
		connection.health?.state ?? (connection.status === "needs_reauth" ? "needs_reconnect" : "ok");

	/** Whether Kantel can refresh it at all: OAuth, with a refresh token, not disabled, and not refused for good. */
	const refreshable = (stored: StoredConnection): boolean =>
		stored.connection.auth === "oauth2" &&
		stored.oauth !== undefined &&
		stored.secrets.refresh !== undefined &&
		stored.secrets.access !== undefined &&
		stored.connection.status !== "disabled" &&
		healthOf(stored.connection) !== "needs_reconnect";

	/**
	 * When a connection next falls due for a refresh: its template's buffer before the access token expires (at most half
	 * the token's life, so a short-lived token isn't refreshed on every request), or, while it is failing, when its
	 * backoff ends. Undefined when it never will: no expiry, nothing to refresh with, disabled, or needing a reconnect.
	 */
	const refreshDueAt = (stored: StoredConnection): number | undefined => {
		if (!refreshable(stored)) return undefined;
		const { connection, oauth } = stored;
		const health = connection.health;
		if (health?.state === "refresh_failing" && health.retryAt !== undefined) return health.retryAt;
		const { expiresAt, updatedAt } = connection.credential;
		if (expiresAt === undefined) return undefined;
		const life = updatedAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, expiresAt - updatedAt);
		const buffer = Math.min((oauth?.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000, life / 2);
		return expiresAt - buffer;
	};

	const announceDue = (stored: StoredConnection | undefined) => {
		const at = stored === undefined ? undefined : refreshDueAt(stored);
		if (at === undefined || options.refresh?.onDue === undefined) return;
		try {
			options.refresh.onDue(at);
		} catch {
			// The sweep still finds it on its next run.
		}
	};

	const consoleLink = (connectionId: string) => `${origin}/connections?connection=${encodeURIComponent(connectionId)}`;

	/** The refusal for a connection a person must connect again (#328): it carries the link to do that. */
	const reconnectRequired = (connection: Connection): KantelError => {
		const reason = connection.health?.reason;
		const details: ConnectionUnavailable = {
			error: "connection_reconnect_required",
			connectionId: connection.id,
			retryable: false,
			link: consoleLink(connection.id),
			...(reason === undefined ? {} : { reason }),
		};
		return new KantelError(
			"refused",
			`connection_reconnect_required: ${connection.name} needs a person to connect it again` +
				`${reason === undefined ? "" : ` (${reason.replace(/\.$/, "")})`}. Nothing was sent, and retrying won't help: ` +
				`ask a person to reconnect it at ${details.link}.`,
			{ ...details },
		);
	};

	/** The refusal for a connection whose token has run out while its refresh is failing for now (#328): retryable. */
	const refreshFailing = (connection: Connection): KantelError => {
		const { reason, retryAt } = connection.health ?? {};
		const details: ConnectionUnavailable = {
			error: "connection_refresh_failing",
			connectionId: connection.id,
			retryable: true,
			...(retryAt === undefined ? {} : { retryAt }),
			...(reason === undefined ? {} : { reason }),
		};
		return new KantelError(
			"unavailable",
			`connection_refresh_failing: Kantel couldn't refresh ${connection.name}'s token` +
				`${reason === undefined ? "" : ` (${reason.replace(/\.$/, "")})`}. Nothing was sent. This is temporary: try ` +
				`again${retryAt === undefined ? " shortly" : ` after ${new Date(retryAt).toISOString()}`}.`,
			{ ...details },
		);
	};

	/** A refresh that failed in a way that may pass: still active, `refresh_failing`, retried after a backoff. */
	const markFailing = async (connectionId: string, reason: string): Promise<RefreshOutcome> => {
		const now = clock.now();
		let health: ConnectionHealth | undefined;
		const updated = await changeConnection(connectionId, (current) => {
			const previous = current.connection.health;
			const failing = previous?.state === "refresh_failing";
			const failures = (failing ? (previous.failures ?? 1) : 0) + 1;
			health = {
				state: "refresh_failing",
				since: failing ? previous.since : now,
				reason,
				failures,
				retryAt: now + refreshBackoffMs(failures),
				...(previous?.refreshedAt === undefined ? {} : { refreshedAt: previous.refreshedAt }),
			};
			return { ...current, connection: { ...current.connection, health, updatedAt: now } };
		});
		await audit(
			SELF,
			updated.connection.organisationId,
			connectionEvent("connections.connection.refresh_failed", updated.connection, {
				reason,
				retryable: true,
				failures: health?.failures ?? 1,
				...(health?.retryAt === undefined ? {} : { retryAt: health.retryAt }),
			}),
		);
		announceDue(updated);
		return "failed";
	};

	/**
	 * The provider refused the refresh token, or the token itself after a refresh: `needs_reconnect` (and `needs_reauth`,
	 * for clients that read only the status) until a person connects it again. `refreshFailed`: it was a refresh.
	 */
	const markNeedsReconnect = async (
		connectionId: string,
		reason: string,
		refreshFailed: boolean,
	): Promise<RefreshOutcome> => {
		const now = clock.now();
		let already = false;
		const updated = await changeConnection(connectionId, (current) => {
			const previous = current.connection.health;
			already = healthOf(current.connection) === "needs_reconnect";
			const health: ConnectionHealth = {
				state: "needs_reconnect",
				since: already && previous !== undefined ? previous.since : now,
				reason,
				...(refreshFailed
					? { failures: (previous?.state === "refresh_failing" ? (previous.failures ?? 1) : 0) + 1 }
					: {}),
				...(previous?.refreshedAt === undefined ? {} : { refreshedAt: previous.refreshedAt }),
			};
			return {
				...current,
				connection: {
					...current.connection,
					status: current.connection.status === "disabled" ? "disabled" : "needs_reauth",
					health,
					updatedAt: now,
				},
			};
		});
		const { organisationId } = updated.connection;
		if (refreshFailed) {
			await audit(
				SELF,
				organisationId,
				connectionEvent("connections.connection.refresh_failed", updated.connection, { reason, retryable: false }),
			);
		}
		if (!already) {
			await audit(
				SELF,
				organisationId,
				connectionEvent("connections.connection.needs_reconnect", updated.connection, {
					reason,
					link: consoleLink(connectionId),
				}),
			);
		}
		return "needs_reconnect";
	};

	// The lease: who is refreshing a connection now, across every process over this database.

	const leaseHolder = options.refresh?.holder ?? `gw_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const leaseMs = options.refresh?.leaseMs ?? 30_000;
	const leaseWaitMs = options.refresh?.leaseWaitMs ?? 35_000;
	const leasePollMs = options.refresh?.pollMs ?? 50;

	/**
	 * Takes a connection's refresh lease: a new one, or one released or expired, each written only if unchanged since it
	 * was read, so of two processes one wins. Held by another, it waits up to `wait` ms (real time, whatever the clock),
	 * then resolves undefined. Resolves the lease's revision, to release it by.
	 */
	const takeLease = async (connection: Connection, wait: number): Promise<number | undefined> => {
		const deadline = Date.now() + wait;
		for (let tries = 0; ; tries += 1) {
			const now = clock.now();
			const value: StoredLease = { holder: leaseHolder, until: now + leaseMs };
			const found = await repo.get<StoredLease>("refresh_lease", connection.id);
			if (found === undefined) {
				const inserted = await repo.insert("refresh_lease", {
					id: connection.id,
					organisationId: connection.organisationId,
					value,
					createdAt: now,
				});
				if (inserted) return 1;
			} else if (found.value.until <= now) {
				if (await repo.update("refresh_lease", connection.id, found.revision, value)) return found.revision + 1;
			} else if (Date.now() >= deadline) {
				return undefined;
			} else {
				await new Promise((resolve) => setTimeout(resolve, leasePollMs));
			}
			// A lost race on a free lease: read it again, but never for ever.
			if (tries > 10_000) return undefined;
		}
	};

	const releaseLease = async (connectionId: string, revision: number): Promise<void> => {
		await repo
			.update<StoredLease>("refresh_lease", connectionId, revision, { holder: leaseHolder, until: 0 })
			.catch(() => false);
	};

	/** Whether this refresh is still wanted, read under the lease: another process may have done it meanwhile. */
	const wanted = (stored: StoredConnection, want: RefreshWant): boolean => {
		if (!refreshable(stored)) return false;
		const now = clock.now();
		const health = stored.connection.health;
		if (want.reason === "rejected") {
			// Only if the token the upstream refused is still the stored one, and not while backing off.
			if (stored.connection.credential.updatedAt !== want.seen) return false;
			return !(health?.state === "refresh_failing" && health.retryAt !== undefined && now < health.retryAt);
		}
		const at = refreshDueAt(stored);
		return at !== undefined && now >= at;
	};

	const settledOutcome = (stored: StoredConnection): RefreshOutcome => {
		const state = healthOf(stored.connection);
		return state === "needs_reconnect" ? "needs_reconnect" : state === "refresh_failing" ? "failed" : "fresh";
	};

	/** The token exchange itself, under the lease. Every way it can go is recorded in the connection's health. */
	const exchangeRefresh = async (stored: StoredConnection): Promise<RefreshOutcome> => {
		const { connection, oauth, secrets } = stored;
		if (oauth === undefined || secrets.refresh === undefined || secrets.access === undefined) return "fresh";
		const provider =
			(connection.templateId === undefined ? undefined : templateById(catalogue, connection.templateId)?.name) ??
			connection.name;
		let refreshToken: string;
		try {
			refreshToken = await credentials.open({
				ref: secrets.refresh,
				host: hostOf(oauth.tokenUrl),
				organisationId: connection.organisationId,
				purpose: `connection ${connection.id}: refresh`,
				request: sentTo("POST", oauth.tokenUrl),
			});
		} catch (error) {
			return isKantelError(error, "refused") || isKantelError(error, "not_found")
				? markNeedsReconnect(connection.id, "Kantel no longer holds a refresh token for it", true)
				: markFailing(connection.id, "The vault did not open the refresh token");
		}
		let client: TokenClient;
		try {
			client = await tokenClient(oauth.client, oauth.tokenUrl, connection.organisationId);
		} catch {
			return markFailing(connection.id, "Kantel could not open the OAuth app's client secret");
		}
		let tokens: TokenSet;
		try {
			tokens = await tokenRequest(
				fetch,
				oauth.tokenUrl,
				client,
				{
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					...(oauth.resource === undefined ? {} : { resource: oauth.resource }),
				},
				{ allowHttp, now: clock.now() },
			);
		} catch (error) {
			const said = isKantelError(error) ? error.message : "The token request failed";
			if (isKantelError(error, "refused")) {
				// A gateway from before the lease may have refreshed first with the same refresh token, which a rotating server
				// then refuses from us: if the stored token has moved on since we read it, the connection is fine.
				const latest = (await connectionRecord(connection.id)).value.connection.credential;
				if (latest.updatedAt !== connection.credential.updatedAt) return "refreshed";
				return markNeedsReconnect(connection.id, `${provider} refused the refresh token. ${said}`, true);
			}
			return markFailing(connection.id, said);
		}
		try {
			await credentials.replace(secrets.access, tokens.accessToken);
			if (tokens.refreshToken !== undefined && tokens.refreshToken !== refreshToken) {
				await credentials.replace(secrets.refresh, tokens.refreshToken);
			}
		} catch {
			return markFailing(connection.id, "The vault did not store the refreshed token");
		}
		const now = clock.now();
		const previous = healthOf(connection);
		const updated = await changeConnection(connection.id, (current) => ({
			...current,
			connection: {
				...current.connection,
				status: current.connection.status === "disabled" ? "disabled" : "active",
				health: {
					state: "ok",
					since: current.connection.health?.state === "ok" ? current.connection.health.since : now,
					refreshedAt: now,
				},
				credential: {
					...current.connection.credential,
					...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
					updatedAt: now,
				},
				updatedAt: now,
			},
		}));
		await audit(
			SELF,
			connection.organisationId,
			connectionEvent("connections.connection.refreshed", updated.connection, {
				...(tokens.refreshToken !== undefined && tokens.refreshToken !== refreshToken ? { rotated: true } : {}),
				...(previous === "ok" ? {} : { recovered: previous }),
			}),
		);
		announceDue(updated);
		return "refreshed";
	};

	/**
	 * Refreshes an OAuth connection's access token if it is still wanted: one refresh at a time per connection in this
	 * process (a second caller gets the first's promise) and, through the lease, across every process over this database.
	 * A caller that waited reads the winner's token and does not refresh again. Never throws for a refresh that failed:
	 * that is the outcome, and the connection's health.
	 */
	const refresh = async (connectionId: string, want: RefreshWant): Promise<RefreshOutcome> => {
		const running = refreshing.get(connectionId);
		if (running !== undefined) return running;
		const work = (async (): Promise<RefreshOutcome> => {
			const first = await connectionRecord(connectionId);
			if (!wanted(first.value, want)) return settledOutcome(first.value);
			const lease = await takeLease(first.value.connection, want.reason === "sweep" ? 0 : leaseWaitMs);
			if (lease === undefined) return "busy";
			try {
				const found = await connectionRecord(connectionId);
				if (!wanted(found.value, want)) return settledOutcome(found.value);
				return await exchangeRefresh(found.value);
			} finally {
				await releaseLease(connectionId, lease);
			}
		})();
		refreshing.set(connectionId, work);
		try {
			return await work;
		} finally {
			refreshing.delete(connectionId);
		}
	};

	/**
	 * A connection's record with a token fit to send, for `deliver`: refreshed first if it is due. Refused with
	 * `connection_reconnect_required` when a person must connect it again, and as retryable when its token has run out
	 * while the refresh is failing or another process's refresh didn't finish in time.
	 */
	const withFreshToken = async (connectionId: string): Promise<StoredConnection> => {
		const before = (await connectionRecord(connectionId)).value;
		if (before.connection.auth !== "oauth2") return before;
		if (healthOf(before.connection) === "needs_reconnect") throw reconnectRequired(before.connection);
		const outcome = await refresh(connectionId, { reason: "due" }).catch((): RefreshOutcome => "busy");
		const after = (await connectionRecord(connectionId)).value;
		if (healthOf(after.connection) === "needs_reconnect") throw reconnectRequired(after.connection);
		const { expiresAt } = after.connection.credential;
		const expired = expiresAt !== undefined && clock.now() >= expiresAt;
		if (expired && (outcome === "busy" || healthOf(after.connection) === "refresh_failing")) {
			throw refreshFailing(after.connection);
		}
		return after;
	};

	// Disconnecting (#329).

	/**
	 * Where an OAuth connection's tokens are revoked: as stored at connect, else its template's endpoint, else (for a
	 * connection made before #329) its authorisation server's metadata, read again. `unreachable` when that metadata
	 * could not be read, so Kantel can't tell whether the server revokes.
	 */
	const revocationFor = async (
		stored: StoredConnection,
		entry: ProviderTemplate | undefined,
	): Promise<Revocation | "none" | "unreachable"> => {
		const { oauth } = stored;
		if (oauth?.revocation !== undefined) return oauth.revocation;
		if (entry?.oauth?.revocationUrl !== undefined) {
			return { url: entry.oauth.revocationUrl, style: entry.oauth.revocationStyle ?? "rfc7009" };
		}
		if (oauth?.issuer === undefined || entry?.oauth?.discovery === "static") return "none";
		const metadata = await authServerMetadata(fetch, oauth.issuer, {
			allowHttp,
			signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
		}).catch(() => undefined);
		if (metadata === undefined) return "unreachable";
		return typeof metadata.revocation_endpoint === "string"
			? { url: metadata.revocation_endpoint, style: "rfc7009" }
			: "none";
	};

	/**
	 * Asks the provider to revoke a connection's tokens, once (#329). Never throws: every way it can go is an answer.
	 *
	 * RFC 7009 gets the refresh token where Kantel holds one, since revoking it ends the whole grant (section 2.1), else
	 * the access token; GitHub's grant endpoint takes the access token. Each token goes only to a host the vault bound it
	 * to, as for any request. The client authenticates as for its token requests: its secret, when it has one, is opened
	 * for the token endpoint's host, as the vault binds it, and goes to the revocation endpoint the same template or
	 * authorisation server named beside it.
	 */
	const revokeUpstream = async (stored: StoredConnection): Promise<ConnectionRevocation> => {
		const { connection, secrets, oauth } = stored;
		const entry = connection.templateId === undefined ? undefined : templateById(catalogue, connection.templateId);
		const manage = entry?.manageAccessUrl === undefined ? {} : { manageUrl: entry.manageAccessUrl };
		const provider = entry?.name ?? connection.name;
		if (connection.auth === "none") return { outcome: "none" };
		if (connection.auth === "key") {
			return {
				outcome: "unsupported",
				reason: `A key can only be revoked at ${provider} itself; Kantel deleted its copy`,
				...manage,
			};
		}
		if (oauth === undefined || (secrets.access === undefined && secrets.refresh === undefined))
			return { outcome: "none" };
		const found = await revocationFor(stored, entry);
		if (found === "unreachable") {
			return {
				outcome: "failed",
				reason: `Kantel could not read ${provider}'s authorisation server metadata to find where to revoke`,
				...manage,
			};
		}
		if (found === "none") {
			return { outcome: "unsupported", reason: `${provider} offers no way for an app to revoke its access`, ...manage };
		}
		const endpoint = found.url.replace("{client_id}", encodeURIComponent(oauth.client.clientId));
		const failed = (reason: string): ConnectionRevocation => ({ outcome: "failed", endpoint, reason, ...manage });
		let host: string;
		try {
			host = publicUrl(endpoint, "The revocation endpoint", allowHttp).hostname.toLowerCase();
		} catch {
			return failed("The revocation endpoint is not an https URL on a public host");
		}
		const refreshHosts = [hostOf(oauth.tokenUrl)];
		const candidates: { readonly hint: "access_token" | "refresh_token"; readonly ref?: string; hosts: string[] }[] =
			found.style === "github_grant"
				? [
						{
							hint: "access_token",
							...(secrets.access === undefined ? {} : { ref: secrets.access }),
							hosts: [...connection.hosts],
						},
					]
				: [
						{
							hint: "refresh_token",
							...(secrets.refresh === undefined ? {} : { ref: secrets.refresh }),
							hosts: refreshHosts,
						},
						{
							hint: "access_token",
							...(secrets.access === undefined ? {} : { ref: secrets.access }),
							hosts: [...connection.hosts],
						},
					];
		const pick = candidates.find((candidate) => candidate.ref !== undefined && candidate.hosts.includes(host));
		if (pick === undefined || pick.ref === undefined) {
			return failed(`Kantel won't send the token to ${host}: the vault binds it to other hosts`);
		}
		let client: TokenClient;
		try {
			client = await tokenClient(oauth.client, oauth.tokenUrl, connection.organisationId);
		} catch {
			return failed("Kantel could not open the OAuth app's client secret");
		}
		if (found.style === "github_grant" && client.clientSecret === undefined) {
			return {
				outcome: "unsupported",
				reason: `${provider} only lets an app revoke access with its client secret, and this connection's app has none`,
				...manage,
			};
		}
		let token: string;
		try {
			token = await credentials.open({
				ref: pick.ref,
				host,
				organisationId: connection.organisationId,
				purpose: `connection ${connection.id}: revoke`,
				// GitHub takes a grant back with a DELETE; RFC 7009 revocation is a POST.
				request: sentTo(found.style === "github_grant" ? "DELETE" : "POST", endpoint),
			});
		} catch {
			return failed("The vault no longer held the token to revoke");
		}
		const result = await revokeToken(
			fetch,
			{ url: endpoint, style: found.style, client, token, hint: pick.hint },
			{ allowHttp, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) },
		);
		return result.revoked ? { outcome: "revoked", endpoint } : failed(result.reason);
	};

	/** Withdraws a removed connection's pending approvals and stops its approved ones not yet used (#333). Best effort. */
	const forgetApprovals = async (organisationId: string, connectionId: string): Promise<number> => {
		if (options.approvals === undefined) return 0;
		try {
			const result = await options.approvals.connectionApproval(SELF, { op: "forget", organisationId, connectionId });
			return result.outcome === "forgotten" ? result.withdrawn + result.stopped : 0;
		} catch {
			// None of them can be used anyway: each names this connection, which is gone.
			return 0;
		}
	};

	/**
	 * The connection a session may use, or a recorded refusal. After the usage check, the rules decide (#332): `deny`
	 * refuses, and `ask` lets the request out only on an approval of this exact request (#333), used up here; with none
	 * yet it is refused as `approval_pending`, naming the approval a person decides. `exact` is what the approval covers
	 * beyond the method and URL: the headers and body as the agent set them.
	 */
	const usableConnection = async (
		scope: ConnectionSessionScope,
		connectionId: string,
		use: {
			readonly kind: ConnectionUseKind;
			readonly method: HttpMethod;
			readonly url: string;
			readonly tool?: string;
			readonly toolCallId?: string;
			/** Sent by the sandbox through the egress gate (#331): its refusals carry their code. */
			readonly egress?: true;
		},
		exact: { readonly headers?: { readonly [name: string]: string }; readonly body?: string } = {},
	): Promise<{ readonly stored: StoredConnection; readonly url: URL; readonly approval?: UsedApproval }> => {
		const found = await repo.get<StoredConnection>("connection", connectionId);
		if (found === undefined || found.organisationId !== scope.organisationId) {
			throw new KantelError("not_found", `No connection ${connectionId}`);
		}
		const { connection } = found.value;
		let url: URL;
		try {
			url = new URL(use.url);
		} catch {
			throw new KantelError("invalid", "The request's URL is not a URL");
		}
		// A connection a person must connect again (#328) is refused with the link to do that, before any rule is read.
		if (
			connection.status !== "disabled" &&
			healthOf(connection) === "needs_reconnect" &&
			connectionUsableIn(connection, scope).usable
		) {
			const refusal = reconnectRequired(connection);
			await recordUse(connection, scope, {
				...use,
				url,
				outcome: "denied",
				reason: `Connection ${connection.name} needs a person to connect it again`,
			});
			throw refusal;
		}
		const ceiling = await ceilingFor(options.ceiling, connection.organisationId);
		// A rule with a use limit is spent as it allows; a race that used it up first decides again.
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const rules = await ensureRules(connection, "migrated");
			const decision = decideUse(connection, rules, ceiling, scope, { ...use, url }, { now: clock.now(), allowHttp });
			const denied = async (reason: string, code: "forbidden" | "refused"): Promise<never> => {
				await recordUse(connection, scope, {
					...use,
					url,
					outcome: "denied",
					reason,
					...(decision.by.kind === "usage" || decision.by.kind === "connection" ? {} : { decision }),
					...(use.egress === true
						? { refusal: decision.by.kind === "usage" ? "connection_not_usable" : "rule_denied" }
						: {}),
				});
				throw new KantelError(code, reason);
			};
			if (decision.action === "deny")
				return denied(decision.reason, decision.by.kind === "usage" ? "forbidden" : "refused");
			// Approvals (#333) answer `ask`: the request is frozen in the vault and sent only once a person approves it.
			if (decision.action === "ask") return askApproval(found.value, scope, { ...use, url }, exact, decision);
			const rule = decision.rule;
			if (rule?.maxUses !== undefined && !(await spendRule(connection, rule.id, decision.rulesVersion))) continue;
			await recordUse(connection, scope, { ...use, url, outcome: "allowed", decision });
			return { stored: found.value, url };
		}
		throw new KantelError("conflict", `The rules on ${connection.name} kept changing; try again`);
	};

	/** Counts one use against a rule with a limit. Resolves false when it was used up first. */
	const spendRule = async (connection: Connection, ruleId: string, version: number): Promise<boolean> => {
		let spent = false;
		await changeRules(repo, connection, (current) => {
			spent = false;
			// Rules edited since the decision: decide again under the new ones.
			if (current.version !== version) return undefined;
			const rule = current.rules.find((r) => r.id === ruleId);
			if (rule === undefined || (rule.maxUses !== undefined && rule.uses >= rule.maxUses)) return undefined;
			spent = true;
			// A use is not a change to the rules: the version stays, so an approval made under them still holds.
			return { ...current, rules: current.rules.map((r) => (r.id === ruleId ? { ...r, uses: r.uses + 1 } : r)) };
		});
		return spent;
	};

	/**
	 * A use a rule asks about (#333): the vault freezes the exact request and digests it. Approved and unused, the request
	 * goes out once under that approval; otherwise the use is refused as `approval_pending`, nothing sent, with the
	 * approval to wait on. An ask rule's use limit is not spent: it counts what it lets out unasked, and it lets out none.
	 */
	const askApproval = async (
		stored: StoredConnection,
		scope: ConnectionSessionScope,
		use: {
			readonly kind: ConnectionUseKind;
			readonly method: HttpMethod;
			readonly url: URL;
			readonly tool?: string;
			readonly toolCallId?: string;
			readonly egress?: true;
		},
		exact: { readonly headers?: { readonly [name: string]: string }; readonly body?: string },
		decision: ConnectionDecision,
	): Promise<{ readonly stored: StoredConnection; readonly url: URL; readonly approval?: UsedApproval }> => {
		const { connection } = stored;
		const { url } = use;
		const approvals = options.approvals;
		const injection = connection.auth === "key" ? (stored.injection ?? { kind: "bearer" as const }) : undefined;
		const credentialParam = injection?.kind === "query" ? injection.param : undefined;
		const credentialHeader =
			injection?.kind === "header" || injection?.kind === "header_template"
				? injection.header.toLowerCase()
				: undefined;
		if (approvals === undefined) {
			const reason = `${decision.reason}: someone must approve it, and this deployment has no approvals`;
			await recordUse(connection, scope, {
				...use,
				outcome: "denied",
				reason,
				decision,
				...(use.egress === true ? { refusal: "rule_denied" as const } : {}),
			});
			throw new KantelError("refused", reason);
		}
		const result = await approvals.connectionApproval(SELF, {
			op: "use",
			scope: {
				organisationId: scope.organisationId,
				...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
				sessionId: scope.sessionId,
				agentId: scope.agentId,
				...(scope.actingUserId === undefined ? {} : { actingUserId: scope.actingUserId }),
			},
			request: {
				connectionId: connection.id,
				connectionName: connection.name,
				connectionVersion: await connectionVersion(connection),
				owner: connection.owner,
				kind: use.kind,
				...(use.tool === undefined ? {} : { tool: use.tool }),
				method: use.method,
				// As it goes out, less what Kantel overwrites with the credential: the agent's copy never leaves. The egress
				// gate (#331) overwrites nothing (it swaps placeholders, which are part of the request) and forwards every
				// header but the hop-by-hop ones, so its approval is of the URL and those headers exactly as the sandbox sent them.
				url: (use.egress === true || credentialParam === undefined ? url : withoutQueryParam(url, credentialParam))
					.href,
				...(exact.headers === undefined
					? {}
					: {
							headers:
								use.egress === true
									? egressHeaders(exact.headers)
									: withoutHeader(sentHeaders(exact.headers), credentialHeader),
						}),
				...(exact.body === undefined ? {} : { body: exact.body }),
				// The rules' version: a change to the rules after approval asks again. A rule's use count isn't one.
				rulesVersion: String(decision.rulesVersion),
			},
			reason: decision.reason,
		});
		if (result.outcome === "approved") {
			const approval = { id: result.proposalId, digest: result.digest, state: "used" as const };
			await recordUse(connection, scope, { ...use, outcome: "allowed", reason: "Approved once", decision, approval });
			return {
				stored,
				url,
				approval: { proposalId: result.proposalId, grantId: result.grantId, digest: result.digest },
			};
		}
		if (result.outcome !== "pending") throw new KantelError("unavailable", "The vault gave no approval answer");
		const proposal = result.proposal;
		const pending: ApprovalPending = {
			error: "approval_pending",
			approvalId: proposal.id,
			digest: result.digest,
			link: proposal.link.startsWith("/") ? `${origin}${proposal.link}` : proposal.link,
			bindingCode: proposal.bindingCode,
			expiresAt: proposal.expiresAt,
		};
		const reason = `Waiting for a person to approve this exact request (${proposal.id})`;
		// Held, not denied: nothing went out, and the person's decision is still to come (`connections.decision.*`).
		await recordUse(connection, scope, {
			...use,
			outcome: "held",
			reason,
			decision,
			approval: { id: proposal.id, digest: result.digest, state: "pending" },
			...(use.egress === true ? { refusal: "approval_pending" as const } : {}),
		});
		throw new KantelError(
			"refused",
			`approval_pending: ${connection.name} needs a person to approve this exact request. Nothing was sent. ` +
				`Approval ${proposal.id}, code ${proposal.bindingCode}: ${pending.link}. Once it is approved, send the ` +
				"identical request again; any change to it needs a new approval.",
			{ ...pending },
		);
	};

	/**
	 * A page of uses with each held one's approval as it now stands (#481): a held use is recorded `pending`, and the
	 * person's decision is the vault's, so a denied, expired or withdrawn approval (or an approved one, sent again as a
	 * use of its own) is read from the vault here, once per approval. One the vault can't answer for stays `pending`.
	 */
	const withEndedApprovals = async (uses: readonly ListedConnectionUse[]): Promise<ListedConnectionUse[]> => {
		const approvals = options.approvals;
		if (approvals === undefined) return [...uses];
		const states = new Map<string, Promise<ConnectionUseApprovalState>>();
		const stateOf = (organisationId: string, proposalId: string): Promise<ConnectionUseApprovalState> => {
			let state = states.get(proposalId);
			if (state === undefined) {
				state = approvals
					.connectionApproval(SELF, { op: "status", organisationId, proposalId })
					.then((answer) => (answer.outcome === "status" ? answer.proposal.status : "pending"))
					.catch(() => "pending" as const);
				states.set(proposalId, state);
			}
			return state;
		};
		return Promise.all(
			uses.map(async (use) => {
				if (isRedactedUse(use) || use.outcome !== "held" || use.approval?.state !== "pending") return use;
				const state = await stateOf(use.organisationId, use.approval.id);
				return state === "pending" ? use : { ...use, approval: { ...use.approval, state } };
			}),
		);
	};

	/** Gives back an approval a request used, when the request failed before any byte reached the upstream. */
	const releaseApproval = async (organisationId: string, approval: UsedApproval | undefined): Promise<void> => {
		if (approval === undefined || options.approvals === undefined) return;
		await options.approvals
			.connectionApproval(SELF, {
				op: "release",
				organisationId,
				grantId: approval.grantId,
				digest: approval.digest,
			})
			.catch(() => undefined);
	};

	/** One request through a connection whose use is already recorded: the credential added, then cut out of the answer. */
	const deliver = async (
		connectionId: string,
		scope: ConnectionSessionScope,
		url: URL,
		request: {
			readonly method: HttpMethod;
			readonly headers?: { readonly [name: string]: string };
			readonly body?: string;
		},
		purpose: string,
		approval?: UsedApproval,
		retried = false,
	): Promise<ConnectionResponse> => {
		// A token fit to send, refreshed first if due (#328); refused, with nothing sent, if it can't be.
		let fresh: StoredConnection;
		try {
			fresh = await withFreshToken(connectionId);
		} catch (error) {
			if (!retried) await releaseApproval(scope.organisationId, approval);
			throw error;
		}
		const { connection, secrets, injection } = fresh;
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(request.headers ?? {})) {
			if (!DROPPED_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
		}
		let target = new URL(url.href);
		const secretsSeen: string[] = [];
		const ref = connection.auth === "oauth2" ? secrets.access : connection.auth === "key" ? secrets.key : undefined;
		if (ref !== undefined) {
			const value = await credentials.open({
				ref,
				host: target.hostname.toLowerCase(),
				organisationId: connection.organisationId,
				scope,
				purpose: `connection ${connection.id}: ${purpose}`,
				request: sentTo(request.method, target),
			});
			secretsSeen.push(value);
			const injected = injectionHeaders(
				connection.auth === "oauth2" ? { kind: "bearer" } : (injection ?? { kind: "bearer" }),
				value,
			);
			// What went on the wire too, so an echo of a Basic header or an encoded value is cut out as well.
			secretsSeen.push(encodeURIComponent(value), ...Object.values(injected.headers));
			for (const sent of Object.values(injected.headers)) {
				const space = sent.indexOf(" ");
				if (space > 0) secretsSeen.push(sent.slice(space + 1));
			}
			Object.assign(headers, injected.headers);
			if (injected.query !== undefined) target = withQueryParam(target, injected.query[0], injected.query[1]);
		}
		let response: Response;
		try {
			response = await fetch(target.href, {
				method: request.method,
				headers,
				...(request.body === undefined || request.method === "GET" || request.method === "HEAD"
					? {}
					: { body: request.body }),
				redirect: "manual",
			});
		} catch (error) {
			// Nothing reached the upstream (no name, no connection, no TLS): an approval this request used is given back. Not
			// on the resend after a 401: the first send reached it.
			if (notConnected(error) && !retried) await releaseApproval(connection.organisationId, approval);
			throw new KantelError("unavailable", `${target.hostname} did not answer`);
		}
		if (response.status === 401 && connection.auth === "oauth2" && secrets.refresh !== undefined && !retried) {
			await response.body?.cancel().catch(() => undefined);
			// The upstream refused the token it was sent: refresh it, unless another request already did, then send once more.
			const outcome = await refresh(connectionId, {
				reason: "rejected",
				seen: connection.credential.updatedAt,
			}).catch((): RefreshOutcome => "busy");
			const after = (await connectionRecord(connectionId)).value.connection;
			if (outcome === "needs_reconnect" || healthOf(after) === "needs_reconnect") throw reconnectRequired(after);
			if (outcome === "failed" || outcome === "busy") throw refreshFailing(after);
			return deliver(connectionId, scope, url, request, purpose, approval, true);
		}
		if (response.status === 401 && connection.auth === "oauth2" && connection.status === "active") {
			await markNeedsReconnect(
				connectionId,
				`${url.hostname} refused ${secrets.refresh === undefined ? "its token" : "even a refreshed token"} (401)`,
				false,
			);
		}
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (reader !== undefined) {
			while (size < RESPONSE_LIMIT) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				size += value.byteLength;
			}
			await reader.cancel().catch(() => undefined);
		}
		const bytes = new Uint8Array(Math.min(size, RESPONSE_LIMIT));
		let offset = 0;
		for (const chunk of chunks) {
			const part = chunk.subarray(0, Math.max(0, bytes.length - offset));
			bytes.set(part, offset);
			offset += part.byteLength;
		}
		const out: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			if (name !== "set-cookie") out[name] = redact(value, secretsSeen);
		});
		return { status: response.status, headers: out, body: redact(new TextDecoder().decode(bytes), secretsSeen) };
	};

	// Placeholder-gated injection (#331).

	/** A session's scope as it is now, for one sandbox request: who can see it is read every time, as the tools do. */
	const egressScope = async (session: EgressSession): Promise<ConnectionSessionScope | undefined> => {
		const directory = typeof options.sessions === "function" ? options.sessions() : options.sessions;
		if (directory === undefined) return undefined;
		const record = await directory.get(
			{ actor: SELF.actor, organisationId: session.organisationId },
			session.sessionId,
		);
		if (record.organisationId !== session.organisationId) return undefined;
		return sessionScopeOf(record, sessionAudienceOf(record, deployment.personal === true));
	};

	/** The organisation's secret fingerprints, by vault reference. */
	const fingerprintsIn = async (organisationId: string): Promise<Map<string, string>> => {
		const out = new Map<string, string>();
		for (const record of await repo.list<StoredFingerprints>("fingerprint", { organisationId })) {
			for (const fingerprint of record.value.fingerprints) out.set(fingerprint, record.id);
		}
		return out;
	};

	/** The connection holding a vault reference, if one does (a client secret is not a connection's). */
	const connectionHolding = async (organisationId: string, ref: string): Promise<Connection | undefined> => {
		const records = await repo.list<StoredConnection>("connection", { organisationId });
		return records.find((record) => Object.values(record.value.secrets).includes(ref))?.value.connection;
	};

	/** Audits a refusal that names no usable connection: an unknown or mixed placeholder, or a raw secret. */
	const auditRefusal = async (
		scope: ConnectionSessionScope | EgressSession,
		draft: EgressDraft,
		refused: EgressRefusal,
		connectionId = refused.connectionId,
	): Promise<void> => {
		let target: URL | undefined;
		try {
			target = new URL(draft.url);
		} catch {
			target = undefined;
		}
		await audit(
			"agentId" in scope
				? { actor: { kind: "agent", agentId: scope.agentId, sessionId: scope.sessionId } }
				: { actor: SELF.actor },
			scope.organisationId,
			{
				type: "connections.egress.refused",
				...("projectId" in scope && scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
				sessionId: scope.sessionId,
				...("agentId" in scope ? { agentId: scope.agentId } : {}),
				subject: { kind: "session", id: scope.sessionId },
				data: {
					error: refused.error,
					method: draft.method,
					...(target === undefined ? {} : { host: target.hostname, path: target.pathname }),
					...(connectionId === undefined ? {} : { connectionId }),
				},
			},
		);
	};

	/**
	 * A request that carried a raw secret, as the use and audit record it: its method and host, and a path of
	 * `/[redacted]`, since the secret may be in the path, the query or anywhere else. The host too, when the secret is in it.
	 */
	const withoutSecret = async (draft: EgressDraft, known: ReadonlySet<string>): Promise<EgressDraft> => {
		let host = "unknown.invalid";
		try {
			host = new URL(draft.url).hostname;
		} catch {
			// Not a URL: recorded with no host.
		}
		const inHost = await rawSecretIn({ method: "GET", url: `https://${host}/`, headers: [] }, known);
		return {
			method: draft.method,
			url: `https://${inHost === undefined ? host : "redacted.invalid"}/[redacted]`,
			headers: [],
		};
	};

	/** The `Authorization` header a connection's credential goes out as, when the sandbox sent the placeholder alone. */
	const authorizationFor = (stored: StoredConnection, value: string): string | undefined => {
		if (stored.connection.auth === "oauth2") return `Bearer ${value}`;
		const rendered = injectionHeaders(stored.injection ?? { kind: "bearer" }, value).headers.authorization;
		return rendered ?? value;
	};

	const egress = async (session: EgressSession, draft: EgressDraft, signal?: AbortSignal): Promise<EgressOutcome> => {
		const refuse = async (
			scope: ConnectionSessionScope | EgressSession,
			refused: EgressRefusal,
			connection?: Connection,
			reason?: string,
			/** The request as it is recorded and audited: a raw secret's is without its path, which may hold it. */
			recorded: EgressDraft = draft,
			/** The connection an audit-only refusal was about, for the audit trail alone. */
			auditedConnectionId?: string,
		): Promise<EgressOutcome> => {
			let url: URL | undefined;
			try {
				url = new URL(recorded.url);
			} catch {
				url = undefined;
			}
			const method = draft.method.toUpperCase() as HttpMethod;
			if (connection !== undefined && "agentId" in scope && url !== undefined) {
				await recordUse(connection, scope, {
					kind: "http",
					method: METHOD_NAMES.includes(method) ? method : "POST",
					url,
					...(session.toolCallId === undefined ? {} : { toolCallId: session.toolCallId }),
					outcome: "denied",
					reason: reason ?? refused.message,
					egress: true,
					refusal: refused.error,
				});
			} else {
				await auditRefusal(scope, recorded, refused, auditedConnectionId);
			}
			return { kind: "refused", refusal: refused };
		};

		let scope: ConnectionSessionScope | undefined;
		try {
			scope = await egressScope(session);
		} catch {
			scope = undefined;
		}

		// 1. Screen: a stored secret's own value never goes out, placeholder or not.
		const known = await fingerprintsIn(session.organisationId);
		const hit = await rawSecretIn(draft, new Set(known.keys()));
		if (hit !== undefined) {
			const holder = await connectionHolding(session.organisationId, known.get(hit)!);
			return refuse(
				scope ?? session,
				rawSecretRefusal(holder?.id),
				holder,
				undefined,
				await withoutSecret(draft, new Set(known.keys())),
			);
		}

		// 2. Find the placeholders. None: no credential, and nothing here to decide.
		const placeholders = placeholdersIn(draft);
		if (placeholders.length === 0) return { kind: "pass" };
		if (scope === undefined) {
			return refuse(
				session,
				refusal("egress_unavailable", "Kantel could not read the session this request came from, so it sent nothing."),
			);
		}
		const named = new Set<string>();
		for (const placeholder of placeholders) {
			const found = await repo.get<{ readonly connectionId: string }>("placeholder", placeholder);
			if (found === undefined || found.organisationId !== scope.organisationId) {
				return refuse(
					scope,
					refusal("unknown_placeholder", "No connection has that placeholder: it was removed, or never existed.", {
						fix: {
							action: "request_connection",
							message: "List this session's connections (connections_list) and use a current placeholder.",
						},
					}),
				);
			}
			named.add(found.value.connectionId);
		}
		if (named.size > 1) {
			return refuse(
				scope,
				refusal(
					"ambiguous_placeholder",
					"The request carries placeholders of more than one connection; one request uses one connection.",
					{ fix: { action: "use_placeholder", message: "Send one connection's placeholder per request." } },
				),
			);
		}
		const connectionId = [...named][0]!;
		const record = await repo.get<StoredConnection>("connection", connectionId);
		if (record === undefined || record.organisationId !== scope.organisationId) {
			return refuse(scope, refusal("unknown_placeholder", "No connection has that placeholder any more."));
		}
		const { connection } = record.value;
		let url: URL;
		try {
			url = new URL(draft.url);
		} catch {
			return refuse(scope, refusal("egress_denied", "The request's URL is not a URL."));
		}
		const method = draft.method.toUpperCase() as HttpMethod;

		// 3. Decide. Whether the session may use it comes first, so a refusal never tells a session where a connection it
		// can't use is bound.
		const reach = connectionUsableIn(connection, scope);
		// Nor its name or ID: the session's viewers read its output and its uses, and this connection isn't theirs to know
		// of (a private one in a shared session, #335). Only the audit trail says which it was.
		if (!reach.usable) {
			return refuse(
				scope,
				refusal(
					"connection_not_usable",
					"This session may not use that placeholder's connection, so nothing was sent.",
					{
						fix: {
							action: "request_connection",
							message: "Use a placeholder connections_list gives this session, or ask for the connection to be shared.",
						},
					},
				),
				undefined,
				undefined,
				draft,
				connectionId,
			);
		}
		if (connection.status === "disabled") {
			return refuse(
				scope,
				refusal("connection_not_usable", `This session may not use connection ${connection.name}: it is disabled.`, {
					connectionId,
					fix: {
						action: "request_connection",
						message: "Ask for a connection this session may use, or for this one to be shared with the project.",
					},
				}),
				connection,
			);
		}
		if (connection.status === "needs_reauth") {
			return refuse(
				scope,
				refusal("needs_reauth", `Connection ${connection.name} must be reconnected before it can be used.`, {
					connectionId,
					fix: { action: "reconnect", message: "Ask its owner to reconnect it in Connections." },
				}),
				connection,
			);
		}
		if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
			return refuse(
				scope,
				refusal("https_required", "A connection's credential only goes out over https.", {
					connectionId,
					fix: { action: "use_https", message: `Send it to https://${url.host}${url.pathname} instead.` },
				}),
				connection,
			);
		}
		const host = url.hostname.toLowerCase();
		if (!connection.hosts.includes(host)) {
			return refuse(
				scope,
				refusal(
					"host_not_bound",
					`Connection ${connection.name}'s placeholder only goes to ${connection.hosts.join(", ")}, not ${host}.`,
					{
						connectionId,
						fix: {
							action: "change_host",
							message: `Send it to ${connection.hosts.join(" or ")}, or use a connection for ${host}.`,
						},
					},
				),
				connection,
			);
		}
		if (!METHOD_NAMES.includes(method)) {
			return refuse(
				scope,
				refusal("egress_denied", `A connection's credential doesn't go out with ${draft.method}.`, { connectionId }),
				connection,
			);
		}
		const bodyText =
			draft.body === undefined || draft.body.byteLength === 0 || method === "GET" || method === "HEAD"
				? undefined
				: exactBody(draft.body);
		const exactHeaders: Record<string, string> = {};
		for (const [name, value] of draft.headers) {
			const lower = name.toLowerCase();
			exactHeaders[lower] = lower in exactHeaders ? `${exactHeaders[lower]}, ${value}` : value;
		}
		let approval: UsedApproval | undefined;
		try {
			// The rules (#332) and approvals (#333) decide as they do for `send`; the use is recorded there.
			({ approval } = await usableConnection(
				scope,
				connectionId,
				{
					kind: "http",
					method,
					url: url.href,
					...(session.toolCallId === undefined ? {} : { toolCallId: session.toolCallId }),
					egress: true,
				},
				{ headers: exactHeaders, ...(bodyText === undefined ? {} : { body: bodyText }) },
			));
		} catch (error) {
			if (!isKantelError(error)) throw error;
			const pending = error.details as Partial<ApprovalPending> | undefined;
			if (pending?.error === "approval_pending") {
				return {
					kind: "refused",
					refusal: {
						error: "approval_pending",
						message: error.message,
						connectionId,
						fix: {
							action: "ask_approval",
							message: "Wait for a person to approve it, then send the identical request again.",
							...(pending.link === undefined ? {} : { link: pending.link }),
						},
						...(pending.approvalId === undefined ? {} : { approvalId: pending.approvalId }),
						...(pending.digest === undefined ? {} : { digest: pending.digest }),
						...(pending.link === undefined ? {} : { link: pending.link }),
						...(pending.bindingCode === undefined ? {} : { bindingCode: pending.bindingCode }),
						...(pending.expiresAt === undefined ? {} : { expiresAt: pending.expiresAt }),
					},
				};
			}
			// Recorded as denied by the decision; the refusal carries its reason.
			const code = error.code === "forbidden" ? "connection_not_usable" : "rule_denied";
			return {
				kind: "refused",
				refusal: refusal(code, error.message, {
					connectionId,
					fix: {
						action: code === "rule_denied" ? "ask_approval" : "request_connection",
						message:
							code === "rule_denied"
								? "Ask the connection's owner to change its rules if this request should be allowed."
								: "Ask for a connection this session may use.",
					},
				}),
			};
		}
		return sendEgress(record.value, scope, url, draft, approval, signal);
	};

	/** The connections a session may use, most specific owner first, each with its placeholder and variable (#331). */
	const usableIn = async (scope: ConnectionSessionScope): Promise<UsableConnection[]> => {
		const records = await repo.list<StoredConnection>("connection", { organisationId: scope.organisationId });
		const usable = records
			.filter(
				({ value: { connection } }) =>
					connection.status !== "needs_reauth" && connectionUsableIn(connection, scope).usable,
			)
			.sort(
				(a, b) =>
					CONNECTION_OWNER_ORDER.indexOf(a.value.connection.owner.kind) -
					CONNECTION_OWNER_ORDER.indexOf(b.value.connection.owner.kind),
			);
		const taken = new Set<string>();
		const out: UsableConnection[] = [];
		for (const record of usable) {
			// One made before placeholders gets its own now.
			const connection = await ensurePlaceholder(record).catch(() => record.value.connection);
			const env = connection.placeholder === undefined ? undefined : placeholderEnvName(connection.name, taken);
			if (env !== undefined) taken.add(env);
			out.push({
				id: connection.id,
				name: connection.name,
				kind: connection.kind,
				...(connection.templateId === undefined ? {} : { templateId: connection.templateId }),
				owner: connection.owner.kind,
				...(connection.account === undefined ? {} : { account: connection.account }),
				hosts: connection.hosts,
				...(connection.mcp === undefined ? {} : { mcpUrl: connection.mcp.url }),
				...(connection.placeholder === undefined || env === undefined
					? {}
					: { placeholder: connection.placeholder, env }),
			});
		}
		return out;
	};

	/** Opens the credential for the request's host, puts it in the placeholder's place, sends, and redacts the answer. */
	/**
	 * A token that can't be used now (#328), as the egress gate's refusal: `needs_reauth` when a person must connect it
	 * again, `egress_unavailable` (try again later) while its refresh is failing.
	 */
	const tokenRefusal = (connection: Connection, error: KantelError): EgressRefusal => {
		const details = error.details as Partial<ConnectionUnavailable> | undefined;
		if (details?.error === "connection_reconnect_required") {
			return refusal("needs_reauth", error.message, {
				connectionId: connection.id,
				fix: {
					action: "reconnect",
					message: `Ask its owner to connect ${connection.name} again.`,
					...(details.link === undefined ? {} : { link: details.link }),
				},
			});
		}
		return refusal("egress_unavailable", `${error.message}; nothing was sent.`, {
			connectionId: connection.id,
			fix: { action: "none", message: "Try again later." },
		});
	};

	const sendEgress = async (
		stored: StoredConnection,
		scope: ConnectionSessionScope,
		url: URL,
		draft: EgressDraft,
		approval: UsedApproval | undefined,
		signal: AbortSignal | undefined,
		retried = false,
	): Promise<EgressOutcome> => {
		let current: StoredConnection;
		try {
			// A token fit to send, refreshed first if it is due (#328), as `deliver` does.
			current = await withFreshToken(stored.connection.id);
		} catch (error) {
			if (!isKantelError(error)) throw error;
			await releaseApproval(stored.connection.organisationId, approval);
			return { kind: "refused", refusal: tokenRefusal(stored.connection, error) };
		}
		const { connection } = current;
		const ref =
			connection.auth === "oauth2"
				? current.secrets.access
				: connection.auth === "key"
					? current.secrets.key
					: undefined;
		if (ref === undefined || connection.placeholder === undefined) {
			return {
				kind: "refused",
				refusal: refusal("egress_unavailable", `Connection ${connection.name} holds no credential to add.`, {
					connectionId: connection.id,
				}),
			};
		}
		const value = await credentials.open({
			ref,
			host: url.hostname.toLowerCase(),
			organisationId: connection.organisationId,
			scope,
			purpose: `connection ${connection.id}: egress ${draft.method.toUpperCase()} ${url.hostname}${url.pathname}`,
			// The vault records an unknown method as POST; the gate refused one it can't send before now.
			request: { method: draft.method.toUpperCase() as HttpMethod, path: url.pathname },
		});
		// One made before #331 is screened from its first use on.
		if ((await repo.get("fingerprint", ref)) === undefined) {
			await keepFingerprints(connection.organisationId, ref, value);
		}
		const authorization = authorizationFor(current, value);
		const substitutions: Substitution[] = [
			{
				placeholder: connection.placeholder,
				value,
				...(authorization === undefined ? {} : { authorization }),
			},
		];
		const out = substitute(
			{ ...draft, headers: draft.headers.filter(([name]) => !EGRESS_DROPPED_HEADERS.has(name)) },
			substitutions,
		);
		const redactions = redactionsOf(substitutions);
		const method = out.method.toUpperCase();
		let response: Response;
		try {
			response = await fetch(out.url, {
				method,
				headers: out.headers.map(([name, header]) => [name, header] as [string, string]),
				...(out.body === undefined || method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(out.body) }),
				// A redirect is answered to the sandbox, never followed with the credential on.
				redirect: "manual",
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			if (notConnected(error) && !retried) await releaseApproval(connection.organisationId, approval);
			throw new KantelError("unavailable", `${url.hostname} did not answer`);
		}
		if (response.status === 401 && connection.auth === "oauth2" && current.secrets.refresh !== undefined && !retried) {
			await response.body?.cancel().catch(() => undefined);
			// The upstream refused the token it was sent: refresh it, unless another request already did, then send once more.
			const outcome = await refresh(connection.id, {
				reason: "rejected",
				seen: connection.credential.updatedAt,
			}).catch((): RefreshOutcome => "busy");
			const after = (await connectionRecord(connection.id)).value.connection;
			if (outcome === "needs_reconnect" || healthOf(after) === "needs_reconnect") {
				return { kind: "refused", refusal: tokenRefusal(after, reconnectRequired(after)) };
			}
			if (outcome === "failed" || outcome === "busy") {
				return { kind: "refused", refusal: tokenRefusal(after, refreshFailing(after)) };
			}
			return sendEgress(current, scope, url, draft, approval, signal, true);
		}
		if (response.status === 401 && connection.auth === "oauth2" && connection.status === "active") {
			await markNeedsReconnect(
				connection.id,
				`${url.hostname} refused ${current.secrets.refresh === undefined ? "its token" : "even a refreshed token"} (401)`,
				false,
			);
		}
		const { bytes, truncated } = await readLimited(response, EGRESS_RESPONSE_LIMIT);
		let count = 0;
		const headers: Record<string, string> = {};
		response.headers.forEach((header, name) => {
			if (name === "set-cookie" || name === "content-length" || name === "content-encoding") return;
			const clean = redactText(header, redactions);
			count += clean.count;
			headers[name] = clean.text;
		});
		const body = redactBytes(bytes, redactions, { truncated });
		count += body.count;
		return {
			kind: "sent",
			connectionId: connection.id,
			status: response.status,
			// A reason phrase can echo a request back too.
			statusText: redactText(response.statusText, redactions).text,
			headers,
			body: body.bytes,
			url: redactText(out.url, redactions).text,
			redactions: count,
		};
	};

	/** An MCP `post` through a connection, for `listTools` and `callTool`. */
	const mcpPost =
		(
			connectionId: string,
			scope: ConnectionSessionScope,
			url: URL,
			purpose: string,
			approval?: UsedApproval,
		): McpPost =>
		async (body, headers) =>
			deliver(connectionId, scope, url, { method: "POST", headers, body }, purpose, approval);

	/**
	 * Stores a new OAuth client, its secret (if any) going into the vault bound to the token endpoint's host and never
	 * kept anywhere else. The caller has checked the right to; `createClient` and the GitHub App flow both come here.
	 */
	const saveClient = async (
		ctx: { readonly actor: Actor; readonly organisationId: string },
		input: CreateOAuthClientInput,
		tokenUrl: string | undefined,
		extra: { readonly githubApp?: GitHubAppInfo } = {},
	): Promise<StoredClient> => {
		if (input.clientSecret !== undefined && tokenUrl === undefined) {
			throw new KantelError("unavailable", "Kantel could not find the provider's token endpoint to bind the secret to");
		}
		const tokenHosts = tokenUrl === undefined ? [] : [hostOf(tokenUrl)];
		const secretRef =
			input.clientSecret === undefined
				? undefined
				: await credentials.put({
						owner: input.owner,
						name: `oauth-client-${input.templateId ?? hostOf(input.issuer!)}`,
						hosts: tokenHosts,
						value: input.clientSecret,
						createdBy: ctx.actor,
					});
		const now = clock.now();
		const client: StoredClient["client"] = {
			id: newId("oc"),
			owner: input.owner,
			...(input.templateId === undefined ? {} : { templateId: input.templateId }),
			...(input.issuer === undefined ? {} : { issuer: input.issuer }),
			label: input.label.trim(),
			clientId: input.clientId.trim(),
			secret: {
				set: input.clientSecret !== undefined,
				...(input.clientSecret === undefined || last4(input.clientSecret) === undefined
					? {}
					: { last4: last4(input.clientSecret) }),
				refreshable: false,
				...(input.clientSecret === undefined ? {} : { updatedAt: now }),
			},
			...(input.scopes === undefined ? {} : { scopes: input.scopes }),
			...(input.redirectDomain === undefined ? {} : { redirectDomain: input.redirectDomain }),
			disabled: false,
			...(extra.githubApp === undefined ? {} : { githubApp: extra.githubApp }),
			createdBy: ctx.actor,
			createdAt: now,
			updatedAt: now,
		};
		const stored: StoredClient = { client, ...(secretRef === undefined ? {} : { secretRef }), tokenHosts };
		await repo.insert("client", { id: client.id, organisationId: ctx.organisationId, value: stored, createdAt: now });
		await audit(ctx, ctx.organisationId, {
			type: "connections.client.created",
			...(input.owner.kind === "project" ? { projectId: input.owner.projectId } : {}),
			subject: { kind: "connections.client", id: client.id },
			data: {
				owner: input.owner.kind,
				...(input.templateId === undefined ? { issuer: input.issuer! } : { templateId: input.templateId }),
				...(extra.githubApp === undefined ? {} : { githubApp: extra.githubApp.slug }),
			},
		});
		return stored;
	};

	// Access rules (#332).

	/**
	 * The template's default rules for a connection: for an API, its endpoint hints and the method defaults (reads allow,
	 * writes ask, deletes deny); for an MCP server none until a listing names its tools (`seedToolDefaults`).
	 */
	const defaultRulesFor = (connection: Connection): ConnectionRuleInput[] => {
		if (connection.kind !== "http") return [];
		const template = connection.templateId === undefined ? undefined : templateById(catalogue, connection.templateId);
		return defaultRuleInputs(template?.endpointHints);
	};

	/** The defaults that fit the organisation's ceiling now; one outside it is left out rather than refused. */
	const fittingDefaults = (
		connection: Connection,
		inputs: readonly ConnectionRuleInput[],
		ceiling: ConnectionCeiling,
		now: number,
	): ConnectionRuleInput[] =>
		inputs.filter((rule) => {
			try {
				checkRule(connection, rule, ceiling, now);
				return true;
			} catch {
				return false;
			}
		});

	/**
	 * A connection's rules, giving it its template's defaults first when it has no rules record (#332's follow-up):
	 * `created` for a new connection, `migrated` for one made before rules, whose `unmatched: allow` let every request
	 * through. Two instances racing settle on the record inserted first. A connection whose rules a person has edited has
	 * a record, so it is never touched here. Audited as `connections.rules.defaulted`.
	 */
	const ensureRules = async (
		connection: Connection,
		reason: "created" | "migrated",
		actor: Actor = RULES_ACTOR,
	): Promise<ConnectionRules> => {
		const found = await readRules(repo, connection.id);
		if (found.revision !== undefined) return found.rules;
		const now = clock.now();
		const ceiling = await ceilingFor(options.ceiling, connection.organisationId);
		const set: ConnectionRules = {
			connectionId: connection.id,
			rules: fittingDefaults(connection, defaultRulesFor(connection), ceiling, now).map((input) =>
				newRule(newId("cr"), connection.id, input, { source: "default", actor }, now),
			),
			unmatched: DEFAULT_UNMATCHED,
			// One past the pre-rules set's 0, so nothing approved under that is used under these.
			version: found.rules.version + 1,
			updatedAt: now,
			defaults: { reason, at: now },
		};
		const inserted = await repo.insert("rules", {
			id: connection.id,
			organisationId: connection.organisationId,
			key: connection.id,
			value: set,
			createdAt: now,
		});
		if (!inserted) return (await readRules(repo, connection.id)).rules;
		await audit(
			{ actor },
			connection.organisationId,
			connectionEvent("connections.rules.defaulted", connection, {
				reason,
				unmatched: set.unmatched,
				version: set.version,
				rules: set.rules.map((rule) => `${rule.action} ${describeRule(rule)}`),
				...(reason === "migrated" ? { before: { unmatched: "allow", rules: 0, version: 0 } } : {}),
			}),
		);
		return set;
	};

	/**
	 * The default rules an MCP server's listing gives the tools it annotates (`defaultToolRuleInputs`): read-only allow,
	 * destructive deny. Only while the rules are still all defaults, and only for tools no rule names, so a person's set
	 * is never loosened. Best effort: a failure here never fails the listing.
	 */
	const seedToolDefaults = async (
		connection: Connection,
		tools: readonly {
			readonly name: string;
			readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
		}[],
	): Promise<void> => {
		try {
			const ceiling = await ceilingFor(options.ceiling, connection.organisationId);
			let added: ConnectionRule[] = [];
			await changeRules(repo, connection, (current) => {
				const now = clock.now();
				const room = Math.max(0, MAX_RULES - current.rules.length);
				const inputs = fittingDefaults(connection, defaultToolRuleInputs(current, tools), ceiling, now).slice(0, room);
				added = inputs.map((input) =>
					newRule(newId("cr"), connection.id, input, { source: "default", actor: RULES_ACTOR }, now),
				);
				if (added.length === 0) return undefined;
				return { ...current, rules: [...current.rules, ...added], version: current.version + 1, updatedAt: now };
			});
			if (added.length === 0) return;
			await audit(
				{ actor: RULES_ACTOR },
				connection.organisationId,
				connectionEvent("connections.rules.defaulted", connection, {
					reason: "tools",
					rules: added.map((rule) => `${rule.action} ${describeRule(rule)}`),
				}),
			);
		} catch {
			// The tools are listed whatever happens here; the next listing tries again.
		}
	};

	const ruleData = (rule: ConnectionRule): Record<string, JsonValue> => ({
		ruleId: rule.id,
		who: { ...rule.who },
		what: { ...rule.what },
		action: rule.action,
		source: rule.source,
		...(rule.expiresAt === undefined ? {} : { expiresAt: rule.expiresAt }),
		...(rule.maxUses === undefined ? {} : { maxUses: rule.maxUses }),
		...(rule.approvalId === undefined ? {} : { approvalId: rule.approvalId }),
	});

	const saveRule = async (
		ctx: CallContext,
		connectionId: string,
		input: ConnectionRuleInput,
		origin: { readonly source: "person" | "approval"; readonly approvalId?: string },
	): Promise<ConnectionRule> => {
		const found = await visibleConnection(ctx, connectionId);
		const connection = found.value.connection;
		await requireManage(ctx, connection.owner, "connections.createRule", connectionId);
		// A rule added to a connection made before rules goes beside its defaults, not onto an allow-everything set.
		await ensureRules(connection, "migrated");
		const now = clock.now();
		checkRule(connection, input, await ceilingFor(options.ceiling, connection.organisationId), now);
		const rule = newRule(newId("cr"), connectionId, input, { ...origin, actor: ctx.actor }, now);
		await changeRules(repo, connection, (current) => {
			assertRoom(current);
			return { ...current, rules: [...current.rules, rule], version: current.version + 1, updatedAt: now };
		});
		await audit(ctx, ctx.organisationId, connectionEvent("connections.rule.created", connection, ruleData(rule)));
		return rule;
	};

	/**
	 * "Always allow requests like this" (#333): the approval named is an exact request through this connection, still
	 * open or approved, and the rule is an `allow` that covers it, for the agent and session that sent it. Otherwise the
	 * rule is refused, so a rule marked as coming from an approval always does.
	 */
	const checkFromApproval = async (
		ctx: CallContext,
		connectionId: string,
		input: ConnectionRuleInput,
		approvalId: string,
	): Promise<void> => {
		const answer = await options.approvals!.connectionApproval(SELF, {
			op: "status",
			organisationId: ctx.organisationId,
			proposalId: approvalId,
		});
		if (answer.outcome !== "status") throw new KantelError("unavailable", "The vault gave no approval answer");
		const { proposal } = answer;
		const request = proposal.terms.request;
		if (request === undefined || request.connectionId !== connectionId) {
			throw new KantelError("refused", `Approval ${approvalId} is not for a request through this connection`);
		}
		if (proposal.status !== "pending" && proposal.status !== "approved") {
			throw new KantelError("refused", `Approval ${approvalId} was ${proposal.status}, so it can't become a rule`);
		}
		if (input?.action !== "allow") throw new KantelError("invalid", "Always allow saves an allow rule");
		const probe = newRule("probe", connectionId, input, { source: "approval", actor: ctx.actor }, clock.now());
		const decision = decideConnectionRules(
			{ rules: [probe], unmatched: "deny", version: 0 },
			{
				...(proposal.projectId === undefined ? {} : { projectId: proposal.projectId }),
				agentId: proposal.requester.agentId ?? "",
				sessionId: proposal.requester.sessionId ?? "",
			},
			{
				kind: request.kind,
				method: request.method,
				host: request.host,
				path: request.path,
				...(request.tool === undefined ? {} : { tool: request.tool }),
			},
			clock.now(),
		);
		if (decision.action !== "allow") {
			throw new KantelError("refused", "This rule doesn't cover the request it is saved from");
		}
	};

	/** Whether this process's sweep has given every connection made before rules its defaults yet. */
	let rulesMigrated = false;

	/** Every connection in the deployment, a page at a time, for the sweep. */
	const everyConnection = async function* (): AsyncGenerator<StoredConnection> {
		let after: string | undefined;
		for (;;) {
			const page = await repo.scan<StoredConnection>("connection", {
				...(after === undefined ? {} : { after }),
				limit: SWEEP_PAGE,
			});
			for (const record of page) yield record.value;
			if (page.length < SWEEP_PAGE) return;
			after = page.at(-1)?.id;
		}
	};

	const service: ConnectionsService = {
		redirectUri,

		async sweep(ctx) {
			await requireSystem(ctx, "connections.sweep");
			let checked = 0;
			let refreshed = 0;
			let failed = 0;
			let nextDueAt: number | undefined;
			const later = (at: number | undefined) => {
				if (at !== undefined && (nextDueAt === undefined || at < nextDueAt)) nextDueAt = at;
			};
			const migrating = !rulesMigrated;
			for await (const stored of everyConnection()) {
				// The first sweep in a process gives every connection made before rules its template's defaults (#332). Each
				// read of a connection's rules does the same, so a request never waits on this.
				if (migrating) await ensureRules(stored.connection, "migrated").catch(() => undefined);
				const at = refreshDueAt(stored);
				if (at === undefined) continue;
				checked += 1;
				if (clock.now() < at) {
					later(at);
					continue;
				}
				const id = stored.connection.id;
				// One connection's failure never stops the sweep: it is recorded in that connection's health.
				const outcome = await refresh(id, { reason: "sweep" }).catch((): RefreshOutcome => "failed");
				if (outcome === "refreshed") refreshed += 1;
				if (outcome === "failed" || outcome === "needs_reconnect") failed += 1;
				const after = await repo.get<StoredConnection>("connection", id);
				// Another process holds it: look again shortly, in case that process dies with the lease.
				later(outcome === "busy" ? clock.now() + leaseMs : after === undefined ? undefined : refreshDueAt(after.value));
			}
			rulesMigrated = true;
			return { checked, refreshed, failed, ...(nextDueAt === undefined ? {} : { nextDueAt }) };
		},

		async nextRefreshAt(ctx) {
			await requireSystem(ctx, "connections.nextRefreshAt");
			let next: number | undefined;
			for await (const stored of everyConnection()) {
				const at = refreshDueAt(stored);
				if (at !== undefined && (next === undefined || at < next)) next = at;
			}
			return next;
		},

		clientMetadata() {
			return {
				client_id: cimdClientId,
				client_name: clientName,
				client_uri: origin,
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			};
		},

		async settings() {
			return { personal: deployment.personal === true };
		},

		// Catalogue.

		async listCatalogue(ctx, query = {}, page) {
			const q = query.q?.trim().toLowerCase();
			const matches = catalogue.filter(
				(entry) =>
					(query.category === undefined || entry.category === query.category) &&
					(query.authType === undefined || entry.authTypes.includes(query.authType)) &&
					(query.kind === undefined || entry.kind === query.kind) &&
					(q === undefined ||
						q === "" ||
						[entry.id, entry.name, entry.description, entry.category].some((text) => text.toLowerCase().includes(q))),
			);
			const slice = paginate(matches, page);
			const clients = (await repo.list<StoredClient>("client", { organisationId: ctx.organisationId })).map(
				(record) => record.value,
			);
			const items: CatalogueEntry[] = [];
			for (const entry of slice.items) {
				items.push({
					id: entry.id,
					version: entry.version,
					name: entry.name,
					description: entry.description,
					icon: entry.icon,
					docsUrl: entry.docsUrl,
					category: entry.category,
					kind: entry.kind,
					authTypes: entry.authTypes,
					...(entry.mcp === undefined ? {} : { mcpUrl: entry.mcp.url }),
					source: entry.source,
					scopeSets: entry.scopeSets,
					...(entry.clientGuidance === undefined ? {} : { clientGuidance: entry.clientGuidance }),
					...setupOf(ctx, entry, clients),
				});
			}
			return slice.nextCursor === undefined ? { items } : { items, nextCursor: slice.nextCursor };
		},

		async getTemplate(_ctx, templateId) {
			return template(templateId);
		},

		async discoverMcp(ctx, url) {
			forbidAgent(ctx);
			const found = await discoverMcpAuth(fetch, url, { allowHttp });
			const entry = templateForMcpUrl(catalogue, found.url);
			const server = found.server;
			const registration: ClientRegistration[] = [];
			if (server !== undefined) {
				const issuer = server.issuer ?? new URL(server.authorization_endpoint).origin;
				const owner: ConnectionOwner =
					ctx.actor.kind === "human"
						? { kind: "user", organisationId: ctx.organisationId, userId: ctx.actor.userId }
						: { kind: "organisation", organisationId: ctx.organisationId };
				const match = { ...(entry === undefined ? {} : { templateId: entry.id }), issuer };
				if (
					(await storedClientsFor(ctx.organisationId, owner, match)).length > 0 ||
					platformClientFor(match) !== undefined
				) {
					registration.push("client");
				}
				if (server.client_id_metadata_document_supported === true && deployment.clientMetadataPublic)
					registration.push("cimd");
				if (server.registration_endpoint !== undefined) registration.push("dcr");
			}
			const discovery: McpDiscovery = {
				url: found.url,
				auth: found.auth,
				...(found.resource === undefined ? {} : { resource: found.resource }),
				...(server === undefined
					? {}
					: { authorizationServer: server.issuer ?? new URL(server.authorization_endpoint).origin }),
				registration,
				...(found.scopes === undefined ? {} : { scopes: found.scopes }),
				...(entry === undefined ? {} : { templateId: entry.id }),
			};
			return discovery;
		},

		// Connections.

		async list(ctx, filter = {}, page) {
			const records = await repo.list<StoredConnection>("connection", { organisationId: ctx.organisationId });
			const out: Connection[] = [];
			for (const record of records) {
				const connection = record.value.connection;
				if (filter.ownerKind !== undefined && connection.owner.kind !== filter.ownerKind) continue;
				if (filter.ownerId !== undefined) {
					const owner = connection.owner;
					const id =
						owner.kind === "organisation"
							? owner.organisationId
							: owner.kind === "project"
								? owner.projectId
								: owner.userId;
					if (id !== filter.ownerId) continue;
				}
				if (filter.templateId !== undefined && connection.templateId !== filter.templateId) continue;
				if (filter.kind !== undefined && connection.kind !== filter.kind) continue;
				if (await canSee(ctx, connection)) out.push(connection);
			}
			return paginate(out, page);
		},

		async get(ctx, connectionId) {
			return (await visibleConnection(ctx, connectionId)).value.connection;
		},

		async update(ctx, connectionId, input) {
			const found = await visibleConnection(ctx, connectionId);
			await requireManage(ctx, found.value.connection.owner, "connections.update", connectionId);
			if (input.usage !== undefined) validateUsage(input.usage);
			if (input.name !== undefined && input.name.trim() === "")
				throw new KantelError("invalid", "A connection needs a name");
			const updated = await changeConnection(connectionId, (current) => ({
				...current,
				connection: {
					...current.connection,
					...(input.name === undefined ? {} : { name: input.name.trim() }),
					...(input.usage === undefined ? {} : { usage: input.usage }),
					...(input.status === undefined
						? {}
						: {
								status:
									input.status === "disabled"
										? "disabled"
										: current.connection.credential.set && current.connection.health?.state !== "needs_reconnect"
											? "active"
											: "needs_reauth",
							}),
					updatedAt: clock.now(),
				},
			}));
			await audit(ctx, ctx.organisationId, connectionEvent("connections.connection.updated", updated.connection));
			return updated.connection;
		},

		async remove(ctx, connectionId) {
			const found = await visibleConnection(ctx, connectionId);
			const { connection } = found.value;
			await requireManage(ctx, connection.owner, "connections.remove", connectionId);
			// 1. Every use stops at once: a disabled connection is refused before any credential is opened, by every
			// instance on its next request, since nothing caches a connection. A disconnect cut short leaves it disabled, and
			// disconnecting again finishes it.
			const stopped = await changeConnection(connectionId, (current) =>
				current.connection.status === "disabled"
					? undefined
					: { ...current, connection: { ...current.connection, status: "disabled", updatedAt: clock.now() } },
			);
			// 2. The provider revokes the tokens, while the vault still holds them. Whatever it answers, the connection goes.
			const revocation = await revokeUpstream(stopped).catch(
				(): ConnectionRevocation => ({ outcome: "failed", reason: "Kantel could not ask the provider to revoke it" }),
			);
			// 3. The stored secrets are destroyed: the vault drops each sealed value.
			for (const ref of Object.values(stopped.secrets)) if (ref !== undefined) await credentials.remove(ref);
			// 4. Its standing rules and approvals not yet used go with it, then the record. Its uses and audit history stay.
			const rules = await repo.get<ConnectionRules>("rules", connectionId);
			if (rules !== undefined) await repo.remove("rules", connectionId);
			const approvalsWithdrawn = await forgetApprovals(connection.organisationId, connectionId);
			// Its placeholder stops naming anything (#331): a sandbox still holding it is refused as `unknown_placeholder`.
			if (stopped.connection.placeholder !== undefined)
				await repo.remove("placeholder", stopped.connection.placeholder);
			await repo.remove("connection", connectionId);
			await repo.remove("refresh_lease", connectionId).catch(() => undefined);
			const removal: ConnectionRemoval = {
				connectionId,
				revocation,
				rulesRemoved: rules?.value.rules.length ?? 0,
				approvalsWithdrawn,
			};
			await audit(
				ctx,
				ctx.organisationId,
				connectionEvent("connections.connection.removed", connection, {
					revocation: revocation.outcome,
					...(revocation.endpoint === undefined ? {} : { revocationEndpoint: revocation.endpoint }),
					...(revocation.reason === undefined ? {} : { revocationReason: revocation.reason }),
					...(revocation.manageUrl === undefined ? {} : { manageUrl: revocation.manageUrl }),
					rulesRemoved: removal.rulesRemoved,
					approvalsWithdrawn,
				}),
			);
			return removal;
		},

		// OAuth connect.

		async startConnect(ctx, input) {
			forbidAgent(ctx);
			if ((input.templateId === undefined) === (input.mcpUrl === undefined) && input.connectionId === undefined) {
				throw new KantelError("invalid", "Give a template or an MCP server's URL");
			}
			if (input.usage !== undefined) validateUsage(input.usage);
			await requireManage(ctx, input.owner, "connections.connect");
			let start = input;
			if (input.connectionId !== undefined) {
				const previous = await visibleConnection(ctx, input.connectionId);
				const connection = previous.value.connection;
				if (!sameOwner(connection.owner, input.owner))
					throw new KantelError("invalid", "A reconnect keeps the connection's owner");
				start = {
					...input,
					...(connection.templateId === undefined ? {} : { templateId: connection.templateId }),
					...(connection.mcp === undefined || connection.templateId !== undefined
						? {}
						: { mcpUrl: connection.mcp.url }),
				};
			}
			const forUserId = start.forUserId ?? (ctx.actor.kind === "human" ? ctx.actor.userId : undefined);
			if (forUserId === undefined) throw new KantelError("invalid", "Name the person who will sign in (forUserId)");
			if (start.owner.kind === "user" && forUserId !== start.owner.userId) {
				throw new KantelError("invalid", "A person's own connection is signed in by that person");
			}
			if (start.returnTo !== undefined && !start.returnTo.startsWith("/") && !start.returnTo.startsWith("https://")) {
				throw new KantelError("invalid", "returnTo is a path on this deployment or an https URL");
			}
			const entry = start.templateId === undefined ? undefined : template(start.templateId);
			if (entry !== undefined && !entry.authTypes.includes("oauth2") && !entry.authTypes.includes("none")) {
				throw new KantelError("invalid", `${entry.name} connects with a key: use POST /v1/connections/keys`);
			}
			const mcpUrl =
				start.mcpUrl === undefined ? undefined : publicUrl(start.mcpUrl, "The MCP server's URL", allowHttp).href;
			const now = clock.now();
			const id = newId("ca");
			const base = {
				id,
				organisationId: ctx.organisationId,
				owner: start.owner,
				...(entry === undefined ? {} : { templateId: entry.id }),
				...(mcpUrl === undefined ? (entry?.mcp === undefined ? {} : { mcpUrl: entry.mcp.url }) : { mcpUrl }),
				forUserId,
				createdBy: ctx.actor,
				createdAt: now,
				expiresAt: now + ATTEMPT_TTL_MS,
			};
			const planned = await planConnect(ctx, start, entry, mcpUrl);
			if (planned.open !== undefined) {
				const connection: Connection = {
					id: newId("conn"),
					organisationId: ctx.organisationId,
					owner: start.owner,
					name: start.name ?? entry?.name ?? hostOf(mcpUrl!),
					...(entry === undefined ? {} : { templateId: entry.id, templateVersion: entry.version }),
					kind: "mcp",
					auth: "none",
					mcp: {
						url: mcpUrl ?? entry!.mcp!.url,
						...(planned.open.resource === undefined ? {} : { resource: planned.open.resource }),
					},
					hosts: [...planned.open.hosts],
					scopes: { requested: [], granted: [] },
					usage: start.usage ?? defaultConnectionUsage(start.owner),
					status: "active",
					credential: { set: false, refreshable: false },
					createdBy: ctx.actor,
					createdAt: now,
					updatedAt: now,
				};
				await saveNewConnection({ connection, secrets: {} });
				await audit(ctx, ctx.organisationId, connectionEvent("connections.connection.created", connection));
				const attempt: ConnectAttempt = { ...base, status: "completed", connectionId: connection.id, completedAt: now };
				await repo.insert("attempt", {
					id,
					organisationId: ctx.organisationId,
					value: { attempt, input: start },
					createdAt: now,
				});
				return attempt;
			}
			const plan = planned.plan!;
			// A public client and a provider with the device flow: the person types a code at the provider instead.
			const deviceUrl =
				plan.client.public === true && entry?.oauth?.discovery === "static"
					? entry.oauth.deviceAuthorizationUrl
					: undefined;
			let device: DeviceAuthorization | undefined;
			if (deviceUrl !== undefined) {
				try {
					device = await deviceAuthorization(
						fetch,
						deviceUrl,
						{ clientId: plan.client.clientId, scope: plan.scopes.join(plan.scopeSeparator) },
						{ allowHttp },
					);
				} catch (error) {
					if (isKantelError(error, "unavailable") || isKantelError(error, "invalid")) throw error;
					return fail("exchange_failed", isKantelError(error) ? error.message : "The device sign-in could not start");
				}
			}
			const attempt: ConnectAttempt =
				device === undefined
					? { ...base, status: "pending", connectUrl: `${origin}/v1/connections/authorize/${id}` }
					: {
							...base,
							status: "pending",
							connectUrl: device.verificationUri,
							device: { userCode: device.userCode, verificationUri: device.verificationUri, interval: device.interval },
							expiresAt: Math.min(base.expiresAt, now + device.expiresIn * 1000),
						};
			const stored: StoredAttempt = {
				attempt,
				input: start,
				plan,
				...(start.returnTo === undefined ? {} : { returnTo: start.returnTo }),
				...(device === undefined
					? {}
					: {
							device: {
								deviceCode: device.deviceCode,
								interval: device.interval,
								nextPollAt: now + device.interval * 1000,
							},
						}),
			};
			await repo.insert("attempt", { id, organisationId: ctx.organisationId, value: stored, createdAt: now });
			await audit(ctx, ctx.organisationId, {
				type: "connections.connect.started",
				...(start.owner.kind === "project" ? { projectId: start.owner.projectId } : {}),
				subject: { kind: "connections.attempt", id },
				data: {
					owner: start.owner.kind,
					client: plan.client.via,
					signIn: device === undefined ? "browser" : "device",
					...(entry === undefined ? {} : { templateId: entry.id }),
					...(mcpUrl === undefined ? {} : { host: hostOf(mcpUrl) }),
				},
			});
			return attempt;
		},

		async getAttempt(ctx, attemptId) {
			const found = await attemptRecord(attemptId);
			const attempt = found.value.attempt;
			if (found.organisationId !== ctx.organisationId)
				throw new KantelError("not_found", `No connect attempt ${attemptId}`);
			const mine =
				(ctx.actor.kind === "human" &&
					(attempt.forUserId === ctx.actor.userId ||
						(attempt.createdBy.kind === "human" && attempt.createdBy.userId === ctx.actor.userId))) ||
				(ctx.actor.kind === "service" &&
					attempt.createdBy.kind === "service" &&
					attempt.createdBy.serviceId === ctx.actor.serviceId);
			if (!mine && !(await canView(ctx, attempt.owner)))
				throw new KantelError("not_found", `No connect attempt ${attemptId}`);
			// A device-flow sign-in has no callback: asking after the attempt is what asks the provider.
			if (found.value.device !== undefined) return attemptView(await pollDevice(found));
			return attemptView(found.value);
		},

		async authorize(ctx, attemptId) {
			if (ctx.actor.kind !== "human") throw new KantelError("forbidden", "A person opens a connect link");
			const found = await attemptRecord(attemptId);
			if (found.organisationId !== ctx.organisationId)
				throw new KantelError("not_found", `No connect attempt ${attemptId}`);
			const view = attemptView(found.value);
			if (view.status !== "pending")
				throw new KantelError(
					view.status === "expired" ? "expired" : "conflict",
					`This connect link is ${view.status}`,
				);
			if (view.forUserId !== undefined && view.forUserId !== ctx.actor.userId) {
				await failAttempt(attemptId, "user_mismatch", "Someone other than the person it was made for opened the link");
				throw new KantelError("forbidden", "This connect link was made for someone else");
			}
			const plan = found.value.plan;
			if (plan === undefined) throw new KantelError("conflict", "This connect needs no sign-in");
			if (found.value.device !== undefined) {
				throw new KantelError("conflict", "This connect signs in with a code at the provider, not a link");
			}
			if (found.value.exchanging === true) throw new KantelError("conflict", "This connect is finishing");
			const state = randomToken(32);
			const pkce = await pkcePair();
			await settleAttempt(
				attemptId,
				(stored) => {
					if (stored.exchanging === true) throw new KantelError("conflict", "This connect is finishing");
					return { ...stored, verifier: pkce.verifier };
				},
				await sha256(state),
			);
			const url = new URL(plan.authorizationUrl);
			url.searchParams.set("response_type", "code");
			url.searchParams.set("client_id", plan.client.clientId);
			url.searchParams.set("redirect_uri", plan.redirectUri);
			url.searchParams.set("state", state);
			if (plan.scopes.length > 0) url.searchParams.set("scope", plan.scopes.join(plan.scopeSeparator));
			if (plan.pkce) {
				url.searchParams.set("code_challenge", pkce.challenge);
				url.searchParams.set("code_challenge_method", "S256");
			}
			if (plan.resource !== undefined) url.searchParams.set("resource", plan.resource);
			for (const [name, value] of Object.entries(plan.extraParams)) url.searchParams.set(name, value);
			return { url: url.href };
		},

		async completeConnect(ctx, callback) {
			if (typeof callback.state !== "string" || callback.state.length === 0) {
				throw new KantelError("invalid", "The provider sent no state");
			}
			const found = await repo.findByKey<StoredAttempt>("attempt", await sha256(callback.state));
			if (found === undefined)
				throw new KantelError("refused", "This sign-in link is used up or unknown", { failure: "invalid_state" });
			const attemptId = found.id;
			// Use the state up first: whatever happens next, it never works twice.
			if (!(await repo.update("attempt", attemptId, found.revision, { ...found.value, exchanging: true }, null))) {
				throw new KantelError("refused", "This sign-in link is used up", { failure: "invalid_state" });
			}
			const stored = found.value;
			const view = attemptView(stored);
			if (view.status !== "pending") {
				throw new KantelError("refused", `This connect is ${view.status}`, { failure: "invalid_state" });
			}
			if (
				found.organisationId !== ctx.organisationId ||
				ctx.actor.kind !== "human" ||
				(view.forUserId !== undefined && view.forUserId !== ctx.actor.userId)
			) {
				await failAttempt(
					attemptId,
					"user_mismatch",
					"Someone other than the person it was made for finished the sign-in",
				);
				throw new KantelError("forbidden", "This sign-in was for someone else; nothing was stored", {
					failure: "user_mismatch",
				});
			}
			if (callback.error !== undefined || callback.code === undefined) {
				const message =
					callback.error === undefined
						? "The provider sent no code"
						: `The provider said ${callback.error}${callback.errorDescription === undefined ? "" : `: ${callback.errorDescription.slice(0, 200)}`}`;
				return attemptView(await failAttempt(attemptId, "denied", message));
			}
			const plan = stored.plan!;
			let tokens: TokenSet;
			try {
				tokens = await tokenRequest(
					fetch,
					plan.tokenUrl,
					await tokenClient(plan.client, plan.tokenUrl, stored.attempt.organisationId),
					{
						grant_type: "authorization_code",
						code: callback.code,
						redirect_uri: plan.redirectUri,
						...(plan.pkce && stored.verifier !== undefined ? { code_verifier: stored.verifier } : {}),
						...(plan.resource === undefined ? {} : { resource: plan.resource }),
					},
					{ allowHttp, now: clock.now() },
				);
			} catch (error) {
				const message = isKantelError(error) ? error.message : "The token exchange failed";
				return attemptView(await failAttempt(attemptId, "exchange_failed", message));
			}
			return attemptView(await finishConnect(attemptId, stored, plan, tokens, ctx.actor));
		},

		// Keys.

		async connectKey(ctx, input: ConnectKeyInput) {
			forbidAgent(ctx);
			await requireManage(ctx, input.owner, "connections.connectKey");
			checkKey(input.value);
			if (input.usage !== undefined) validateUsage(input.usage);
			let hosts: readonly string[];
			let injection: KeyInjection;
			let kind: Connection["kind"];
			let mcpUrl: string | undefined;
			let entry: ProviderTemplate | undefined;
			if (input.templateId !== undefined) {
				entry = template(input.templateId);
				if (entry.key === undefined) throw new KantelError("invalid", `${entry.name} does not connect with a key`);
				hosts = entry.apiHosts;
				injection = entry.key.injection;
				kind = entry.kind;
				mcpUrl = entry.mcp?.url;
			} else if (input.custom !== undefined) {
				hosts = input.custom.hosts.map((host) => host.trim().toLowerCase());
				if (hosts.length === 0 || hosts.some((host) => !/^[a-z0-9.-]+$/.test(host) || !host.includes("."))) {
					throw new KantelError("invalid", "Give the https hosts the key may be sent to, as plain host names");
				}
				assertInjection(input.custom.injection);
				injection = input.custom.injection;
				kind = input.custom.kind;
				if (kind === "mcp") {
					if (input.custom.mcpUrl === undefined)
						throw new KantelError("invalid", "An MCP key connection needs the server's URL");
					mcpUrl = publicUrl(input.custom.mcpUrl, "The MCP server's URL", allowHttp).href;
					if (!hosts.includes(hostOf(mcpUrl)))
						throw new KantelError("invalid", "The MCP server's host must be one of the hosts");
				}
			} else {
				throw new KantelError("invalid", "Give a template or a custom service");
			}
			const now = clock.now();
			const key = await credentials.put({
				owner: input.owner,
				name: `${entry?.id ?? hosts[0]!.replace(/[^a-z0-9-]+/g, "-")}-key`,
				hosts,
				value: input.value,
				createdBy: ctx.actor,
			});
			// The template's test request, with the key sent as it will be: a key the service refuses is stored, but as
			// `failing_test`, so the page can say so straight away.
			const test =
				entry?.testRequest === undefined
					? undefined
					: await runTest(entry.testRequest, entry.apiHosts, injection, input.value);
			const account = test?.account;
			const connection: Connection = {
				id: newId("conn"),
				organisationId: ctx.organisationId,
				owner: input.owner,
				name: input.name ?? entry?.name ?? hosts[0]!,
				...(entry === undefined ? {} : { templateId: entry.id, templateVersion: entry.version }),
				kind,
				auth: "key",
				...(mcpUrl === undefined ? {} : { mcp: { url: mcpUrl } }),
				hosts: [...hosts],
				...(account === undefined ? {} : { account }),
				scopes: { requested: [], granted: [] },
				usage: input.usage ?? defaultConnectionUsage(input.owner),
				status: test?.refused === true ? "failing_test" : "active",
				credential: {
					set: true,
					...(last4(input.value) === undefined ? {} : { last4: last4(input.value) }),
					refreshable: false,
					updatedAt: now,
				},
				createdBy: ctx.actor,
				createdAt: now,
				updatedAt: now,
			};
			const saved = await saveNewConnection({ connection, secrets: { key }, injection });
			await audit(ctx, ctx.organisationId, connectionEvent("connections.connection.created", saved));
			return saved;
		},

		async rotateKey(ctx, connectionId, input) {
			const found = await visibleConnection(ctx, connectionId);
			await requireManage(ctx, found.value.connection.owner, "connections.rotateKey", connectionId);
			if (found.value.connection.auth !== "key" || found.value.secrets.key === undefined) {
				throw new KantelError("invalid", "Only a key connection has a key to replace");
			}
			checkKey(input.value);
			const entry =
				found.value.connection.templateId === undefined
					? undefined
					: templateById(catalogue, found.value.connection.templateId);
			const test =
				entry?.testRequest === undefined
					? undefined
					: await runTest(entry.testRequest, entry.apiHosts, found.value.injection ?? { kind: "bearer" }, input.value);
			await credentials.replace(found.value.secrets.key, input.value);
			const updated = await changeConnection(connectionId, (current) => ({
				...current,
				connection: {
					...current.connection,
					...(test?.account === undefined ? {} : { account: test.account }),
					status:
						current.connection.status === "disabled" ? "disabled" : test?.refused === true ? "failing_test" : "active",
					credential: {
						set: true,
						...(last4(input.value) === undefined ? {} : { last4: last4(input.value) }),
						refreshable: false,
						updatedAt: clock.now(),
					},
					updatedAt: clock.now(),
				},
			}));
			await audit(ctx, ctx.organisationId, connectionEvent("connections.connection.rotated", updated.connection));
			return updated.connection;
		},

		// OAuth clients.

		async listClients(ctx, filter = {}, page) {
			const out: OAuthClient[] = [];
			for (const [index, client] of platformClients.entries()) out.push(platformClientView(client, index));
			for (const record of await repo.list<StoredClient>("client", { organisationId: ctx.organisationId })) {
				if (await canView(ctx, record.value.client.owner)) out.push(await clientView(record.value));
			}
			return paginate(
				out.filter(
					(client) =>
						(filter.templateId === undefined || client.templateId === filter.templateId) &&
						(filter.tier === undefined || client.owner.kind === filter.tier),
				),
				page,
			);
		},

		async getClient(ctx, oauthClientId) {
			const index = platformClients.findIndex((client, i) => platformClientView(client, i).id === oauthClientId);
			if (index >= 0) return platformClientView(platformClients[index]!, index);
			const found = await repo.get<StoredClient>("client", oauthClientId);
			if (
				found === undefined ||
				found.organisationId !== ctx.organisationId ||
				!(await canView(ctx, found.value.client.owner))
			) {
				throw new KantelError("not_found", `No OAuth client ${oauthClientId}`);
			}
			return clientView(found.value);
		},

		async createClient(ctx, input) {
			if (input.owner.kind === "platform") {
				throw new KantelError("refused", "The deployment's OAuth clients come from its configuration");
			}
			await requireManage(ctx, input.owner, "connections.createClient");
			if ((input.templateId === undefined) === (input.issuer === undefined)) {
				throw new KantelError("invalid", "An OAuth client is for a template or an authorisation server's issuer");
			}
			if (input.label.trim() === "" || input.clientId.trim() === "")
				throw new KantelError("invalid", "Give a label and a client ID");
			let tokenUrl: string | undefined;
			if (input.templateId !== undefined) {
				const entry = template(input.templateId);
				if (entry.oauth === undefined) throw new KantelError("invalid", `${entry.name} has no OAuth`);
				tokenUrl = entry.oauth.tokenUrl;
				if (tokenUrl === undefined && entry.mcp !== undefined) {
					tokenUrl = (await discoverMcpAuth(fetch, entry.mcp.url, { allowHttp }).catch(() => undefined))?.server
						?.token_endpoint;
				}
			} else {
				tokenUrl = (await authServerMetadata(fetch, input.issuer!, { allowHttp }))?.token_endpoint;
			}
			return clientView(await saveClient(ctx, input, tokenUrl));
		},

		async updateClient(ctx, oauthClientId, input) {
			const found = await repo.get<StoredClient>("client", oauthClientId);
			if (
				found === undefined ||
				found.organisationId !== ctx.organisationId ||
				!(await canView(ctx, found.value.client.owner))
			) {
				throw new KantelError("not_found", `No OAuth client ${oauthClientId}`);
			}
			await requireManage(ctx, found.value.client.owner, "connections.updateClient");
			let secretRef = found.value.secretRef;
			if (input.clientSecret !== undefined) {
				if (secretRef !== undefined) await credentials.replace(secretRef, input.clientSecret);
				else if (found.value.tokenHosts.length > 0) {
					secretRef = await credentials.put({
						owner: found.value.client.owner,
						name: `oauth-client-${found.value.client.templateId ?? "issuer"}`,
						hosts: found.value.tokenHosts,
						value: input.clientSecret,
						createdBy: ctx.actor,
					});
				} else
					throw new KantelError(
						"unavailable",
						"Kantel does not know the provider's token endpoint to bind the secret to",
					);
			}
			const now = clock.now();
			const next: StoredClient = {
				...found.value,
				...(secretRef === undefined ? {} : { secretRef }),
				client: {
					...found.value.client,
					...(input.label === undefined ? {} : { label: input.label }),
					...(input.scopes === undefined ? {} : { scopes: input.scopes }),
					...(input.redirectDomain === undefined ? {} : { redirectDomain: input.redirectDomain }),
					...(input.disabled === undefined ? {} : { disabled: input.disabled }),
					...(input.clientSecret === undefined
						? {}
						: {
								secret: {
									set: true,
									...(last4(input.clientSecret) === undefined ? {} : { last4: last4(input.clientSecret) }),
									refreshable: false,
									updatedAt: now,
								},
							}),
					updatedAt: now,
				},
			};
			if (!(await repo.update("client", oauthClientId, found.revision, next))) {
				throw new KantelError("conflict", "The OAuth client changed while it was being updated; try again");
			}
			return clientView(next);
		},

		async removeClient(ctx, oauthClientId) {
			const found = await repo.get<StoredClient>("client", oauthClientId);
			if (
				found === undefined ||
				found.organisationId !== ctx.organisationId ||
				!(await canView(ctx, found.value.client.owner))
			) {
				throw new KantelError("not_found", `No OAuth client ${oauthClientId}`);
			}
			await requireManage(ctx, found.value.client.owner, "connections.removeClient");
			const view = await clientView(found.value);
			if (view.connections > 0) {
				throw new KantelError(
					"conflict",
					`${view.connections} connection(s) are pinned to this client; remove or reconnect them first`,
				);
			}
			if (found.value.secretRef !== undefined) await credentials.remove(found.value.secretRef);
			await repo.remove("client", oauthClientId);
		},

		// GitHub App manifest flow.

		async startGitHubApp(ctx, input) {
			if (ctx.actor.kind !== "human") throw new KantelError("forbidden", "A person sets up a GitHub App");
			const userId = ctx.actor.userId;
			let owner: ConnectionOwner;
			switch (input.owner) {
				case "organisation":
					owner = { kind: "organisation", organisationId: ctx.organisationId };
					break;
				case "project":
					if (typeof input.projectId !== "string" || input.projectId === "") {
						throw new KantelError("invalid", "A project's GitHub App needs the project (projectId)");
					}
					owner = { kind: "project", organisationId: ctx.organisationId, projectId: input.projectId };
					break;
				case "user":
					owner = { kind: "user", organisationId: ctx.organisationId, userId };
					break;
				default:
					throw new KantelError("invalid", "A GitHub App is your organisation's, a project's or your own");
			}
			if (input.githubOrganisation !== undefined && !GITHUB_LOGIN.test(input.githubOrganisation)) {
				throw new KantelError("invalid", "That is not a GitHub organisation's name");
			}
			if (input.returnTo !== undefined && !input.returnTo.startsWith("/") && !input.returnTo.startsWith("https://")) {
				throw new KantelError("invalid", "returnTo is a path on this deployment or an https URL");
			}
			if (input.returnTo?.startsWith("//") === true) {
				throw new KantelError("invalid", "returnTo is a path on this deployment or an https URL");
			}
			const github = template(GITHUB_TEMPLATE);
			if (github.oauth?.tokenUrl === undefined) throw new KantelError("unavailable", "GitHub's template has no OAuth");
			// The same right as registering a client at that tier by hand.
			await requireManage(ctx, owner, "connections.createClient");
			const state = randomToken(32);
			const now = clock.now();
			const id = newId("gha");
			const suffix = [...crypto.getRandomValues(new Uint8Array(3))]
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join("");
			const stored: StoredGitHubApp = {
				setup: { id, status: "pending", expiresAt: now + GITHUB_APP_TTL_MS, createdAt: now },
				owner,
				createdBy: ctx.actor,
				...(input.githubOrganisation === undefined ? {} : { githubOrganisation: input.githubOrganisation }),
				...(input.returnTo === undefined ? {} : { returnTo: input.returnTo }),
				suffix,
			};
			await repo.insert("github_app", {
				id,
				organisationId: ctx.organisationId,
				key: await sha256(state),
				value: stored,
				createdAt: now,
			});
			await audit(ctx, ctx.organisationId, {
				type: "connections.github_app.started",
				...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
				subject: { kind: "connections.github_app", id },
				data: {
					owner: owner.kind,
					...(input.githubOrganisation === undefined ? {} : { githubOrganisation: input.githubOrganisation }),
				},
			});
			// The only time the state leaves Kantel's hands: in this URL, to the person who started the flow.
			return {
				...stored.setup,
				url: `${origin}/v1/connections/github-app/${encodeURIComponent(id)}/start?state=${encodeURIComponent(state)}`,
			};
		},

		async getGitHubApp(ctx, setupId) {
			const found = await repo.get<StoredGitHubApp>("github_app", setupId);
			if (found === undefined || found.organisationId !== ctx.organisationId) {
				throw new KantelError("not_found", `No GitHub App setup ${setupId}`);
			}
			const creator = found.value.createdBy;
			const mine = ctx.actor.kind === "human" && creator.kind === "human" && creator.userId === ctx.actor.userId;
			if (!mine && !(await canView(ctx, found.value.owner))) {
				throw new KantelError("not_found", `No GitHub App setup ${setupId}`);
			}
			return gitHubAppView(found.value);
		},

		async gitHubAppManifestPage(setupId, state) {
			if (typeof state !== "string" || state === "") throw new KantelError("invalid", "The link has no state");
			const found = await repo.get<StoredGitHubApp>("github_app", setupId);
			if (found === undefined || found.key === undefined || found.key !== (await sha256(state))) {
				throw new KantelError("refused", "This GitHub App link is used up or unknown");
			}
			const view = gitHubAppView(found.value);
			if (view.status !== "pending") {
				throw new KantelError(
					view.status === "expired" ? "expired" : "conflict",
					`This GitHub App link is ${view.status}`,
				);
			}
			const account = found.value.githubOrganisation;
			const manifest = gitHubAppManifest({
				origin,
				name: gitHubAppName(clientName, account, found.value.suffix),
				redirectUri,
			});
			return gitHubAppManifestHtml(gitHubAppFormAction(account, state), manifest);
		},

		async completeGitHubApp(input) {
			if (typeof input.state !== "string" || input.state === "") {
				throw new KantelError("invalid", "GitHub sent no state");
			}
			const found = await repo.findByKey<StoredGitHubApp>("github_app", await sha256(input.state));
			if (found === undefined) throw new KantelError("refused", "This GitHub App link is used up or unknown");
			// Use the state up first: whatever happens next, it never works twice.
			if (!(await repo.update("github_app", found.id, found.revision, found.value, null))) {
				throw new KantelError("refused", "This GitHub App link is used up");
			}
			const used: StoredRecord<StoredGitHubApp> = { ...found, revision: found.revision + 1 };
			const stored = found.value;
			const id = stored.setup.id;
			const failed = async (message: string, flag: string) => {
				await failGitHubApp(used, message);
				return { redirectTo: gitHubAppReturn(stored, { githubApp: id, githubAppError: flag }) };
			};
			const view = gitHubAppView(stored);
			if (view.status !== "pending") {
				return view.status === "expired"
					? failed("The hour GitHub allows to create the app ran out; start again", "expired")
					: { redirectTo: gitHubAppReturn(stored, { githubApp: id, githubAppError: view.status }) };
			}
			const organisationId = ownerOrganisation(stored.owner)!;
			const ctx: CallContext = { actor: stored.createdBy, organisationId };
			try {
				// Still allowed to: the flow may take up to an hour, and rights can change in it.
				await requireManage(ctx, stored.owner, "connections.createClient");
			} catch {
				return failed("You may no longer register OAuth clients there", "forbidden");
			}
			let app: ConvertedGitHubApp;
			try {
				app = await convertManifestCode(fetch, input.code);
			} catch (error) {
				return failed(isKantelError(error) ? error.message : "GitHub did not hand over the app", "conversion");
			}
			const githubApp: GitHubAppInfo = {
				slug: app.slug,
				appId: app.id,
				htmlUrl: app.htmlUrl,
				installUrl: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`,
			};
			let client: StoredClient;
			try {
				client = await saveClient(
					ctx,
					{
						owner: stored.owner,
						templateId: GITHUB_TEMPLATE,
						label: `GitHub App ${app.slug}`,
						clientId: app.clientId,
						clientSecret: app.clientSecret,
					},
					template(GITHUB_TEMPLATE).oauth?.tokenUrl,
					{ githubApp },
				);
			} catch {
				return failed("Kantel could not store the app's client", "store");
			}
			for (let tries = 0; tries < 5; tries += 1) {
				const current = await repo.get<StoredGitHubApp>("github_app", id);
				if (current === undefined) break;
				const next: StoredGitHubApp = {
					...current.value,
					setup: { ...current.value.setup, status: "created", clientId: client.client.id, githubApp },
				};
				if (await repo.update("github_app", id, current.revision, next, null)) break;
			}
			return { redirectTo: gitHubAppReturn(stored, { githubApp: id }) };
		},

		// Uses.

		async listUses(ctx, filter = {}, page) {
			if (filter.sessionId !== undefined) {
				await access().require(ctx, {
					sessionId: filter.sessionId,
					needed: "viewer",
					operation: "connections.listUses",
				});
			}
			const named = filter.connectionId === undefined ? undefined : await visibleConnection(ctx, filter.connectionId);
			const records = await repo.list<ConnectionUse>("use", {
				organisationId: ctx.organisationId,
				...(filter.connectionId === undefined ? {} : { key: filter.connectionId }),
				...(filter.sessionId === undefined ? {} : { ref: filter.sessionId }),
				limit: 5000,
			});
			const out: ListedConnectionUse[] = [];
			// Each connection, read once: absent when it has since been removed.
			const connections = new Map<string, Connection | undefined>();
			if (named !== undefined) connections.set(named.value.connection.id, named.value.connection);
			const connectionOf = async (id: string): Promise<Connection | undefined> => {
				if (!connections.has(id))
					connections.set(id, (await repo.get<StoredConnection>("connection", id))?.value.connection);
				return connections.get(id);
			};
			const visible = new Map<string, boolean>();
			// Whether the caller may open a session now: asked once per session; the one the filter named, they may.
			const opens = new Map<string, boolean>();
			if (filter.sessionId !== undefined) opens.set(filter.sessionId, true);
			for (const record of records) {
				const use = record.value;
				if (filter.connectionId === undefined && filter.sessionId === undefined) {
					let ok = visible.get(use.connectionId);
					if (ok === undefined) {
						const connection = await connectionOf(use.connectionId);
						ok = connection === undefined ? ctx.actor.kind === "system" : await canSee(ctx, connection);
						visible.set(use.connectionId, ok);
					}
					if (!ok) continue;
				}
				// Held uses stored before `held` existed read `denied` with a pending approval: they read as held now.
				const listed: ConnectionUse =
					use.outcome === "denied" && use.approval?.state === "pending" ? { ...use, outcome: "held" } : use;
				const { audience } = listed;
				out.push(
					audience.kind === "private" && !(await privateUseShown(ctx, use, connectionOf, opens))
						? redactUse(listed, audience)
						: listed,
				);
			}
			const listedPage = paginate(out, page);
			return { ...listedPage, items: await withEndedApprovals(listedPage.items) };
		},

		// Sharing a person's connection (#335).

		async share(ctx, connectionId, projectId) {
			forbidAgent(ctx);
			const found = await visibleConnection(ctx, connectionId);
			const connection = found.value.connection;
			if (connection.owner.kind !== "user") {
				throw new KantelError(
					"invalid",
					"Only a person's own connection is shared; a project's or the organisation's reaches its sessions already",
				);
			}
			if (ctx.actor.kind !== "human" || ctx.actor.userId !== connection.owner.userId) {
				throw new KantelError("forbidden", "Only the person a connection belongs to can share it");
			}
			if (typeof projectId !== "string" || projectId === "") throw new KantelError("invalid", "Name a project");
			// Into a project where they may run sessions themselves.
			await access().require(ctx, {
				projectId,
				needed: "operator",
				operation: "connections.share",
				subject: { kind: "connection", id: connectionId },
			});
			if ((connection.shares ?? []).some((share) => share.projectId === projectId)) return connection;
			const now = clock.now();
			const updated = await changeConnection(connectionId, (current) =>
				(current.connection.shares ?? []).some((share) => share.projectId === projectId)
					? undefined
					: {
							...current,
							connection: {
								...current.connection,
								shares: [...(current.connection.shares ?? []), { projectId, sharedBy: ctx.actor, sharedAt: now }],
								updatedAt: now,
							},
						},
			);
			await audit(ctx, ctx.organisationId, {
				...connectionEvent("connections.connection.shared", updated.connection, { project: projectId }),
				projectId,
			});
			return updated.connection;
		},

		async unshare(ctx, connectionId, projectId) {
			forbidAgent(ctx);
			const found = await visibleConnection(ctx, connectionId);
			const connection = found.value.connection;
			const owner = connection.owner;
			const mine = owner.kind === "user" && ctx.actor.kind === "human" && ctx.actor.userId === owner.userId;
			if (!mine) {
				// An admin of the project takes a person's connection out of it; nobody else does.
				await access().require(ctx, {
					projectId,
					needed: "admin",
					operation: "connections.unshare",
					subject: { kind: "connection", id: connectionId },
				});
			}
			if (!(connection.shares ?? []).some((share) => share.projectId === projectId)) return connection;
			const updated = await changeConnection(connectionId, (current) =>
				(current.connection.shares ?? []).some((share) => share.projectId === projectId)
					? {
							...current,
							connection: {
								...current.connection,
								shares: (current.connection.shares ?? []).filter((share) => share.projectId !== projectId),
								updatedAt: clock.now(),
							},
						}
					: undefined,
			);
			await audit(ctx, ctx.organisationId, {
				...connectionEvent("connections.connection.unshared", updated.connection, { project: projectId }),
				projectId,
			});
			return updated.connection;
		},

		async sessionConnections(ctx, sessionId, request = {}) {
			await access().require(ctx, { sessionId, needed: "viewer", operation: "connections.sessionConnections" });
			const directory = typeof options.sessions === "function" ? options.sessions() : options.sessions;
			if (directory === undefined) throw new KantelError("unavailable", "Sessions are not available here");
			const record = await directory.get({ actor: SELF.actor, organisationId: ctx.organisationId }, sessionId);
			if (request.visibility !== undefined && request.visibility !== "private" && request.visibility !== "shared") {
				throw new KantelError("invalid", "A session's visibility is private or shared");
			}
			const visibility = request.visibility ?? record.visibility ?? "shared";
			const scope = sessionScopeOf(record, sessionAudienceOf({ ...record, visibility }, deployment.personal === true));
			const caller = ctx.actor.kind === "human" ? ctx.actor.userId : undefined;
			const records = await repo.list<StoredConnection>("connection", { organisationId: ctx.organisationId });
			const out: SessionConnectionEligibility[] = [];
			for (const stored of records) {
				const connection = stored.value.connection;
				const { owner } = connection;
				const sharedHere =
					owner.kind === "user" &&
					record.projectId !== undefined &&
					(connection.shares ?? []).some((share) => share.projectId === record.projectId);
				// What could reach this session: the organisation's, its project's, its person's and those shared into it.
				const relevant =
					owner.kind === "organisation" ||
					(owner.kind === "project" && owner.projectId === record.projectId) ||
					(owner.kind === "user" && owner.userId === record.userId) ||
					sharedHere;
				if (!relevant) continue;
				const reach = connectionUsableIn(connection, scope);
				const usable = reach.usable && connection.status !== "needs_reauth";
				// Another person's connection shows its account only where it is shared.
				const showAccount = owner.kind !== "user" || owner.userId === caller || sharedHere;
				out.push({
					connection: {
						id: connection.id,
						name: connection.name,
						kind: connection.kind,
						...(connection.templateId === undefined ? {} : { templateId: connection.templateId }),
						owner: owner.kind,
						...(connection.account === undefined || !showAccount ? {} : { account: connection.account }),
						hosts: connection.hosts,
						...(connection.mcp === undefined ? {} : { mcpUrl: connection.mcp.url }),
					},
					...(owner.kind === "user"
						? { ownerId: owner.userId }
						: owner.kind === "project"
							? { ownerId: owner.projectId }
							: {}),
					usable,
					...(reach.usable
						? connection.status === "needs_reauth"
							? { reason: "It needs connecting again" }
							: {}
						: { reason: reach.reason }),
					...(reach.usable && reach.viaShare === true ? { viaShare: true } : {}),
				});
			}
			out.sort(
				(a, b) =>
					Number(b.usable) - Number(a.usable) ||
					CONNECTION_OWNER_ORDER.indexOf(a.connection.owner) - CONNECTION_OWNER_ORDER.indexOf(b.connection.owner),
			);
			return out;
		},

		// Access rules (#332).

		async getRules(ctx, connectionId) {
			const found = await visibleConnection(ctx, connectionId);
			return ensureRules(found.value.connection, "migrated");
		},

		async updateRules(ctx, connectionId, input) {
			const found = await visibleConnection(ctx, connectionId);
			const connection = found.value.connection;
			await requireManage(ctx, connection.owner, "connections.updateRules", connectionId);
			if (input.unmatched !== undefined && !["allow", "ask", "deny"].includes(input.unmatched)) {
				throw new KantelError("invalid", "Unmatched requests are allowed, asked about or denied");
			}
			if (input.reset !== undefined && input.reset !== "template")
				throw new KantelError("invalid", "Reset to template");
			await ensureRules(connection, "migrated");
			const ceiling = await ceilingFor(options.ceiling, connection.organisationId);
			const now = clock.now();
			const defaults =
				input.reset === "template" ? fittingDefaults(connection, defaultRulesFor(connection), ceiling, now) : undefined;
			const updated = await changeRules(repo, connection, (current) => ({
				...current,
				...(defaults === undefined
					? {}
					: {
							rules: [
								...current.rules.filter((rule) => rule.source !== "default"),
								...defaults.map((rule) =>
									newRule(newId("cr"), connectionId, rule, { source: "default", actor: ctx.actor }, now),
								),
							],
							unmatched: DEFAULT_UNMATCHED,
							defaults: { reason: "reset" as const, at: now },
						}),
				...(input.unmatched === undefined ? {} : { unmatched: input.unmatched }),
				version: current.version + 1,
				updatedAt: now,
			}));
			await audit(
				ctx,
				ctx.organisationId,
				connectionEvent("connections.rules.updated", connection, {
					unmatched: updated.unmatched,
					version: updated.version,
					...(input.reset === undefined ? {} : { reset: input.reset }),
				}),
			);
			return updated;
		},

		createRule: (ctx, connectionId, input) => saveRule(ctx, connectionId, input, { source: "person" }),

		async createRuleFromApproval(ctx, connectionId, input, approvalId) {
			if (typeof approvalId !== "string" || approvalId === "") throw new KantelError("invalid", "Name the approval");
			// No approvals here, no approval to check: refuse rather than mark a rule as coming from one unchecked.
			if (options.approvals === undefined) {
				throw new KantelError("refused", "This deployment has no approvals, so no rule can come from one");
			}
			await checkFromApproval(ctx, connectionId, input, approvalId);
			return saveRule(ctx, connectionId, input, { source: "approval", approvalId });
		},

		async updateRule(ctx, connectionId, ruleId, input) {
			const found = await visibleConnection(ctx, connectionId);
			const connection = found.value.connection;
			await requireManage(ctx, connection.owner, "connections.updateRule", connectionId);
			const ceiling = await ceilingFor(options.ceiling, connection.organisationId);
			const now = clock.now();
			let saved: ConnectionRule | undefined;
			await changeRules(repo, connection, (current) => {
				const rule = current.rules.find((r) => r.id === ruleId);
				if (rule === undefined) throw new KantelError("not_found", `No rule ${ruleId} on ${connection.name}`);
				const merged: ConnectionRuleInput = {
					who: input.who ?? rule.who,
					what: input.what ?? rule.what,
					action: input.action ?? rule.action,
					...(input.expiresAt === null
						? {}
						: (input.expiresAt ?? rule.expiresAt) === undefined
							? {}
							: { expiresAt: (input.expiresAt ?? rule.expiresAt) as number }),
					...(input.maxUses === null
						? {}
						: (input.maxUses ?? rule.maxUses) === undefined
							? {}
							: { maxUses: (input.maxUses ?? rule.maxUses) as number }),
					...(input.note === null
						? {}
						: (input.note ?? rule.note) === undefined
							? {}
							: { note: (input.note ?? rule.note) as string }),
				};
				// An expiry kept as it was may have passed; only a new one must be in the future.
				checkRule(
					connection,
					input.expiresAt === undefined && merged.expiresAt !== undefined
						? { ...merged, expiresAt: Math.max(merged.expiresAt, now + 1) }
						: merged,
					ceiling,
					now,
				);
				const { expiresAt: _e, maxUses: _m, note: _n, ...kept } = rule;
				saved = {
					...kept,
					who: merged.who,
					what:
						merged.what.kind === "endpoint" && merged.what.host !== undefined
							? { ...merged.what, host: merged.what.host.toLowerCase() }
							: merged.what,
					action: merged.action,
					...(merged.expiresAt === undefined ? {} : { expiresAt: merged.expiresAt }),
					...(merged.maxUses === undefined ? {} : { maxUses: merged.maxUses }),
					...(merged.note === undefined || merged.note.trim() === "" ? {} : { note: merged.note.trim() }),
					// A default a person changed is theirs now: a reset to the template's leaves it.
					source: rule.source === "default" ? "person" : rule.source,
					updatedAt: now,
				};
				const next = saved;
				return {
					...current,
					rules: current.rules.map((r) => (r.id === ruleId ? next : r)),
					version: current.version + 1,
					updatedAt: now,
				};
			});
			const rule = saved as unknown as ConnectionRule;
			await audit(ctx, ctx.organisationId, connectionEvent("connections.rule.updated", connection, ruleData(rule)));
			return rule;
		},

		async removeRule(ctx, connectionId, ruleId) {
			const found = await visibleConnection(ctx, connectionId);
			const connection = found.value.connection;
			await requireManage(ctx, connection.owner, "connections.removeRule", connectionId);
			let removed: ConnectionRule | undefined;
			await changeRules(repo, connection, (current) => {
				removed = current.rules.find((r) => r.id === ruleId);
				if (removed === undefined) throw new KantelError("not_found", `No rule ${ruleId} on ${connection.name}`);
				return {
					...current,
					rules: current.rules.filter((r) => r.id !== ruleId),
					version: current.version + 1,
					updatedAt: clock.now(),
				};
			});
			const rule = removed as unknown as ConnectionRule;
			await audit(ctx, ctx.organisationId, connectionEvent("connections.rule.removed", connection, ruleData(rule)));
		},

		async dryRun(ctx, connectionId, request) {
			const found = await visibleConnection(ctx, connectionId);
			const connection = found.value.connection;
			const mcpUrl = connection.mcp?.url;
			if (!METHOD_NAMES.includes(request.method)) throw new KantelError("invalid", "Pick a method");
			const raw = request.url ?? mcpUrl;
			if (raw === undefined || raw === "") throw new KantelError("invalid", "Give the request's URL");
			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				throw new KantelError("invalid", "The request's URL is not a URL");
			}
			const caller = ctx.actor.kind === "human" ? ctx.actor.userId : undefined;
			const actingUserId = request.actingUserId === null ? undefined : (request.actingUserId ?? caller);
			const audience =
				actingUserId !== undefined &&
				(request.audience ?? (deployment.personal === true ? "private" : "shared")) === "private"
					? ({ kind: "private", userId: actingUserId } as const)
					: ({ kind: "shared" } as const);
			const scope: ConnectionSessionScope = {
				organisationId: ctx.organisationId,
				...(request.projectId === undefined || request.projectId === "" ? {} : { projectId: request.projectId }),
				sessionId: request.sessionId ?? "",
				agentId: request.agentId ?? "",
				...(actingUserId === undefined ? {} : { actingUserId }),
				audience,
			};
			const kind: ConnectionUseKind =
				mcpUrl === undefined ? "http" : request.tool === undefined || request.tool === "" ? "mcp_tools" : "mcp_call";
			const rules = await ensureRules(connection, "migrated");
			return decideUse(
				connection,
				rules,
				await ceilingFor(options.ceiling, connection.organisationId),
				scope,
				{
					kind,
					method: kind === "http" ? request.method : "POST",
					url,
					...(kind === "mcp_call" ? { tool: request.tool as string } : {}),
				},
				{ now: clock.now(), allowHttp },
			);
		},

		async getCeiling(ctx) {
			if (ctx.actor.kind !== "system")
				await access().require(ctx, { needed: "viewer", operation: "connections.getCeiling" });
			return ceilingFor(options.ceiling, ctx.organisationId);
		},

		async setCeiling(ctx, routes) {
			forbidAgent(ctx);
			await access().require(ctx, { needed: "admin", operation: "connections.setCeiling" });
			if (options.ceiling === undefined) {
				throw new KantelError("not_supported", "This deployment keeps no ceiling for connections");
			}
			validateRoutes(routes);
			const saved = await options.ceiling.set(ctx, routes);
			return { set: true, routes: saved };
		},

		// The agent side.

		async usable(ctx, scope) {
			await requireSystem(ctx, "connections.usable");
			return usableIn(scope);
		},

		async egressEnvironment(ctx, session) {
			await requireSystem(ctx, "connections.egress");
			const scope = await egressScope(session).catch(() => undefined);
			if (scope === undefined) return {};
			const env: Record<string, string> = {};
			for (const connection of await usableIn(scope)) {
				if (connection.env !== undefined && connection.placeholder !== undefined) {
					env[connection.env] = connection.placeholder;
				}
			}
			return env;
		},

		async egress(ctx, session, request) {
			await requireSystem(ctx, "connections.egress");
			return egress(session, request, ctx.signal);
		},

		async send(ctx, scope, connectionId, request: ConnectionRequest) {
			await requireSystem(ctx, "connections.send");
			const { url, approval } = await usableConnection(
				scope,
				connectionId,
				{
					kind: request.kind,
					method: request.method,
					url: request.url,
					...(request.tool === undefined ? {} : { tool: request.tool }),
					...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
				},
				{
					...(request.headers === undefined ? {} : { headers: request.headers }),
					// A GET or HEAD sends no body, so none is approved.
					...(request.body === undefined || request.method === "GET" || request.method === "HEAD"
						? {}
						: { body: request.body }),
				},
			);
			return deliver(connectionId, scope, url, request, `${request.method} ${url.hostname}${url.pathname}`, approval);
		},

		async approvalStatus(ctx, scope, approvalId) {
			await requireSystem(ctx, "connections.approvalStatus");
			if (options.approvals === undefined) throw new KantelError("not_found", `No approval ${approvalId}`);
			const result = await options.approvals.connectionApproval(SELF, {
				op: "status",
				organisationId: scope.organisationId,
				proposalId: approvalId,
			});
			if (result.outcome !== "status") throw new KantelError("unavailable", "The vault gave no approval status");
			const { requester } = result.proposal;
			if (requester.sessionId !== scope.sessionId || requester.agentId !== scope.agentId) {
				throw new KantelError("not_found", `No approval ${approvalId}`);
			}
			return result.proposal;
		},

		async listTools(ctx, scope, connectionId, step = {}) {
			await requireSystem(ctx, "connections.listTools");
			const found = await connectionRecord(connectionId).catch(() => undefined);
			const mcpUrl = found?.value.connection.mcp?.url;
			if (found === undefined || found.organisationId !== scope.organisationId)
				throw new KantelError("not_found", `No connection ${connectionId}`);
			if (mcpUrl === undefined) throw new KantelError("invalid", `${found.value.connection.name} is not an MCP server`);
			const { url, approval } = await usableConnection(
				scope,
				connectionId,
				{
					kind: "mcp_tools",
					method: "POST",
					url: mcpUrl,
					...(step.toolCallId === undefined ? {} : { toolCallId: step.toolCallId }),
				},
				{ headers: { "content-type": "application/json" }, body: stableJson({ method: "tools/list" }) },
			);
			const listed = await listMcpTools(mcpPost(connectionId, scope, url, "tools/list", approval));
			// The tools it annotates get their defaults (#332): read-only allow, destructive deny.
			await seedToolDefaults(found.value.connection, listed);
			return listed;
		},

		async callTool(ctx, scope, connectionId, call) {
			await requireSystem(ctx, "connections.callTool");
			const found = await connectionRecord(connectionId).catch(() => undefined);
			const mcpUrl = found?.value.connection.mcp?.url;
			if (found === undefined || found.organisationId !== scope.organisationId)
				throw new KantelError("not_found", `No connection ${connectionId}`);
			if (mcpUrl === undefined) throw new KantelError("invalid", `${found.value.connection.name} is not an MCP server`);
			if (typeof call.name !== "string" || call.name.length === 0)
				throw new KantelError("invalid", "Name the tool to call");
			// What an approval of a tool call covers: the tool and its arguments, not the JSON-RPC envelope around them,
			// whose IDs change from one send to the next.
			const { url, approval } = await usableConnection(
				scope,
				connectionId,
				{
					kind: "mcp_call",
					method: "POST",
					url: mcpUrl,
					tool: call.name,
					...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
				},
				{
					headers: { "content-type": "application/json" },
					body: stableJson({ name: call.name, arguments: call.arguments ?? {} }),
				},
			);
			return callMcpTool(
				mcpPost(connectionId, scope, url, `tools/call ${call.name}`, approval),
				call.name,
				call.arguments,
			);
		},
	};
	return service;
}
