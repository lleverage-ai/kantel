// The Connections page's source over Kantel's public API (`@kantel/api`'s generated SDK, `/v1/connections`, #322),
// for when the console talks to a real Kantel. Same-origin under /v1, like the sharing API: behind Cloudflare Access
// the browser's cookie signs each call in; signed in with an email code, `headers` adds the session's bearer.
//
// The page's model (`@kantel/ui`'s connections-model.ts) is shaped for showing; this file maps the contract
// (`@kantel/contracts`' connections.ts) onto it and back. No call ever returns a secret: a key or client secret goes
// out once, in the call that stores it.

import { createKantelClient, KantelApiError, type KantelClient } from "@kantel/api/sdk";
import type {
	CatalogueEntry,
	ConnectAttempt,
	ConnectFailureCode,
	Connection,
	ConnectionCeiling,
	ConnectionDecision,
	ConnectionOwner,
	ConnectionRemoval,
	ConnectionRule,
	ConnectionRules,
	ConnectionsSettings,
	ConnectionUse,
	GitHubAppSetup,
	KeyInjection,
	MeResponse,
	OAuthClient,
	OAuthClientTier,
	OwnerRef,
	Page,
	Project,
	ProviderCategory,
	ProviderTemplate,
} from "@kantel/contracts";
import {
	CONNECT_FAILURE_TEXT,
	type ConnectAttemptState,
	type ConnectionRulesSource,
	type ConnectionsSource,
	type ConnectionsViewer,
	type ConnectionUseView,
	type ConnectionView,
	type ConnectStart,
	type DisconnectResult,
	type GitHubAppState,
	type KeyConnectionInput,
	type OAuthClientView,
	type ProviderTemplateView,
} from "@kantel/ui";
import { readPeople } from "./audit-http.ts";
import type { ConsoleConnections } from "./oversight.ts";

export interface ConnectionsApiOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	/** Credentials for every call, such as `Authorization`; none behind Access. */
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
	/** This origin, for the OAuth callback's URL. Default `location.origin`. */
	readonly origin?: string;
	/** What the deployment's own OAuth clients are called. Default "Kantel". */
	readonly hostName?: string;
}

/** The catalogue's categories as the page names them. */
const CATEGORY_LABELS: Record<ProviderCategory, string> = {
	developer: "Developer tools",
	productivity: "Productivity",
	communication: "Communication",
	knowledge: "Knowledge",
	project_management: "Project management",
	crm: "Sales and support",
	payments: "Finance",
	ai: "AI models",
	cloud: "Cloud",
	data: "Data",
	design: "Design",
	other: "Other",
};

/** The first sentence of a description, for a catalogue card. */
export function summaryOf(description: string): string {
	const match = /^(.+?[.!?])(\s|$)/.exec(description.trim());
	return match?.[1] ?? description.trim();
}

/** The page's auth types: a remote MCP server signs in by its own discovery (or needs no sign-in). */
function authTypesOf(entry: Pick<CatalogueEntry, "kind" | "authTypes">): ProviderTemplateView["authTypes"] {
	const mcp = entry.kind === "mcp" && entry.authTypes.some((type) => type === "oauth2" || type === "none");
	return [
		...(mcp ? (["mcp_oauth"] as const) : []),
		...entry.authTypes.filter(
			(type): type is Exclude<typeof type, "none"> => type !== "none" && !(mcp && type === "oauth2"),
		),
	];
}

/** A remote MCP server that answers without a sign-in (`none` alone): there's no OAuth client to register for it. */
export function isOpen(entry: Pick<CatalogueEntry, "kind" | "authTypes">): boolean {
	return entry.kind === "mcp" && entry.authTypes.length > 0 && entry.authTypes.every((type) => type === "none");
}

/** A template's scope sets as the page shows them. */
const scopeSetsOf = (sets: CatalogueEntry["scopeSets"] | undefined): ProviderTemplateView["scopeSets"] =>
	(sets ?? []).map((set) => ({
		id: set.id,
		label: set.label,
		description: set.description ?? "",
		access: set.access,
		scopes: set.scopes,
		...(set.default === undefined ? {} : { default: set.default }),
	}));

