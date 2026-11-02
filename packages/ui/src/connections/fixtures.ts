// Fixtures for the Connections page: a catalogue, an organisation's connections and OAuth clients, and an in-memory
// source that connects, disconnects and registers clients the way the API will, with a short delay on each call.
// Stories and the console's recorded mode use them; nothing here is a real credential.

import {
	type ConnectionCeiling,
	type ConnectionDecision,
	type ConnectionOperation,
	type ConnectionRule,
	type ConnectionRuleInput,
	type ConnectionRules,
	DEFAULT_UNMATCHED,
	decideConnectionRules,
	defaultRuleInputs,
	type EndpointHint,
	methodAccess,
	pathPatternProblem,
	requestWithinCeiling,
	ruleOutsideCeiling,
} from "@kantel/contracts";

/**
 * What a GitHub request does, roughly as the server's classifier (#465) says it, for the fixtures' dry run and the
 * grid's tests: Actions under a repository are `workflow`, the signed-in person's account `profile`, the rest `repo`;
 * a GraphQL document that says `mutation` writes and any other reads. The real one reads GitHub's REST description.
 */
export function fixtureOperation(
	method: Parameters<typeof methodAccess>[0],
	path: string,
	body?: string,
): ConnectionOperation {
	const repo = /^\/repos\/([^/]+\/[^/]+)(\/|$)/.exec(path)?.[1];
	const group = /^\/repos\/[^/]+\/[^/]+\/actions(\/|$)/.test(path)
		? "workflow"
		: /^\/users?(\/|$)/.test(path)
			? "profile"
			: "repo";
	const access =
		path === "/graphql" && method === "POST"
			? body === undefined || /\bmutation\b/.test(body)
				? "write"
				: "read"
			: methodAccess(method);
	return { label: `${method} ${path}`, group, access, ...(repo === undefined ? {} : { resource: repo }) };
}

import type { SessionAccessConnection, SessionAccessSource } from "../session/access-connections.tsx";
import type {
	SessionConnectionView,
	SessionVisibility,
	SessionVisibilitySource,
} from "../session/session-visibility.tsx";
import { type PolicyChoice, planPolicy } from "./connection-policy-model.ts";
import {
	type ConnectAttemptState,
	type Connection,
	type ConnectionOwner,
	type ConnectionReachView,
	type ConnectionRulesSource,
	type ConnectionSharingSource,
	type ConnectionsSource,
	type ConnectionsViewer,
	type ConnectionUseView,
	type ConnectStart,
	canManage,
	type OAuthClient,
	type OwnerChoice,
	type ProviderTemplate,
	type RecentUseView,
	type ScopeSet,
	type SetupGuide,
} from "./connections-model.ts";
import { appIcon, logo } from "./fixture-logos.ts";

