// The Connections page's model (issue #322): the catalogue of provider templates, the connections made from them, the
// OAuth clients they connect through, and the calls the page makes. The shapes follow the tickets (#325 catalogue,
// #326 clients, #327 connect flow, #330 key connections, #335 ownership, #338 remote MCP servers) and stand in for the
// public API's contract until it lands; the console binds `ConnectionsSource` to the real routes, stories to fixtures.
//
// Nothing here ever holds a secret value. A key or a client secret goes out once, in the call that stores it, and
// comes back only as "set" with its last four characters.

import type { OwnerRef } from "@harbour/contracts";

/** How a template's credential is obtained and sent (#325). */
export type AuthType =
	| "oauth2"
	| "oauth2_client_credentials"
	| "bearer"
	| "header"
	| "query"
	| "basic"
	| "header_template"
	| "mcp_oauth";

/** The auth types a person enters a key for. */
export const KEY_AUTH_TYPES: readonly AuthType[] = ["bearer", "header", "query", "basic", "header_template"];

export const CATEGORIES = [
	"Developer tools",
	"Productivity",
	"Communication",
	"Sales and support",
	"Finance",
	"AI models",
	"Data",
] as const;
export type Category = (typeof CATEGORIES)[number] | (string & {});

/** A named group of scopes a template may ask for. Only `default` sets are asked for unless a person picks more. */
export interface ScopeSet {
	readonly id: string;
	readonly label: string;
	/** What it lets an agent do, in a line. */
	readonly description: string;
	readonly access: "read" | "write";
	readonly scopes: readonly string[];
	readonly default?: boolean;
}

/** Patterns that recognise a provider's keys, for suggesting the template when a key is pasted (#330). */
export interface KeyShape {
	/** What the key is, as the suggestion says it: "a GitHub fine-grained token". */
	readonly label: string;
	readonly prefix?: string;
	/** A whole-key pattern, as a regular expression source. */
	readonly pattern?: string;
}

/** The client a new OAuth connection to a template would go through, as the catalogue resolves it (#326). */
export interface ResolvedClient {
	readonly tier: ClientTier;
	/** Whose client it is, in words: "Lleverage", "Acme", "Tom Davies". */
	readonly ownerLabel: string;
}

/** A provider template from the catalogue (#325), as the catalogue route lists it: no client secrets. */
export interface ProviderTemplate {
	readonly id: string;
	readonly name: string;
	/** One line on what the service is, for its card. */
	readonly summary: string;
	/** A few sentences for its own page. */
	readonly description?: string;
	readonly category: Category;
	/** The logo: an https or data: URL. Without one the card shows the name's first letter. */
	readonly icon?: string;
	readonly docsUrl: string;
	/** Who makes the service, if not the name: "Google". */
	readonly publisher?: string;
	readonly authTypes: readonly AuthType[];
	/** Host patterns the credential may be sent to. Injection never goes beyond these. */
	readonly apiHosts: readonly string[];
	readonly scopeSets: readonly ScopeSet[];
	readonly keyShapes?: readonly KeyShape[];
	/** Where to make a key, for a key template: "Settings, Developer settings, Personal access tokens". */
	readonly keyHelp?: string;
	/** The client a new OAuth connection would use. Absent on an OAuth template: no client is set up yet. */
	readonly client?: ResolvedClient;
	/**
	 * Whether a person can connect it now, when the API says so rather than naming the client (`CatalogueEntry.setup`):
	 * `needs_client` puts it behind an OAuth client whatever `client` says.
	 */
	readonly setup?: "ready" | "needs_client";
	/** Short provider-specific notes for whoever registers an OAuth app (#340). */
	readonly clientGuidance?: string;
	/** A remote MCP server's URL, for a catalogued MCP server (#338). */
	readonly mcpUrl?: string;
	readonly version?: number;
}

/** A connection's health (#328, #330). `disabled`: an admin stopped every use of it. */
export type ConnectionHealth = "healthy" | "needs_reconnect" | "error" | "failing_test" | "disabled";

/** The owners a connection can have (#335): never the platform. */
export type ConnectionOwner = Extract<OwnerRef, { kind: "organisation" | "project" | "user" }>;

