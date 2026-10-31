/**
 * GitHub's app manifest flow (#326, tier 3): Harbour posts a manifest describing a GitHub App to GitHub, the person
 * checks it and chooses Create, and GitHub redirects back with a code Harbour converts into the new app's credentials
 * (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). The service keeps
 * the flow's record and its single-use state; this file is the manifest, the page that posts it and the conversion.
 */
import { HarbourError } from "@harbour/contracts";
import type { Fetch } from "./ports.ts";

/** GitHub requires the whole flow, from the manifest to the conversion, within an hour. */
export const GITHUB_APP_TTL_MS = 60 * 60 * 1000;

/** A GitHub organisation's or user's login. */
export const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** What the app may do: no more than agents need, and no more than the console's guide asks for by hand. */
export const GITHUB_APP_PERMISSIONS = {
	contents: "write",
	issues: "write",
	pull_requests: "write",
	actions: "read",
	metadata: "read",
	members: "read",
} as const;

/** GitHub App names are unique across GitHub and at most 34 characters: a short random suffix keeps them apart. */
export function gitHubAppName(clientName: string, account: string | undefined, suffix: string): string {
	const tail = ` ${suffix}`;
	const base = account === undefined ? clientName : `${clientName} for ${account}`;
	return `${base.slice(0, 34 - tail.length).trimEnd()}${tail}`;
}

/**
 * The manifest for a deployment at `origin`. Its OAuth callback is the deployment's connect callback, so the app's
 * client signs people in like any other registered client. The webhook is off: Harbour only needs the user-to-server
 * OAuth client, never events or the app's own identity.
 */
export function gitHubAppManifest(input: {
	readonly origin: string;
	readonly name: string;
	readonly redirectUri: string;
}): Record<string, unknown> {
	return {
		name: input.name,
		url: input.origin,
		redirect_url: `${input.origin}/v1/connections/github-app/callback`,
		callback_urls: [input.redirectUri],
		public: false,
		request_oauth_on_install: false,
		hook_attributes: { url: `${input.origin}/v1/connections/github-app/webhook`, active: false },
		default_permissions: { ...GITHUB_APP_PERMISSIONS },
		default_events: [],
	};
}

/** Where the manifest is posted: the person's own account, or a GitHub organisation's settings. */
export function gitHubAppFormAction(githubOrganisation: string | undefined, state: string): string {
	const base =
		githubOrganisation === undefined
			? "https://github.com/settings/apps/new"
			: `https://github.com/organizations/${encodeURIComponent(githubOrganisation)}/settings/apps/new`;
	return `${base}?state=${encodeURIComponent(state)}`;
}

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The page that sends the manifest on to GitHub: a form posting it, submitted by a one-line inline script (the page's
 * CSP allows inline script, as the connect result page's does), with a visible button for a browser without script.
 */
export function gitHubAppManifestHtml(action: string, manifest: Record<string, unknown>): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Create the GitHub App</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f}h1{font-size:1.25rem}</style>
</head><body><h1>Create the GitHub App</h1>
<p>Harbour is sending you to GitHub with the app filled in. Check it there, then choose Create GitHub App.</p>
<form id="manifest" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>
<noscript><p>Choose Continue to GitHub to go on.</p></noscript>
<script>document.getElementById("manifest").submit();</script>
</body></html>`;
}

/** The part of a converted app Harbour keeps. */
export interface ConvertedGitHubApp {
	readonly id: number;
	readonly slug: string;
	readonly clientId: string;
	/** Write-only from here on: it goes straight into the vault. */
	readonly clientSecret: string;
	readonly htmlUrl: string;
}

/**
 * Converts the code GitHub's redirect carries into the app's credentials (`POST /app-manifests/{code}/conversions`,
 * no authentication: the code is single-use and lasts an hour). Neither the code nor anything GitHub answered goes into
 * an error message: a successful answer holds the app's private key and secrets.
 */
export async function convertManifestCode(fetch: Fetch, code: string): Promise<ConvertedGitHubApp> {
	if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) {
		throw new HarbourError("invalid", "GitHub sent no code Harbour can use");
	}
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
			method: "POST",
			headers: { accept: "application/vnd.github+json", "user-agent": "Harbour", "x-github-api-version": "2022-11-28" },
			redirect: "manual",
		});
	} catch {
		throw new HarbourError("unavailable", "GitHub did not answer");
	}
	const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	const id = body?.id;
	const slug = body?.slug;
	const clientId = body?.client_id;
	const clientSecret = body?.client_secret;
	const htmlUrl = body?.html_url;
	if (
		!response.ok ||
		typeof id !== "number" ||
		typeof slug !== "string" ||
		!/^[A-Za-z0-9-]{1,100}$/.test(slug) ||
		typeof clientId !== "string" ||
		clientId === "" ||
		typeof clientSecret !== "string" ||
		clientSecret === "" ||
		typeof htmlUrl !== "string" ||
		!htmlUrl.startsWith("https://")
	) {
		throw new HarbourError("refused", `GitHub did not hand over the app (status ${response.status})`);
	}
	// Only the user-to-server OAuth client is kept. The app's private key (`pem`) and webhook secret are dropped here and
	// never stored: Harbour signs people in through the app, and never acts as the app itself.
	return { id, slug, clientId, clientSecret, htmlUrl };
}
