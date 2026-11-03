/**
 * OAuth sign-in providers: the seam each one (GitHub today, Google next) fills, and GitHub's. A provider turns the
 * code its authorisation server sends back into the identities Kantel may sign the person in as. Portable: `fetch` and
 * WebCrypto only.
 *
 * GitHub (an OAuth app, https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps):
 * - scopes `read:user user:email`, with PKCE (S256) and the state the sign-in routes check;
 * - the identity's subject is the GitHub user's numeric ID, which outlives a renamed login; its name is their name,
 *   else their login;
 * - one identity per email GitHub has verified for them, the primary first, so an invite to any of their verified
 *   addresses lets them in. An account with no verified email gets one identity with no email: only someone Kantel
 *   already knows by that GitHub ID can sign in with it.
 */
import { type ExternalIdentity, GITHUB_ISSUER, KantelError, type SignInProviderId } from "@kantel/contracts";

export interface OAuthAuthorizeRequest {
	/** Where the provider sends the person back: the console origin's `authCallbackPath(id)`. */
	readonly redirectUri: string;
	readonly state: string;
	/** The PKCE challenge: the base64url SHA-256 of the verifier (S256). */
	readonly codeChallenge: string;
}

export interface OAuthProvider {
	readonly id: SignInProviderId;
	/** As a button says it: "GitHub". */
	readonly name: string;
	/** Whether the deployment has the provider's client ID and secret. A provider that isn't is still listed. */
	readonly configured: boolean;
	/** The provider's authorisation URL to send the person to. */
	authorizeUrl(request: OAuthAuthorizeRequest): string;
	/**
	 * The identities `code` vouches for, the likeliest first (one per verified email). Rejects with `refused` for a
	 * code the provider refuses, `unavailable` when it can't be reached.
	 */
	identities(code: string, redirectUri: string, codeVerifier: string): Promise<readonly ExternalIdentity[]>;
}

export interface GitHubProviderOptions {
	/** `KANTEL_GITHUB_CLIENT_ID`. Without it (or the secret) the provider is listed as not configured. */
	readonly clientId?: string;
	/** `KANTEL_GITHUB_CLIENT_SECRET`. */
	readonly clientSecret?: string;
	/** Default the global `fetch`; tests pass a fake GitHub. */
	readonly fetch?: typeof fetch;
	/** Default `https://github.com`. */
	readonly webUrl?: string;
	/** Default `https://api.github.com`. */
	readonly apiUrl?: string;
}

/** How long a call to GitHub may take before the sign-in counts as failed. */
const GITHUB_TIMEOUT_MILLISECONDS = 10_000;
const GITHUB_SCOPES = "read:user user:email";

interface GitHubUser {
	readonly id?: unknown;
	readonly login?: unknown;
	readonly name?: unknown;
}

interface GitHubEmail {
	readonly email?: unknown;
	readonly verified?: unknown;
	readonly primary?: unknown;
}

const unavailable = (what: string) => new KantelError("unavailable", `GitHub ${what}`);

/** GitHub's OAuth app sign-in. */
export function githubProvider(options: GitHubProviderOptions): OAuthProvider {
	const clientId = options.clientId?.trim() ?? "";
	const clientSecret = options.clientSecret?.trim() ?? "";
	const webUrl = (options.webUrl ?? "https://github.com").replace(/\/+$/, "");
	const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
	const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const configured = clientId !== "" && clientSecret !== "";

	async function call(url: string, init: RequestInit, what: string): Promise<unknown> {
		let response: Response;
		try {
			response = await doFetch(url, {
				...init,
				headers: { accept: "application/json", "user-agent": "kantel", ...(init.headers ?? {}) },
				signal: AbortSignal.timeout(GITHUB_TIMEOUT_MILLISECONDS),
			});
		} catch {
			throw unavailable(`could not be reached for ${what}`);
		}
		if (response.status === 401 || response.status === 403) {
			throw new KantelError("refused", `GitHub refused ${what}`);
		}
		if (!response.ok) throw unavailable(`answered ${response.status} for ${what}`);
		try {
			return await response.json();
		} catch {
			throw unavailable(`sent something other than JSON for ${what}`);
		}
	}

	return {
		id: "github",
		name: "GitHub",
		configured,

		authorizeUrl({ redirectUri, state, codeChallenge }) {
			if (!configured) throw new KantelError("unavailable", "GitHub sign-in is not configured");
			const url = new URL(`${webUrl}/login/oauth/authorize`);
			url.searchParams.set("client_id", clientId);
			url.searchParams.set("redirect_uri", redirectUri);
			url.searchParams.set("scope", GITHUB_SCOPES);
			url.searchParams.set("state", state);
			url.searchParams.set("code_challenge", codeChallenge);
			url.searchParams.set("code_challenge_method", "S256");
			url.searchParams.set("allow_signup", "true");
			return url.toString();
		},

		async identities(code, redirectUri, codeVerifier) {
			if (!configured) throw new KantelError("unavailable", "GitHub sign-in is not configured");
			const exchanged = (await call(
				`${webUrl}/login/oauth/access_token`,
				{
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: clientId,
						client_secret: clientSecret,
						code,
						redirect_uri: redirectUri,
						code_verifier: codeVerifier,
					}).toString(),
				},
				"the sign-in code",
			)) as { access_token?: unknown; error?: unknown };
			// GitHub answers 200 with `error` for a bad, used or expired code.
			if (typeof exchanged?.access_token !== "string" || exchanged.access_token === "") {
				throw new KantelError("refused", "GitHub refused the sign-in code");
			}
			const headers = { authorization: `Bearer ${exchanged.access_token}`, "x-github-api-version": "2022-11-28" };
			const [user, emails] = await Promise.all([
				call(`${apiUrl}/user`, { headers }, "the account") as Promise<GitHubUser>,
				call(`${apiUrl}/user/emails`, { headers }, "the account's emails") as Promise<readonly GitHubEmail[]>,
			]);
			if (typeof user?.id !== "number" && typeof user?.id !== "string") throw unavailable("sent an account with no ID");
			const subject = String(user.id);
			const login = typeof user.login === "string" ? user.login : undefined;
			const name = typeof user.name === "string" && user.name.trim() !== "" ? user.name.trim() : login;
			const verified = (Array.isArray(emails) ? emails : [])
				.filter((entry) => entry?.verified === true && typeof entry.email === "string" && entry.email !== "")
				.sort((a, b) => Number(b.primary === true) - Number(a.primary === true))
				.map((entry) => String(entry.email));
			const base = { issuer: GITHUB_ISSUER, subject, ...(name === undefined ? {} : { name }) };
			if (verified.length === 0) return [base];
			return verified.map((email) => ({ ...base, email, emailVerified: true }));
		},
	};
}

/** A PKCE verifier (32 random bytes, base64url) and its S256 challenge. */
export async function pkcePair(): Promise<{ readonly verifier: string; readonly challenge: string }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const verifier = base64url(bytes);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return { verifier, challenge: base64url(digest) };
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
