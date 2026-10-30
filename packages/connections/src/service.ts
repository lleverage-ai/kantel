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
 * The agent side: `usable` lists what a session may use (`connectionUsableIn`), and `send`, `listTools` and `callTool`
 * make one request through a connection: the use is recorded first, the token refreshed if due, the vault opens the
 * credential for the request's host only, and the answer comes back with the credential cut out.
 */
import {
	type Actor,
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
	type ConnectionOwner,
	type ConnectionRequest,
	type ConnectionResponse,
	type ConnectionSessionScope,
	type Connections,
	type ConnectionUsage,
	type ConnectionUse,
	type ConnectionUseKind,
	type ConnectKeyInput,
	connectionUsableIn,
	defaultConnectionUsage,
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
	type ProviderTemplate,
	requireSystem,
	type StartConnectInput,
	type SystemContext,
	systemClock,
	systemContext,
	type UsableConnection,
} from "@harbour/contracts";
import { buildCatalogue, templateById, templateForMcpUrl } from "./catalogue.ts";
import { callMcpTool, listMcpTools, type McpPost, type McpTool, type McpToolResult } from "./mcp.ts";
import {
	authServerMetadata,
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

/** How long a connect URL and its state stay usable. */
export const ATTEMPT_TTL_MS = 15 * 60 * 1000;
/** The most of a response body a tool gets back. */
export const RESPONSE_LIMIT = 2 * 1024 * 1024;

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
			...(stored.secretRef === undefined ? {} : { secretRef: stored.secretRef }),
			...(stored.client.redirectDomain === undefined ? {} : { redirectUri: redirectUriOf(stored.client) }),
		}) satisfies ClientPlan;

	const clientView = async (stored: StoredClient): Promise<OAuthClient> => {
		const pinned = (
			await repo.list<StoredConnection>("connection", { organisationId: ownerOrganisation(stored.client.owner) ?? "" })
		).filter((record) => record.value.connection.client?.oauthClientId === stored.client.id).length;
		return {
			...stored.client,
			redirectUri: redirectUriOf(stored.client),
			connections: pinned,
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
		createdBy: { kind: "system", component: "deployment" },
		createdAt: 0,
		updatedAt: 0,
	});

	/** The stored clients an owner's connect may use, most specific tier first, for a template or an issuer. */
	const storedClientsFor = async (
		organisationId: string,
		owner: ConnectionOwner,
		match: { readonly templateId?: string; readonly issuer?: string },
	): Promise<StoredClient[]> => {
		const all = (await repo.list<StoredClient>("client", { organisationId })).map((record) => record.value);
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

	/** Whether any client resolves for a template for this owner, and if not who could register one. */
	const setupOf = async (
		ctx: CallContext,
		entry: ProviderTemplate,
	): Promise<Pick<CatalogueEntry, "setup" | "clientTiers">> => {
		if (!entry.authTypes.includes("oauth2") || entry.oauth === undefined) return { setup: "ready" };
		const registration = entry.oauth.registration;
		if (registration.includes("dcr")) return { setup: "ready" };
		if (registration.includes("cimd") && deployment.clientMetadataPublic) return { setup: "ready" };
		if (platformClientFor({ templateId: entry.id }) !== undefined) return { setup: "ready" };
		const owner: ConnectionOwner =
			ctx.actor.kind === "human"
				? { kind: "user", organisationId: ctx.organisationId, userId: ctx.actor.userId }
				: { kind: "organisation", organisationId: ctx.organisationId };
		if ((await storedClientsFor(ctx.organisationId, owner, { templateId: entry.id })).length > 0)
			return { setup: "ready" };
		return { setup: "needs_client", clientTiers: ["platform", "organisation", "project", "user"] };
	};

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
				client = { via: "client", clientId: platform.clientId, tier: "platform", platform: true };
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
				client = { via: "client", clientId: platform.clientId, tier: "platform", platform: true };
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
			const { connectUrl: _url, ...rest } = attempt;
			return { ...rest, status: "expired" };
		}
		return attempt;
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
		settleAttempt(attemptId, (stored) => {
			const { connectUrl: _url, ...rest } = stored.attempt;
			const { verifier: _verifier, ...keep } = stored;
			return { ...keep, attempt: { ...rest, status: "failed", failure: { code, message }, completedAt: clock.now() } };
		});

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
		},
	): Promise<void> => {
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

	/** The connection a session may use, or a recorded refusal. */
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
	): Promise<{ readonly stored: StoredConnection; readonly url: URL }> => {
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
		const denied = async (reason: string, code: "forbidden" | "refused" = "forbidden"): Promise<never> => {
			await recordUse(connection, scope, { ...use, url, outcome: "denied", reason });
			throw new HarbourError(code, reason);
		};
		const usable = connectionUsableIn(connection, scope);
		if (!usable.usable) return denied(`Connection ${connection.name} can't be used here: ${usable.reason}`);
		if (connection.status === "needs_reauth")
			return denied(`Connection ${connection.name} needs someone to connect it again`, "refused");
		if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
			return denied("A connection only sends over https", "refused");
		if (!connection.hosts.includes(url.hostname.toLowerCase())) {
			return denied(
				`Connection ${connection.name} is not for ${url.hostname}; it is for ${connection.hosts.join(", ")}`,
				"refused",
			);
		}
		await recordUse(connection, scope, { ...use, url, outcome: "allowed" });
		return { stored: found.value, url };
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
		} catch {
			throw new HarbourError("unavailable", `${target.hostname} did not answer`);
		}
		if (response.status === 401 && connection.auth === "oauth2" && secrets.refresh !== undefined && !retried) {
			await response.body?.cancel().catch(() => undefined);
			await refresh(connectionId, true);
			return deliver(connectionId, scope, url, request, purpose, true);
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
		(connectionId: string, scope: ConnectionSessionScope, url: URL, purpose: string): McpPost =>
		async (body, headers) =>
			deliver(connectionId, scope, url, { method: "POST", headers, body }, purpose);

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
					...(await setupOf(ctx, entry)),
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
			const attempt: ConnectAttempt = {
				...base,
				status: "pending",
				connectUrl: `${origin}/v1/connections/authorize/${id}`,
			};
			const stored: StoredAttempt = {
				attempt,
				input: start,
				plan: planned.plan!,
				...(start.returnTo === undefined ? {} : { returnTo: start.returnTo }),
			};
			await repo.insert("attempt", { id, organisationId: ctx.organisationId, value: stored, createdAt: now });
			await audit(ctx, ctx.organisationId, {
				type: "connections.connect.started",
				...(start.owner.kind === "project" ? { projectId: start.owner.projectId } : {}),
				subject: { kind: "connections.attempt", id },
				data: {
					owner: start.owner.kind,
					client: planned.plan!.client.via,
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
			const connection = await storeTokens(stored, plan, tokens, ctx.actor);
			const done = await settleAttempt(attemptId, (current) => {
				const { connectUrl: _url, ...rest } = current.attempt;
				const { verifier: _verifier, ...keep } = current;
				return {
					...keep,
					attempt: { ...rest, status: "completed", connectionId: connection.id, completedAt: clock.now() },
				};
			});
			await audit(
				ctx,
				connection.organisationId,
				connectionEvent(
					stored.input.connectionId === undefined
						? "connections.connection.created"
						: "connections.connection.reconnected",
					connection,
					{ client: plan.client.via },
				),
			);
			return attemptView(done);
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
				},
			});
			return clientView(stored);
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
			const { url } = await usableConnection(scope, connectionId, {
				kind: request.kind,
				method: request.method,
				url: request.url,
				...(request.tool === undefined ? {} : { tool: request.tool }),
				...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
			});
			return deliver(connectionId, scope, url, request, `${request.method} ${url.hostname}${url.pathname}`);
		},

		async listTools(ctx, scope, connectionId, step = {}) {
			await requireSystem(ctx, "connections.listTools");
			const found = await connectionRecord(connectionId).catch(() => undefined);
			const mcpUrl = found?.value.connection.mcp?.url;
			if (found === undefined || found.organisationId !== scope.organisationId)
				throw new HarbourError("not_found", `No connection ${connectionId}`);
			if (mcpUrl === undefined)
				throw new HarbourError("invalid", `${found.value.connection.name} is not an MCP server`);
			const { url } = await usableConnection(scope, connectionId, {
				kind: "mcp_tools",
				method: "POST",
				url: mcpUrl,
				...(step.toolCallId === undefined ? {} : { toolCallId: step.toolCallId }),
			});
			return listMcpTools(mcpPost(connectionId, scope, url, "tools/list"));
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
			const { url } = await usableConnection(scope, connectionId, {
				kind: "mcp_call",
				method: "POST",
				url: mcpUrl,
				tool: call.name,
				...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
			});
			return callMcpTool(mcpPost(connectionId, scope, url, `tools/call ${call.name}`), call.name, call.arguments);
		},
	};
	return service;
}
