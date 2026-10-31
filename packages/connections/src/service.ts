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
	type ConnectionDecision,
	type ConnectionOwner,
	type ConnectionRequest,
	type ConnectionResponse,
	type ConnectionRule,
	type ConnectionRuleInput,
	type ConnectionSessionScope,
	type Connections,
	type ConnectionUsage,
	type ConnectionUse,
	type ConnectionUseKind,
	type ConnectKeyInput,
	type CreateOAuthClientInput,
	connectionUsableIn,
	decideConnectionRules,
	defaultConnectionUsage,
	defaultRuleInputs,
	type GitHubAppInfo,
	type GitHubAppSetup,
	HarbourError,
	type HttpMethod,
	isHarbourError,
	type JsonValue,
	type KeyInjection,
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
	requireSystem,
	type StartConnectInput,
	type SystemContext,
	systemClock,
	systemContext,
	type UsableConnection,
} from "@harbour/contracts";
import { buildCatalogue, templateById, templateForMcpUrl } from "./catalogue.ts";
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
	randomToken,
	registerClient,
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
	newRule,
	readRules,
	validateRoutes,
} from "./rules.ts";

/** How long a connect URL and its state stay usable. */
export const ATTEMPT_TTL_MS = 15 * 60 * 1000;
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
	 * Approvals bound to the exact request (#333), kept in the vault (`connectionApproval`). A rule's `ask` freezes the
	 * request there and refuses it as `approval_pending` until a person approves it. Without them an `ask` is refused.
	 */
	readonly approvals?: ConnectionApprovals;
}

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
	/** The deployment's client ID metadata document, served without signing in. */
	clientMetadata(): Record<string, unknown>;
	/** The callback URL every provider redirects to. */
	readonly redirectUri: string;
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
	};
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
	if (isHarbourError(error)) return true;
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
	if (!Number.isInteger(start) || start < 0) throw new HarbourError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

const hostOf = (url: string) => new URL(url).hostname.toLowerCase();
const last4 = (value: string) => (value.length > 8 ? value.slice(-4) : undefined);

/** Header names a tool may not set: the credential goes on here, and hop-by-hop headers are the fetch's. */
const DROPPED_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"host",
	"content-length",
	"connection",
	"transfer-encoding",
]);