export const FIXTURE_NOW = Date.UTC(2026, 9, 30, 14, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const VIEWER: ConnectionsViewer = {
	userId: "usr_tom",
	name: "Tom Davies",
	organisation: "Acme",
	projects: [
		{ id: "proj_support", name: "Support" },
		{ id: "proj_billing", name: "Billing" },
	],
	admin: true,
	host: "Lleverage",
};

/** A member who isn't an admin: no organisation connections, no client settings. */
export const MEMBER_VIEWER: ConnectionsViewer = { ...VIEWER, admin: false };

/** Ana, an organisation admin, looking at Tom's connections: she sees them, but can't use or share them. */
export const ADMIN_OTHER_VIEWER: ConnectionsViewer = { ...VIEWER, userId: "usr_ana", name: "Ana Ruiz" };

export const PEOPLE: Readonly<Record<string, string>> = { usr_tom: "Tom Davies", usr_ana: "Ana Ruiz" };

const read = (id: string, label: string, description: string, scopes: string[]): ScopeSet => ({
	id,
	label,
	description,
	access: "read",
	scopes,
	default: true,
});
const write = (id: string, label: string, description: string, scopes: string[]): ScopeSet => ({
	id,
	label,
	description,
	access: "write",
	scopes,
});

const hostClient = { tier: "deployment", ownerLabel: "Lleverage" } as const;
const REDIRECT = "https://kantel.lleverage.ai/v1/connections/callback";

/** The setup guide for a Google API (tier 3), as the catalogue sends it with this deployment's redirect URI. */
export function googleGuide(name: string, api: string, scopes: readonly string[], restricted = false): SetupGuide {
	return {
		kind: "steps",
		provider: "Google Cloud",
		redirectUri: REDIRECT,
		steps: [
			{
				title: "Pick a Google Cloud project",
				detail: "Use one you have, or create one just for Kantel. It holds the app; nothing in it is billed.",
				link: { label: "Create a project", url: "https://console.cloud.google.com/projectcreate" },
			},
			{
				title: `Turn on the ${name} API`,
				detail: `In the project's API library, enable the ${name} API so the app may call it.`,
				link: { label: `Enable the ${name} API`, url: `https://console.cloud.google.com/apis/library/${api}` },
			},
			{
				title: "Set up the consent screen",
				detail:
					"In Google Auth Platform, give the app a name and your support email, choose External as its audience, and under Audience add your own Google account as a test user.",
				link: { label: "Open Google Auth Platform", url: "https://console.cloud.google.com/auth/overview" },
			},
			{
				title: "Add the scopes",
				detail: "Under Data access, add each of these scopes, so the consent screen lists what Kantel asks for.",
				values: scopes.map((scope) => ({ label: "Scope", value: scope })),
				link: { label: "Open Data access", url: "https://console.cloud.google.com/auth/scopes" },
			},
			{
				title: "Create the OAuth client",
				detail:
					"Under Clients, create a client of type Web application and add this as an authorised redirect URI, exactly as it is. Google shows the client ID and secret once: keep the window open for the last step.",
				values: [{ label: "Authorised redirect URI", value: REDIRECT }],
				link: { label: "Create an OAuth client", url: "https://console.cloud.google.com/auth/clients/create" },
			},
		],
		notes: [
			{
				level: "warning",
				text: "While the app's publishing status is Testing, Google ends each sign-in after seven days: reconnect every week, or publish the app.",
			},
			...(restricted
				? [
						{
							level: "info" as const,
							text: `${name}'s scopes are restricted. For your own use, leave the app in Testing: only its test users (up to 100) can connect, and Google warns them that it's unverified. Publishing it for anyone needs Google's verification and a security assessment.`,
						},
					]
				: []),
		],
	};
}

/** GitHub's guide: Kantel can have GitHub create the app from a manifest, or it is registered by hand. */
export function githubGuide(): SetupGuide {
	return {
		kind: "github_app_manifest",
		provider: "GitHub",
		redirectUri: REDIRECT,
		steps: [
			{
				title: "Register a GitHub App",
				detail:
					"In GitHub, under Settings, Developer settings, GitHub Apps, choose New GitHub App. A GitHub App rather than an OAuth App: its tokens expire and it can be limited to chosen repositories. Turn off the webhook.",
				link: { label: "New GitHub App", url: "https://github.com/settings/apps/new" },
			},
			{
				title: "Set the callback URL",
				detail:
					"Add this as the callback URL, exactly as it is, and tick Request user authorization (OAuth) during installation.",
				values: [{ label: "Callback URL", value: REDIRECT }],
			},
			{
				title: "Choose its permissions",
				detail:
					"Repository permissions: Contents, Issues, Pull requests and Actions, read and write. Organisation permissions: Members, read only. Agents get no more than these, whatever they ask for.",
			},
			{
				title: "Generate a client secret, then install it",
				detail:
					"On the app's page, copy the client ID, generate a client secret, then install the app on the repositories agents may use.",
			},
		],
	};
}

/** GitHub with nothing provided: its own app still to create, with the manifest flow on offer (tier 3). */
export const GITHUB_OWN_APP: ProviderTemplate = {
	id: "github",
	name: "GitHub",
	summary: "Repositories, issues, pull requests and Actions.",
	category: "Developer tools",
	icon: logo("github"),
	docsUrl: "https://docs.github.com/en/rest",
	authTypes: ["oauth2", "bearer"],
	apiHosts: ["api.github.com", "uploads.github.com"],
	scopeSets: [],
	tier: "own_app",
	guide: githubGuide(),
};

/** GitHub once Acme's GitHub App is made from Kantel's manifest: kantel-agent, ready to install and sign in through. */
export const GITHUB_APP_MADE: ProviderTemplate = {
	...GITHUB_OWN_APP,
	description:
		"Let agents read code, open and review pull requests, triage issues and check workflow runs. Every request goes out as the account that connected, through Kantel's egress proxy, so the token never reaches the agent.",
	scopeSets: [
		read("profile", "Your profile", "Your name and email.", ["read:user", "user:email"]),
		write("repo", "Repositories, issues and pull requests", "Code, issues and pull requests.", ["repo"]),
	],
	client: {
		tier: "organisation",
		ownerLabel: "Acme",
		label: "GitHub App kantel-agent",
		public: false,
		githubApp: {
			slug: "kantel-agent",
			installUrl: "https://github.com/apps/kantel-agent/installations/new",
			appUrl: "https://github.com/apps/kantel-agent",
		},
	},
	setup: "ready",
	tier: "host_client",
	signIn: "browser",
};

/** About thirty templates across the categories, as the shipped catalogue will have. */
export const CATALOGUE: readonly ProviderTemplate[] = [
	{
		id: "github",
		name: "GitHub",
		summary: "Repositories, issues, pull requests and Actions.",
		description:
			"Let agents read code, open and review pull requests, triage issues and check workflow runs. Every request goes out as the account that connected, through Kantel's egress proxy, so the token never reaches the agent.",
		category: "Developer tools",
		icon: logo("github"),
		docsUrl: "https://docs.github.com/en/rest",
		authTypes: ["oauth2", "bearer"],
		apiHosts: ["api.github.com", "uploads.github.com"],
		scopeSets: [
			read("read", "Read repositories and issues", "Code, issues, pull requests and workflow runs.", [
				"repo:read",
				"read:org",
			]),
			write(
				"write",
				"Open pull requests and comment",
				"Push branches, open and review pull requests, comment on issues.",
				["repo"],
			),
			write("admin", "Manage repository settings", "Webhooks, branch protection and collaborators.", [
				"admin:repo_hook",
			]),
		],
		keyShapes: [
			{ label: "a GitHub fine-grained token", prefix: "github_pat_" },
			{ label: "a GitHub classic token", prefix: "ghp_" },
		],
		keyHelp: "Make a fine-grained token in GitHub under Settings, Developer settings, Personal access tokens.",
		client: { tier: "deployment", ownerLabel: "Lleverage", label: "Kantel for GitHub", public: true },
		tier: "public_client",
		signIn: "device",
		clientGuidance:
			"Register a GitHub App rather than an OAuth App, so tokens expire and can be limited to repositories.",
		guide: githubGuide(),
	},
	{
		id: "gitlab",
		name: "GitLab",
		summary: "Projects, merge requests and pipelines.",
		category: "Developer tools",
		icon: logo("gitlab"),
		docsUrl: "https://docs.gitlab.com/ee/api/rest/",
		authTypes: ["oauth2", "bearer"],
		apiHosts: ["gitlab.com"],
		scopeSets: [read("read", "Read projects", "Code, issues, merge requests and pipelines.", ["read_api"])],
		keyShapes: [{ label: "a GitLab personal access token", prefix: "glpat-" }],
	},
	{
		id: "linear",
		name: "Linear",
		summary: "Issues, projects and cycles.",
		description:
			"Linear's own MCP server. Agents can find and update issues, file bugs with what they found, and follow a project's progress. Kantel signs in for you and applies a rule to each tool.",
		category: "Developer tools",
		// A logo with a dark background of its own, as Linear's favicon is.
		icon: appIcon("linear", "222326", "F4F5F8"),
		docsUrl: "https://linear.app/docs/mcp",
		authTypes: ["mcp_oauth"],
		mcpUrl: "https://mcp.linear.app/mcp",
		apiHosts: ["mcp.linear.app"],
		scopeSets: [],
	},
	{
		id: "deepwiki",
		name: "DeepWiki",
		summary: "Docs and answers about public code, from Devin.",
		description: "DeepWiki's MCP server. It needs no sign-in: agents can read its wiki pages and ask it questions.",
		category: "Developer tools",
		docsUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
		authTypes: ["mcp_oauth"],
		mcpUrl: "https://mcp.deepwiki.com/mcp",
		apiHosts: ["mcp.deepwiki.com"],
		scopeSets: [],
		setup: "ready",
		open: true,
	},
	{
		id: "jira",
		name: "Jira",
		summary: "Issues, boards and sprints in Atlassian Cloud.",
		category: "Developer tools",
		icon: logo("jira"),
		docsUrl: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/",
		authTypes: ["oauth2", "basic"],
		apiHosts: ["api.atlassian.com", "*.atlassian.net"],
		scopeSets: [
			read("read", "Read issues", "Issues, boards and sprints.", ["read:jira-work"]),
			write("write", "Create and edit issues", "Create, edit and transition issues.", ["write:jira-work"]),
		],
		publisher: "Atlassian",
		clientGuidance: "Add the offline_access scope to the Atlassian app, or connections stop working after an hour.",
	},
	{
		id: "sentry",
		name: "Sentry",
		summary: "Errors, issues and releases.",
		category: "Developer tools",
		icon: logo("sentry"),
		docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
		authTypes: ["mcp_oauth", "bearer"],
		mcpUrl: "https://mcp.sentry.dev/mcp",
		apiHosts: ["mcp.sentry.dev", "sentry.io"],
		scopeSets: [],
		keyShapes: [{ label: "a Sentry auth token", prefix: "sntrys_" }],
	},
	{
		id: "vercel",
		name: "Vercel",
		summary: "Deployments, domains and logs.",
		category: "Developer tools",
		icon: logo("vercel"),
		docsUrl: "https://vercel.com/docs/rest-api",
		authTypes: ["bearer"],
		apiHosts: ["api.vercel.com"],
		scopeSets: [],
		keyHelp: "Make a token in Vercel under Account Settings, Tokens, scoped to one team.",
	},
	{
		id: "cloudflare",
		name: "Cloudflare",
		summary: "Workers, DNS, R2 and analytics.",
		category: "Developer tools",
		icon: logo("cloudflare"),
		docsUrl: "https://developers.cloudflare.com/api/",
		authTypes: ["bearer"],
		apiHosts: ["api.cloudflare.com"],
		scopeSets: [],
		keyHelp:
			"Make an API token in the Cloudflare dashboard under My Profile, API Tokens, with only the permissions agents need.",
	},
	{
		id: "pagerduty",
		name: "PagerDuty",
		summary: "Incidents, on-call schedules and services.",
		category: "Developer tools",
		icon: logo("pagerduty"),
		docsUrl: "https://developer.pagerduty.com/api-reference/",
		authTypes: ["oauth2", "header"],
		apiHosts: ["api.pagerduty.com"],
		scopeSets: [read("read", "Read incidents", "Incidents, schedules and services.", ["read"])],
	},
	{
		id: "datadog",
		name: "Datadog",
		summary: "Metrics, logs and monitors.",
		category: "Developer tools",
		icon: logo("datadog"),
		docsUrl: "https://docs.datadoghq.com/api/",
		authTypes: ["header"],
		apiHosts: ["api.datadoghq.com", "api.datadoghq.eu"],
		scopeSets: [],
	},
	{
		id: "notion",
		name: "Notion",
		summary: "Pages, databases and comments.",
		description:
			"Notion's own MCP server. Agents can search the workspace, read pages and databases, and write up what they did as a page.",
		category: "Productivity",
		// And one with a white background, as Notion's is.
		icon: appIcon("notion", "FFFFFF", "000000"),
		docsUrl: "https://developers.notion.com/docs/mcp",
		authTypes: ["mcp_oauth"],
		mcpUrl: "https://mcp.notion.com/mcp",
		apiHosts: ["mcp.notion.com"],
		scopeSets: [],
	},
	{
		id: "confluence",
		name: "Confluence",
		summary: "Spaces, pages and comments in Atlassian Cloud.",
		category: "Productivity",
		icon: logo("confluence"),
		docsUrl: "https://developer.atlassian.com/cloud/confluence/rest/v2/",
		authTypes: ["oauth2"],
		apiHosts: ["api.atlassian.com"],
		scopeSets: [read("read", "Read pages", "Spaces, pages and attachments.", ["read:confluence-content.all"])],
		publisher: "Atlassian",
	},
	{
		id: "google-drive",
		name: "Google Drive",
		summary: "Files and folders in Drive.",
		description:
			"Agents can search Drive and read the files people share with them. Editing every file is off unless you pick it: Google treats it as a restricted scope.",
		category: "Productivity",
		icon: logo("googledrive"),
		docsUrl: "https://developers.google.com/drive/api",
		authTypes: ["oauth2"],
		apiHosts: ["www.googleapis.com"],
		scopeSets: [
			read("read", "See files opened with it", "Only files an agent is given or creates.", [
				"https://www.googleapis.com/auth/drive.file",
			]),
			write("write", "See, edit and delete all files", "Every file in Drive. Google treats this as restricted.", [
				"https://www.googleapis.com/auth/drive",
			]),
		],
		publisher: "Google",
		client: hostClient,
		clientGuidance:
			"Publish the Google app (In production, not Testing): a testing app's refresh tokens expire after seven days.",
	},
	{
		id: "google-sheets",
		name: "Google Sheets",
		summary: "Spreadsheets: read ranges, append rows.",
		category: "Productivity",
		icon: logo("googlesheets"),
		docsUrl: "https://developers.google.com/sheets/api",
		authTypes: ["oauth2"],
		apiHosts: ["sheets.googleapis.com"],
		scopeSets: [
			read("read", "Read spreadsheets", "Values and formatting.", [
				"https://www.googleapis.com/auth/spreadsheets.readonly",
			]),
		],
		publisher: "Google",
		client: hostClient,
	},
	{
		id: "google-calendar",
		name: "Google Calendar",
		summary: "Events, availability and invitations.",
		category: "Productivity",
		icon: logo("googlecalendar"),
		docsUrl: "https://developers.google.com/calendar/api",
		authTypes: ["oauth2"],
		apiHosts: ["www.googleapis.com"],
		scopeSets: [
			read("read", "See calendars", "Events and free and busy times.", [
				"https://www.googleapis.com/auth/calendar.readonly",
			]),
			write("write", "Create and change events", "Add events and answer invitations.", [
				"https://www.googleapis.com/auth/calendar.events",
			]),
		],
		publisher: "Google",
	},
	{
		id: "asana",
		name: "Asana",
		summary: "Tasks, projects and portfolios.",
		category: "Productivity",
		icon: logo("asana"),
		docsUrl: "https://developers.asana.com/docs",
		authTypes: ["oauth2", "bearer"],
		apiHosts: ["app.asana.com"],
		scopeSets: [read("read", "Read tasks", "Tasks, projects and comments.", ["default"])],
	},
	{
		id: "trello",
		name: "Trello",
		summary: "Boards, lists and cards.",
		category: "Productivity",
		icon: logo("trello"),
		docsUrl: "https://developer.atlassian.com/cloud/trello/rest/",
		authTypes: ["query"],
		apiHosts: ["api.trello.com"],
		scopeSets: [],
		publisher: "Atlassian",
	},
	{
		id: "todoist",
		name: "Todoist",
		summary: "Tasks and projects.",
		category: "Productivity",
		icon: logo("todoist"),
		docsUrl: "https://developer.todoist.com/rest/v2/",
		authTypes: ["oauth2", "bearer"],
		apiHosts: ["api.todoist.com"],
		scopeSets: [read("read", "Read tasks", "Tasks, projects and labels.", ["data:read"])],
	},
	{
		id: "dropbox",
		name: "Dropbox",
		summary: "Files, folders and sharing links.",
		category: "Productivity",
		icon: logo("dropbox"),
		docsUrl: "https://www.dropbox.com/developers/documentation/http/documentation",
		authTypes: ["oauth2"],
		apiHosts: ["api.dropboxapi.com", "content.dropboxapi.com"],
		scopeSets: [read("read", "Read files", "File contents and metadata.", ["files.content.read"])],
	},
	{
		id: "figma",
		name: "Figma",
		summary: "Files, comments and components.",
		category: "Productivity",
		icon: logo("figma"),
		docsUrl: "https://www.figma.com/developers/api",
		authTypes: ["oauth2", "header"],
		apiHosts: ["api.figma.com"],
		scopeSets: [read("read", "Read files", "Files, comments and components.", ["file_content:read"])],
		keyShapes: [{ label: "a Figma personal access token", prefix: "figd_" }],
	},
	{
		id: "slack",
		name: "Slack",
		summary: "Channels, messages and search.",
		description:
			"Agents can search messages, read the channels the app is in and post replies. Posting asks first unless a rule says otherwise.",
		category: "Communication",
		icon: logo("slack"),
		docsUrl: "https://api.slack.com/web",
		authTypes: ["oauth2", "bearer"],
		apiHosts: ["slack.com"],
		scopeSets: [
			read("read", "Read channels and search", "Messages in channels the app is in, and search.", [
				"channels:history",
				"search:read",
			]),
			write("write", "Post messages", "Post and reply as the connected account.", ["chat:write"]),
		],
		keyShapes: [
			{ label: "a Slack bot token", prefix: "xoxb-" },
			{ label: "a Slack user token", prefix: "xoxp-" },
		],
		client: { tier: "organisation", ownerLabel: "Acme" },
	},
	{
		id: "gmail",
		name: "Gmail",
		summary: "Search, read and draft email.",
		category: "Communication",
		icon: logo("gmail"),
		docsUrl: "https://developers.google.com/gmail/api",
		authTypes: ["oauth2"],
		apiHosts: ["gmail.googleapis.com"],
		scopeSets: [
			read("read", "Read email", "Search and read messages and threads.", [
				"https://www.googleapis.com/auth/gmail.readonly",
			]),
			write("write", "Draft and send email", "Create drafts and send them.", [
				"https://www.googleapis.com/auth/gmail.compose",
			]),
		],
		publisher: "Google",
		tier: "own_app",
		clientGuidance:
			"Gmail's scopes are restricted: keep the app in Testing for your own use, or have Google verify it.",
		guide: googleGuide(
			"Gmail",
			"gmail.googleapis.com",
			["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
			true,
		),
	},
	{
		id: "discord",
		name: "Discord",
		summary: "Servers, channels and messages.",
		category: "Communication",
		icon: logo("discord"),
		docsUrl: "https://discord.com/developers/docs/intro",
		authTypes: ["header"],
		apiHosts: ["discord.com"],
		scopeSets: [],
	},
	{
		id: "twilio",
		name: "Twilio",
		summary: "SMS, voice and WhatsApp messages.",
		category: "Communication",
		icon: logo("twilio"),
		docsUrl: "https://www.twilio.com/docs/usage/api",
		authTypes: ["basic"],
		apiHosts: ["api.twilio.com"],
		scopeSets: [],
	},
	{
		id: "zendesk",
		name: "Zendesk",
		summary: "Tickets, users and help centre articles.",
		category: "Sales and support",
		icon: logo("zendesk"),
		docsUrl: "https://developer.zendesk.com/api-reference/",
		authTypes: ["oauth2", "basic"],
		apiHosts: ["*.zendesk.com"],
		scopeSets: [read("read", "Read tickets", "Tickets, users and articles.", ["read"])],
	},
	{
		id: "hubspot",
		name: "HubSpot",
		summary: "Contacts, companies and deals.",
		category: "Sales and support",
		icon: logo("hubspot"),
		docsUrl: "https://developers.hubspot.com/docs/api/overview",
		authTypes: ["oauth2"],
		apiHosts: ["api.hubapi.com"],
		scopeSets: [read("read", "Read CRM records", "Contacts, companies and deals.", ["crm.objects.contacts.read"])],
		client: hostClient,
	},
	{
		id: "salesforce",
		name: "Salesforce",
		summary: "Accounts, opportunities and cases.",
		category: "Sales and support",
		icon: logo("salesforce"),
		docsUrl: "https://developer.salesforce.com/docs/apis",
		authTypes: ["oauth2"],
		apiHosts: ["*.my.salesforce.com"],
		scopeSets: [read("read", "Read records", "Accounts, opportunities and cases.", ["api", "refresh_token"])],
	},
	{
		id: "shopify",
		name: "Shopify",
		summary: "Orders, products and customers.",
		category: "Sales and support",
		icon: logo("shopify"),
		docsUrl: "https://shopify.dev/docs/api/admin-rest",
		authTypes: ["header"],
		apiHosts: ["*.myshopify.com"],
		scopeSets: [],
		keyShapes: [{ label: "a Shopify admin API token", prefix: "shpat_" }],
	},
	{
		id: "stripe",
		name: "Stripe",
		summary: "Payments, customers and subscriptions.",
		description:
			"Use a restricted key with only the resources agents need. Kantel sends it only to api.stripe.com, and the agent sees a placeholder, never the key.",
		category: "Finance",
		icon: logo("stripe"),
		docsUrl: "https://docs.stripe.com/api",
		authTypes: ["bearer"],
		apiHosts: ["api.stripe.com"],
		scopeSets: [],
		keyShapes: [
			{ label: "a Stripe restricted key", prefix: "rk_live_" },
			{ label: "a Stripe test key", prefix: "sk_test_" },
			{ label: "a Stripe secret key", prefix: "sk_live_" },
		],
		keyHelp: "Make a restricted key in the Stripe dashboard under Developers, API keys.",
	},
	{
		id: "supabase",
		name: "Supabase",
		summary: "Postgres projects, auth and storage.",
		category: "Data",
		icon: logo("supabase"),
		docsUrl: "https://supabase.com/docs/reference/api",
		authTypes: ["bearer"],
		apiHosts: ["api.supabase.com"],
		scopeSets: [],
		keyShapes: [{ label: "a Supabase access token", prefix: "sbp_" }],
	},
	{
		id: "posthog",
		name: "PostHog",
		summary: "Product analytics, session replays and flags.",
		category: "Data",
		icon: logo("posthog"),
		docsUrl: "https://posthog.com/docs/api",
		authTypes: ["bearer"],
		apiHosts: ["us.posthog.com", "eu.posthog.com"],
		scopeSets: [],
		keyShapes: [{ label: "a PostHog personal API key", prefix: "phx_" }],
	},
	{
		id: "airtable",
		name: "Airtable",
		summary: "Bases, tables and records.",
		category: "Data",
		icon: logo("airtable"),
		docsUrl: "https://airtable.com/developers/web/api/introduction",
		authTypes: ["oauth2", "bearer"],
		apiHosts: ["api.airtable.com"],
		scopeSets: [read("read", "Read records", "Bases, tables and records.", ["data.records:read"])],
		keyShapes: [{ label: "an Airtable personal access token", prefix: "pat", pattern: "^pat[A-Za-z0-9]{14}\\." }],
	},
	{
		id: "openai",
		name: "OpenAI",
		summary: "Models, embeddings and files.",
		category: "AI models",
		icon: logo("openai"),
		docsUrl: "https://platform.openai.com/docs/api-reference",
		authTypes: ["bearer"],
		apiHosts: ["api.openai.com"],
		scopeSets: [],
		keyShapes: [{ label: "an OpenAI project key", prefix: "sk-proj-" }],
	},
	{
		id: "anthropic",
		name: "Anthropic",
		summary: "Claude models and the Messages API.",
		category: "AI models",
		icon: logo("anthropic"),
		docsUrl: "https://docs.anthropic.com/en/api",
		authTypes: ["header"],
		apiHosts: ["api.anthropic.com"],
		scopeSets: [],
		keyShapes: [{ label: "an Anthropic API key", prefix: "sk-ant-" }],
	},
];

const owner = {
	tom: { kind: "user", organisationId: "org_acme", userId: "usr_tom" },
	ana: { kind: "user", organisationId: "org_acme", userId: "usr_ana" },
	support: { kind: "project", organisationId: "org_acme", projectId: "proj_support" },
	billing: { kind: "project", organisationId: "org_acme", projectId: "proj_billing" },
	org: { kind: "organisation", organisationId: "org_acme" },
} as const satisfies Record<string, ConnectionOwner>;

const iconOf = (templateId: string): { icon?: string } => {
	const found = CATALOGUE.find((template) => template.id === templateId)?.icon;
	return found === undefined ? {} : { icon: found };
};

/**
 * The organisation's connections: two GitHub accounts with different owners, a personal Gmail that needs reconnecting,
 * an MCP server, a project's Stripe key and a custom service whose test fails.
 */
export const CONNECTIONS: readonly Connection[] = [
	{
		id: "conn_github_tom",
		templateId: "github",
		name: "GitHub",
		...iconOf("github"),
		kind: "oauth",
		account: "tvdavies",
		owner: owner.tom,
		shares: [{ projectId: "proj_support", sharedBy: "Tom Davies", sharedAt: FIXTURE_NOW - 3 * DAY }],
		usage: { visibility: "private", unattended: false, actingUsers: ["usr_tom"] },
		health: "healthy",
		lastUsedAt: FIXTURE_NOW - 4 * MINUTE,
		createdAt: FIXTURE_NOW - 12 * DAY,
		createdBy: "Tom Davies",
		scopes: ["repo:read", "read:org", "repo"],
		hosts: ["api.github.com", "uploads.github.com"],
		client: { id: "cli_lleverage_github", label: "Lleverage GitHub app" },
		rulesSummary: "Reads allowed, writes ask",
		placeholders: ["{{connection.github_tvdavies.token}}"],
	},
	{
		id: "conn_github_bot",
		templateId: "github",
		name: "GitHub",
		...iconOf("github"),
		kind: "oauth",
		account: "acme-release-bot",
		label: "Release bot",
		owner: owner.org,
		usage: { visibility: "shared", unattended: true },
		health: "healthy",
		lastUsedAt: FIXTURE_NOW - 2 * HOUR,
		createdAt: FIXTURE_NOW - 40 * DAY,
		createdBy: "Ana Ruiz",
		scopes: ["repo:read", "repo"],
		hosts: ["api.github.com", "uploads.github.com"],
		client: { id: "cli_acme_github", label: "Acme GitHub app" },
		rulesSummary: "Reads allowed, pushes to main denied",
		placeholders: ["{{connection.github_release_bot.token}}"],
	},
	{
		id: "conn_gmail_tom",
		templateId: "gmail",
		name: "Gmail",
		...iconOf("gmail"),
		kind: "oauth",
		account: "tom@acme.com",
		owner: owner.tom,
		usage: { visibility: "private", unattended: false, actingUsers: ["usr_tom"] },
		health: "needs_reconnect",
		lastError: "Google stopped accepting the refresh token on 29 October. Reconnect to sign in again.",
		lastUsedAt: FIXTURE_NOW - 1 * DAY,
		createdAt: FIXTURE_NOW - 60 * DAY,
		createdBy: "Tom Davies",
		scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
		hosts: ["gmail.googleapis.com"],
		client: { id: "cli_lleverage_google", label: "Lleverage Google app" },
		rulesSummary: "Reads allowed",
	},
	{
		id: "conn_linear_support",
		templateId: "linear",
		name: "Linear",
		...iconOf("linear"),
		kind: "mcp",
		account: "Acme workspace",
		owner: owner.support,
		usage: { visibility: "shared", unattended: true, agents: ["triage", "support-reply"] },
		health: "healthy",
		lastUsedAt: FIXTURE_NOW - 25 * MINUTE,
		createdAt: FIXTURE_NOW - 9 * DAY,
		createdBy: "Ana Ruiz",
		hosts: ["mcp.linear.app"],
		mcp: { url: "https://mcp.linear.app/mcp", tools: 23 },
		rulesSummary: "Read tools allowed, 9 tools ask",
	},
	{
		id: "conn_stripe_billing",
		templateId: "stripe",
		name: "Stripe",
		...iconOf("stripe"),
		kind: "key",
		account: "Acme Ltd (live)",
		owner: owner.billing,
		health: "healthy",
		lastUsedAt: FIXTURE_NOW - 3 * HOUR,
		createdAt: FIXTURE_NOW - 21 * DAY,
		createdBy: "Ana Ruiz",
		hosts: ["api.stripe.com"],
		key: { set: true, last4: "Q8xz" },
		rulesSummary: "Reads allowed, refunds ask",
		placeholders: ["{{connection.stripe.key}}"],
	},
	{
		id: "conn_slack_org",
		templateId: "slack",
		name: "Slack",
		...iconOf("slack"),
		kind: "oauth",
		account: "Acme workspace",
		owner: owner.org,
		health: "healthy",
		lastUsedAt: FIXTURE_NOW - 50 * MINUTE,
		createdAt: FIXTURE_NOW - 90 * DAY,
		createdBy: "Ana Ruiz",
		scopes: ["channels:history", "search:read", "chat:write"],
		hosts: ["slack.com"],
		client: { id: "cli_acme_slack", label: "Acme Slack app" },
		rulesSummary: "Search allowed, posting asks",
	},
	{
		id: "conn_notion_org",
		templateId: "notion",
		name: "Notion",
		...iconOf("notion"),
		kind: "mcp",
		account: "Acme wiki",
		owner: owner.org,
		usage: { visibility: "shared", unattended: true },
		health: "refresh_failing",
		lastError: "Notion's token endpoint answered 503",
		retryAt: FIXTURE_NOW + 4 * MINUTE,
		lastUsedAt: FIXTURE_NOW - 2 * HOUR,
		createdAt: FIXTURE_NOW - 30 * DAY,
		createdBy: "Ana Ruiz",
		hosts: ["mcp.notion.com"],
		mcp: { url: "https://mcp.notion.com/mcp", tools: 14 },
		rulesSummary: "Read tools allowed, writes ask",
	},
	{
		id: "conn_custom_status",
		templateId: "custom",
		name: "Statuspage internal API",
		kind: "key",
		owner: owner.org,
		health: "failing_test",
		lastError: "The test request to status.acme.dev/api/me returned 401 Unauthorized.",
		createdAt: FIXTURE_NOW - 2 * DAY,
		createdBy: "Tom Davies",
		hosts: ["status.acme.dev"],
		key: { set: true, last4: "h7Tk" },
		rulesSummary: "Everything asks",
		placeholders: ["{{connection.statuspage.key}}"],
	},
];

export const CLIENTS: readonly OAuthClient[] = [
	{
		id: "cli_lleverage_github",
		templateId: "github",
		tier: "deployment",
		ownerLabel: "Lleverage",
		label: "Lleverage GitHub app",
		clientId: "Iv23liLleverage01",
		secret: { set: true, last4: "9c1e" },
		scopes: ["repo", "read:org"],
		redirectUri: REDIRECT,
		pinnedConnections: 1,
		createdAt: FIXTURE_NOW - 200 * DAY,
	},
	{
		id: "cli_acme_github",
		templateId: "github",
		tier: "organisation",
		ownerLabel: "Acme",
		label: "Acme GitHub app",
		clientId: "Iv23liAcmeOps7Q",
		secret: { set: true, last4: "41b0" },
		scopes: ["repo", "read:org"],
		redirectUri: REDIRECT,
		pinnedConnections: 1,
		createdAt: FIXTURE_NOW - 45 * DAY,
	},
	{
		id: "cli_lleverage_google",
		templateId: "gmail",
		tier: "deployment",
		ownerLabel: "Lleverage",
		label: "Lleverage Google app",
		clientId: "4410-lleverage.apps.googleusercontent.com",
		secret: { set: true, last4: "XkP2" },
		scopes: ["gmail.readonly", "gmail.compose"],
		redirectUri: REDIRECT,
		pinnedConnections: 1,
		createdAt: FIXTURE_NOW - 200 * DAY,
	},
	{
		id: "cli_acme_slack",
		templateId: "slack",
		tier: "organisation",
		ownerLabel: "Acme",
		label: "Acme Slack app",
		clientId: "2210.88412",
		secret: { set: true, last4: "e0d4" },
		scopes: ["channels:history", "search:read", "chat:write"],
		redirectUri: REDIRECT,
		pinnedConnections: 1,
		createdAt: FIXTURE_NOW - 90 * DAY,
	},
	{
		id: "cli_tom_jira",
		templateId: "jira",
		tier: "user",
		ownerLabel: "Tom Davies",
		label: "My Atlassian app",
		clientId: "Zq0vAtlassianTom",
		secret: { set: true, last4: "7a7a" },
		scopes: ["read:jira-work", "offline_access"],
		redirectUri: REDIRECT,
		disabled: true,
		pinnedConnections: 0,
		createdAt: FIXTURE_NOW - 5 * DAY,
	},
];

const ACME_REPOS = ["web", "api", "billing", "docs", "infra", "mobile", "design-system", "status-page"];
const OWN_REPOS = ["dotfiles", "kantel-notes", "advent-of-code", "blog"];

/** What Tom's GitHub connection reaches: kantel-agent on Acme (eight repositories) and on his own account (four). */
export const FIXTURE_REACH: ConnectionReachView = {
	repositories: [
		...ACME_REPOS.map((name, index) => ({ fullName: `acme/${name}`, private: index % 3 !== 2 })),
		...OWN_REPOS.map((name) => ({ fullName: `tvdavies/${name}`, private: name === "kantel-notes" })),
	],
	total: ACME_REPOS.length + OWN_REPOS.length,
	truncated: false,
	owners: [
		{ login: "acme", repositories: ACME_REPOS.length },
		{ login: "tvdavies", repositories: OWN_REPOS.length },
	],
	manageUrl: "https://github.com/settings/installations",
};

/** An organisation with more repositories than Kantel lists: the first 300 of 340. */
export const FIXTURE_REACH_MANY: ConnectionReachView = {
	repositories: Array.from({ length: 300 }, (_, index) => ({
		fullName: `acme/service-${String(index + 1).padStart(3, "0")}`,
		private: index % 4 !== 0,
	})),
	total: 340,
	truncated: true,
	owners: [{ login: "acme", repositories: 300 }],
	manageUrl: "https://github.com/organizations/acme/settings/installations/41",
};

/** The callback every client registers with its provider. */
export const REDIRECT_URI = REDIRECT;

export interface ScenarioOptions {
	/** How each round trip settles. Default: it connects. */
	readonly connectOutcome?: "connected" | "denied" | "user_mismatch" | "no_client" | "pending";
	/** Milliseconds each call takes. */
	readonly delay?: number;
	/** Milliseconds a sign-in takes in its window. */
	readonly signInTime?: number;
	readonly connections?: readonly Connection[];
	readonly clients?: readonly OAuthClient[];
	readonly catalogue?: readonly ProviderTemplate[];
	/** Reads never settle: the loading state. */
	readonly hang?: boolean;
	/** Reads fail: the error state. */
	readonly fail?: boolean;
	/** `false`: a source without the rules editor's calls, as before #341. */
	readonly rules?: false;
	/** The organisation's ceiling. Default none. */
	readonly ceiling?: ConnectionCeiling;
	/**
	 * What a GitHub connection reaches. Default `FIXTURE_REACH`; `many`: more than Kantel lists; `none`: installed
	 * nowhere; `hang`: never answers; `fail`: GitHub can't be asked.
	 */
	readonly reach?: "many" | "none" | "hang" | "fail";
}

const toOwner = (choice: OwnerChoice, viewer: ConnectionsViewer): ConnectionOwner =>
	choice.kind === "user"
		? { kind: "user", organisationId: "org_acme", userId: viewer.userId }
		: choice.kind === "project"
			? { kind: "project", organisationId: "org_acme", projectId: choice.projectId }
			: { kind: "organisation", organisationId: "org_acme" };

/**
 * An in-memory source with the page's whole flow: a sign-in settles `signInTime` after it starts, keys are kept as
 * their last four characters, an MCP server takes its name from its URL, and clients register and delete as the API
 * would (a pinned client can't be deleted).
 */
export function createConnectionsScenario(options: ScenarioOptions = {}, viewer = VIEWER): ConnectionsSource {
	let connections = [...(options.connections ?? CONNECTIONS)];
	let clients = [...(options.clients ?? CLIENTS)];
	const catalogue = options.catalogue ?? CATALOGUE;
	const delay = options.delay ?? 250;
	const signInTime = options.signInTime ?? 2200;
	const attempts = new Map<string, { started: number; settle: () => ConnectAttemptState }>();
	let counter = 0;

	const wait = <T>(value: () => T): Promise<T> =>
		options.hang === true
			? new Promise<T>(() => {})
			: new Promise<T>((resolve, reject) =>
					setTimeout(() => {
						if (options.fail === true) {
							reject(new Error("Couldn't reach Kantel"));
							return;
						}
						try {
							resolve(value());
						} catch (error) {
							reject(error);
						}
					}, delay),
				);

	const start = (settle: () => ConnectAttemptState, device = false): ConnectStart => {
		counter += 1;
		const attemptId = `att_${counter}`;
		attempts.set(attemptId, { started: Date.now(), settle });
		return device
			? {
					attemptId,
					url: "https://github.com/login/device",
					expiresAt: FIXTURE_NOW + 15 * MINUTE,
					device: { userCode: "WDJB-MJHT" },
				}
			: {
					attemptId,
					url: `https://kantel.example/v1/connections/connect/${attemptId}`,
					expiresAt: FIXTURE_NOW + 15 * MINUTE,
				};
	};

	const settleWith =
		(make: () => Connection): (() => ConnectAttemptState) =>
		() => {
			const outcome = options.connectOutcome ?? "connected";
			if (outcome === "pending") return { status: "pending" };
			if (outcome !== "connected") return { status: "failed", reason: outcome };
			const made = make();
			connections = [...connections.filter((c) => c.id !== made.id), made];
			return { status: "connected", connection: made };
		};

	// A template with a client registered here since resolves to it, as the API's catalogue would.
	const resolved = (template: ProviderTemplate): ProviderTemplate => {
		const added = clients.find(
			(c) => c.templateId === template.id && c.id.startsWith("cli_new_") && c.disabled !== true,
		);
		return added === undefined || template.client !== undefined
			? template
			: {
					...template,
					client: {
						tier: added.tier,
						ownerLabel: added.ownerLabel,
						...(added.label === undefined ? {} : { label: added.label }),
					},
					tier: "own_app",
				};
	};

	return {
		catalogue: () => wait(() => catalogue.map(resolved)),
		template: (templateId) =>
			wait(() => {
				const template = catalogue.find((t) => t.id === templateId);
				if (template === undefined) throw new Error("There's no such service in the catalogue.");
				return resolved(template);
			}),
		connections: () => wait(() => connections),
		connect: (input) =>
			wait(() => {
				const template = catalogue.find((t) => t.id === input.templateId);
				if (template === undefined) throw new Error("There's no such service in the catalogue.");
				const existing = connections.find((c) => c.id === input.connectionId);
				return start(
					settleWith(() => ({
						id: existing?.id ?? `conn_${template.id}_${counter}`,
						templateId: template.id,
						name: template.name,
						...(template.icon === undefined ? {} : { icon: template.icon }),
						kind: template.authTypes.includes("mcp_oauth") ? "mcp" : "oauth",
						account: template.id === "github" ? "tvdavies-work" : "tom@acme.com",
						owner: existing?.owner ?? toOwner(input.owner, viewer),
						health: "healthy",
						createdAt: existing?.createdAt ?? FIXTURE_NOW,
						createdBy: viewer.name,
						lastUsedAt: FIXTURE_NOW,
						scopes: template.scopeSets
							.filter((set) => (input.scopeSets ?? []).includes(set.id) || set.default === true)
							.flatMap((set) => set.scopes),
						hosts: template.apiHosts,
						rulesSummary: "Reads allowed, writes ask",
					})),
					template.signIn === "device",
				);
			}),
		attempt: (attemptId) =>
			wait((): ConnectAttemptState => {
				const attempt = attempts.get(attemptId);
				if (attempt === undefined) return { status: "failed", reason: "expired" };
				if (Date.now() - attempt.started < signInTime) return { status: "pending" };
				return attempt.settle();
			}),
		cancelAttempt: (attemptId) =>
			wait(() => {
				attempts.delete(attemptId);
			}),
		connectKey: (input) =>
			wait(() => {
				const template = catalogue.find((t) => t.id === input.templateId);
				counter += 1;
				const account = template === undefined ? undefined : template.id === "stripe" ? "Acme Ltd (test)" : "Acme";
				const connection: Connection = {
					id: `conn_key_${counter}`,
					templateId: template?.id ?? "custom",
					name: template?.name ?? input.name ?? "Custom service",
					...(template?.icon === undefined ? {} : { icon: template.icon }),
					kind: "key",
					...(account === undefined ? {} : { account }),
					...(input.label === undefined || input.label === "" ? {} : { label: input.label }),
					owner: toOwner(input.owner, viewer),
					health: template === undefined ? "failing_test" : "healthy",
					createdAt: FIXTURE_NOW,
					createdBy: viewer.name,
					hosts: template?.apiHosts ?? input.hosts ?? [],
					key: { set: true, last4: input.key.trim().slice(-4) },
					rulesSummary: "Everything asks",
				};
				connections = [...connections, connection];
				return {
					connection,
					test:
						account === undefined
							? { ok: false, message: "The test request returned 401 Unauthorized. Check the key and the header." }
							: { ok: true, account },
				};
			}),
		addMcpServer: (input) =>
			wait(() => {
				const host = new URL(input.url).hostname;
				const base = input.name?.trim() || host.replace(/^mcp\./, "").replace(/\.[a-z]+$/, "");
				const serverName = base.charAt(0).toUpperCase() + base.slice(1);
				if (host.includes("key")) return { auth: "key", serverName, header: "Authorization" } as const;
				const begun = start(
					settleWith(() => ({
						id: `conn_mcp_${counter}`,
						templateId: "custom-mcp",
						name: serverName,
						kind: "mcp",
						account: viewer.name,
						owner: toOwner(input.owner, viewer),
						health: "healthy",
						createdAt: FIXTURE_NOW,
						createdBy: viewer.name,
						hosts: [host],
						mcp: { url: input.url, tools: 12 },
						rulesSummary: "Read tools allowed, others ask",
					})),
				);
				return { auth: "oauth", serverName, ...begun } as const;
			}),
		disconnect: (connectionId) =>
			wait(() => {
				const connection = connections.find((c) => c.id === connectionId);
				connections = connections.filter((c) => c.id !== connectionId);
				// What the API answers (#329): a key and Slack can't be revoked by an app, Google refuses here, the rest revoke.
				if (connection?.kind === "key") return { revoked: "unsupported" } as const;
				if (connection?.templateId === "slack")
					return {
						revoked: "unsupported",
						revokeUrl: "https://slack.com/apps/manage",
						reason: "Slack offers no way for an app to revoke its access",
					} as const;
				if (connection?.templateId === "gmail")
					return {
						revoked: false,
						revokeUrl: "https://myaccount.google.com/connections",
						reason: "The revocation endpoint did not answer in time",
					} as const;
				return { revoked: true } as const;
			}),
		reconnect: (connectionId) =>
			wait(() => {
				const connection = connections.find((c) => c.id === connectionId);
				if (connection === undefined) throw new Error("There's no such connection.");
				return start(
					settleWith(() => {
						const { lastError: _, ...rest } = connection;
						return { ...rest, health: "healthy" };
					}),
				);
			}),
		clients: () => wait(() => clients),
		createClient: (input) =>
			wait(() => {
				counter += 1;
				const client: OAuthClient = {
					id: `cli_new_${counter}`,
					templateId: input.templateId,
					tier: input.tier,
					ownerLabel: input.tier === "organisation" ? viewer.organisation : viewer.name,
					...(input.label === undefined || input.label === "" ? {} : { label: input.label }),
					clientId: input.clientId,
					secret: { set: true, last4: input.clientSecret.slice(-4) },
					scopes: input.scopes ?? [],
					redirectUri: REDIRECT,
					pinnedConnections: 0,
					createdAt: FIXTURE_NOW,
				};
				clients = [...clients, client];
				return client;
			}),
		setClientDisabled: (clientId, disabled) =>
			wait(() => {
				const client = clients.find((c) => c.id === clientId);
				if (client === undefined) throw new Error("There's no such client.");
				const next = { ...client, disabled };
				clients = clients.map((c) => (c.id === clientId ? next : c));
				return next;
			}),
		createGitHubApp: () =>
			wait(() => {
				throw new Error("This is a recorded demo, so GitHub isn't opened. On Kantel it opens with the app filled in.");
			}),
		deleteClient: (clientId) =>
			wait(() => {
				const client = clients.find((c) => c.id === clientId);
				if (client !== undefined && client.pinnedConnections > 0)
					throw new Error(`${client.pinnedConnections} connections are pinned to this client, so it can't be deleted.`);
				clients = clients.filter((c) => c.id !== clientId);
			}),
		sharing: createSharingScenario({
			connections: () => connections,
			set: (next) => {
				connections = connections.map((c) => (c.id === next.id ? next : c));
			},
			wait,
			viewer,
		}),
		uses: (connectionId) => wait(() => FIXTURE_USES.filter((use) => use.id.startsWith(`${connectionId}:`))),
		reach: (connectionId) =>
			options.reach === "hang"
				? new Promise<never>(() => {})
				: wait((): ConnectionReachView | undefined => {
						if (options.reach === "fail") throw new Error("GitHub didn't answer");
						if (connections.find((c) => c.id === connectionId)?.templateId !== "github") return undefined;
						if (options.reach === "many") return FIXTURE_REACH_MANY;
						if (options.reach === "none")
							return {
								repositories: [],
								total: 0,
								truncated: false,
								owners: [],
								manageUrl: "https://github.com/settings/installations",
							};
						return FIXTURE_REACH;
					}),
		...(options.rules === false
			? {}
			: {
					rules: createRulesScenario({
						connections: () => connections,
						wait,
						viewer,
						...(options.ceiling === undefined ? {} : { ceiling: options.ceiling }),
					}),
				}),
	};
}

/** Sharing as the API does it: only the person shares their own; they or an admin stop a share. */
export function createSharingScenario(options: {
	readonly connections: () => readonly Connection[];
	readonly set: (connection: Connection) => void;
	readonly wait: <T>(value: () => T) => Promise<T>;
	readonly viewer: ConnectionsViewer;
}): ConnectionSharingSource {
	const { viewer } = options;
	const find = (connectionId: string) => {
		const found = options.connections().find((c) => c.id === connectionId);
		if (found === undefined) throw new Error("There's no such connection.");
		return found;
	};
	return {
		share: (connectionId, projectId) =>
			options.wait(() => {
				const connection = find(connectionId);
				if (connection.owner.kind !== "user" || connection.owner.userId !== viewer.userId)
					throw new Error("Only the person a connection belongs to can share it.");
				const next: Connection = {
					...connection,
					shares: [
						...(connection.shares ?? []).filter((s) => s.projectId !== projectId),
						{ projectId, sharedBy: viewer.name, sharedAt: FIXTURE_NOW },
					],
				};
				options.set(next);
				return next;
			}),
		unshare: (connectionId, projectId) =>
			options.wait(() => {
				const connection = find(connectionId);
				const mine = connection.owner.kind === "user" && connection.owner.userId === viewer.userId;
				if (!mine && !viewer.admin) throw new Error("Only its owner or an admin can stop sharing it.");
				const next: Connection = {
					...connection,
					shares: (connection.shares ?? []).filter((s) => s.projectId !== projectId),
				};
				options.set(next);
				return next;
			}),
	};
}

/**
 * Recent uses of the fixture connections, newest first: allowed, refused for the session's audience, refused and sent
 * at the egress gate from the session's shell (#331; no step yet: a shell command doesn't carry its tool call), and held.
 */
export const FIXTURE_USES: readonly ConnectionUseView[] = [
	{
		id: "conn_github_tom:u1",
		at: FIXTURE_NOW - 4 * MINUTE,
		sessionId: "ses_7f2c",
		sessionTitle: "Triage the release blockers",
		toolCallId: "call_04",
		what: "GET api.github.com/repos/acme/web/issues",
		actingFor: "Tom Davies",
		audience: "private",
		outcome: "allowed",
	},
	{
		id: "conn_github_tom:u2",
		at: FIXTURE_NOW - 38 * MINUTE,
		sessionId: "ses_91ab",
		sessionTitle: "Weekly release notes",
		toolCallId: "call_02",
		what: "GET api.github.com/repos/acme/web/pulls",
		actingFor: "Tom Davies",
		audience: "shared",
		outcome: "denied",
		reason: "It is private, and other people can see this session",
	},
	{
		id: "conn_github_tom:u6",
		at: FIXTURE_NOW - 52 * MINUTE,
		sessionId: "ses_7f2c",
		sessionTitle: "Triage the release blockers",
		what: "POST hooks.example.net/collect",
		actingFor: "Tom Davies",
		audience: "private",
		outcome: "denied",
		via: "sandbox",
		refusal: "host_not_bound",
		reason: "Connection GitHub's placeholder only goes to api.github.com, not hooks.example.net.",
	},
	{
		id: "conn_github_tom:u7",
		at: FIXTURE_NOW - 70 * MINUTE,
		sessionId: "ses_7f2c",
		sessionTitle: "Triage the release blockers",
		what: "GET api.github.com/user",
		actingFor: "Tom Davies",
		audience: "private",
		outcome: "denied",
		via: "sandbox",
		refusal: "raw_secret",
		reason: "The request carries a stored secret's own value rather than its placeholder, so Kantel did not send it.",
	},
	{
		id: "conn_github_tom:u8",
		at: FIXTURE_NOW - 90 * MINUTE,
		sessionId: "ses_7f2c",
		sessionTitle: "Triage the release blockers",
		what: "GET api.github.com/repos/acme/web/actions/runs",
		actingFor: "Tom Davies",
		audience: "private",
		outcome: "allowed",
		via: "sandbox",
	},
	{
		id: "conn_github_tom:u3",
		at: FIXTURE_NOW - 2 * HOUR,
		sessionId: "ses_3c40",
		sessionTitle: "Customer escalation: Northwind",
		toolCallId: "call_11",
		what: "GET api.github.com/repos/acme/web/issues/481",
		actingFor: "Ana Ruiz",
		audience: "shared",
		outcome: "allowed",
	},
	{
		id: "conn_github_tom:u4",
		at: FIXTURE_NOW - 3 * HOUR,
		sessionId: "ses_3c40",
		sessionTitle: "Customer escalation: Northwind",
		toolCallId: "call_14",
		what: "POST api.github.com/repos/acme/web/issues/481/comments",
		actingFor: "Ana Ruiz",
		audience: "shared",
		outcome: "held",
		approval: "waiting",
		reason: "Writes ask: waiting for Tom Davies to approve this exact request",
	},
	{
		id: "conn_github_tom:u9",
		at: FIXTURE_NOW - 4 * HOUR,
		sessionId: "ses_3c40",
		sessionTitle: "Customer escalation: Northwind",
		toolCallId: "call_09",
		what: "DELETE api.github.com/repos/acme/web/issues/481/labels/blocked",
		actingFor: "Ana Ruiz",
		audience: "shared",
		outcome: "held",
		approval: "denied",
		reason: "A person denied this exact request, so nothing was sent",
	},
	{
		id: "conn_github_tom:u5",
		at: FIXTURE_NOW - 26 * HOUR,
		sessionId: "ses_0d9e",
		sessionTitle: "Nightly dependency check",
		what: "GET api.github.com/repos/acme/web/dependabot/alerts",
		audience: "shared",
		outcome: "denied",
		reason: "It is not available to sessions with no person behind them",
	},
];

/**
 * The same uses as an organisation admin gets them (#335): each one in Tom's private sessions redacted to when, how it
 * ended and who it acted for, the rest whole.
 */
export const FIXTURE_USES_SEEN_BY_ADMIN: readonly RecentUseView[] = FIXTURE_USES.map((use) =>
	use.audience === "private"
		? {
				id: use.id,
				at: use.at,
				redacted: true as const,
				outcome: use.outcome,
				...(use.actingFor === undefined ? {} : { actingFor: use.actingFor }),
			}
		: use,
);

/** A session's connections as the API's check answers them, for each visibility. */
export function sessionConnectionsFor(visibility: SessionVisibility): readonly SessionConnectionView[] {
	const privateOnly = "It is private, and other people can see this session";
	return [
		{
			id: "conn_github_tom",
			name: "GitHub",
			account: "tvdavies",
			owner: "user",
			ownerLabel: "Yours",
			usable: true,
			...(visibility === "shared" ? { viaShare: true } : {}),
		},
		{
			id: "conn_gmail_tom",
			name: "Gmail",
			account: "tom@acme.com",
			owner: "user",
			ownerLabel: "Yours",
			usable: visibility === "private",
			...(visibility === "private" ? {} : { reason: privateOnly }),
		},
		{
			id: "conn_linear_support",
			name: "Linear",
			account: "Acme workspace",
			owner: "project",
			ownerLabel: "Support project",
			usable: false,
			reason: "It is not available to this agent",
		},
		{
			id: "conn_github_bot",
			name: "GitHub",
			account: "acme-release-bot",
			owner: "organisation",
			ownerLabel: "Acme",
			usable: true,
		},
		{
			id: "conn_slack_org",
			name: "Slack",
			account: "Acme workspace",
			owner: "organisation",
			ownerLabel: "Acme",
			usable: true,
		},
		{
			id: "conn_stripe_billing",
			name: "Stripe",
			account: "Acme Ltd (live)",
			owner: "project",
			ownerLabel: "Billing project",
			usable: false,
			reason: "It belongs to another project",
		},
	];
}

/** A session's visibility source over the fixtures: a short delay, and a change that sticks. */
export function createSessionVisibilityScenario(
	options: { readonly delay?: number; readonly fail?: boolean } = {},
): SessionVisibilitySource {
	const delay = options.delay ?? 200;
	const after = <T>(value: () => T) =>
		new Promise<T>((resolve, reject) =>
			setTimeout(() => {
				if (options.fail === true) reject(new Error("Couldn't reach Kantel"));
				else resolve(value());
			}, delay),
		);
	return {
		connections: (visibility) => after(() => sessionConnectionsFor(visibility)),
		setVisibility: () => after(() => undefined),
	};
}

const TOM = { kind: "human", userId: "usr_tom" } as const;

const fixtureRule = (
	connectionId: string,
	id: string,
	rule: Pick<ConnectionRule, "who" | "what" | "action"> & Partial<ConnectionRule>,
): ConnectionRule => ({
	id,
	connectionId,
	uses: 0,
	source: "person",
	createdBy: TOM,
	createdAt: FIXTURE_NOW - 5 * DAY,
	updatedAt: FIXTURE_NOW - 5 * DAY,
	...rule,
});

/** The read and write hints the fixture's API templates have, as GitHub's do. */
const TEMPLATE_HINTS: readonly EndpointHint[] = [
	{ method: "GET", path: "/**", access: "read" },
	{ method: "*", path: "/**", access: "write" },
];

/**
 * The release bot's GitHub connection as #332's migration left it: made before rules, so it let every request through,
 * then given the template's defaults: reads allow, writes ask, deletes are blocked.
 */
export const MIGRATED_RULES: ConnectionRules = {
	connectionId: "conn_github_bot",
	unmatched: "ask",
	version: 1,
	updatedAt: FIXTURE_NOW - 2 * HOUR,
	defaults: { reason: "migrated", at: FIXTURE_NOW - 2 * HOUR },
	rules: defaultRuleInputs(TEMPLATE_HINTS).map((input, index) =>
		fixtureRule("conn_github_bot", `cr_bot_default_${index}`, {
			...input,
			source: "default",
			createdBy: { kind: "system", component: "connections" },
			createdAt: FIXTURE_NOW - 2 * HOUR,
			updatedAt: FIXTURE_NOW - 2 * HOUR,
		}),
	),
};

/** A connection whose person set requests no rule covers to go through: kept by the migration, and warned about. */
export const OPEN_RULES: ConnectionRules = {
	connectionId: "conn_github_bot",
	unmatched: "allow",
	version: 4,
	updatedAt: FIXTURE_NOW - 3 * DAY,
	rules: [
		fixtureRule("conn_github_bot", "cr_bot_main", {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "*", path: "/repos/acme/*/git/refs/heads/main" },
			action: "deny",
			note: "Nobody pushes to main",
		}),
	],
};

/** The rules the fixture connections start with: GitHub's template defaults and a few of people's own. */
export const FIXTURE_RULES: Readonly<Record<string, ConnectionRules>> = {
	conn_github_tom: {
		connectionId: "conn_github_tom",
		unmatched: "ask",
		version: 6,
		rules: [
			fixtureRule("conn_github_tom", "cr_gh_reads", {
				who: { kind: "any" },
				what: { kind: "endpoint", method: "GET", path: "/**" },
				action: "allow",
				source: "default",
				uses: 412,
			}),
			fixtureRule("conn_github_tom", "cr_gh_writes", {
				who: { kind: "any" },
				what: { kind: "endpoint", method: "*", path: "/**" },
				action: "ask",
				source: "default",
			}),
			fixtureRule("conn_github_tom", "cr_gh_issues", {
				who: { kind: "agent", agentId: "triage" },
				what: { kind: "endpoint", method: "POST", path: "/repos/acme/*/issues" },
				action: "allow",
				source: "approval",
				approvalId: "apr_7Kd2",
				uses: 31,
			}),
			fixtureRule("conn_github_tom", "cr_gh_delete", {
				who: { kind: "any" },
				what: { kind: "endpoint", method: "DELETE", path: "/repos/**" },
				action: "deny",
				note: "Agents never delete repositories or branches",
			}),
			fixtureRule("conn_github_tom", "cr_gh_release", {
				who: { kind: "project", projectId: "proj_support" },
				what: { kind: "endpoint", method: "POST", path: "/repos/acme/web/releases" },
				action: "allow",
				expiresAt: FIXTURE_NOW + 2 * DAY,
				maxUses: 3,
				uses: 1,
			}),
		],
	},
	conn_linear_support: {
		connectionId: "conn_linear_support",
		unmatched: "ask",
		version: 2,
		rules: [
			fixtureRule("conn_linear_support", "cr_lin_search", {
				who: { kind: "any" },
				what: { kind: "tool", tool: "search_issues" },
				action: "allow",
			}),
			fixtureRule("conn_linear_support", "cr_lin_delete", {
				who: { kind: "any" },
				what: { kind: "tool", tool: "delete_issue" },
				action: "deny",
			}),
		],
	},
};

/**
 * Rules in memory, decided by the contract's own functions, as the API decides them: usage first (a private
 * connection in a session its project can see is refused), then the hosts, the ceiling and the rules.
 */
export function createRulesScenario(options: {
	readonly connections: () => readonly Connection[];
	readonly wait: <T>(value: () => T) => Promise<T>;
	readonly viewer: ConnectionsViewer;
	readonly ceiling?: ConnectionCeiling;
	readonly initial?: Readonly<Record<string, ConnectionRules>>;
}): ConnectionRulesSource {
	const sets = new Map<string, ConnectionRules>(Object.entries(options.initial ?? FIXTURE_RULES));
	const ceiling = options.ceiling ?? { set: false, routes: [] };
	let counter = 0;
	const { wait } = options;
	const connectionOf = (id: string) => {
		const found = options.connections().find((c) => c.id === id);
		if (found === undefined) throw new Error("There's no such connection.");
		return found;
	};
	const setOf = (id: string): ConnectionRules =>
		sets.get(id) ?? { connectionId: id, rules: [], unmatched: "allow", version: 0 };
	const change = (id: string, next: (current: ConnectionRules) => ConnectionRules) => {
		const current = setOf(id);
		const changed = { ...next(current), version: current.version + 1, updatedAt: FIXTURE_NOW };
		sets.set(id, changed);
		return changed;
	};
	const check = (connection: Connection, input: ConnectionRuleInput) => {
		if (input.what.kind === "endpoint") {
			const problem = pathPatternProblem(input.what.path);
			if (problem !== undefined) throw new Error(problem);
		}
		const outside = ruleOutsideCeiling(ceiling, input, {
			hosts: connection.hosts,
			...(connection.mcp === undefined ? {} : { mcpUrl: connection.mcp.url }),
		});
		if (outside !== undefined) throw new Error(`${outside}, so this rule can't be saved`);
	};
	const made = (connectionId: string, input: ConnectionRuleInput): ConnectionRule => {
		counter += 1;
		return {
			id: `cr_new_${counter}`,
			connectionId,
			who: input.who,
			what: input.what,
			action: input.action,
			...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
			...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
			...(input.note === undefined ? {} : { note: input.note }),
			uses: 0,
			source: "person",
			createdBy: TOM,
			createdAt: FIXTURE_NOW + counter,
			updatedAt: FIXTURE_NOW + counter,
		};
	};
	return {
		get: (id) => wait(() => setOf(id)),
		ceiling: () => wait(() => ceiling),
		update: (id, input) =>
			wait(() =>
				change(id, (current) =>
					input.reset === "template"
						? {
								...current,
								unmatched: DEFAULT_UNMATCHED,
								defaults: { reason: "reset", at: FIXTURE_NOW },
								rules: [
									...current.rules.filter((r) => r.source !== "default"),
									// An API's template defaults, as the API gives them; an MCP server's come with its tools.
									...(connectionOf(id).kind === "mcp" ? [] : defaultRuleInputs(TEMPLATE_HINTS)).map((rule) => ({
										...made(id, rule),
										source: "default" as const,
									})),
								],
							}
						: { ...current, ...(input.unmatched === undefined ? {} : { unmatched: input.unmatched }) },
				),
			),
		create: (id, input) =>
			wait(() => {
				check(connectionOf(id), input);
				const rule = made(id, input);
				change(id, (current) => ({ ...current, rules: [...current.rules, rule] }));
				return rule;
			}),
		updateRule: (id, ruleId, input) =>
			wait(() => {
				const current = setOf(id).rules.find((r) => r.id === ruleId);
				if (current === undefined) throw new Error("There's no such rule.");
				const { expiresAt: _e, maxUses: _m, note: _n, ...kept } = current;
				const next: ConnectionRule = {
					...kept,
					...(input.who === undefined ? {} : { who: input.who }),
					...(input.what === undefined ? {} : { what: input.what }),
					...(input.action === undefined ? {} : { action: input.action }),
					...((input.expiresAt === undefined ? current.expiresAt : input.expiresAt) == null
						? {}
						: { expiresAt: (input.expiresAt ?? current.expiresAt) as number }),
					...((input.maxUses === undefined ? current.maxUses : input.maxUses) == null
						? {}
						: { maxUses: (input.maxUses ?? current.maxUses) as number }),
					...((input.note === undefined ? current.note : input.note) == null
						? {}
						: { note: (input.note ?? current.note) as string }),
					source: current.source === "default" ? "person" : current.source,
					updatedAt: FIXTURE_NOW,
				};
				check(connectionOf(id), next);
				change(id, (set) => ({ ...set, rules: set.rules.map((r) => (r.id === ruleId ? next : r)) }));
				return next;
			}),
		remove: (id, ruleId) =>
			wait(() => {
				change(id, (set) => ({ ...set, rules: set.rules.filter((r) => r.id !== ruleId) }));
			}),
		dryRun: (id, request) =>
			wait((): ConnectionDecision => {
				const connection = connectionOf(id);
				const set = setOf(id);
				const deny = (by: ConnectionDecision["by"], reason: string): ConnectionDecision => ({
					action: "deny",
					by,
					reason,
					rulesVersion: set.version,
				});
				if (connection.owner.kind === "user" && request.audience !== "private")
					return deny({ kind: "usage" }, `${connection.name} is personal, so a session others can see can't use it`);
				if (connection.health === "needs_reconnect")
					return deny({ kind: "connection" }, `${connection.name} needs someone to connect it again`);
				const url = new URL(request.url ?? connection.mcp?.url ?? "https://invalid.invalid/");
				if (url.protocol !== "https:") return deny({ kind: "connection" }, "A connection only sends over https");
				if (!connection.hosts.includes(url.hostname))
					return deny(
						{ kind: "connection" },
						`${connection.name} is for ${connection.hosts.join(", ")}, not ${url.hostname}`,
					);
				const kind = connection.kind === "mcp" ? (request.tool === undefined ? "mcp_tools" : "mcp_call") : "http";
				const operation =
					kind === "http" && connection.templateId === "github"
						? fixtureOperation(request.method, url.pathname, request.body)
						: undefined;
				const ruleRequest = {
					kind,
					method: kind === "http" ? request.method : "POST",
					host: url.hostname,
					path: url.pathname,
					...(request.tool === undefined ? {} : { tool: request.tool }),
					...(operation === undefined ? {} : { operation }),
				} as const;
				if (!requestWithinCeiling(ceiling, ruleRequest))
					return deny(
						{ kind: "ceiling" },
						`The organisation's ceiling doesn't allow ${ruleRequest.method} ${url.hostname}${url.pathname}`,
					);
				const decision = decideConnectionRules(
					set,
					{
						sessionId: request.sessionId ?? "",
						agentId: request.agentId ?? "",
						...(request.projectId === undefined ? {} : { projectId: request.projectId }),
						...(request.unattended === true || request.actingUserId === null ? { unattended: true } : {}),
					},
					ruleRequest,
					FIXTURE_NOW,
				);
				return operation === undefined ? decision : { ...decision, operation };
			}),
	};
}

/** The session the access menu's stories are in. */
export const FIXTURE_SESSION_ID = "ses_3430cd86";

/**
 * Tom's GitHub connection as "What agents may do" first shows it (#462): GitHub's defaults (#485), a rule an approval
 * saved, one a person made, and one for a single session from "Allow for this session" (#460).
 */
export const POLICY_RULES: ConnectionRules = {
	connectionId: "conn_github_tom",
	unmatched: "ask",
	version: 4,
	updatedAt: FIXTURE_NOW - HOUR,
	rules: [
		...defaultRuleInputs(TEMPLATE_HINTS).map((input, index) =>
			fixtureRule("conn_github_tom", `cr_tom_default_${index}`, {
				...input,
				source: "default",
				createdBy: { kind: "system", component: "connections" },
			}),
		),
		fixtureRule("conn_github_tom", "cr_tom_pulls", {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "POST", path: "/repos/tvdavies/harbour/pulls" },
			action: "allow",
			source: "approval",
			approvalId: "apr_9Qx1",
			createdAt: FIXTURE_NOW - DAY,
			updatedAt: FIXTURE_NOW - DAY,
		}),
		fixtureRule("conn_github_tom", "cr_tom_merge", {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "PUT", path: "/repos/*/*/pulls/*/merge" },
			action: "deny",
			note: "A person merges",
		}),
		fixtureRule("conn_github_tom", "cr_tom_session_comments", {
			who: { kind: "session", sessionId: FIXTURE_SESSION_ID },
			what: { kind: "endpoint", method: "POST", path: "/repos/tvdavies/harbour/issues/*/comments" },
			action: "allow",
			source: "approval",
			createdAt: FIXTURE_NOW - 53 * MINUTE,
			updatedAt: FIXTURE_NOW - 53 * MINUTE,
		}),
	],
};