/**
 * A catalogue entry as the page's card shows it. Its page fills in the rest with `template`. `ownerName` puts a name
 * on the client it resolves to ("Acme" for the organisation's), where the API can only say "your organisation".
 */
export function entryView(
	entry: CatalogueEntry,
	ownerName?: (tier: OAuthClientTier) => string | undefined,
): ProviderTemplateView {
	const client = entry.client;
	return {
		id: entry.id,
		name: entry.name,
		summary: summaryOf(entry.description),
		description: entry.description,
		category: CATEGORY_LABELS[entry.category] ?? entry.category,
		icon: entry.icon,
		docsUrl: entry.docsUrl,
		authTypes: authTypesOf(entry),
		apiHosts: [],
		scopeSets: scopeSetsOf(entry.scopeSets),
		setup: entry.setup,
		version: entry.version,
		...(entry.mcpUrl === undefined ? {} : { mcpUrl: entry.mcpUrl }),
		...(isOpen(entry) ? { open: true } : {}),
		...(entry.tier === undefined ? {} : { tier: entry.tier }),
		...(entry.signIn === undefined ? {} : { signIn: entry.signIn }),
		...(entry.clientGuidance === undefined ? {} : { clientGuidance: entry.clientGuidance }),
		...(entry.guide === undefined ? {} : { guide: entry.guide }),
		...(client === undefined
			? {}
			: {
					client: {
						tier: client.tier === "platform" ? "deployment" : client.tier,
						ownerLabel: ownerName?.(client.tier) ?? client.ownerLabel,
						...(client.label === undefined ? {} : { label: client.label }),
						public: client.public,
					},
				}),
	};
}

/** A whole template, for its own page: its scope sets, hosts and key shapes. */
export function templateView(
	template: ProviderTemplate,
	entry?: CatalogueEntry,
	ownerName?: (tier: OAuthClientTier) => string | undefined,
): ProviderTemplateView {
	return {
		...(entry === undefined ? {} : entryView(entry, ownerName)),
		id: template.id,
		name: template.name,
		summary: summaryOf(template.description),
		description: template.description,
		category: CATEGORY_LABELS[template.category] ?? template.category,
		icon: template.icon,
		docsUrl: template.docsUrl,
		authTypes: authTypesOf(template),
		apiHosts: template.apiHosts,
		scopeSets: scopeSetsOf(template.scopeSets),
		version: template.version,
		...(template.clientGuidance === undefined ? {} : { clientGuidance: template.clientGuidance }),
		...(template.key?.shapes === undefined ? {} : { keyShapes: template.key.shapes }),
		...(template.mcp === undefined ? {} : { mcpUrl: template.mcp.url }),
		...(isOpen(template) ? { open: true } : {}),
	};
}

const HEALTH: Record<Connection["status"], ConnectionView["health"]> = {
	active: "healthy",
	needs_reauth: "needs_reconnect",
	failing_test: "failing_test",
	disabled: "disabled",
};

/**
 * A use as the page's Recent uses shows it: what it asked for, the session and step, who it acted for and who could see
 * the session then.
 */
export function useView(
	use: ConnectionUse,
	context: {
		readonly people?: ((userId: string) => string | undefined) | undefined;
		readonly titles?: ReadonlyMap<string, string>;
	},
): ConnectionUseView {
	const title = context.titles?.get(use.sessionId);
	const actingFor =
		use.actingUserId === undefined ? undefined : (context.people?.(use.actingUserId) ?? use.actingUserId);
	return {
		id: use.id,
		at: use.at,
		sessionId: use.sessionId,
		...(title === undefined ? {} : { sessionTitle: title }),
		...(use.toolCallId === undefined ? {} : { toolCallId: use.toolCallId }),
		what:
			use.kind === "mcp_call" && use.tool !== undefined
				? `${use.tool} on ${use.host}`
				: `${use.method} ${use.host}${use.path}`,
		...(actingFor === undefined ? {} : { actingFor }),
		audience: use.audience.kind,
		outcome: use.outcome,
		...(use.reason === undefined ? {} : { reason: use.reason }),
	};
}

