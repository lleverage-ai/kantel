/**
 * The provider catalogue Kantel ships (#325): templates held as data, no provider code. Remote MCP servers' auth was
 * read from each server's own metadata (RFC 9728 protected-resource metadata and its authorisation server's RFC 8414
 * metadata) on 30 Oct 2026: `registration` lists what that server offers, in Kantel's order (client, CIMD, DCR).
 *
 * Providers whose authorisation server offers neither CIMD nor DCR (GitHub, Google, Slack, Asana) need an OAuth app
 * someone registers (#326); until then they show `needs_client`, or connect by key where the provider has keys.
 */
import type { ClientRegistration, ProviderTemplate, ScopeSet } from "@kantel/contracts";

/** A site's icon by domain, so the catalogue carries no images. */
export const iconFor = (domain: string): string => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

const MCP_DISCOVERED = (registration: readonly ClientRegistration[]): ProviderTemplate["oauth"] => ({
	discovery: "mcp",
	pkce: true,
	registration,
});

/** A remote MCP server's template; its scopes come from discovery unless given. */
function mcpServer(input: {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly domain: string;
	readonly docsUrl: string;
	readonly category: ProviderTemplate["category"];
	readonly url: string;
	/** `none` for an open server; otherwise the ways a client can be had there. */
	readonly registration: readonly ClientRegistration[] | "none";
	readonly apiHosts?: readonly string[];
	readonly scopeSets?: readonly ScopeSet[];
	readonly key?: ProviderTemplate["key"];
}): ProviderTemplate {
	const host = new URL(input.url).hostname;
	const open = input.registration === "none";
	return {
		id: input.id,
		version: 1,
		name: input.name,
		description: input.description,
		icon: iconFor(input.domain),
		docsUrl: input.docsUrl,
		category: input.category,
		kind: "mcp",
		authTypes: open ? ["none"] : input.key === undefined ? ["oauth2"] : ["oauth2", "bearer"],
		apiHosts: input.apiHosts ?? [host],
		mcp: { url: input.url },
		...(open ? {} : { oauth: MCP_DISCOVERED(input.registration as readonly ClientRegistration[]) }),
		...(input.key === undefined ? {} : { key: input.key }),
		scopeSets: input.scopeSets ?? [],
		endpointHints: [],
		source: "shipped",
	};
}

const read = (id: string, label: string, scopes: readonly string[], extra: Partial<ScopeSet> = {}): ScopeSet => ({
	id,
	label,
	access: "read",
	scopes,
	default: true,
	...extra,
});
const write = (id: string, label: string, scopes: readonly string[], extra: Partial<ScopeSet> = {}): ScopeSet => ({
	id,
	label,
	access: "write",
	scopes,
	...extra,
});

