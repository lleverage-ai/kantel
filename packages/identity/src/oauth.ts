/**
 * Sign-in with GitHub and Google (TASK-5060): OAuth 2.0's authorisation code flow with PKCE, over HTTP, as a
 * Fetch-style handler either gateway mounts beside email one-time PIN sign-in. The routes and the console's side are
 * in `packages/contracts/src/identity.ts` (`oauthStartPath`):
 *
 * - `GET /auth/oauth/<provider>/start` makes a state and a PKCE verifier, keeps them in a short-lived HttpOnly cookie
 *   (`kantel_oauth`, 10 minutes, `SameSite=Lax` so it comes back on the provider's redirect), and redirects to the
 *   provider's consent page with the state and the verifier's S256 challenge.
 * - `GET /auth/oauth/<provider>/callback` clears that cookie, and goes on only when the state matches it: a callback
 *   that didn't start in this browser (a stale tab, another browser, a forged link) is `state_mismatch`. It exchanges
 *   the code with the verifier and the client secret, reads who the person is (GitHub: `/user` and the primary
 *   verified email of `/user/emails`; Google: OpenID Connect's userinfo, whose `email_verified` must be true), and
 *   signs them in: `signIn` with `GITHUB_ISSUER` or `GOOGLE_ISSUER` and the provider's user ID as subject. The new
 *   Kantel session goes in a second HttpOnly cookie (`kantel_oauth_session`, 2 minutes, `SameSite=Strict`), and the
 *   browser goes back to the console with `?signed_in=<provider>`; on any failure, with `?sign_in_error=<why>`.
 * - `POST /auth/oauth/session` (same origin, no body; the gateway's cross-site check refuses another page's) hands the
 *   console that session as `OtpVerifyResponse` and clears the cookie, or answers 401. The console keeps it as it does
 *   an email code's: a bearer in its localStorage. So no gateway reads a session from a cookie.
 *
 * Nothing is kept on the server between start and callback, so it works across replicas and Worker isolates alike.
 * A provider is on only with its client ID and secret both set (`oauthClientsFromEnv`); `providers` names the ones
 * that are, and each gateway answers 404 for the others' routes.
 */
import {
	type Clock,
	type ExternalIdentity,
	GITHUB_ISSUER,
	GOOGLE_ISSUER,
	type IdentityDirectory,
	isKantelError,
	isOAuthProvider,
	OAUTH_DONE_PARAM,
	OAUTH_ERROR_PARAM,
	OAUTH_PATH_PREFIX,
	OAUTH_PROVIDER_PARAM,
	OAUTH_PROVIDERS,
	OAUTH_SESSION_PATH,
	type OAuthProvider,
	type OAuthSignInError,
	type OtpVerifyResponse,
	oauthCallbackPath,
	type SignIn,
	type SystemContext,
	systemClock,
	systemContext,
} from "@kantel/contracts";
import { clearConsoleCookie, readConsoleCookie, setConsoleCookie } from "./cookies.ts";
import {
	createSessionStarter,
	hashSessionToken,
	isSessionToken,
	type SessionStarterOptions,
	type StartedSession,
} from "./otp.ts";

/** A provider's OAuth client, as registered with it. */
export interface OAuthClient {
	readonly clientId: string;
	readonly clientSecret: string;
}

export type OAuthClients = { readonly [provider in OAuthProvider]?: OAuthClient };

/** The environment variables each provider's client is read from, on both gateways. */
export const OAUTH_CLIENT_ENV: {
	readonly [provider in OAuthProvider]: { readonly id: string; readonly secret: string };
} = {
	github: { id: "KANTEL_GITHUB_CLIENT_ID", secret: "KANTEL_GITHUB_CLIENT_SECRET" },
	google: { id: "KANTEL_GOOGLE_CLIENT_ID", secret: "KANTEL_GOOGLE_CLIENT_SECRET" },
};

/**
 * The providers whose client ID and secret are both set in `env`. One set without the other turns nothing on, and is
 * reported to `warn` (by name only, never the value).
 */
