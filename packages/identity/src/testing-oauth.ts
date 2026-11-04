/**
 * A stand-in for GitHub's and Google's OAuth, for tests of sign-in with them (`oauth.ts`): their consent pages, token
 * endpoints and identity APIs, answered by one `fetch`, and a browser that follows a sign-in from its start to the
 * console. The token endpoint checks the PKCE verifier against the challenge the consent page was given, and the
 * client's ID, secret and redirect URI, as the real ones do.
 */
import type { OAuthProvider } from "@kantel/contracts";
import { type OAuthClients, type OAuthEndpoints, pkceChallenge } from "./oauth.ts";

export const MOCK_OAUTH_ENDPOINTS: { readonly [provider in OAuthProvider]: OAuthEndpoints } = {
	github: {
		authorize: "https://github.mock/login/oauth/authorize",
		token: "https://github.mock/login/oauth/access_token",
		identity: "https://api.github.mock",
	},
	google: {
		authorize: "https://accounts.google.mock/o/oauth2/v2/auth",
		token: "https://oauth2.google.mock/token",
		identity: "https://openidconnect.google.mock/v1/userinfo",
	},
};

export const MOCK_OAUTH_CLIENTS: Required<OAuthClients> = {
	github: { clientId: "Ov23liMockGitHubClient", clientSecret: "mock-github-secret-0123456789abcdef" },
	google: { clientId: "mock-google-client.apps.googleusercontent.com", clientSecret: "GOCSPX-mock-google-secret" },
};

/** Who the person is at GitHub: `/user`, and `/user/emails`. */
export interface MockGitHubAccount {
	readonly id: number;
	readonly login: string;
	readonly name?: string | null;
	readonly emails: readonly { readonly email: string; readonly primary: boolean; readonly verified: boolean }[];
}

/** Who the person is at Google: OpenID Connect's userinfo. */
export interface MockGoogleAccount {
	readonly sub: string;
	readonly email: string;
	readonly email_verified: boolean;
	readonly name?: string;
}

interface Grant {
	readonly provider: OAuthProvider;
	readonly challenge: string;
	readonly redirectUri: string;
	readonly account: MockGitHubAccount | MockGoogleAccount;
}

export interface MockOAuth {
	/** Answers the providers' token and identity calls. */
	readonly fetch: typeof fetch;
	readonly endpoints: typeof MOCK_OAUTH_ENDPOINTS;
	readonly clients: typeof MOCK_OAUTH_CLIENTS;
	/**
	 * The provider's consent page, given its URL (the start's `Location`): the person approves as `account` and is sent
	 * to the callback with a code, or declines (`access_denied`). Throws when the request isn't one the real page takes.
	 */
	consent(authorizeUrl: string, account: MockGitHubAccount | MockGoogleAccount | "decline"): URL;
	/** Every token exchange so far, and whether the provider gave a token for it. */
	readonly exchanges: { readonly provider: OAuthProvider; readonly ok: boolean }[];
}

export function createMockOAuth(): MockOAuth {
	const grants = new Map<string, Grant>();
	const tokens = new Map<string, Grant>();
	const exchanges: { provider: OAuthProvider; ok: boolean }[] = [];
	let next = 0;

	const providerAt = (url: string, kind: keyof OAuthEndpoints): OAuthProvider | undefined =>
		(Object.keys(MOCK_OAUTH_ENDPOINTS) as OAuthProvider[]).find((provider) =>
			kind === "identity"
				? url.startsWith(MOCK_OAUTH_ENDPOINTS[provider].identity)
				: url === MOCK_OAUTH_ENDPOINTS[provider][kind],
		);

	async function exchange(provider: OAuthProvider, request: Request): Promise<Response> {
		const form = new URLSearchParams(await request.text());
		const client = MOCK_OAUTH_CLIENTS[provider];
		const grant = grants.get(form.get("code") ?? "");
		const verifier = form.get("code_verifier") ?? "";
		const refused = (error: string) => {
			exchanges.push({ provider, ok: false });
			// GitHub answers 200 with an `error`; Google a 400.
			return Response.json({ error }, { status: provider === "github" ? 200 : 400 });
		};
		if (form.get("client_id") !== client.clientId || form.get("client_secret") !== client.clientSecret) {
			return refused("invalid_client");
		}
		if (grant === undefined || grant.provider !== provider) return refused("bad_verification_code");
		// A code is good once.
		grants.delete(form.get("code") ?? "");
		if (form.get("redirect_uri") !== grant.redirectUri) return refused("redirect_uri_mismatch");
		if (verifier === "" || (await pkceChallenge(verifier)) !== grant.challenge) return refused("invalid_grant");
		const token = `mock-token-${++next}`;
		tokens.set(token, grant);
		exchanges.push({ provider, ok: true });
		return Response.json({ access_token: token, token_type: "bearer", scope: "granted" });
	}

	function identity(provider: OAuthProvider, request: Request): Response {
		const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
		const grant = token === undefined ? undefined : tokens.get(token);
		if (grant === undefined || grant.provider !== provider)
			return Response.json({ message: "Bad credentials" }, { status: 401 });
		const path = new URL(request.url).pathname;
		if (provider === "google") return Response.json(grant.account);
		const account = grant.account as MockGitHubAccount;
		if (path === "/user") return Response.json({ id: account.id, login: account.login, name: account.name ?? null });
		if (path === "/user/emails") return Response.json(account.emails);
		return Response.json({ message: "Not Found" }, { status: 404 });
	}

	const mockFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const request = new Request(input, init);
		const url = request.url;
		const tokenOf = providerAt(url, "token");
		if (tokenOf !== undefined && request.method === "POST") return exchange(tokenOf, request);
		const identityOf = providerAt(url.replace(/\?.*$/, ""), "identity");
		if (identityOf !== undefined) return identity(identityOf, request);
		return new Response("no such mock", { status: 404 });
	}) as typeof fetch;

	return {
		fetch: mockFetch,
		endpoints: MOCK_OAUTH_ENDPOINTS,
		clients: MOCK_OAUTH_CLIENTS,
		exchanges,
		consent(authorizeUrl, account) {
			const url = new URL(authorizeUrl);
			const provider = providerAt(`${url.origin}${url.pathname}`, "authorize");
			if (provider === undefined) throw new Error(`not a mock consent page: ${authorizeUrl}`);
			const params = url.searchParams;
			const redirectUri = params.get("redirect_uri");
			const challenge = params.get("code_challenge");
			if (params.get("client_id") !== MOCK_OAUTH_CLIENTS[provider].clientId) throw new Error("unknown client");
			if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256") {
				throw new Error("not a PKCE code request");
			}
			if (redirectUri === null || challenge === null || params.get("state") === null) throw new Error("incomplete");
			const back = new URL(redirectUri);
			back.searchParams.set("state", params.get("state") ?? "");
			if (account === "decline") {
				back.searchParams.set("error", "access_denied");
				return back;
			}
			const code = `mock-code-${++next}`;
			grants.set(code, { provider, challenge, redirectUri, account });
			back.searchParams.set("code", code);
			return back;
		},
	};
}