/** How a connection was made. */
export type ConnectionKind = "oauth" | "key" | "mcp";

/** A key's or secret's presence, never its value. */
export interface SecretHint {
	readonly set: true;
	readonly last4: string;
}

/** One authorisation against a provider (#327, #330, #338). An owner may hold several for one template. */
export interface Connection {
	readonly id: string;
	readonly templateId: string;
	/** The template's name, or the name given to a custom service or MCP server. */
	readonly name: string;
	readonly icon?: string;
	readonly kind: ConnectionKind;
	/** Who it connects as, from the template's test request: "tvdavies", "ops@acme.com", "Acme workspace". */
	readonly account?: string;
	/** A person's own label, to tell two connections to one provider apart: "Work", "Personal". */
	readonly label?: string;
	readonly owner: ConnectionOwner;
	/** Projects a personal connection is shared to (#335). */
	readonly sharedWith?: readonly string[];
	/** For an organisation's connection: only sessions in these projects (`ConnectionUsage.projects`). */
	readonly onlyProjects?: readonly string[];
	readonly health: ConnectionHealth;
	/** The last refresh or test error, in plain words. */
	readonly lastError?: string;
	readonly lastUsedAt?: number;
	readonly createdAt: number;
	/** Who made it, by name. */
	readonly createdBy?: string;
	readonly scopes?: readonly string[];
	readonly hosts: readonly string[];
	/** The client an OAuth connection is pinned to. */
	readonly client?: { readonly id: string; readonly label: string };
	readonly key?: SecretHint;
	/** A remote MCP server's URL and how many tools it lists. */
	readonly mcp?: { readonly url: string; readonly tools?: number };
	/** One line on its access rules, until the rules editor (#341): "Reads allowed, writes ask". */
	readonly rulesSummary?: string;
	/** The placeholders an agent writes for the credential, which the egress proxy swaps (#331). */
	readonly placeholders?: readonly string[];
}

/** Where an OAuth client is registered (#326), narrowest last. A narrower client wins for a new connection. */
export type ClientTier = "deployment" | "organisation" | "project" | "user";

/** An OAuth app registration (#326). */
export interface OAuthClient {
	readonly id: string;
	readonly templateId: string;
	readonly tier: ClientTier;
	/** Whose it is, in words: the host's name for a deployment client, else the organisation, project or person. */
	readonly ownerLabel: string;
	readonly label?: string;
	readonly clientId: string;
	/** Absent for a public client, which signs in with PKCE alone. */
	readonly secret?: SecretHint;
	readonly scopes: readonly string[];
	readonly redirectUri: string;
	readonly redirectDomain?: string;
	readonly disabled?: boolean;
	/** Connections pinned to it. A client with any can't be deleted. */
	readonly pinnedConnections: number;
	readonly createdAt: number;
}

/** What a connection is for, as a person picks it when connecting. */
export type OwnerChoice =
	| { readonly kind: "user" }
	| { readonly kind: "project"; readonly projectId: string }
	| { readonly kind: "organisation" };

export interface ConnectInput {
	readonly templateId: string;
	/** The scope sets picked; the template's defaults when absent. */
	readonly scopeSets?: readonly string[];
	readonly owner: OwnerChoice;
	/** For more scopes on an existing connection: it keeps its ID (#327). */
	readonly connectionId?: string;
}

/** A started OAuth round trip: the URL to open, on Harbour's domain, and how to ask after it. */
export interface ConnectStart {
	readonly attemptId: string;
	readonly url: string;
	readonly expiresAt: number;
	/** Set when it needed no sign-in (a server that answers without one): the connection, made already. */
	readonly connected?: Connection;
}

/** Why a connect attempt failed, as the connect URL's final page or the attempt reports it (#326, #327, #338). */
export type ConnectFailure =
	| "denied"
	| "expired"
	| "user_mismatch"
	| "no_client"
	| "discovery_failed"
	| "test_failed"
	| "provider_error";

export type ConnectAttemptState =
	| { readonly status: "pending" }
	| { readonly status: "connected"; readonly connection: Connection }
	| { readonly status: "failed"; readonly reason: ConnectFailure; readonly message?: string };