export function oauthClientsFromEnv(
	/** `process.env`, or a Worker's `env`. */
	env: object,
	warn: (message: string) => void = console.warn,
): OAuthClients {
	const read = (name: string): string => {
		const value = (env as { readonly [name: string]: unknown })[name];
		return typeof value === "string" ? value.trim() : "";
	};
	const clients: { [provider in OAuthProvider]?: OAuthClient } = {};
	for (const provider of OAUTH_PROVIDERS) {
		const names = OAUTH_CLIENT_ENV[provider];
		const clientId = read(names.id);
		const clientSecret = read(names.secret);
		if (clientId !== "" && clientSecret !== "") clients[provider] = { clientId, clientSecret };
		else if (clientId !== "" || clientSecret !== "") {
			warn(`kantel: ${clientId === "" ? names.id : names.secret} is not set, so sign-in with ${provider} is off`);
		}
	}
	return clients;
}

/** The scopes Kantel asks each provider for: who the person is and their verified email, nothing more. */
export const OAUTH_SCOPES: { readonly [provider in OAuthProvider]: string } = {
	github: "read:user user:email",
	google: "openid email profile",
};

/** Where each provider's consent page, token endpoint and identity are. Tests point them at a mock. */
export interface OAuthEndpoints {
	readonly authorize: string;
	readonly token: string;
	/** GitHub: the API's base (`/user`, `/user/emails`). Google: the userinfo endpoint. */
	readonly identity: string;
}

export const OAUTH_ENDPOINTS: { readonly [provider in OAuthProvider]: OAuthEndpoints } = {
	github: {
		authorize: "https://github.com/login/oauth/authorize",
		token: "https://github.com/login/oauth/access_token",
		identity: "https://api.github.com",
	},
	google: {
		authorize: "https://accounts.google.com/o/oauth2/v2/auth",
		token: "https://oauth2.googleapis.com/token",
		identity: "https://openidconnect.googleapis.com/v1/userinfo",
	},
};

export const OAUTH_STATE_COOKIE = "kantel_oauth";
export const OAUTH_SESSION_COOKIE = "kantel_oauth_session";
/** How long a person has on the provider's consent page. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
/** How long the console has to pick up the session after the callback. */
export const OAUTH_SESSION_HANDOFF_SECONDS = 2 * 60;

export interface OAuthSignInOptions extends Omit<SessionStarterOptions, "clock"> {
	readonly clients: OAuthClients;
	/** The origin people reach the console on, such as `https://app.kantel.dev`: the callbacks are under it. */
	readonly publicUrl: string;
	/** Signs the person in; on the hosted service, wrapped in open sign-up (`apps/cloudflare/src/sign-up.ts`). */
	readonly identity: Pick<IdentityDirectory, "signIn">;
	readonly clock?: Clock;
	/** For the provider's token and identity calls. Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	readonly endpoints?: { readonly [provider in OAuthProvider]?: Partial<OAuthEndpoints> };
	/** Told why a sign-in failed, never with a code, token or secret. Default `console.warn`. */
	readonly onFailure?: (provider: OAuthProvider, reason: string) => void;
}

export interface OAuthSignIn {
	/** The providers that are on, in `OAUTH_PROVIDERS` order: what the 401's `signIn` names besides email codes. */
	readonly providers: readonly OAuthProvider[];
	/** Whether `path` is one of the routes this answers: an on provider's start or callback, or the session pick-up. */
	handles(path: string): boolean;
	fetch(request: Request): Promise<Response>;
}

const OAUTH_CONTEXT: SystemContext = systemContext("identity.oauth");

/** The path `/auth/oauth/<provider>/<step>` names, when it names one. */
export function oauthRouteOf(
	path: string,
): { readonly provider: OAuthProvider; readonly step: "start" | "callback" } | undefined {
	if (!path.startsWith(OAUTH_PATH_PREFIX)) return undefined;
	const [provider, step, ...rest] = path.slice(OAUTH_PATH_PREFIX.length).split("/");
	if (rest.length > 0 || !isOAuthProvider(provider) || (step !== "start" && step !== "callback")) return undefined;
	return { provider, step };
}

/** Whether `path` is under `/auth/oauth/`: each gateway answers every one of them itself, a 404 when it's off. */
export const isOAuthPath = (path: string): boolean => path.startsWith(OAUTH_PATH_PREFIX);