/** A browser's cookie jar for one origin: what `Set-Cookie` set, sent back as `Cookie`. Enough for these flows. */
export class MockCookieJar {
	readonly #cookies = new Map<string, string>();

	/** Keeps what `response` set (and drops what it cleared). */
	take(response: Response): void {
		for (const line of response.headers.getSetCookie()) {
			const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
			const index = pair.indexOf("=");
			const name = pair.slice(0, index);
			const value = pair.slice(index + 1);
			const maxAge = attributes.find((attribute) => attribute.toLowerCase().startsWith("max-age="));
			if (value === "" || maxAge?.toLowerCase() === "max-age=0") this.#cookies.delete(name);
			else this.#cookies.set(name, value);
		}
	}

	get(name: string): string | undefined {
		return this.#cookies.get(name);
	}

	set(name: string, value: string): void {
		this.#cookies.set(name, value);
	}

	delete(name: string): void {
		this.#cookies.delete(name);
	}

	/** The `Cookie` header, or undefined when the jar is empty. */
	header(): string | undefined {
		const pairs = [...this.#cookies].map(([name, value]) => `${name}=${value}`);
		return pairs.length === 0 ? undefined : pairs.join("; ");
	}
}

export interface MockSignInResult {
	/** Where the callback sent the browser: the console's page with `?signed_in=` or `?sign_in_error=`. */
	readonly landing: URL;
	readonly jar: MockCookieJar;
}

/**
 * A browser signing in with `provider` through `gateway`: the start, the provider's consent as `account`, the callback,
 * and (when it signed in) nothing more: pick the session up with `POST /auth/oauth/session` and the jar's cookies.
 * `tamper` changes the callback URL first, for tests of a forged or mixed-up one.
 */
export async function mockOAuthSignIn(
	gateway: (request: Request) => Promise<Response>,
	options: {
		readonly origin: string;
		readonly provider: OAuthProvider;
		readonly oauth: MockOAuth;
		readonly account: MockGitHubAccount | MockGoogleAccount | "decline";
		readonly jar?: MockCookieJar;
		readonly tamper?: (callback: URL, jar: MockCookieJar) => URL | undefined;
		readonly headers?: Record<string, string>;
	},
): Promise<MockSignInResult> {
	const jar = options.jar ?? new MockCookieJar();
	const withCookies = (): Record<string, string> => {
		const cookie = jar.header();
		return { ...options.headers, ...(cookie === undefined ? {} : { cookie }) };
	};
	const started = await gateway(
		new Request(`${options.origin}/auth/oauth/${options.provider}/start`, { headers: withCookies() }),
	);
	if (started.status !== 303) throw new Error(`the start answered ${started.status}: ${await started.text()}`);
	jar.take(started);
	let callback = options.oauth.consent(started.headers.get("location") ?? "", options.account);
	callback = options.tamper?.(callback, jar) ?? callback;
	const back = await gateway(new Request(callback, { headers: withCookies() }));
	if (back.status !== 303) throw new Error(`the callback answered ${back.status}: ${await back.text()}`);
	jar.take(back);
	return { landing: new URL(back.headers.get("location") ?? ""), jar };
}
