/**
 * Setup guides (#326, tier 3): how to register an app for a template at its provider, as the catalogue sends them,
 * with this deployment's redirect URI and the template's scopes written into the steps so they can be copied exactly.
 * A template names its guide (`ProviderTemplate.guide`); one with none has no guide. The words match the console's
 * fixtures in `packages/ui/src/connections/fixtures.ts`.
 */
import type { ProviderTemplate, SetupGuide } from "@kantel/contracts";

/**
 * The Google API library entry to turn on, for a shipped template whose first API host is not its API's own name
 * (Drive and Calendar are served from `www.googleapis.com`). Any other template's is its first API host.
 */
const GOOGLE_API_LIBRARY: { readonly [templateId: string]: string } = {
	"google-drive": "drive.googleapis.com",
	"google-calendar": "calendar-json.googleapis.com",
};

/** Scopes Google calls restricted: only test users may consent until Google verifies the app. */
function restrictedScope(scope: string): boolean {
	return scope.includes("gmail.") || scope === "https://www.googleapis.com/auth/drive";
}

/** Every scope a template's scope sets name, once each, in order. */
function allScopes(template: ProviderTemplate): string[] {
	return [...new Set(template.scopeSets.flatMap((set) => set.scopes))];
}

/** The guide to a Google Cloud OAuth client for a Google API. */
export function googleGuide(template: ProviderTemplate, redirectUri: string): SetupGuide {
	const name = template.name;
	const api = GOOGLE_API_LIBRARY[template.id] ?? template.apiHosts[0] ?? "";
	const scopes = allScopes(template);
	const restricted = scopes.some(restrictedScope);
	return {
		kind: "steps",
		provider: "Google Cloud",
		redirectUri,
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
				values: [{ label: "Authorised redirect URI", value: redirectUri }],
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

/** GitHub's guide: Kantel can have GitHub create the app from a manifest (`startGitHubApp`), or it is made by hand. */
export function githubGuide(redirectUri: string): SetupGuide {
	return {
		kind: "github_app_manifest",
		provider: "GitHub",
		redirectUri,
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
				values: [{ label: "Callback URL", value: redirectUri }],
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

/** The guide a template names, with `redirectUri` (the deployment's callback) in it; `undefined` when it names none. */
export function setupGuide(template: ProviderTemplate, redirectUri: string): SetupGuide | undefined {
	switch (template.guide) {
		case "google":
			return googleGuide(template, redirectUri);
		case "github_app_manifest":
			return githubGuide(redirectUri);
		case undefined:
			return undefined;
	}
}