/** How a key goes out on a custom service (#330). */
export type Injection =
	| { readonly kind: "bearer" }
	| { readonly kind: "header"; readonly name: string; readonly prefix?: string }
	| { readonly kind: "query"; readonly name: string }
	| { readonly kind: "basic" };

export interface KeyConnectionInput {
	/** A catalogue template, or none for a custom service. */
	readonly templateId?: string;
	/** A custom service's name. */
	readonly name?: string;
	/** A custom service's hosts. A template's are fixed. */
	readonly hosts?: readonly string[];
	readonly injection?: Injection;
	readonly owner: OwnerChoice;
	readonly label?: string;
	/** For basic auth: the user name that goes with the key. */
	readonly username?: string;
	/** For a remote MCP server that takes a key: its endpoint, on one of `hosts`. */
	readonly mcpUrl?: string;
	/** The key itself: sent once, here, and never returned. */
	readonly key: string;
}

/** A stored key connection and its test's result (#330). */
export interface KeyConnectionResult {
	readonly connection: Connection;
	readonly test?: { readonly ok: boolean; readonly account?: string; readonly message?: string };
}

export interface McpServerInput {
	readonly url: string;
	readonly name?: string;
	readonly owner: OwnerChoice;
	/** A pre-registered client of the person's own, tried first (#338). The secret goes once, here. */
	readonly client?: { readonly clientId: string; readonly clientSecret?: string };
}

/** Adding an MCP server either starts an OAuth round trip or, for a server that takes a key, asks for it. */
export type McpServerStart =
	| ({ readonly auth: "oauth"; readonly serverName: string } & ConnectStart)
	| { readonly auth: "key"; readonly serverName: string; readonly header: string };

/** What Disconnect did upstream (#329). */
export interface DisconnectResult {
	/** `unsupported`: the provider has no revoke endpoint. `unknown`: the API didn't say. */
	readonly revoked: boolean | "unsupported" | "unknown";
	/** Where to revoke by hand when Harbour couldn't. */
	readonly revokeUrl?: string;
}

export interface OAuthClientInput {
	readonly templateId: string;
	readonly tier: Exclude<ClientTier, "deployment">;
	/** The project, for a project's client. */
	readonly projectId?: string;
	readonly label?: string;
	readonly clientId: string;
	/** Sent once, here, and never returned. */
	readonly clientSecret: string;
	readonly scopes?: readonly string[];
}

/** The calls the page makes, bound to the viewer by the host. */
export interface ConnectionsSource {
	catalogue(): Promise<readonly ProviderTemplate[]>;
	/**
	 * One template in full, for its page, when the catalogue lists only summaries (no scope sets or hosts). Without it,
	 * the catalogue's entries are taken as complete.
	 */
	template?(templateId: string): Promise<ProviderTemplate>;
	connections(): Promise<readonly Connection[]>;
	/** Starts an OAuth round trip (#327). */
	connect(input: ConnectInput): Promise<ConnectStart>;
	/** Where a round trip has got to. The page asks until it settles or the person stops waiting. */
	attempt(attemptId: string): Promise<ConnectAttemptState>;
	/** Gives up on a round trip, so its URL stops working. */
	cancelAttempt?(attemptId: string): Promise<void>;
	connectKey(input: KeyConnectionInput): Promise<KeyConnectionResult>;
	addMcpServer(input: McpServerInput): Promise<McpServerStart>;
	disconnect(connectionId: string): Promise<DisconnectResult>;
	reconnect(connectionId: string): Promise<ConnectStart>;
	clients(): Promise<readonly OAuthClient[]>;
	createClient(input: OAuthClientInput): Promise<OAuthClient>;
	setClientDisabled(clientId: string, disabled: boolean): Promise<OAuthClient>;
	deleteClient(clientId: string): Promise<void>;
}