/** Kantel's shipped templates, in the order the catalogue lists them. */
export const SHIPPED_TEMPLATES: readonly ProviderTemplate[] = [
	// HTTP APIs with OAuth apps someone must register (#326), or keys.
	{
		id: "github",
		version: 2,
		name: "GitHub",
		description: "Repositories, issues, pull requests and Actions through GitHub's REST and GraphQL APIs.",
		icon: iconFor("github.com"),
		docsUrl: "https://docs.github.com/en/rest",
		category: "developer",
		kind: "http",
		authTypes: ["oauth2", "bearer"],
		apiHosts: ["api.github.com", "uploads.github.com"],
		oauth: {
			discovery: "static",
			authorizationUrl: "https://github.com/login/oauth/authorize",
			tokenUrl: "https://github.com/login/oauth/access_token",
			pkce: true,
			registration: ["client"],
			// A public client the deployment supplies (no secret) signs in with GitHub's device flow (tier 2).
			deviceAuthorizationUrl: "https://github.com/login/device/code",
		},
		key: {
			injection: { kind: "bearer" },
			shapes: [
				{ label: "Fine-grained token", prefix: "github_pat_" },
				{ label: "Classic token", prefix: "ghp_" },
			],
		},
		scopeSets: [
			read("profile", "Your profile", ["read:user", "user:email"]),
			write("repo", "Repositories, issues and pull requests", ["repo"]),
			write("workflow", "GitHub Actions workflows", ["workflow"]),
		],
		endpointHints: [
			{ method: "GET", path: "/**", access: "read" },
			{ method: "*", path: "/**", access: "write" },
		],
		testRequest: {
			method: "GET",
			url: "https://api.github.com/user",
			account: { id: "id", name: "login", email: "email" },
		},
		source: "shipped",
		clientGuidance:
			"Register a GitHub App rather than an OAuth App, so tokens expire and can be limited to repositories.",
		guide: "github_app_manifest",
	},
	{
		id: "gmail",
		version: 2,
		name: "Gmail",
		description: "Read, search, draft and send Gmail messages.",
		icon: iconFor("mail.google.com"),
		docsUrl: "https://developers.google.com/gmail/api",
		category: "communication",
		kind: "http",
		authTypes: ["oauth2"],
		apiHosts: ["gmail.googleapis.com", "www.googleapis.com"],
		oauth: {
			discovery: "static",
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			revocationUrl: "https://oauth2.googleapis.com/revoke",
			extraAuthorizationParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
			pkce: true,
			registration: ["client"],
		},
		scopeSets: [
			read("identity", "Your email address", ["openid", "email", "profile"]),
			read("mail-read", "Read mail", ["https://www.googleapis.com/auth/gmail.readonly"]),
			write("mail-compose", "Draft and send mail", ["https://www.googleapis.com/auth/gmail.compose"]),
		],
		endpointHints: [
			{ method: "GET", path: "/**", access: "read" },
			{ method: "*", path: "/**", access: "write" },
		],
		testRequest: {
			method: "GET",
			url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
			account: { email: "emailAddress" },
		},
		source: "shipped",
		clientGuidance:
			"Gmail's scopes are restricted: keep the app in Testing for your own use, or have Google verify it.",
		guide: "google",
	},
	{
		id: "google-drive",
		version: 2,
		name: "Google Drive",
		description: "Find, read and create files in Google Drive, Docs and Sheets.",
		icon: iconFor("drive.google.com"),
		docsUrl: "https://developers.google.com/drive/api",
		category: "productivity",
		kind: "http",
		authTypes: ["oauth2"],
		apiHosts: ["www.googleapis.com", "docs.googleapis.com", "sheets.googleapis.com"],
		oauth: {
			discovery: "static",
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			revocationUrl: "https://oauth2.googleapis.com/revoke",
			extraAuthorizationParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
			pkce: true,
			registration: ["client"],
		},
		scopeSets: [
			read("identity", "Your email address", ["openid", "email", "profile"]),
			read("drive-read", "Read files", ["https://www.googleapis.com/auth/drive.readonly"]),
			write("drive-file", "Files Kantel creates or opens", ["https://www.googleapis.com/auth/drive.file"]),
		],
		endpointHints: [
			{ method: "GET", path: "/**", access: "read" },
			{ method: "*", path: "/**", access: "write" },
		],
		testRequest: {
			method: "GET",
			url: "https://www.googleapis.com/drive/v3/about?fields=user",
			account: { name: "user.displayName", email: "user.emailAddress" },
		},
		source: "shipped",
		guide: "google",
	},
	{
		id: "google-calendar",
		version: 2,
		name: "Google Calendar",
		description: "Read and manage events in Google Calendar.",
		icon: iconFor("calendar.google.com"),
		docsUrl: "https://developers.google.com/calendar/api",
		category: "productivity",
		kind: "http",
		authTypes: ["oauth2"],
		apiHosts: ["www.googleapis.com"],
		oauth: {
			discovery: "static",
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			revocationUrl: "https://oauth2.googleapis.com/revoke",
			extraAuthorizationParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
			pkce: true,
			registration: ["client"],
		},
		scopeSets: [
			read("identity", "Your email address", ["openid", "email", "profile"]),
			read("calendar-read", "Read calendars", ["https://www.googleapis.com/auth/calendar.readonly"]),
			write("calendar-events", "Manage events", ["https://www.googleapis.com/auth/calendar.events"]),
		],
		endpointHints: [
			{ method: "GET", path: "/**", access: "read" },
			{ method: "*", path: "/**", access: "write" },
		],
		source: "shipped",
		guide: "google",
	},
	{
		id: "slack",
		version: 1,
		name: "Slack",
		description: "Search, read and post messages in Slack through Slack's own MCP server.",
		icon: iconFor("slack.com"),
		docsUrl: "https://docs.slack.dev/ai/mcp-server",
		category: "communication",
		kind: "mcp",
		authTypes: ["oauth2"],
		apiHosts: ["mcp.slack.com"],
		mcp: { url: "https://mcp.slack.com/mcp" },
		// Slack's server offers neither CIMD nor DCR: a Slack app must be registered.
		oauth: { discovery: "mcp", pkce: true, registration: ["client"] },
		scopeSets: [
			read("read", "Read channels and messages", [
				"channels:history",
				"channels:read",
				"search:read.public",
				"users:read",
			]),
			write("post", "Post messages", ["chat:write"]),
		],
		endpointHints: [],
		source: "shipped",
	},
	{
		id: "github-mcp",
		version: 1,
		name: "GitHub (MCP)",
		description: "GitHub's own remote MCP server: repositories, issues, pull requests and Actions as tools.",
		icon: iconFor("github.com"),
		docsUrl: "https://github.com/github/github-mcp-server",
		category: "developer",
		kind: "mcp",
		authTypes: ["oauth2", "bearer"],
		apiHosts: ["api.githubcopilot.com"],
		mcp: { url: "https://api.githubcopilot.com/mcp/" },
		// GitHub's authorisation server offers neither CIMD nor DCR; a personal access token works as a key.
		oauth: { discovery: "mcp", pkce: true, registration: ["client"] },
		key: { injection: { kind: "bearer" }, shapes: [{ label: "Fine-grained token", prefix: "github_pat_" }] },
		scopeSets: [],
		endpointHints: [],
		source: "shipped",
	},

	// Remote MCP servers that connect with no app registered (CIMD or DCR).
	mcpServer({
		id: "linear",
		name: "Linear",
		description: "Find, create and update Linear issues, projects and comments.",
		domain: "linear.app",
		docsUrl: "https://linear.app/docs/mcp",
		category: "project_management",
		url: "https://mcp.linear.app/mcp",
		registration: ["client", "cimd", "dcr"],
		scopeSets: [read("read", "Read", ["read"]), write("write", "Write", ["write"])],
	}),
	mcpServer({
		id: "notion",
		name: "Notion",
		description: "Search, read and edit Notion pages and databases.",
		domain: "notion.so",
		docsUrl: "https://developers.notion.com/docs/mcp",
		category: "knowledge",
		url: "https://mcp.notion.com/mcp",
		registration: ["client", "cimd", "dcr"],
	}),
	mcpServer({
		id: "atlassian",
		name: "Atlassian",
		description: "Jira issues and Confluence pages through Atlassian's remote MCP server.",
		domain: "atlassian.com",
		docsUrl: "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/",
		category: "project_management",
		url: "https://mcp.atlassian.com/v1/mcp",
		registration: ["client", "dcr"],
	}),
	mcpServer({
		id: "sentry",
		name: "Sentry",
		description: "Look up Sentry issues, events and releases.",
		domain: "sentry.io",
		docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
		category: "developer",
		url: "https://mcp.sentry.dev/mcp",
		registration: ["client", "cimd", "dcr"],
	}),
	mcpServer({
		id: "stripe",
		name: "Stripe",
		description: "Customers, payments, invoices and Stripe's documentation.",
		domain: "stripe.com",
		docsUrl: "https://docs.stripe.com/mcp",
		category: "payments",
		url: "https://mcp.stripe.com",
		registration: ["client", "dcr"],
		key: { injection: { kind: "bearer" }, shapes: [{ label: "Restricted key", prefix: "rk_" }] },
	}),
	mcpServer({
		id: "vercel",
		name: "Vercel",
		description: "Projects, deployments and logs on Vercel.",
		domain: "vercel.com",
		docsUrl: "https://vercel.com/docs/mcp/vercel-mcp",
		category: "cloud",
		url: "https://mcp.vercel.com",
		registration: ["client", "cimd", "dcr"],
	}),
	mcpServer({
		id: "cloudflare-bindings",
		name: "Cloudflare",
		description: "Workers, KV, R2 and D1 on a Cloudflare account.",
		domain: "cloudflare.com",
		docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
		category: "cloud",
		url: "https://bindings.mcp.cloudflare.com/mcp",
		registration: ["client", "dcr"],
	}),
	mcpServer({
		id: "supabase",
		name: "Supabase",
		description: "Supabase projects, databases and edge functions.",
		domain: "supabase.com",
		docsUrl: "https://supabase.com/docs/guides/getting-started/mcp",
		category: "data",
		url: "https://mcp.supabase.com/mcp",
		registration: ["client", "dcr"],
	}),
	mcpServer({
		id: "neon",
		name: "Neon",
		description: "Neon Postgres projects, branches and queries.",
		domain: "neon.tech",
		docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
		category: "data",
		url: "https://mcp.neon.tech/mcp",
		registration: ["client", "dcr"],
	}),
	mcpServer({
		id: "canva",
		name: "Canva",
		description: "Find, create and edit Canva designs.",
		domain: "canva.com",
		docsUrl: "https://www.canva.dev/docs/mcp/",
		category: "design",
		url: "https://mcp.canva.com/mcp",
		registration: ["client", "cimd", "dcr"],
	}),
	mcpServer({
		id: "intercom",
		name: "Intercom",
		description: "Conversations and contacts in Intercom.",
		domain: "intercom.com",
		docsUrl: "https://developers.intercom.com/docs/guides/mcp",
		category: "crm",
		url: "https://mcp.intercom.com/mcp",
		registration: ["client", "dcr"],
	}),
	mcpServer({
		id: "monday",
		name: "monday.com",
		description: "Boards, items and updates on monday.com.",
		domain: "monday.com",
		docsUrl: "https://developer.monday.com/apps/docs/mondaycom-mcp-integration",
		category: "project_management",
		url: "https://mcp.monday.com/mcp",
		registration: ["client", "cimd", "dcr"],
	}),
	mcpServer({
		id: "paypal",
		name: "PayPal",
		description: "Invoices, orders and transactions on PayPal.",
		domain: "paypal.com",
		docsUrl: "https://developer.paypal.com/tools/mcp-server/",
		category: "payments",
		url: "https://mcp.paypal.com/mcp",
		registration: ["client", "dcr"],
	}),
	mcpServer({
		id: "square",
		name: "Square",
		description: "Payments, orders and catalogue on Square.",
		domain: "squareup.com",
		docsUrl: "https://developer.squareup.com/docs/mcp",
		category: "payments",
		url: "https://mcp.squareup.com/mcp",
		registration: ["client", "dcr"],
	}),
	mcpServer({
		id: "hugging-face",
		name: "Hugging Face",
		description: "Search models, datasets, Spaces and papers on Hugging Face.",
		domain: "huggingface.co",
		docsUrl: "https://huggingface.co/settings/mcp",
		category: "ai",
		url: "https://huggingface.co/mcp",
		registration: ["client", "cimd", "dcr"],
	}),

	// Open remote MCP servers: nothing to sign in to.
	mcpServer({
		id: "deepwiki",
		name: "DeepWiki",
		description: "Ask questions about any public GitHub repository's code and docs.",
		domain: "deepwiki.com",
		docsUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
		category: "developer",
		url: "https://mcp.deepwiki.com/mcp",
		registration: "none",
	}),
	mcpServer({
		id: "cloudflare-docs",
		name: "Cloudflare docs",
		description: "Search Cloudflare's developer documentation.",
		domain: "developers.cloudflare.com",
		docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
		category: "developer",
		url: "https://docs.mcp.cloudflare.com/mcp",
		registration: "none",
	}),

	// Keys only.
	{
		id: "linear-api",
		version: 1,
		name: "Linear API",
		description: "Linear's GraphQL API with a personal API key.",
		icon: iconFor("linear.app"),
		docsUrl: "https://linear.app/developers/graphql",
		category: "project_management",
		kind: "http",
		authTypes: ["header"],
		apiHosts: ["api.linear.app"],
		key: { injection: { kind: "header", header: "Authorization" }, shapes: [{ label: "API key", prefix: "lin_api_" }] },
		scopeSets: [],
		endpointHints: [{ method: "POST", path: "/graphql", access: "write" }],
		source: "shipped",
	},
	{
		id: "notion-api",
		version: 1,
		name: "Notion API",
		description: "Notion's REST API with an internal integration token.",
		icon: iconFor("notion.so"),
		docsUrl: "https://developers.notion.com/reference/intro",
		category: "knowledge",
		kind: "http",
		authTypes: ["bearer"],
		apiHosts: ["api.notion.com"],
		key: { injection: { kind: "bearer" }, shapes: [{ label: "Integration token", prefix: "ntn_" }] },
		scopeSets: [],
		endpointHints: [
			{ method: "GET", path: "/**", access: "read" },
			{ method: "*", path: "/**", access: "write" },
		],
		testRequest: { method: "GET", url: "https://api.notion.com/v1/users/me", account: { id: "id", name: "name" } },
		source: "shipped",
	},
	{
		id: "openai",
		version: 1,
		name: "OpenAI API",
		description: "OpenAI's API with a project key.",
		icon: iconFor("openai.com"),
		docsUrl: "https://platform.openai.com/docs/api-reference",
		category: "ai",
		kind: "http",
		authTypes: ["bearer"],
		apiHosts: ["api.openai.com"],
		key: { injection: { kind: "bearer" }, shapes: [{ label: "Project key", prefix: "sk-proj-" }] },
		scopeSets: [],
		endpointHints: [],
		source: "shipped",
	},
];