/** Who a credential belongs to, in words. */
const accountOf = (connection: Connection): string | undefined =>
	connection.account?.name ?? connection.account?.email ?? connection.account?.id;

export interface ViewContext {
	readonly templates: ReadonlyMap<string, Pick<ProviderTemplateView, "name" | "icon">>;
	readonly people?: ((userId: string) => string | undefined) | undefined;
}

/**
 * A connection as the page shows it. A connection named other than its template ("Release bot") shows as the
 * template's name with that as its label, so two to one provider read apart.
 */
export function connectionView(connection: Connection, context: ViewContext): ConnectionView {
	const template = connection.templateId === undefined ? undefined : context.templates.get(connection.templateId);
	const label = template !== undefined && connection.name !== template.name ? connection.name : undefined;
	const account = accountOf(connection);
	const createdBy = connection.createdBy.kind === "human" ? context.people?.(connection.createdBy.userId) : undefined;
	return {
		id: connection.id,
		templateId: connection.templateId ?? (connection.kind === "mcp" ? "custom-mcp" : "custom"),
		name: template?.name ?? connection.name,
		...(template?.icon === undefined ? {} : { icon: template.icon }),
		kind: connection.auth === "key" ? "key" : connection.kind === "mcp" ? "mcp" : "oauth",
		...(account === undefined ? {} : { account }),
		...(label === undefined ? {} : { label }),
		owner: connection.owner,
		...(connection.owner.kind === "organisation" && connection.usage.projects !== undefined
			? { onlyProjects: connection.usage.projects }
			: {}),
		usage: {
			visibility: connection.usage.visibility,
			unattended: connection.usage.unattended,
			...(connection.usage.agents === undefined ? {} : { agents: connection.usage.agents }),
			...(connection.usage.actingUsers === undefined ? {} : { actingUsers: connection.usage.actingUsers }),
		},
		health: HEALTH[connection.status],
		createdAt: connection.createdAt,
		...(createdBy === undefined ? {} : { createdBy }),
		scopes: connection.scopes.granted.length > 0 ? connection.scopes.granted : connection.scopes.requested,
		hosts: connection.hosts,
		...(connection.client === undefined
			? {}
			: {
					client: {
						id: connection.client.oauthClientId ?? connection.client.clientId,
						label: connection.client.clientId,
					},
				}),
		...(connection.auth === "key" && connection.credential.set && connection.credential.last4 !== undefined
			? { key: { set: true as const, last4: connection.credential.last4 } }
			: {}),
		...(connection.mcp === undefined ? {} : { mcp: { url: connection.mcp.url } }),
	};
}

/** Why a connect failed, in the page's words; the API's message goes with the ones the page can't say itself. */
export function failureOf(attempt: ConnectAttempt): Extract<ConnectAttemptState, { status: "failed" }> {
	if (attempt.status === "expired") return { status: "failed", reason: "expired" };
	const code: ConnectFailureCode | undefined = attempt.failure?.code;
	const message = attempt.failure?.message;
	switch (code) {
		case "user_mismatch":
		case "no_client":
		case "denied":
		case "discovery_failed":
			return { status: "failed", reason: code };
		case "invalid_state":
			return { status: "failed", reason: "expired" };
		default:
			return { status: "failed", reason: "provider_error", ...(message === undefined ? {} : { message }) };
	}
}

/**
 * A connect the API refused to start, in the page's words. A missing OAuth client or an MCP server that names no
 * sign-in comes back as a refusal carrying `details.failure`, not as a failed attempt, so the page would otherwise show
 * only the API's message.
 */
export function startError(error: unknown): unknown {
	if (!(error instanceof KantelApiError)) return error;
	const failure = error.details?.failure;
	switch (failure) {
		case "no_client":
		case "discovery_failed":
			return new Error(`${CONNECT_FAILURE_TEXT[failure]} (${error.message})`);
		case "registration_failed":
			return new Error(
				`${error.message}. Add your own OAuth client for it under "Use your own OAuth client", or connect it with a key.`,
			);
		default:
			return error;
	}
}