/** A connection's rules after "What agents may do" made `choice`, as the API leaves them: the plan, made. */
export function policyFixture(set: ConnectionRules, choice: PolicyChoice): ConnectionRules {
	const plan = planPolicy(set, choice, { templateId: "github", host: "api.github.com", now: FIXTURE_NOW });
	const removed = new Set(plan.remove);
	const rules = set.rules
		.filter((rule) => !removed.has(rule.id))
		.map((rule) => {
			const change = plan.update.find((update) => update.ruleId === rule.id);
			return change === undefined ? rule : { ...rule, action: change.action };
		});
	return {
		...set,
		version: set.version + 1,
		rules: [
			...rules,
			...plan.create.map((input, index) => fixtureRule(set.connectionId, `cr_grid_${set.version}_${index}`, input)),
		],
	};
}

/**
 * The access menu's source over the fixtures (#463): the connections a private session of Tom's can use, each with
 * its rules from `rules` (the rules editor's own fixture source, so a revoke there is a revoke everywhere), and Revoke
 * where `viewer` manages the connection.
 */
export function createSessionAccessScenario(
	options: {
		readonly delay?: number;
		readonly fail?: boolean;
		readonly hang?: boolean;
		/** A session that can use no connections. */
		readonly none?: boolean;
		readonly viewer?: ConnectionsViewer;
		readonly rules?: ConnectionRulesSource;
		/** The session the menu is for; default the one `POLICY_RULES` has an allowance for. */
		readonly sessionId?: string;
	} = {},
): SessionAccessSource {
	const viewer = options.viewer ?? VIEWER;
	const rules =
		options.rules ??
		createRulesScenario({
			connections: () => CONNECTIONS,
			viewer,
			wait: async (value) => value(),
			initial: { ...FIXTURE_RULES, conn_github_tom: POLICY_RULES, conn_github_bot: MIGRATED_RULES },
		});
	const after = <T>(value: () => Promise<T>) =>
		options.hang === true
			? new Promise<T>(() => {})
			: new Promise<T>((resolve, reject) =>
					setTimeout(() => {
						if (options.fail === true) reject(new Error("Couldn't reach Kantel"));
						else value().then(resolve, reject);
					}, options.delay ?? 150),
				);
	return {
		sessionId: options.sessionId ?? FIXTURE_SESSION_ID,
		connections: () =>
			after(async () => {
				if (options.none === true) return [];
				const usable = sessionConnectionsFor("private").filter((view) => view.usable);
				return Promise.all(
					usable.map(async (view): Promise<SessionAccessConnection> => {
						const connection = CONNECTIONS.find((each) => each.id === view.id);
						if (connection === undefined) throw new Error("fixtures changed");
						return {
							connection: { ...view, ...(connection.icon === undefined ? {} : { icon: connection.icon }) },
							kind: connection.kind === "mcp" ? "mcp" : "http",
							templateId: connection.templateId,
							hosts: connection.hosts,
							rules: await rules.get(connection.id),
							canManage: canManage(connection, viewer),
						};
					}),
				);
			}),
		revoke: (connectionId, ruleId) => after(() => rules.remove(connectionId, ruleId)),
	};
}