/** A template by ID from `templates`, or `undefined`. */
export function templateById(templates: readonly ProviderTemplate[], id: string): ProviderTemplate | undefined {
	return templates.find((template) => template.id === id);
}

/** The template whose MCP endpoint is `url`, ignoring a trailing slash. */
export function templateForMcpUrl(templates: readonly ProviderTemplate[], url: string): ProviderTemplate | undefined {
	const bare = (value: string) => value.replace(/\/+$/, "");
	return templates.find((template) => template.mcp !== undefined && bare(template.mcp.url) === bare(url));
}

/**
 * The catalogue: shipped templates with the deployment's added or overriding ones (same ID replaces). Templates are
 * checked here so a bad deployment template fails at start, not at a connect.
 */
export function buildCatalogue(extra: readonly ProviderTemplate[] = []): readonly ProviderTemplate[] {
	const byId = new Map<string, ProviderTemplate>();
	for (const template of [...SHIPPED_TEMPLATES, ...extra]) {
		assertTemplate(template);
		byId.set(template.id, template);
	}
	return [...byId.values()];
}

export function assertTemplate(template: ProviderTemplate): void {
	const fail = (why: string) => {
		throw new Error(`Provider template ${template.id}: ${why}`);
	};
	if (!/^[a-z0-9][a-z0-9-]*$/.test(template.id)) fail("its ID must be lower case letters, digits and dashes");
	if (template.apiHosts.length === 0) fail("it needs at least one API host");
	if (template.authTypes.length === 0) fail("it needs at least one auth type");
	if (template.kind === "mcp") {
		if (template.mcp === undefined) fail("an MCP template needs its server's URL");
		const host = new URL(template.mcp!.url).hostname;
		if (!template.apiHosts.includes(host)) fail("its MCP server's host must be one of its API hosts");
	}
	if (template.authTypes.includes("oauth2") && template.oauth === undefined) fail("an OAuth template needs `oauth`");
	if (
		template.oauth?.discovery === "static" &&
		(template.oauth.authorizationUrl === undefined || template.oauth.tokenUrl === undefined)
	) {
		fail("a static OAuth template needs its authorisation and token URLs");
	}
	const device = template.oauth?.deviceAuthorizationUrl;
	if (device !== undefined && (template.oauth?.discovery !== "static" || !device.startsWith("https://"))) {
		fail("a device authorisation URL is an https URL on a static OAuth template");
	}
	const keyed = template.authTypes.some((type) =>
		["bearer", "header", "query", "basic", "header_template"].includes(type),
	);
	if (keyed && template.key === undefined) fail("a key template needs `key`");
}