/** Who is looking, and where they may put a connection. */
export interface ConnectionsViewer {
	readonly userId: string;
	readonly name: string;
	readonly organisation: string;
	/** Projects the viewer may connect for. */
	readonly projects: readonly { readonly id: string; readonly name: string }[];
	/** An organisation admin: may connect for the organisation and manage its OAuth clients. */
	readonly admin: boolean;
	/** The host's name, for its own clients: "Lleverage". */
	readonly host?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Words

export const HEALTH_LABELS: Record<ConnectionHealth, string> = {
	healthy: "Connected",
	needs_reconnect: "Needs reconnecting",
	error: "Error",
	failing_test: "Test failing",
	disabled: "Disabled",
};

export const TIER_LABELS: Record<ClientTier, string> = {
	deployment: "Host",
	organisation: "Organisation",
	project: "Project",
	user: "Personal",
};

const projectName = (viewer: ConnectionsViewer, projectId: string): string =>
	viewer.projects.find((project) => project.id === projectId)?.name ?? projectId;

/** A person's name from the viewer, or the ID. Only the viewer's own name is known to the page. */
const personName = (viewer: ConnectionsViewer, userId: string, people?: (id: string) => string | undefined) =>
	userId === viewer.userId ? viewer.name : (people?.(userId) ?? userId);

/** Who owns it, short: "You", "Support project", "Acme". */
export function ownerText(
	owner: ConnectionOwner,
	viewer: ConnectionsViewer,
	people?: (id: string) => string | undefined,
): string {
	switch (owner.kind) {
		case "organisation":
			return viewer.organisation;
		case "project":
			return `${projectName(viewer, owner.projectId)} project`;
		case "user":
			return owner.userId === viewer.userId ? "You" : personName(viewer, owner.userId, people);
	}
}

/**
 * Where a connection may be used, in a sentence (#335): the line that tells two connections to one provider apart.
 * "Personal to Tom Davies, only in sessions acting as Tom Davies." "Shared with the Support project."
 */
export function usageText(
	connection: Pick<Connection, "owner" | "sharedWith" | "onlyProjects">,
	viewer: ConnectionsViewer,
	people?: (id: string) => string | undefined,
): string {
	const { owner } = connection;
	switch (owner.kind) {
		case "organisation": {
			const only = connection.onlyProjects ?? [];
			if (only.length > 0)
				return `Shared across ${viewer.organisation}, only in the ${listText(only.map((id) => projectName(viewer, id)))} ${only.length === 1 ? "project" : "projects"}.`;
			return `Shared across ${viewer.organisation}: organisation agents, and project agents its rules allow.`;
		}
		case "project":
			return `Shared with the ${projectName(viewer, owner.projectId)} project: its agents can use it.`;
		case "user": {
			const name = personName(viewer, owner.userId, people);
			const shares = connection.sharedWith ?? [];
			const base = `Personal to ${name}, only in sessions acting as ${name}`;
			if (shares.length === 0) return `${base}.`;
			const names = shares.map((id) => projectName(viewer, id));
			return `${base}, and shared with the ${listText(names)} ${shares.length === 1 ? "project" : "projects"}.`;
		}
	}
}

/** What an owner choice means, for the picker's hint. */
export function ownerChoiceHint(choice: OwnerChoice, viewer: ConnectionsViewer): string {
	switch (choice.kind) {
		case "user":
			return `Only sessions acting as you can use it. You can share it with a project later.`;
		case "project":
			return `Every agent in ${projectName(viewer, choice.projectId)} can use it, including scheduled runs.`;
		case "organisation":
			return `Organisation agents can use it, and project agents where its rules allow.`;
	}
}

export function ownerChoiceKey(choice: OwnerChoice): string {
	return choice.kind === "project" ? `project:${choice.projectId}` : choice.kind;
}

/** The owners a viewer may connect for: themselves, their projects, and the organisation for an admin. */
export function ownerChoices(
	viewer: ConnectionsViewer,
): readonly { value: string; label: string; choice: OwnerChoice }[] {
	return [
		{ value: "user", label: `Just me (${viewer.name})`, choice: { kind: "user" } },
		...viewer.projects.map((project) => ({
			value: `project:${project.id}`,
			label: `${project.name} project`,
			choice: { kind: "project", projectId: project.id } as const,
		})),
		...(viewer.admin
			? [{ value: "organisation", label: viewer.organisation, choice: { kind: "organisation" } as const }]
			: []),
	];
}

/** "a", "a and b", "a, b and c". */
export function listText(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** How a template connects, for its card: one click, needs a client set up, or a key. */
export type ConnectRoute = "one_click" | "needs_client" | "key";

export function connectRoute(template: ProviderTemplate): ConnectRoute {
	const oauth = template.authTypes.includes("oauth2") || template.authTypes.includes("mcp_oauth");
	if (!oauth) return "key";
	if (template.setup !== undefined) return template.setup === "ready" ? "one_click" : "needs_client";
	if (template.authTypes.includes("mcp_oauth") || template.client !== undefined) return "one_click";
	return "needs_client";
}

export function takesKey(template: ProviderTemplate): boolean {
	return template.authTypes.some((type) => KEY_AUTH_TYPES.includes(type));
}

export function routeText(template: ProviderTemplate): string {
	switch (connectRoute(template)) {
		case "one_click":
			return "Sign in";
		case "needs_client":
			return "Needs an OAuth client";
		case "key":
			return "API key";
	}
}

export const FAILURE_TEXT: Record<ConnectFailure, string> = {
	denied: "The sign-in was cancelled or access was refused, so nothing was connected.",
	expired: "The sign-in link expired before it was finished. Start again.",
	user_mismatch:
		"Someone other than the person this sign-in was for finished it, so nothing was stored. Sign in as yourself and try again.",
	no_client: "There's no OAuth client for this service yet. An admin can add one in OAuth clients.",
	discovery_failed: "The server didn't say how to sign in. Check the URL, or connect it with a key instead.",
	test_failed: "Signed in, but the test request failed.",
	provider_error: "The service returned an error during sign-in. Try again in a moment.",
};

// ---------------------------------------------------------------------------------------------------------------------
// Catalogue

/** Templates matching a search and a category, by name first, then summary and category. */
export function searchCatalogue(
	templates: readonly ProviderTemplate[],
	query: string,
	category?: string,
): readonly ProviderTemplate[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const inCategory = category === undefined ? templates : templates.filter((t) => t.category === category);
	if (words.length === 0) return inCategory;
	const scored = inCategory
		.map((template) => {
			const name = template.name.toLowerCase();
			const rest = `${template.summary} ${template.category} ${template.publisher ?? ""} ${template.id}`.toLowerCase();
			let score = 0;
			for (const word of words) {
				if (name.startsWith(word)) score += 4;
				else if (name.includes(word)) score += 3;
				else if (rest.includes(word)) score += 1;
				else return undefined;
			}
			return { template, score };
		})
		.filter((entry) => entry !== undefined);
	return scored
		.sort((a, b) => b.score - a.score || a.template.name.localeCompare(b.template.name))
		.map((e) => e.template);
}

/** The categories the catalogue uses, in the page's order, with counts. */
export function categoryCounts(templates: readonly ProviderTemplate[]): readonly { category: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const template of templates) counts.set(template.category, (counts.get(template.category) ?? 0) + 1);
	const known = CATEGORIES.filter((category) => counts.has(category));
	const other = [...counts.keys()].filter((category) => !(CATEGORIES as readonly string[]).includes(category)).sort();
	return [...known, ...other].map((category) => ({ category, count: counts.get(category) ?? 0 }));
}

/** The templates a pasted key looks like, from their key shapes (#330). Suggests only; the person confirms. */
export function detectKey(
	templates: readonly ProviderTemplate[],
	key: string,
): { template: ProviderTemplate; shape: KeyShape } | undefined {
	const value = key.trim();
	if (value.length < 8) return undefined;
	let best: { template: ProviderTemplate; shape: KeyShape; length: number } | undefined;
	for (const template of templates) {
		for (const shape of template.keyShapes ?? []) {
			const prefixOk = shape.prefix === undefined || value.startsWith(shape.prefix);
			const patternOk = shape.pattern === undefined || safeTest(shape.pattern, value);
			if (!prefixOk || !patternOk || (shape.prefix === undefined && shape.pattern === undefined)) continue;
			// The longest prefix wins: `github_pat_` over `gh`.
			const length = shape.prefix?.length ?? 0;
			if (best === undefined || length > best.length) best = { template, shape, length };
		}
	}
	return best === undefined ? undefined : { template: best.template, shape: best.shape };
}

function safeTest(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern).test(value);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation

/** Why an MCP server URL can't be used, or undefined when it can. https only (#338). */
export function mcpUrlError(value: string): string | undefined {
	const text = value.trim();
	if (text === "") return "Paste the server's URL.";
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return "That isn't a URL. It should look like https://mcp.example.com/mcp.";
	}
	if (url.protocol === "http:") return "Use https. Harbour sends credentials only over https.";
	if (url.protocol !== "https:") return "Use an https URL.";
	if (url.username !== "" || url.password !== "")
		return "Leave the credentials out of the URL. Harbour signs in for you.";
	return undefined;
}

