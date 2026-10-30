// The Connections page's source over Harbour's public API (`@harbour/api`'s generated SDK, `/v1/connections`, #322),
// for when the console talks to a real Harbour. Same-origin under /v1, like the sharing API: behind Cloudflare Access
// the browser's cookie signs each call in; signed in with an email code, `headers` adds the session's bearer.
//
// The page's model (`@harbour/ui`'s connections-model.ts) is shaped for showing; this file maps the contract
// (`@harbour/contracts`' connections.ts) onto it and back. No call ever returns a secret: a key or client secret goes
// out once, in the call that stores it.

import { createHarbourClient, type HarbourClient } from "@harbour/api/sdk";
import type {
	CatalogueEntry,
	ConnectAttempt,
	ConnectFailureCode,
	Connection,
	ConnectionOwner,
	KeyInjection,
	MeResponse,
	OAuthClient,
	OwnerRef,
	Page,
	Project,
	ProviderCategory,
	ProviderTemplate,
} from "@harbour/contracts";
import type {
	ConnectAttemptState,
	ConnectionsSource,
	ConnectionsViewer,
	ConnectionView,
	ConnectStart,
	KeyConnectionInput,
	OAuthClientView,
	ProviderTemplateView,
} from "@harbour/ui";
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
	/** What the deployment's own OAuth clients are called. Default "Harbour". */
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

/** A catalogue entry as the page's card shows it. Its page fills in the rest with `template`. */
export function entryView(entry: CatalogueEntry): ProviderTemplateView {
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
		scopeSets: [],
		setup: entry.setup,
		version: entry.version,
		...(entry.mcpUrl === undefined ? {} : { mcpUrl: entry.mcpUrl }),
	};
}

/** A whole template, for its own page: its scope sets, hosts and key shapes. */
export function templateView(template: ProviderTemplate, entry?: CatalogueEntry): ProviderTemplateView {
	return {
		...(entry === undefined ? {} : entryView(entry)),
		id: template.id,
		name: template.name,
		summary: summaryOf(template.description),
		description: template.description,
		category: CATEGORY_LABELS[template.category] ?? template.category,
		icon: template.icon,
		docsUrl: template.docsUrl,
		authTypes: authTypesOf(template),
		apiHosts: template.apiHosts,
		scopeSets: template.scopeSets.map((set) => ({
			id: set.id,
			label: set.label,
			description: set.description ?? "",
			access: set.access,
			scopes: set.scopes,
			...(set.default === undefined ? {} : { default: set.default }),
		})),
		version: template.version,
		...(template.key?.shapes === undefined ? {} : { keyShapes: template.key.shapes }),
		...(template.mcp === undefined ? {} : { mcpUrl: template.mcp.url }),
	};
}

const HEALTH: Record<Connection["status"], ConnectionView["health"]> = {
	active: "healthy",
	needs_reauth: "needs_reconnect",
	failing_test: "failing_test",
	disabled: "disabled",
};

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

/** The Connections page's source over the API: one call per route, two where the page wants a connection made. */
export function connectionsApiSource(api: HarbourClient, context: SourceContext): ConnectionsSource {
	const { organisationId, userId, viewer, people, hostName } = context;
	// The catalogue's names and logos, for connections and clients; kept from the last catalogue read.
	const templates = new Map<string, Pick<ProviderTemplateView, "name" | "icon">>();
	// Whether each connection listed is a key, so Disconnect can say what's left to do at the service.
	const keys = new Set<string>();
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
			throw new Error(attempt.failure?.message ?? failed.message ?? "Harbour couldn't start the sign-in.");
		}
		return { attemptId: attempt.id, url: attempt.connectUrl, expiresAt: attempt.expiresAt };
	};
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
	});

	return {
		catalogue: async () => {
			const entries = await allPages((cursor) => api.listCatalogue(pageArgs(cursor)) as Promise<Page<CatalogueEntry>>);
			templates.clear();
			for (const entry of entries) templates.set(entry.id, { name: entry.name, icon: entry.icon });
			return entries.map(entryView);
		},
		template: async (templateId) => {
			const template = (await api.getProviderTemplate(templateId)) as ProviderTemplate;
			const entry = ((await api.listCatalogue({ q: template.id, limit: 50 })) as Page<CatalogueEntry>).items.find(
				(candidate) => candidate.id === template.id,
			);
			return templateView(template, entry);
		},
		connections: async () => {
			await ensureCatalogue().catch(() => undefined);
			const items = await allPages((cursor) => api.listConnections(pageArgs(cursor)) as Promise<Page<Connection>>);
			keys.clear();
			for (const connection of items) if (connection.auth === "key") keys.add(connection.id);
			return items.map(view);
		},
		connect: async (input) =>
			started(
				(await api.startConnect({
					templateId: input.templateId,
					owner: ownerOf(input.owner),
					...(input.scopeSets === undefined ? {} : { scopeSets: input.scopeSets }),
					...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
				})) as ConnectAttempt,
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
			const attempt = (await api.startConnect({
				mcpUrl: input.url,
				owner: ownerOf(input.owner),
				...(input.name === undefined ? {} : { name: input.name }),
			})) as ConnectAttempt;
			return { auth: "oauth", serverName, ...(await started(attempt)) };
		},
		disconnect: async (connectionId) => {
			await api.removeConnection(connectionId);
			return { revoked: keys.has(connectionId) ? "unsupported" : "unknown" };
		},
		reconnect: async (connectionId) => {
			const connection = (await api.getConnection(connectionId)) as Connection;
			return started(
				(await api.startConnect({
					...(connection.templateId !== undefined
						? { templateId: connection.templateId }
						: connection.mcp === undefined
							? {}
							: { mcpUrl: connection.mcp.url }),
					owner: connection.owner,
					connectionId,
				})) as ConnectAttempt,
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
		deleteClient: async (clientId) => {
			await api.removeOAuthClient(clientId);
		},
	};
}

async function projects(options: ConnectionsApiOptions, doFetch: typeof fetch): Promise<Project[]> {
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
	const api = createHarbourClient({
		baseUrl: options.baseUrl ?? "/v1",
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: watched,
	});
	// The probe: one entry is enough to know the routes are served.
	await api.listCatalogue({ limit: 1 });
	const [visible, people] = await Promise.all([
		projects(options, watched).catch(() => [] as Project[]),
		readPeople({
			baseUrl: (options.baseUrl ?? "/v1").replace(/\/v1$/, ""),
			fetch: watched,
			...(options.headers === undefined ? {} : { headers: options.headers }),
		}).catch(() => undefined),
	]);
	const names = people?.names ?? new Map<string, string>();
	const organisation =
		people?.organisations?.find((candidate) => candidate.id === me.organisationId)?.name ?? "Your organisation";
	const hostName = options.hostName ?? "Harbour";
	const viewer: ConnectionsViewer = {
		userId: me.actor.userId,
		name: me.name,
		organisation,
		projects: visible.map((project) => ({ id: project.id, name: project.name })),
		admin: me.roles.some((held) => held.projectId === undefined && held.role === "admin"),
		host: hostName,
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