/** A key is a non-empty string long enough to find and cut out of an answer that echoes it. */
function checkKey(value: unknown): void {
	if (typeof value !== "string" || value.trim().length === 0) throw new HarbourError("invalid", "The key is empty");
	if (value.trim().length < 8) throw new HarbourError("invalid", "The key is shorter than 8 characters");
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
	if (typeof usage !== "object" || usage === null) throw new HarbourError("invalid", "A usage is an object");
	if (typeof usage.unattended !== "boolean")
		throw new HarbourError("invalid", "A usage says whether unattended sessions may use it");
	if (usage.visibility !== "private" && usage.visibility !== "shared") {
		throw new HarbourError("invalid", "A usage's visibility is private or shared");
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
	if (!ok) throw new HarbourError("invalid", "The key's injection is incomplete");
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
	const { repository: repo, credentials, deployment } = options;
	const clock = options.clock ?? systemClock;
	const fetch: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const access = (): ProjectAccess => (typeof options.access === "function" ? options.access() : options.access);
	const newId = options.newId ?? ((prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`);
	const catalogue = buildCatalogue(options.templates);
	const allowHttp = options.allowInsecureUrls === true;
	const origin = deployment.origin.replace(/\/+$/, "");
	const redirectUri = `${origin}/v1/connections/callback`;
	const cimdClientId = `${origin}/v1/connections/oauth/client-metadata.json`;
	const clientName = deployment.clientName ?? "Harbour";
	const platformClients = deployment.platformClients ?? [];
	const refreshing = new Map<string, Promise<void>>();

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
		if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", MANAGE_REFUSAL);
	};

	const sameOrganisation = (ctx: CallContext, owner: OwnerRef) => {
		const organisation = ownerOrganisation(owner);
		if (organisation !== undefined && organisation !== ctx.organisationId) {
			throw new HarbourError("invalid", "The owner must be in the caller's organisation");
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
		if (found === undefined) throw new HarbourError("not_found", `No template ${id}`);
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
		throw new HarbourError(
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
				throw new HarbourError("invalid", "One of the scope sets is not the template's");
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
				},
			};
		}

		const url = mcpUrl ?? entry?.mcp?.url;
		if (url === undefined) throw new HarbourError("invalid", "Give a template with OAuth, or an MCP server's URL");
		let discovered: Awaited<ReturnType<typeof discoverMcpAuth>>;
		try {
			discovered = await discoverMcpAuth(fetch, url, { allowHttp });
		} catch (error) {
			if (isHarbourError(error, "invalid")) throw error;
			return fail("discovery_failed", `Harbour could not reach the MCP server at ${hostOf(url)}`);
		}
		const host = hostOf(discovered.url);
		const hosts = entry?.apiHosts ?? [host];
		if (discovered.auth === "none") {
			return { open: { hosts, ...(discovered.resource === undefined ? {} : { resource: discovered.resource }) } };
		}
		const server = discovered.server;
		if (server === undefined)
			return fail("discovery_failed", `The MCP server at ${host} named no authorisation server Harbour could read`);
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
				return fail(
					"registration_failed",
					isHarbourError(error) ? error.message : "Dynamic client registration failed",
				);
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
			},
		};
	};

	// Connections.

	const connectionRecord = async (connectionId: string): Promise<StoredRecord<StoredConnection>> => {
		const found = await repo.get<StoredConnection>("connection", connectionId);
		if (found === undefined) throw new HarbourError("not_found", `No connection ${connectionId}`);
		return found;
	};

	const visibleConnection = async (ctx: CallContext, connectionId: string): Promise<StoredRecord<StoredConnection>> => {
		const found = await repo.get<StoredConnection>("connection", connectionId);
		if (
			found === undefined ||
			found.organisationId !== ctx.organisationId ||
			!(await canView(ctx, found.value.connection.owner))
		) {
			throw new HarbourError("not_found", `No connection ${connectionId}`);
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
		throw new HarbourError("conflict", `Connection ${connectionId} changed while it was being updated; try again`);
	};

	const saveNewConnection = async (stored: StoredConnection): Promise<void> => {
		const inserted = await repo.insert("connection", {
			id: stored.connection.id,
			organisationId: stored.connection.organisationId,
			key: `${stored.connection.owner.kind}:${stored.connection.owner.kind === "organisation" ? stored.connection.owner.organisationId : stored.connection.owner.kind === "project" ? stored.connection.owner.projectId : stored.connection.owner.userId}`,
			value: stored,
			createdAt: stored.connection.createdAt,
		});
		if (!inserted) throw new HarbourError("conflict", "That connection ID is taken");
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
					credential,
					updatedAt: now,
				},
			}));
			for (const ref of [previous.value.secrets.access, previous.value.secrets.refresh]) {
				if (ref !== undefined) await credentials.remove(ref).catch(() => undefined);
			}
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
			credential,
			createdBy: attempt.createdBy,
			createdAt: now,
			updatedAt: now,
		};
		await saveNewConnection({ connection, secrets: { access, ...(refresh === undefined ? {} : { refresh }) }, oauth });
		return connection;
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
				headers: { accept: "application/json", "user-agent": "Harbour", ...injected.headers },
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
		if (found === undefined) throw new HarbourError("not_found", `No connect attempt ${attemptId}`);
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
		throw new HarbourError("conflict", `Connect attempt ${attemptId} changed while it was being settled`);
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
				const message = isHarbourError(error) ? error.message : "Harbour could not store the connection";
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
			readonly outcome: "allowed" | "denied";
			readonly reason?: string;
			readonly decision?: ConnectionDecision;
			readonly approval?: ConnectionUse["approval"];
		},
	): Promise<void> => {
		const decision = use.decision;
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
				type: use.outcome === "allowed" ? "connections.use.allowed" : "connections.use.denied",
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

	/** Refreshes an OAuth connection's access token, once at a time per connection in this process. */
	const refresh = async (connectionId: string, force: boolean): Promise<void> => {
		const running = refreshing.get(connectionId);
		if (running !== undefined) return running;
		const work = (async () => {
			const found = await connectionRecord(connectionId);
			const stored = found.value;
			const { connection, oauth, secrets } = stored;
			if (oauth === undefined || secrets.refresh === undefined) return;
			const buffer = (oauth.refreshBufferSeconds ?? 60) * 1000;
			const due =
				connection.credential.expiresAt !== undefined && clock.now() >= connection.credential.expiresAt - buffer;
			if (!force && !due) return;
			const refreshToken = await credentials.open({
				ref: secrets.refresh,
				host: hostOf(oauth.tokenUrl),
				organisationId: connection.organisationId,
				purpose: `connection ${connection.id}: refresh`,
			});
			let tokens: TokenSet;
			try {
				tokens = await tokenRequest(
					fetch,
					oauth.tokenUrl,
					await tokenClient(oauth.client, oauth.tokenUrl, connection.organisationId),
					{
						grant_type: "refresh_token",
						refresh_token: refreshToken,
						...(oauth.resource === undefined ? {} : { resource: oauth.resource }),
					},
					{ allowHttp, now: clock.now() },
				);
			} catch (error) {
				if (isHarbourError(error, "refused")) {
					// Another gateway may have refreshed first with the same refresh token, which a rotating server then
					// refuses from us: if the stored token has moved on since we read it, the connection is fine.
					const latest = (await connectionRecord(connectionId)).value.connection.credential;
					if (latest.updatedAt !== connection.credential.updatedAt) return;
					await changeConnection(connectionId, (current) => ({
						...current,
						connection: { ...current.connection, status: "needs_reauth", updatedAt: clock.now() },
					}));
					await audit(
						SELF,
						connection.organisationId,
						connectionEvent("connections.connection.needs_reauth", connection),
					);
				}
				throw error;
			}
			await credentials.replace(secrets.access!, tokens.accessToken);
			if (tokens.refreshToken !== undefined && tokens.refreshToken !== refreshToken) {
				await credentials.replace(secrets.refresh, tokens.refreshToken);
			}
			await changeConnection(connectionId, (current) => ({
				...current,
				connection: {
					...current.connection,
					status: current.connection.status === "disabled" ? "disabled" : "active",
					credential: {
						...current.connection.credential,
						...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
						updatedAt: clock.now(),
					},
					updatedAt: clock.now(),
				},
			}));
			await audit(SELF, connection.organisationId, connectionEvent("connections.connection.refreshed", connection));
		})();
		refreshing.set(connectionId, work);
		try {
			await work;
		} finally {
			refreshing.delete(connectionId);
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
		},
		exact: { readonly headers?: { readonly [name: string]: string }; readonly body?: string } = {},
	): Promise<{ readonly stored: StoredConnection; readonly url: URL; readonly approval?: UsedApproval }> => {
		const found = await repo.get<StoredConnection>("connection", connectionId);
		if (found === undefined || found.organisationId !== scope.organisationId) {
			throw new HarbourError("not_found", `No connection ${connectionId}`);
		}
		const { connection } = found.value;
		let url: URL;
		try {
			url = new URL(use.url);
		} catch {
			throw new HarbourError("invalid", "The request's URL is not a URL");
		}
		const ceiling = await ceilingFor(options.ceiling, connection.organisationId);
		// A rule with a use limit is spent as it allows; a race that used it up first decides again.
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const { rules } = await readRules(repo, connectionId);
			const decision = decideUse(connection, rules, ceiling, scope, { ...use, url }, { now: clock.now(), allowHttp });
			const denied = async (reason: string, code: "forbidden" | "refused"): Promise<never> => {
				await recordUse(connection, scope, {
					...use,
					url,
					outcome: "denied",
					reason,
					...(decision.by.kind === "usage" || decision.by.kind === "connection" ? {} : { decision }),
				});
				throw new HarbourError(code, reason);
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
		throw new HarbourError("conflict", `The rules on ${connection.name} kept changing; try again`);
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
		},
		exact: { readonly headers?: { readonly [name: string]: string }; readonly body?: string },
		decision: ConnectionDecision,
	): Promise<{ readonly stored: StoredConnection; readonly url: URL; readonly approval?: UsedApproval }> => {
		const { connection } = stored;
		const { url } = use;
		const approvals = options.approvals;
		if (approvals === undefined) {
			const reason = `${decision.reason}: someone must approve it, and this deployment has no approvals`;
			await recordUse(connection, scope, { ...use, outcome: "denied", reason, decision });
			throw new HarbourError("refused", reason);
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
				url: url.href,
				...(exact.headers === undefined ? {} : { headers: sentHeaders(exact.headers) }),
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
		if (result.outcome !== "pending") throw new HarbourError("unavailable", "The vault gave no approval answer");
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
		await recordUse(connection, scope, {
			...use,
			outcome: "denied",
			reason,
			decision,
			approval: { id: proposal.id, digest: result.digest, state: "pending" },
		});
		throw new HarbourError(
			"refused",
			`approval_pending: ${connection.name} needs a person to approve this exact request. Nothing was sent. ` +
				`Approval ${proposal.id}, code ${proposal.bindingCode}: ${pending.link}. Once it is approved, send the ` +
				"identical request again; any change to it needs a new approval.",
			{ ...pending },
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
		const { connection, secrets, injection } = (await connectionRecord(connectionId)).value;
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(request.headers ?? {})) {
			if (!DROPPED_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
		}
		const target = new URL(url.href);
		const secretsSeen: string[] = [];
		const ref = connection.auth === "oauth2" ? secrets.access : connection.auth === "key" ? secrets.key : undefined;
		if (connection.auth === "oauth2") await refresh(connectionId, false).catch(() => undefined);
		if (ref !== undefined) {
			const value = await credentials.open({
				ref,
				host: target.hostname.toLowerCase(),
				organisationId: connection.organisationId,
				scope,
				purpose: `connection ${connection.id}: ${purpose}`,
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
			if (injected.query !== undefined) target.searchParams.set(injected.query[0], injected.query[1]);
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
			// Nothing reached the upstream (no name, no connection, no TLS): an approval this request used is given back.
			if (notConnected(error)) await releaseApproval(connection.organisationId, approval);
			throw new HarbourError("unavailable", `${target.hostname} did not answer`);
		}
		if (response.status === 401 && connection.auth === "oauth2" && secrets.refresh !== undefined && !retried) {
			await response.body?.cancel().catch(() => undefined);
			await refresh(connectionId, true);
			return deliver(connectionId, scope, url, request, purpose, approval, true);
		}
		if (response.status === 401 && connection.auth === "oauth2") {
			await changeConnection(connectionId, (current) =>
				current.connection.status === "active"
					? { ...current, connection: { ...current.connection, status: "needs_reauth", updatedAt: clock.now() } }
					: undefined,
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
			throw new HarbourError(
				"unavailable",
				"Harbour could not find the provider's token endpoint to bind the secret to",
			);
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

	/** The template's default rules for a connection: its endpoint hints, reads allow and writes ask. */
	const defaultRulesFor = (connection: Connection): ConnectionRuleInput[] => {
		if (connection.kind !== "http" || connection.templateId === undefined) return [];
		return defaultRuleInputs(templateById(catalogue, connection.templateId)?.endpointHints);
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
		if (answer.outcome !== "status") throw new HarbourError("unavailable", "The vault gave no approval answer");
		const { proposal } = answer;
		const request = proposal.terms.request;
		if (request === undefined || request.connectionId !== connectionId) {
			throw new HarbourError("refused", `Approval ${approvalId} is not for a request through this connection`);
		}
		if (proposal.status !== "pending" && proposal.status !== "approved") {
			throw new HarbourError("refused", `Approval ${approvalId} was ${proposal.status}, so it can't become a rule`);
		}
		if (input?.action !== "allow") throw new HarbourError("invalid", "Always allow saves an allow rule");
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
			throw new HarbourError("refused", "This rule doesn't cover the request it is saved from");
		}
	};

	const service: ConnectionsService = {
		redirectUri,

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
				if (await canView(ctx, connection.owner)) out.push(connection);
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
				throw new HarbourError("invalid", "A connection needs a name");
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
										: current.connection.credential.set
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
			await requireManage(ctx, found.value.connection.owner, "connections.remove", connectionId);
			for (const ref of Object.values(found.value.secrets)) if (ref !== undefined) await credentials.remove(ref);
			await repo.remove("connection", connectionId);
			await audit(ctx, ctx.organisationId, connectionEvent("connections.connection.removed", found.value.connection));
		},

		// OAuth connect.

		async startConnect(ctx, input) {
			forbidAgent(ctx);
			if ((input.templateId === undefined) === (input.mcpUrl === undefined) && input.connectionId === undefined) {
				throw new HarbourError("invalid", "Give a template or an MCP server's URL");
			}
			if (input.usage !== undefined) validateUsage(input.usage);
			await requireManage(ctx, input.owner, "connections.connect");
			let start = input;
			if (input.connectionId !== undefined) {
				const previous = await visibleConnection(ctx, input.connectionId);
				const connection = previous.value.connection;
				if (!sameOwner(connection.owner, input.owner))
					throw new HarbourError("invalid", "A reconnect keeps the connection's owner");
				start = {
					...input,
					...(connection.templateId === undefined ? {} : { templateId: connection.templateId }),
					...(connection.mcp === undefined || connection.templateId !== undefined
						? {}
						: { mcpUrl: connection.mcp.url }),
				};
			}
			const forUserId = start.forUserId ?? (ctx.actor.kind === "human" ? ctx.actor.userId : undefined);
			if (forUserId === undefined) throw new HarbourError("invalid", "Name the person who will sign in (forUserId)");
			if (start.owner.kind === "user" && forUserId !== start.owner.userId) {
				throw new HarbourError("invalid", "A person's own connection is signed in by that person");
			}
			if (start.returnTo !== undefined && !start.returnTo.startsWith("/") && !start.returnTo.startsWith("https://")) {
				throw new HarbourError("invalid", "returnTo is a path on this deployment or an https URL");
			}
			const entry = start.templateId === undefined ? undefined : template(start.templateId);
			if (entry !== undefined && !entry.authTypes.includes("oauth2") && !entry.authTypes.includes("none")) {
				throw new HarbourError("invalid", `${entry.name} connects with a key: use POST /v1/connections/keys`);
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
					if (isHarbourError(error, "unavailable") || isHarbourError(error, "invalid")) throw error;
					return fail("exchange_failed", isHarbourError(error) ? error.message : "The device sign-in could not start");
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
				throw new HarbourError("not_found", `No connect attempt ${attemptId}`);
			const mine =
				(ctx.actor.kind === "human" &&
					(attempt.forUserId === ctx.actor.userId ||
						(attempt.createdBy.kind === "human" && attempt.createdBy.userId === ctx.actor.userId))) ||
				(ctx.actor.kind === "service" &&
					attempt.createdBy.kind === "service" &&
					attempt.createdBy.serviceId === ctx.actor.serviceId);
			if (!mine && !(await canView(ctx, attempt.owner)))
				throw new HarbourError("not_found", `No connect attempt ${attemptId}`);
			// A device-flow sign-in has no callback: asking after the attempt is what asks the provider.
			if (found.value.device !== undefined) return attemptView(await pollDevice(found));
			return attemptView(found.value);
		},

		async authorize(ctx, attemptId) {
			if (ctx.actor.kind !== "human") throw new HarbourError("forbidden", "A person opens a connect link");
			const found = await attemptRecord(attemptId);
			if (found.organisationId !== ctx.organisationId)
				throw new HarbourError("not_found", `No connect attempt ${attemptId}`);
			const view = attemptView(found.value);
			if (view.status !== "pending")
				throw new HarbourError(
					view.status === "expired" ? "expired" : "conflict",
					`This connect link is ${view.status}`,
				);
			if (view.forUserId !== undefined && view.forUserId !== ctx.actor.userId) {
				await failAttempt(attemptId, "user_mismatch", "Someone other than the person it was made for opened the link");
				throw new HarbourError("forbidden", "This connect link was made for someone else");
			}
			const plan = found.value.plan;
			if (plan === undefined) throw new HarbourError("conflict", "This connect needs no sign-in");
			if (found.value.device !== undefined) {
				throw new HarbourError("conflict", "This connect signs in with a code at the provider, not a link");
			}
			if (found.value.exchanging === true) throw new HarbourError("conflict", "This connect is finishing");
			const state = randomToken(32);
			const pkce = await pkcePair();
			await settleAttempt(
				attemptId,
				(stored) => {
					if (stored.exchanging === true) throw new HarbourError("conflict", "This connect is finishing");
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
				throw new HarbourError("invalid", "The provider sent no state");
			}
			const found = await repo.findByKey<StoredAttempt>("attempt", await sha256(callback.state));
			if (found === undefined)
				throw new HarbourError("refused", "This sign-in link is used up or unknown", { failure: "invalid_state" });
			const attemptId = found.id;
			// Use the state up first: whatever happens next, it never works twice.
			if (!(await repo.update("attempt", attemptId, found.revision, { ...found.value, exchanging: true }, null))) {
				throw new HarbourError("refused", "This sign-in link is used up", { failure: "invalid_state" });
			}
			const stored = found.value;
			const view = attemptView(stored);
			if (view.status !== "pending") {
				throw new HarbourError("refused", `This connect is ${view.status}`, { failure: "invalid_state" });
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
				throw new HarbourError("forbidden", "This sign-in was for someone else; nothing was stored", {
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
				const message = isHarbourError(error) ? error.message : "The token exchange failed";
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
				if (entry.key === undefined) throw new HarbourError("invalid", `${entry.name} does not connect with a key`);
				hosts = entry.apiHosts;
				injection = entry.key.injection;
				kind = entry.kind;
				mcpUrl = entry.mcp?.url;
			} else if (input.custom !== undefined) {
				hosts = input.custom.hosts.map((host) => host.trim().toLowerCase());
				if (hosts.length === 0 || hosts.some((host) => !/^[a-z0-9.-]+$/.test(host) || !host.includes("."))) {
					throw new HarbourError("invalid", "Give the https hosts the key may be sent to, as plain host names");
				}
				assertInjection(input.custom.injection);
				injection = input.custom.injection;
				kind = input.custom.kind;
				if (kind === "mcp") {
					if (input.custom.mcpUrl === undefined)
						throw new HarbourError("invalid", "An MCP key connection needs the server's URL");
					mcpUrl = publicUrl(input.custom.mcpUrl, "The MCP server's URL", allowHttp).href;
					if (!hosts.includes(hostOf(mcpUrl)))
						throw new HarbourError("invalid", "The MCP server's host must be one of the hosts");
				}
			} else {
				throw new HarbourError("invalid", "Give a template or a custom service");
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
			await saveNewConnection({ connection, secrets: { key }, injection });
			await audit(ctx, ctx.organisationId, connectionEvent("connections.connection.created", connection));
			return connection;
		},

		async rotateKey(ctx, connectionId, input) {
			const found = await visibleConnection(ctx, connectionId);
			await requireManage(ctx, found.value.connection.owner, "connections.rotateKey", connectionId);
			if (found.value.connection.auth !== "key" || found.value.secrets.key === undefined) {
				throw new HarbourError("invalid", "Only a key connection has a key to replace");
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
				throw new HarbourError("not_found", `No OAuth client ${oauthClientId}`);
			}
			return clientView(found.value);
		},

		async createClient(ctx, input) {
			if (input.owner.kind === "platform") {
				throw new HarbourError("refused", "The deployment's OAuth clients come from its configuration");
			}
			await requireManage(ctx, input.owner, "connections.createClient");
			if ((input.templateId === undefined) === (input.issuer === undefined)) {
				throw new HarbourError("invalid", "An OAuth client is for a template or an authorisation server's issuer");
			}
			if (input.label.trim() === "" || input.clientId.trim() === "")
				throw new HarbourError("invalid", "Give a label and a client ID");
			let tokenUrl: string | undefined;
			if (input.templateId !== undefined) {
				const entry = template(input.templateId);
				if (entry.oauth === undefined) throw new HarbourError("invalid", `${entry.name} has no OAuth`);
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
				throw new HarbourError("not_found", `No OAuth client ${oauthClientId}`);
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
					throw new HarbourError(
						"unavailable",
						"Harbour does not know the provider's token endpoint to bind the secret to",
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
				throw new HarbourError("conflict", "The OAuth client changed while it was being updated; try again");
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
				throw new HarbourError("not_found", `No OAuth client ${oauthClientId}`);
			}
			await requireManage(ctx, found.value.client.owner, "connections.removeClient");
			const view = await clientView(found.value);
			if (view.connections > 0) {
				throw new HarbourError(
					"conflict",
					`${view.connections} connection(s) are pinned to this client; remove or reconnect them first`,
				);
			}
			if (found.value.secretRef !== undefined) await credentials.remove(found.value.secretRef);
			await repo.remove("client", oauthClientId);
		},

		// GitHub App manifest flow.

		async startGitHubApp(ctx, input) {
			if (ctx.actor.kind !== "human") throw new HarbourError("forbidden", "A person sets up a GitHub App");
			const userId = ctx.actor.userId;
			let owner: ConnectionOwner;
			switch (input.owner) {
				case "organisation":
					owner = { kind: "organisation", organisationId: ctx.organisationId };
					break;
				case "project":
					if (typeof input.projectId !== "string" || input.projectId === "") {
						throw new HarbourError("invalid", "A project's GitHub App needs the project (projectId)");
					}
					owner = { kind: "project", organisationId: ctx.organisationId, projectId: input.projectId };
					break;
				case "user":
					owner = { kind: "user", organisationId: ctx.organisationId, userId };
					break;
				default:
					throw new HarbourError("invalid", "A GitHub App is your organisation's, a project's or your own");
			}
			if (input.githubOrganisation !== undefined && !GITHUB_LOGIN.test(input.githubOrganisation)) {
				throw new HarbourError("invalid", "That is not a GitHub organisation's name");
			}
			if (input.returnTo !== undefined && !input.returnTo.startsWith("/") && !input.returnTo.startsWith("https://")) {
				throw new HarbourError("invalid", "returnTo is a path on this deployment or an https URL");
			}
			if (input.returnTo?.startsWith("//") === true) {
				throw new HarbourError("invalid", "returnTo is a path on this deployment or an https URL");
			}
			const github = template(GITHUB_TEMPLATE);
			if (github.oauth?.tokenUrl === undefined) throw new HarbourError("unavailable", "GitHub's template has no OAuth");
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
			// The only time the state leaves Harbour's hands: in this URL, to the person who started the flow.
			return {
				...stored.setup,
				url: `${origin}/v1/connections/github-app/${encodeURIComponent(id)}/start?state=${encodeURIComponent(state)}`,
			};
		},

		async getGitHubApp(ctx, setupId) {
			const found = await repo.get<StoredGitHubApp>("github_app", setupId);
			if (found === undefined || found.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No GitHub App setup ${setupId}`);
			}
			const creator = found.value.createdBy;
			const mine = ctx.actor.kind === "human" && creator.kind === "human" && creator.userId === ctx.actor.userId;
			if (!mine && !(await canView(ctx, found.value.owner))) {
				throw new HarbourError("not_found", `No GitHub App setup ${setupId}`);
			}
			return gitHubAppView(found.value);
		},

		async gitHubAppManifestPage(setupId, state) {
			if (typeof state !== "string" || state === "") throw new HarbourError("invalid", "The link has no state");
			const found = await repo.get<StoredGitHubApp>("github_app", setupId);
			if (found === undefined || found.key === undefined || found.key !== (await sha256(state))) {
				throw new HarbourError("refused", "This GitHub App link is used up or unknown");
			}
			const view = gitHubAppView(found.value);
			if (view.status !== "pending") {
				throw new HarbourError(
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
				throw new HarbourError("invalid", "GitHub sent no state");
			}
			const found = await repo.findByKey<StoredGitHubApp>("github_app", await sha256(input.state));
			if (found === undefined) throw new HarbourError("refused", "This GitHub App link is used up or unknown");
			// Use the state up first: whatever happens next, it never works twice.
			if (!(await repo.update("github_app", found.id, found.revision, found.value, null))) {
				throw new HarbourError("refused", "This GitHub App link is used up");
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
				return failed(isHarbourError(error) ? error.message : "GitHub did not hand over the app", "conversion");
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
				return failed("Harbour could not store the app's client", "store");
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
			if (filter.connectionId !== undefined) await visibleConnection(ctx, filter.connectionId);
			const records = await repo.list<ConnectionUse>("use", {
				organisationId: ctx.organisationId,
				...(filter.connectionId === undefined ? {} : { key: filter.connectionId }),
				...(filter.sessionId === undefined ? {} : { ref: filter.sessionId }),
				limit: 5000,
			});
			const out: ConnectionUse[] = [];
			const visible = new Map<string, boolean>();
			for (const record of records) {
				const use = record.value;
				if (filter.connectionId === undefined && filter.sessionId === undefined) {
					let ok = visible.get(use.connectionId);
					if (ok === undefined) {
						const connection = await repo.get<StoredConnection>("connection", use.connectionId);
						ok =
							connection === undefined
								? ctx.actor.kind === "system"
								: await canView(ctx, connection.value.connection.owner);
						visible.set(use.connectionId, ok);
					}
					if (!ok) continue;
				}
				out.push(use);
			}
			return paginate(out, page);
		},

		// Access rules (#332).

		async getRules(ctx, connectionId) {
			await visibleConnection(ctx, connectionId);
			return (await readRules(repo, connectionId)).rules;
		},

		async updateRules(ctx, connectionId, input) {
			const found = await visibleConnection(ctx, connectionId);
			const connection = found.value.connection;
			await requireManage(ctx, connection.owner, "connections.updateRules", connectionId);
			if (input.unmatched !== undefined && !["allow", "ask", "deny"].includes(input.unmatched)) {
				throw new HarbourError("invalid", "Unmatched requests are allowed, asked about or denied");
			}
			if (input.reset !== undefined && input.reset !== "template")
				throw new HarbourError("invalid", "Reset to template");
			const ceiling = await ceilingFor(options.ceiling, connection.organisationId);
			const now = clock.now();
			const defaults =
				input.reset === "template"
					? defaultRulesFor(connection).filter((rule) => {
							try {
								checkRule(connection, rule, ceiling, now);
								return true;
							} catch {
								return false;
							}
						})
					: undefined;
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
							unmatched: "ask",
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
			if (typeof approvalId !== "string" || approvalId === "") throw new HarbourError("invalid", "Name the approval");
			if (options.approvals !== undefined) await checkFromApproval(ctx, connectionId, input, approvalId);
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
				if (rule === undefined) throw new HarbourError("not_found", `No rule ${ruleId} on ${connection.name}`);
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
				if (removed === undefined) throw new HarbourError("not_found", `No rule ${ruleId} on ${connection.name}`);
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
			if (!METHOD_NAMES.includes(request.method)) throw new HarbourError("invalid", "Pick a method");
			const raw = request.url ?? mcpUrl;
			if (raw === undefined || raw === "") throw new HarbourError("invalid", "Give the request's URL");
			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				throw new HarbourError("invalid", "The request's URL is not a URL");
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
			const { rules } = await readRules(repo, connectionId);
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
				throw new HarbourError("not_supported", "This deployment keeps no ceiling for connections");
			}
			validateRoutes(routes);
			const saved = await options.ceiling.set(ctx, routes);
			return { set: true, routes: saved };
		},

		// The agent side.

		async usable(ctx, scope) {
			await requireSystem(ctx, "connections.usable");
			const records = await repo.list<StoredConnection>("connection", { organisationId: scope.organisationId });
			const usable = records
				.map((record) => record.value.connection)
				.filter((connection) => connection.status !== "needs_reauth" && connectionUsableIn(connection, scope).usable)
				.sort((a, b) => CONNECTION_OWNER_ORDER.indexOf(a.owner.kind) - CONNECTION_OWNER_ORDER.indexOf(b.owner.kind));
			return usable.map(
				(connection): UsableConnection => ({
					id: connection.id,
					name: connection.name,
					kind: connection.kind,
					...(connection.templateId === undefined ? {} : { templateId: connection.templateId }),
					owner: connection.owner.kind,
					...(connection.account === undefined ? {} : { account: connection.account }),
					hosts: connection.hosts,
					...(connection.mcp === undefined ? {} : { mcpUrl: connection.mcp.url }),
				}),
			);
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
			if (options.approvals === undefined) throw new HarbourError("not_found", `No approval ${approvalId}`);
			const result = await options.approvals.connectionApproval(SELF, {
				op: "status",
				organisationId: scope.organisationId,
				proposalId: approvalId,
			});
			if (result.outcome !== "status") throw new HarbourError("unavailable", "The vault gave no approval status");
			const { requester } = result.proposal;
			if (requester.sessionId !== scope.sessionId || requester.agentId !== scope.agentId) {
				throw new HarbourError("not_found", `No approval ${approvalId}`);
			}
			return result.proposal;
		},

		async listTools(ctx, scope, connectionId, step = {}) {
			await requireSystem(ctx, "connections.listTools");
			const found = await connectionRecord(connectionId).catch(() => undefined);
			const mcpUrl = found?.value.connection.mcp?.url;
			if (found === undefined || found.organisationId !== scope.organisationId)
				throw new HarbourError("not_found", `No connection ${connectionId}`);
			if (mcpUrl === undefined)
				throw new HarbourError("invalid", `${found.value.connection.name} is not an MCP server`);
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
			return listMcpTools(mcpPost(connectionId, scope, url, "tools/list", approval));
		},

		async callTool(ctx, scope, connectionId, call) {
			await requireSystem(ctx, "connections.callTool");
			const found = await connectionRecord(connectionId).catch(() => undefined);
			const mcpUrl = found?.value.connection.mcp?.url;
			if (found === undefined || found.organisationId !== scope.organisationId)
				throw new HarbourError("not_found", `No connection ${connectionId}`);
			if (mcpUrl === undefined)
				throw new HarbourError("invalid", `${found.value.connection.name} is not an MCP server`);
			if (typeof call.name !== "string" || call.name.length === 0)
				throw new HarbourError("invalid", "Name the tool to call");
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