/** Why a host pattern can't be used, or undefined (#330): a host or `*.host`, no scheme, path or plain http. */
export function hostPatternError(value: string): string | undefined {
	const text = value.trim();
	if (text === "") return "Add at least one host.";
	if (/^http:\/\//i.test(text)) return "Plain http isn't allowed. Harbour sends keys only over https.";
	const host = text.replace(/^https:\/\//i, "");
	if (/[/?#\s]/.test(host)) return "Just the host, such as api.example.com, without a path.";
	if (!/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?$/i.test(host))
		return "That isn't a host name, such as api.example.com.";
	return undefined;
}

/** The hosts in a comma- or line-separated list, without a scheme. */
export function parseHosts(value: string): readonly string[] {
	return value
		.split(/[\s,]+/)
		.map((host) => host.trim().replace(/^https:\/\//i, ""))
		.filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------------
// Connections

export interface ConnectionGroup {
	readonly key: string;
	readonly title: string;
	readonly connections: readonly Connection[];
}

/** Connections grouped by owner (#339): the viewer's own, then each project's, then the organisation's. */
export function groupConnections(
	connections: readonly Connection[],
	viewer: ConnectionsViewer,
	people?: (id: string) => string | undefined,
): readonly ConnectionGroup[] {
	const groups = new Map<string, { title: string; order: number; connections: Connection[] }>();
	for (const connection of connections) {
		const { owner } = connection;
		const [key, title, order] =
			owner.kind === "user"
				? owner.userId === viewer.userId
					? ["mine", "Yours", 0]
					: [`user:${owner.userId}`, `${personName(viewer, owner.userId, people)}'s`, 1]
				: owner.kind === "project"
					? [`project:${owner.projectId}`, `${projectName(viewer, owner.projectId)} project`, 2]
					: ["organisation", viewer.organisation, 3];
		const group = groups.get(key) ?? { title, order, connections: [] };
		group.connections.push(connection);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.sort(([, a], [, b]) => a.order - b.order || a.title.localeCompare(b.title))
		.map(([key, group]) => ({
			key,
			title: group.title,
			connections: group.connections.sort(
				(a, b) => attention(b) - attention(a) || a.name.localeCompare(b.name) || a.createdAt - b.createdAt,
			),
		}));
}

const attention = (connection: Connection): number => (connection.health === "healthy" ? 0 : 1);

/** How many connections need someone to act: the navigation's badge. */
export function needsAttention(connections: readonly Connection[]): number {
	return connections.filter((connection) => connection.health !== "healthy").length;
}

/** The viewer's connections to one template, for its page. */
export function connectionsFor(connections: readonly Connection[], templateId: string): readonly Connection[] {
	return connections.filter((connection) => connection.templateId === templateId);
}

/** A connection's name with its account, so two to one provider read apart: "GitHub", "tvdavies". */
export function accountText(connection: Connection): string | undefined {
	if (connection.label !== undefined && connection.account !== undefined)
		return `${connection.label}, ${connection.account}`;
	return connection.label ?? connection.account;
}

/** The client tier that wins for a template (#326): the narrowest enabled one. */
export function winningClient(clients: readonly OAuthClient[], templateId: string): OAuthClient | undefined {
	const order: readonly ClientTier[] = ["user", "project", "organisation", "deployment"];
	const enabled = clients.filter((client) => client.templateId === templateId && client.disabled !== true);
	for (const tier of order) {
		const found = enabled.find((client) => client.tier === tier);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The client secret's or key's presence in words: "Set, ends in 4f2a". */
export function secretText(secret: SecretHint): string {
	return `Set, ends in ${secret.last4}`;
}