/** Runs a connect start, putting a refusal in the page's words. */
async function starting<T>(start: () => Promise<T>): Promise<T> {
	try {
		return await start();
	} catch (error) {
		throw startError(error);
	}
}

/**
 * When each connection was last used by a session: the newest allowed use of each. One page of the organisation's
 * uses (newest first) covers most; a connection it misses, when there were more, is asked after by itself.
 */
export async function lastUses(api: KantelClient, connectionIds: readonly string[]): Promise<Map<string, number>> {
	const last = new Map<string, number>();
	const note = (uses: readonly ConnectionUse[]) => {
		for (const use of uses)
			if (use.outcome === "allowed" && !last.has(use.connectionId)) last.set(use.connectionId, use.at);
	};
	const page = (await api.listConnectionUses({ limit: 200 })) as Page<ConnectionUse>;
	note(page.items);
	if (page.nextCursor !== undefined) {
		const missed = connectionIds.filter((id) => !last.has(id));
		const pages = await Promise.all(
			missed.map((connectionId) =>
				(api.listConnectionUses({ connectionId, limit: 20 }) as Promise<Page<ConnectionUse>>).catch(() => undefined),
			),
		);
		for (const found of pages) if (found !== undefined) note(found.items);
	}
	return last;
}

/** A key's way out, as the contract says it. */
export function injectionOf(injection: NonNullable<KeyConnectionInput["injection"]>): KeyInjection {
	switch (injection.kind) {
		case "bearer":
		case "basic":
			return { kind: injection.kind };
		case "header":
			return {
				kind: "header",
				header: injection.name,
				...(injection.prefix === undefined ? {} : { prefix: injection.prefix }),
			};
		case "query":
			return { kind: "query", param: injection.name };
	}
}

/** A server's name from its URL, when it isn't given one: `mcp.notion.com` is "Notion". */
export function serverNameOf(url: string, name?: string): string {
	if (name !== undefined && name.trim() !== "") return name.trim();
	const host = new URL(url).hostname.replace(/^(mcp|api)\./, "");
	const base = host.split(".").at(-2) ?? host;
	return base.charAt(0).toUpperCase() + base.slice(1);
}