function randomToken(bytes = 32): string {
	const buffer = new Uint8Array(bytes);
	crypto.getRandomValues(buffer);
	return base64url(buffer);
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE's S256 challenge for `verifier`. */
export async function pkceChallenge(verifier: string): Promise<string> {
	return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Compares two strings without stopping at the first difference. */
function sameString(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

/** What the state cookie holds: `<provider>.<state>.<verifier>.<expires, seconds>`, each cookie-safe. */
interface PendingSignIn {
	readonly provider: OAuthProvider;
	readonly state: string;
	readonly verifier: string;
	readonly expiresAt: number;
}

function pendingOf(value: string | undefined): PendingSignIn | undefined {
	const [provider, state, verifier, expires, ...rest] = (value ?? "").split(".");
	if (rest.length > 0 || !isOAuthProvider(provider) || !state || !verifier || !expires) return undefined;
	const expiresAt = Number(expires) * 1000;
	return Number.isFinite(expiresAt) ? { provider, state, verifier, expiresAt } : undefined;
}

/** A provider's answer was not what was asked for. */
class ProviderRefused extends Error {}

/** The person a provider vouched for, or why they can't sign in with it. */
type ProviderIdentity = ExternalIdentity | "unverified_email";

/**
 * Whether Google is authoritative for `email`, so its `email_verified` says who holds the address now: a Gmail address,
 * or any address of a Google Workspace account, which has the hosted domain `hd`
 * (https://developers.google.com/identity/sign-in/web/backend-auth).
 */
export function googleIsAuthoritative(email: string, hd: unknown): boolean {
	return /@gmail\.com$/i.test(email.trim()) || (typeof hd === "string" && hd.trim() !== "");
}

export function createOAuthSignIn(options: OAuthSignInOptions): OAuthSignIn {
	const clock = options.clock ?? systemClock;
	const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
	const publicUrl = new URL(options.publicUrl);
	const secure = publicUrl.protocol === "https:";
	const onFailure =
		options.onFailure ??
		((provider: OAuthProvider, reason: string) => console.warn(`kantel: sign-in with ${provider} failed: ${reason}`));
	const starter = createSessionStarter({
		sessions: options.sessions,
		clock,
		...(options.audit === undefined ? {} : { audit: options.audit }),
		...(options.sessionTtlMilliseconds === undefined ? {} : { sessionTtlMilliseconds: options.sessionTtlMilliseconds }),
	});
	const providers = OAUTH_PROVIDERS.filter((provider) => options.clients[provider] !== undefined);
	const endpointsOf = (provider: OAuthProvider): OAuthEndpoints => ({
		...OAUTH_ENDPOINTS[provider],
		...options.endpoints?.[provider],
	});
	const callbackUrl = (provider: OAuthProvider) => new URL(oauthCallbackPath(provider), publicUrl).toString();
	const consoleUrl = (params: Record<string, string>) => {
		const url = new URL("/", publicUrl);
		for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
		return url.toString();
	};

	const redirect = (location: string, cookies: readonly string[]) => {
		const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
		for (const cookie of cookies) headers.append("set-cookie", cookie);
		return new Response(null, { status: 303, headers });
	};
	const json = (status: number, body: unknown, cookies: readonly string[] = []) => {
		const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		for (const cookie of cookies) headers.append("set-cookie", cookie);
		return new Response(JSON.stringify(body), { status, headers });
	};
	const notFound = () => json(404, { error: { code: "not_found", message: "No such route" } });
	const clearState = () => clearConsoleCookie(OAUTH_STATE_COOKIE, { secure });
	const clearSession = () => clearConsoleCookie(OAUTH_SESSION_COOKIE, { secure });
	const failed = (provider: OAuthProvider, error: OAuthSignInError, reason: string) => {
		onFailure(provider, reason);
		return redirect(consoleUrl({ [OAUTH_ERROR_PARAM]: error, [OAUTH_PROVIDER_PARAM]: provider }), [clearState()]);
	};

	async function start(provider: OAuthProvider, client: OAuthClient): Promise<Response> {
		const state = randomToken();
		const verifier = randomToken(48);
		const expires = Math.floor(clock.now() / 1000) + OAUTH_STATE_TTL_SECONDS;
		const authorize = new URL(endpointsOf(provider).authorize);
		authorize.search = new URLSearchParams({
			client_id: client.clientId,
			redirect_uri: callbackUrl(provider),
			response_type: "code",
			scope: OAUTH_SCOPES[provider],
			state,
			code_challenge: await pkceChallenge(verifier),
			code_challenge_method: "S256",
			// Google: let someone signed in to several accounts choose one.
			...(provider === "google" ? { prompt: "select_account" } : {}),
		}).toString();
		return redirect(authorize.toString(), [
			setConsoleCookie(OAUTH_STATE_COOKIE, `${provider}.${state}.${verifier}.${expires}`, {
				secure,
				maxAgeSeconds: OAUTH_STATE_TTL_SECONDS,
				sameSite: "Lax",
			}),
		]);
	}

	/** The access token for `code`, exchanged with the verifier and the client secret. */
	async function exchange(
		provider: OAuthProvider,
		client: OAuthClient,
		code: string,
		verifier: string,
	): Promise<string> {
		const response = await doFetch(endpointsOf(provider).token, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: client.clientId,
				client_secret: client.clientSecret,
				code,
				redirect_uri: callbackUrl(provider),
				code_verifier: verifier,
			}).toString(),
		});
		const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
		if (!response.ok || typeof body.access_token !== "string" || body.access_token === "") {
			// GitHub answers 200 with `error` (a wrong verifier is `bad_verification_code`); Google answers 400.
			throw new ProviderRefused(`the token exchange answered ${response.status} ${String(body.error ?? "")}`.trim());
		}
		return body.access_token;
	}

	async function providerJson(url: string, accessToken: string): Promise<unknown> {
		const response = await doFetch(url, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${accessToken}`,
				// GitHub's API refuses a request without one.
				"user-agent": "kantel",
			},
		});
		if (!response.ok) throw new ProviderRefused(`${new URL(url).pathname} answered ${response.status}`);
		return response.json();
	}

	async function githubIdentity(accessToken: string): Promise<ProviderIdentity> {
		const base = endpointsOf("github").identity.replace(/\/+$/, "");
		const [user, emails] = await Promise.all([
			providerJson(`${base}/user`, accessToken) as Promise<{ id?: unknown; login?: unknown; name?: unknown }>,
			providerJson(`${base}/user/emails`, accessToken) as Promise<unknown>,
		]);
		if (typeof user.id !== "number" && typeof user.id !== "string") throw new ProviderRefused("/user has no id");
		// Only the primary email, and only once GitHub has verified it: any other could be someone else's.
		const primary = Array.isArray(emails)
			? (emails as { email?: unknown; primary?: unknown; verified?: unknown }[]).find(
					(entry) => entry.primary === true && entry.verified === true && typeof entry.email === "string",
				)
			: undefined;
		if (primary === undefined) return "unverified_email";
		const name = typeof user.name === "string" && user.name.trim() !== "" ? user.name : user.login;
		return {
			issuer: GITHUB_ISSUER,
			subject: String(user.id),
			email: String(primary.email),
			emailVerified: true,
			...(typeof name === "string" && name !== "" ? { name } : {}),
		};
	}

	async function googleIdentity(accessToken: string): Promise<ProviderIdentity> {
		const info = (await providerJson(endpointsOf("google").identity, accessToken)) as {
			sub?: unknown;
			email?: unknown;
			email_verified?: unknown;
			hd?: unknown;
			name?: unknown;
		};
		if (typeof info.sub !== "string" || info.sub === "") throw new ProviderRefused("userinfo has no sub");
		// OpenID Connect's userinfo: Google says `email_verified` true only for an address it has verified.
		if (info.email_verified !== true || typeof info.email !== "string" || info.email === "") return "unverified_email";
		const name = typeof info.name === "string" && info.name !== "" ? { name: info.name } : {};
		// But it vouches for the address now only where it is authoritative for it: Gmail, or a Workspace account (`hd`).
		// Another address was verified once, when the account was made, and may have changed hands since; it signs in only
		// an account already linked (by its subject), and never links, joins an invite or signs up by that email.
		if (!googleIsAuthoritative(info.email, info.hd)) return { issuer: GOOGLE_ISSUER, subject: info.sub, ...name };
		return { issuer: GOOGLE_ISSUER, subject: info.sub, email: info.email, emailVerified: true, ...name };
	}

	async function callback(request: Request, provider: OAuthProvider, client: OAuthClient): Promise<Response> {
		const params = new URL(request.url).searchParams;
		const pending = pendingOf(readConsoleCookie(request, OAUTH_STATE_COOKIE, { secure }));
		const state = params.get("state") ?? "";
		if (
			pending === undefined ||
			pending.provider !== provider ||
			pending.expiresAt <= clock.now() ||
			!sameString(pending.state, state)
		) {
			return failed(provider, "state_mismatch", "the state did not match this browser's");
		}
		const error = params.get("error");
		if (error !== null) {
			return failed(provider, error === "access_denied" ? "cancelled" : "failed", `the provider answered ${error}`);
		}
		const code = params.get("code");
		if (code === null || code === "") return failed(provider, "failed", "the callback had no code");

		let external: ProviderIdentity;
		try {
			const accessToken = await exchange(provider, client, code, pending.verifier);
			external = provider === "github" ? await githubIdentity(accessToken) : await googleIdentity(accessToken);
		} catch (cause) {
			return failed(provider, "failed", cause instanceof Error ? cause.message : String(cause));
		}
		if (external === "unverified_email") return failed(provider, "unverified_email", "no verified email");

		let session: StartedSession;
		try {
			session = await starter.start(external, await options.identity.signIn(OAUTH_CONTEXT, external));
		} catch (cause) {
			if (isKantelError(cause, "forbidden")) {
				// With no email the provider vouches for, only an account linked already could sign in.
				return external.emailVerified === true
					? failed(provider, "not_allowed", "nobody here matches them")
					: failed(provider, "unverified_email", "the provider is not authoritative for their email");
			}
			return failed(provider, "failed", `signing in failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		const maxAge = Math.max(1, Math.min(OAUTH_SESSION_HANDOFF_SECONDS, (session.expiresAt - clock.now()) / 1000));
		return redirect(consoleUrl({ [OAUTH_DONE_PARAM]: provider }), [
			clearState(),
			setConsoleCookie(OAUTH_SESSION_COOKIE, session.token, { secure, maxAgeSeconds: maxAge, sameSite: "Strict" }),
		]);
	}

	/** `POST /auth/oauth/session`: the session the callback left, once. */
	async function handOff(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return json(405, { error: { code: "invalid", message: "Use POST" } });
		}
		const unauthenticated = () =>
			json(401, { error: { code: "unauthenticated", message: "There is no sign-in to pick up" } }, [clearSession()]);
		const token = readConsoleCookie(request, OAUTH_SESSION_COOKIE, { secure });
		if (token === undefined || !isSessionToken(token)) return unauthenticated();
		const session = await options.sessions.find(await hashSessionToken(token), clock.now());
		if (session === undefined) return unauthenticated();
		let signedIn: SignIn;
		try {
			signedIn = await options.identity.signIn(OAUTH_CONTEXT, {
				issuer: session.issuer,
				subject: session.subject,
				...(session.email === undefined ? {} : { email: session.email, emailVerified: true }),
				userId: session.userId,
			});
		} catch (cause) {
			if (isKantelError(cause, "forbidden")) return unauthenticated();
			throw cause;
		}
		const body: OtpVerifyResponse = {
			token,
			expiresAt: session.expiresAt,
			user: signedIn.user,
			organisationIds: signedIn.organisationIds,
		};
		return json(200, body, [clearSession()]);
	}

	return {
		providers,
		handles(path) {
			if (path === OAUTH_SESSION_PATH) return providers.length > 0;
			const route = oauthRouteOf(path);
			return route !== undefined && options.clients[route.provider] !== undefined;
		},
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === OAUTH_SESSION_PATH && providers.length > 0) return handOff(request);
			const route = oauthRouteOf(path);
			const client = route === undefined ? undefined : options.clients[route.provider];
			if (route === undefined || client === undefined) return notFound();
			if (request.method !== "GET" && request.method !== "HEAD") {
				return json(405, { error: { code: "invalid", message: "Use GET" } });
			}
			return route.step === "start" ? start(route.provider, client) : callback(request, route.provider, client);
		},
	};
}
