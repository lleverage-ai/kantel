/**
 * A stand-in for GitHub's OAuth app endpoints, for tests: the authorise page (approved in code), the code exchange
 * (checking the client secret, the redirect URI and the PKCE verifier) and the `/user` and `/user/emails` API. Give
 * `githubProvider` its `fetch`, `webUrl` and `apiUrl`; `signInWithGitHub` then walks a whole sign-in through the
 * sign-in routes. Portable, so suites on Workers, Bun and Node can use it.
 */
import {
	type Clock,
	CONSOLE_SIGN_IN_PATH,
	CONSOLE_SIGNED_IN_PATH,
	type IdentityDirectory,
	type SignInError,
} from "@kantel/contracts";
import type { SignInProvider } from "./jwt.ts";
import { githubProvider } from "./oauth.ts";
import { createMemorySessionStore, createSessions, kantelSessionProvider } from "./sessions.ts";
import { createSignInHandler } from "./sign-in-http.ts";

export interface FakeGitHubAccount {
	readonly id: number;
	readonly login: string;
	readonly name?: string;
	readonly emails?: readonly { readonly email: string; readonly verified: boolean; readonly primary?: boolean }[];
}

export interface FakeGitHub {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly webUrl: string;
	readonly apiUrl: string;
	readonly fetch: typeof fetch;
	/** Adds (or replaces) an account. */
	account(account: FakeGitHubAccount): void;
	/**
	 * The person `login` approves the authorise URL Kantel sent them to: the callback URL GitHub sends them back to,
	 * with a code and the state. `deny` answers as GitHub does when they say no.
	 */
	approve(authorizeUrl: string, login: string, options?: { readonly deny?: boolean }): string;
}

const enc = new TextEncoder();

async function s256(verifier: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
	let binary = "";
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createFakeGitHub(
	options: { readonly clientId?: string; readonly clientSecret?: string } = {},
): FakeGitHub {
	const clientId = options.clientId ?? "Iv1.fakeclient";
	const clientSecret = options.clientSecret ?? "fake-secret";
	const webUrl = "https://github.fake";
	const apiUrl = "https://api.github.fake";
	const accounts = new Map<string, FakeGitHubAccount>();
	const codes = new Map<string, { login: string; redirectUri: string; challenge: string }>();
	const tokens = new Map<string, string>();

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	const fake: FakeGitHub["fetch"] = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin === webUrl && url.pathname === "/login/oauth/access_token" && request.method === "POST") {
			const form = new URLSearchParams(await request.text());
			if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) {
				return json({ error: "incorrect_client_credentials" });
			}
			const code = codes.get(form.get("code") ?? "");
			codes.delete(form.get("code") ?? "");
			if (code === undefined || code.redirectUri !== form.get("redirect_uri"))
				return json({ error: "bad_verification_code" });
			if ((await s256(form.get("code_verifier") ?? "")) !== code.challenge)
				return json({ error: "bad_verification_code" });
			const token = `gho_${crypto.randomUUID()}`;
			tokens.set(token, code.login);
			return json({ access_token: token, token_type: "bearer", scope: "read:user,user:email" });
		}
		if (url.origin === apiUrl) {
			const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
			const account = accounts.get(tokens.get(token ?? "") ?? "");
			if (account === undefined) return json({ message: "Bad credentials" }, 401);
			if (url.pathname === "/user") return json({ id: account.id, login: account.login, name: account.name ?? null });
			if (url.pathname === "/user/emails") return json(account.emails ?? []);
		}
		return json({ message: "Not Found" }, 404);
	};

	return {
		clientId,
		clientSecret,
		webUrl,
		apiUrl,
		fetch: fake,
		account(account) {
			accounts.set(account.login, account);
		},
		approve(authorizeUrl, login, approveOptions = {}) {
			const url = new URL(authorizeUrl);
			if (url.origin !== webUrl || url.pathname !== "/login/oauth/authorize")
				throw new Error("not GitHub's authorise URL");
			if (url.searchParams.get("client_id") !== clientId) throw new Error("the wrong client ID");
			if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("no PKCE");
			const redirectUri = url.searchParams.get("redirect_uri") ?? "";
			const back = new URL(redirectUri);
			back.searchParams.set("state", url.searchParams.get("state") ?? "");
			if (approveOptions.deny === true) {
				back.searchParams.set("error", "access_denied");
				return back.toString();
			}
			const code = crypto.randomUUID();
			codes.set(code, { login, redirectUri, challenge: url.searchParams.get("code_challenge") ?? "" });
			back.searchParams.set("code", code);
			return back.toString();
		},
	};
}