async function allPages<T>(read: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	do {
		const page = await read(cursor);
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return items;
}

const pageArgs = (cursor: string | undefined) => ({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });

export interface SourceContext {
	readonly organisationId: string;
	readonly userId: string;
	readonly viewer: ConnectionsViewer;
	readonly people?: ((userId: string) => string | undefined) | undefined;
	/** The deployment's name, for its own OAuth clients. */
	readonly hostName: string;
}

/** What a disconnect did at the provider (#329), as the page says it. */
export function disconnectResult(removal: ConnectionRemoval | undefined): DisconnectResult {
	const revocation = removal?.revocation;
	if (revocation === undefined) return { revoked: "unknown" };
	const extra = {
		...(revocation.manageUrl === undefined ? {} : { revokeUrl: revocation.manageUrl }),
		...(revocation.reason === undefined ? {} : { reason: revocation.reason }),
	};
	switch (revocation.outcome) {
		case "revoked":
			return { revoked: true };
		case "none":
			return { revoked: "none" };
		case "unsupported":
			return { revoked: "unsupported", ...extra };
		case "failed":
			return { revoked: false, ...extra };
		default:
			return { revoked: "unknown" };
	}
}

/** The Connections page's source over the API: one call per route, two where the page wants a connection made. */
export function connectionsApiSource(api: KantelClient, context: SourceContext): ConnectionsSource {
	const { organisationId, userId, viewer, people, hostName } = context;
	// The catalogue's names and logos, for connections and clients; kept from the last catalogue read.
	const templates = new Map<string, Pick<ProviderTemplateView, "name" | "icon">>();
	const view = (connection: Connection) => connectionView(connection, { templates, people });
	const ownerOf = (
		choice: { kind: "user" } | { kind: "organisation" } | { kind: "project"; projectId: string },
	): ConnectionOwner =>
		choice.kind === "user"
			? { kind: "user", organisationId, userId }
			: choice.kind === "project"
				? { kind: "project", organisationId, projectId: choice.projectId }
				: { kind: "organisation", organisationId };
	const ensureCatalogue = async () => {
		if (templates.size > 0) return;
		const entries = await allPages((cursor) => api.listCatalogue(pageArgs(cursor)) as Promise<Page<CatalogueEntry>>);
		for (const entry of entries) templates.set(entry.id, { name: entry.name, icon: entry.icon });
	};
	const started = async (attempt: ConnectAttempt): Promise<ConnectStart> => {
		if (attempt.status === "completed" && attempt.connectionId !== undefined)
			return {
				attemptId: attempt.id,
				url: "",
				expiresAt: attempt.expiresAt,
				connected: view((await api.getConnection(attempt.connectionId)) as Connection),
			};
		if (attempt.status !== "pending" || attempt.connectUrl === undefined) {
			const failed = failureOf(attempt);
			throw new Error(attempt.failure?.message ?? failed.message ?? "Kantel couldn't start the sign-in.");
		}
		// A sign-in with a code: the page shows the code and opens the provider's page to type it at.
		if (attempt.device !== undefined) {
			return {
				attemptId: attempt.id,
				url: attempt.device.verificationUri,
				expiresAt: attempt.expiresAt,
				device: { userCode: attempt.device.userCode },
			};
		}
		return { attemptId: attempt.id, url: attempt.connectUrl, expiresAt: attempt.expiresAt };
	};
	/** A name for the client a catalogue entry resolves to, where the console knows a better one than the API. */
	const resolvedOwnerName = (tier: OAuthClientTier): string | undefined =>
		tier === "organisation" ? viewer.organisation : tier === "user" ? viewer.name : undefined;
	const ownerLabel = (owner: OwnerRef): string => {
		switch (owner.kind) {
			case "platform":
				return hostName;
			case "organisation":
				return viewer.organisation;
			case "project":
				return viewer.projects.find((project) => project.id === owner.projectId)?.name ?? "A project";
			case "user":
				return owner.userId === userId ? viewer.name : (people?.(owner.userId) ?? "Someone");
		}
	};
	const clientView = (client: OAuthClient): OAuthClientView => ({
		id: client.id,
		templateId: client.templateId ?? client.issuer ?? "custom",
		tier: client.owner.kind === "platform" ? "deployment" : client.owner.kind,
		ownerLabel: ownerLabel(client.owner),
		label: client.label,
		clientId: client.clientId,
		...(client.secret.set && client.secret.last4 !== undefined
			? { secret: { set: true as const, last4: client.secret.last4 } }
			: {}),
		scopes: client.scopes ?? [],
		redirectUri: client.redirectUri,
		...(client.redirectDomain === undefined ? {} : { redirectDomain: client.redirectDomain }),
		disabled: client.disabled,
		pinnedConnections: client.connections,
		createdAt: client.createdAt,
		...(client.githubApp === undefined
			? {}
			: {
					githubApp: {
						slug: client.githubApp.slug,
						installUrl: client.githubApp.installUrl,
						appUrl: client.githubApp.htmlUrl,
					},
				}),
	});
	/** A GitHub App manifest flow, in the page's words. */
	const gitHubAppState = async (setup: GitHubAppSetup): Promise<GitHubAppState> => {
		switch (setup.status) {
			case "pending":
				return { status: "pending" };
			case "created": {
				if (setup.clientId === undefined || setup.githubApp === undefined) {
					return { status: "failed", message: "GitHub made the app, but Kantel lost track of its client." };
				}
				const client = clientView((await api.getOAuthClient(setup.clientId)) as OAuthClient);
				return {
					status: "created",
					client,
					installUrl: setup.githubApp.installUrl,
					appUrl: setup.githubApp.htmlUrl,
				};
			}
			case "expired":
				return { status: "failed", message: "The hour GitHub allows to create the app ran out. Start again." };
			case "failed":
				return { status: "failed", message: setup.failure?.message ?? "GitHub didn't create the app." };
		}
	};

	return {
		catalogue: async () => {
			const entries = await allPages((cursor) => api.listCatalogue(pageArgs(cursor)) as Promise<Page<CatalogueEntry>>);
			templates.clear();
			for (const entry of entries) templates.set(entry.id, { name: entry.name, icon: entry.icon });
			return entries.map((entry) => entryView(entry, resolvedOwnerName));
		},
		template: async (templateId) => {
			const template = (await api.getProviderTemplate(templateId)) as ProviderTemplate;
			const entry = ((await api.listCatalogue({ q: template.id, limit: 50 })) as Page<CatalogueEntry>).items.find(
				(candidate) => candidate.id === template.id,
			);
			return templateView(template, entry, resolvedOwnerName);
		},
		connections: async () => {
			await ensureCatalogue().catch(() => undefined);
			const items = await allPages((cursor) => api.listConnections(pageArgs(cursor)) as Promise<Page<Connection>>);
			// "Used 4m ago": best effort, so a list never fails for want of it.
			const used = await lastUses(
				api,
				items.map((connection) => connection.id),
			).catch(() => new Map<string, number>());
			return items.map((connection) => {
				const at = used.get(connection.id);
				return at === undefined ? view(connection) : { ...view(connection), lastUsedAt: at };
			});
		},
		connect: async (input) =>
			started(
				(await starting(() =>
					api.startConnect({
						templateId: input.templateId,
						owner: ownerOf(input.owner),
						...(input.scopeSets === undefined ? {} : { scopeSets: input.scopeSets }),
						...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
					}),
				)) as ConnectAttempt,
			),
		attempt: async (attemptId) => {
			const attempt = (await api.getConnectAttempt(attemptId)) as ConnectAttempt;
			if (attempt.status === "pending") return { status: "pending" };
			if (attempt.status === "completed" && attempt.connectionId !== undefined)
				return { status: "connected", connection: view((await api.getConnection(attempt.connectionId)) as Connection) };
			return failureOf(attempt);
		},
		connectKey: async (input) => {
			const value = input.username === undefined ? input.key : `${input.username}:${input.key}`;
			const made = (await api.connectKey({
				owner: ownerOf(input.owner),
				value,
				...(input.templateId !== undefined
					? {
							templateId: input.templateId,
							...(input.label === undefined ? {} : { name: input.label }),
						}
					: {
							name: input.label === undefined ? (input.name ?? "Custom service") : `${input.name} (${input.label})`,
							custom: {
								kind: input.mcpUrl === undefined ? "http" : "mcp",
								hosts: input.hosts ?? [],
								injection: injectionOf(input.injection ?? { kind: "bearer" }),
								...(input.mcpUrl === undefined ? {} : { mcpUrl: input.mcpUrl }),
							},
						}),
			})) as Connection;
			const connection = view(made);
			const account = accountOf(made);
			return {
				connection,
				...(made.status === "failing_test"
					? { test: { ok: false } }
					: account === undefined
						? {}
						: { test: { ok: true, account } }),
			};
		},
		addMcpServer: async (input) => {
			const serverName = serverNameOf(input.url, input.name);
			const discovery = await api.discoverMcpServer({ url: input.url });
			// A server that refused and named no sign-in takes a key, most likely as a bearer token.
			if (discovery.auth === "unknown") return { auth: "key", serverName, header: "Authorization" };
			if (input.client !== undefined) {
				if (discovery.authorizationServer === undefined)
					throw new Error(`${serverName} didn't name its authorisation server, so its client can't be registered.`);
				await api.createOAuthClient({
					owner: { kind: "user", organisationId, userId },
					issuer: discovery.authorizationServer,
					label: `${serverName} client`,
					clientId: input.client.clientId,
					...(input.client.clientSecret === undefined ? {} : { clientSecret: input.client.clientSecret }),
				});
			}
			const attempt = (await starting(() =>
				api.startConnect({
					mcpUrl: input.url,
					owner: ownerOf(input.owner),
					...(input.name === undefined ? {} : { name: input.name }),
				}),
			)) as ConnectAttempt;
			return { auth: "oauth", serverName, ...(await started(attempt)) };
		},
		disconnect: async (connectionId) => {
			return disconnectResult((await api.removeConnection(connectionId)) as ConnectionRemoval | undefined);
		},
		reconnect: async (connectionId) => {
			const connection = (await api.getConnection(connectionId)) as Connection;
			return started(
				(await starting(() =>
					api.startConnect({
						...(connection.templateId !== undefined
							? { templateId: connection.templateId }
							: connection.mcp === undefined
								? {}
								: { mcpUrl: connection.mcp.url }),
						owner: connection.owner,
						connectionId,
					}),
				)) as ConnectAttempt,
			);
		},
		clients: async () => {
			await ensureCatalogue().catch(() => undefined);
			const items = await allPages((cursor) => api.listOAuthClients(pageArgs(cursor)) as Promise<Page<OAuthClient>>);
			return items.map(clientView);
		},
		createClient: async (input) => {
			const owner: OwnerRef =
				input.tier === "organisation"
					? { kind: "organisation", organisationId }
					: input.tier === "project" && input.projectId !== undefined
						? { kind: "project", organisationId, projectId: input.projectId }
						: { kind: "user", organisationId, userId };
			const name = templates.get(input.templateId)?.name ?? input.templateId;
			return clientView(
				(await api.createOAuthClient({
					owner,
					templateId: input.templateId,
					label: input.label ?? `${ownerLabel(owner)} ${name} app`,
					clientId: input.clientId,
					clientSecret: input.clientSecret,
					...(input.scopes === undefined || input.scopes.length === 0 ? {} : { scopes: input.scopes }),
				})) as OAuthClient,
			);
		},
		setClientDisabled: async (clientId, disabled) =>
			clientView((await api.updateOAuthClient(clientId, { disabled })) as OAuthClient),
		uses: async (connectionId) => {
			const page = (await api.listConnectionUses({ connectionId, limit: 20 })) as Page<ConnectionUse>;
			// The sessions' titles, read as the viewer: one they can't open (someone's private session) keeps its ID.
			const titles = new Map<string, string>();
			await Promise.all(
				[...new Set(page.items.map((use) => use.sessionId))].map(async (sessionId) => {
					const session = await api.getSession(sessionId).catch(() => undefined);
					if (session?.title !== undefined && session.title !== "") titles.set(sessionId, session.title);
				}),
			);
			return page.items.map((use) => useView(use, { people, titles }));
		},
		deleteClient: async (clientId) => {
			await api.removeOAuthClient(clientId);
		},
		createGitHubApp: async (input) => {
			// GitHub sends the person back to this page, as it is now, once the app is made.
			const here = typeof location === "undefined" ? undefined : `${location.pathname}${location.search}`;
			const setup = (await api.startGitHubApp({
				owner: input.tier,
				...(input.tier === "project" && input.projectId !== undefined ? { projectId: input.projectId } : {}),
				...(input.githubOrganisation === undefined || input.githubOrganisation.trim() === ""
					? {}
					: { githubOrganisation: input.githubOrganisation.trim() }),
				...(here === undefined ? {} : { returnTo: here }),
			})) as GitHubAppSetup;
			if (setup.url === undefined) throw new Error("Kantel didn't say where to send you to GitHub.");
			return { id: setup.id, url: setup.url, expiresAt: setup.expiresAt };
		},
		gitHubApp: async (id) => gitHubAppState((await api.getGitHubApp(id)) as GitHubAppSetup),
		rules: connectionRulesApiSource(api),
	};
}

/** The rules editor's calls, one API call each (#341). The API checks who may do what; nothing is decided here. */
export function connectionRulesApiSource(api: KantelClient): ConnectionRulesSource {
	return {
		get: async (connectionId) => (await api.getConnectionRules(connectionId)) as ConnectionRules,
		update: async (connectionId, input) => (await api.updateConnectionRules(connectionId, input)) as ConnectionRules,
		create: async (connectionId, input) => (await api.createConnectionRule(connectionId, input)) as ConnectionRule,
		updateRule: async (connectionId, ruleId, input) =>
			(await api.updateConnectionRule(connectionId, ruleId, input)) as ConnectionRule,
		remove: async (connectionId, ruleId) => {
			await api.removeConnectionRule(connectionId, ruleId);
		},
		dryRun: async (connectionId, request) =>
			(await api.dryRunConnectionRequest(connectionId, request)) as ConnectionDecision,
		ceiling: async () => (await api.getConnectionCeiling()) as ConnectionCeiling,
	};
}

/** The projects the viewer may see, every page, by name. */
export async function readProjects(
	options: Pick<ConnectionsApiOptions, "baseUrl" | "headers">,
	doFetch: typeof fetch,
): Promise<Project[]> {
	const items: Project[] = [];
	let cursor: string | undefined;
	do {
		const query = new URLSearchParams({ limit: "200" });
		if (cursor !== undefined) query.set("cursor", cursor);
		const response = await doFetch(`${options.baseUrl ?? "/v1"}/projects?${query}`, {
			headers: { accept: "application/json", ...(options.headers?.() ?? {}) },
		});
		if (!response.ok) throw new Error(`GET /v1/projects answered ${response.status}`);
		const page = (await response.json()) as Page<Project>;
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return items.sort((a, b) => a.name.localeCompare(b.name, "en-GB") || a.id.localeCompare(b.id));
}

/**
 * The Connections page on the gateway this console is served by (`source=api`), for a person signed in. Asks the
 * catalogue first: a gateway that doesn't serve `/v1/connections` yet throws, and the console lists no page.
 */
export async function apiConnections(
	me: Pick<MeResponse, "actor" | "organisationId" | "name" | "roles">,
	options: ConnectionsApiOptions = {},
): Promise<ConsoleConnections> {
	if (me.actor.kind !== "human") throw new Error("Connections are for a person signed in");
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const watched: typeof fetch = async (input, init) => {
		const response = await doFetch(input, init);
		if (response.status === 401) options.onUnauthenticated?.();
		return response;
	};
	const api = createKantelClient({
		baseUrl: options.baseUrl ?? "/v1",
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: watched,
	});
	// The probe: one entry is enough to know the routes are served.
	await api.listCatalogue({ limit: 1 });
	const [visible, people, settings] = await Promise.all([
		readProjects(options, watched).catch(() => [] as Project[]),
		readPeople({
			baseUrl: (options.baseUrl ?? "/v1").replace(/\/v1$/, ""),
			fetch: watched,
			...(options.headers === undefined ? {} : { headers: options.headers }),
		}).catch(() => undefined),
		// Whether a "Just me" connection works in the person's sessions; a gateway without the route has it off.
		api.getConnectionsSettings().catch((): ConnectionsSettings => ({ personal: false })),
	]);
	const names = people?.names ?? new Map<string, string>();
	const organisation =
		people?.organisations?.find((candidate) => candidate.id === me.organisationId)?.name ?? "Your organisation";
	const hostName = options.hostName ?? "Kantel";
	const viewer: ConnectionsViewer = {
		userId: me.actor.userId,
		name: me.name,
		organisation,
		projects: visible.map((project) => ({ id: project.id, name: project.name })),
		admin: me.roles.some((held) => held.projectId === undefined && held.role === "admin"),
		host: hostName,
		personal: settings.personal,
	};
	const lookup = (userId: string) => names.get(userId);
	const origin = options.origin ?? (typeof location === "undefined" ? "" : location.origin);
	return {
		source: connectionsApiSource(api, {
			organisationId: me.organisationId,
			userId: me.actor.userId,
			viewer,
			people: lookup,
			hostName,
		}),
		viewer,
		people: lookup,
		redirectUri: `${origin}${options.baseUrl ?? "/v1"}/connections/callback`,
	};
}