/** A suite's sign-in: a fake GitHub, the sign-in routes over it, and a session provider for the authenticator. */
export interface TestSignIn {
	readonly github: FakeGitHub;
	/** For `createAuthenticator`'s providers. */
	readonly sessionProvider: SignInProvider;
	/** The sign-in routes (`/api/auth/…`). */
	readonly handler: (request: Request) => Promise<Response>;
	/**
	 * Signs in the GitHub account whose primary verified email is `email` (made on first use), through the routes:
	 * the session token.
	 */
	tokenFor(email: string): Promise<string>;
}

export function createTestSignIn(options: {
	readonly identity: IdentityDirectory;
	readonly clock?: Clock;
}): TestSignIn {
	const github = createFakeGitHub();
	const store = createMemorySessionStore();
	const clock = options.clock === undefined ? {} : { clock: options.clock };
	const handler = createSignInHandler({
		identity: options.identity,
		sessions: createSessions({ identity: options.identity, sessions: store, ...clock }),
		providers: [githubProvider(github)],
		...clock,
	});
	const ids = new Map<string, number>();
	return {
		github,
		sessionProvider: kantelSessionProvider({ sessions: store, ...clock }),
		handler,
		async tokenFor(email) {
			const login = email.replace(/[^a-z0-9]/gi, "-");
			if (!ids.has(login)) {
				ids.set(login, ids.size + 1);
				github.account({ id: ids.size, login, emails: [{ email, verified: true, primary: true }] });
			}
			const signedIn = await signInWithGitHub(handler, github, login);
			if (!signedIn.ok) throw new Error(`${email} could not sign in: ${signedIn.error}`);
			return signedIn.token;
		},
	};
}

/** What a sign-in through the routes ended in: a session, or the error the sign-in page was sent. */
export type GitHubSignInResult =
	| { readonly ok: true; readonly token: string; readonly expiresAt: number; readonly returnTo: string }
	| { readonly ok: false; readonly error: SignInError | string };

/**
 * Walks a GitHub sign-in through `serve` (a gateway, or the sign-in handler): the start route, GitHub's approval as
 * `login`, and the callback with the state cookie the start set.
 */
export async function signInWithGitHub(
	serve: (request: Request) => Promise<Response>,
	github: FakeGitHub,
	login: string,
	options: { readonly origin?: string; readonly returnTo?: string; readonly deny?: boolean } = {},
): Promise<GitHubSignInResult> {
	const origin = options.origin ?? "http://kantel.test";
	const query = options.returnTo === undefined ? "" : `?return=${encodeURIComponent(options.returnTo)}`;
	const started = await serve(new Request(`${origin}/api/auth/github/start${query}`));
	const location = started.headers.get("location") ?? "";
	if (location.includes(`${CONSOLE_SIGN_IN_PATH}?error=`)) {
		return { ok: false, error: new URL(location).searchParams.get("error") ?? "" };
	}
	const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	const callback = github.approve(location, login, options.deny === undefined ? {} : { deny: options.deny });
	const finished = await serve(new Request(callback, { headers: { cookie } }));
	const done = new URL(finished.headers.get("location") ?? "", origin);
	if (done.pathname === CONSOLE_SIGNED_IN_PATH) {
		const fragment = new URLSearchParams(done.hash.slice(1));
		return {
			ok: true,
			token: fragment.get("token") ?? "",
			expiresAt: Number(fragment.get("expiresAt")),
			returnTo: fragment.get("return") ?? "",
		};
	}
	return { ok: false, error: done.searchParams.get("error") ?? `status ${finished.status}` };
}
