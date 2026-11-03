/**
 * Kantel's own sign-in routes, on the console's origin (`/api/auth/…`; the model is in `@kantel/contracts`
 * `sign-in.ts`): a provider's redirect and callback (GitHub today), one-time sign-in links, signing out, and which
 * providers this deployment offers. A Fetch-style handler that needs no credentials; the gateway mounts it in front of
 * its authenticated routes. Portable: Workers, Bun and Node.
 *
 * - Start: a state and a PKCE verifier go in an HttpOnly cookie (`SameSite=Lax`, `Secure` over HTTPS, 10 minutes,
 *   scoped to `/api/auth/`), and the person goes to the provider. The callback refuses a state that doesn't match
 *   the cookie's, so a forged callback can't sign someone in as somebody else.
 * - Callback: each identity the provider vouches for (one per verified email) is tried with `signIn`; the first it
 *   accepts gets a Kantel session, handed to the console in the URL fragment of `CONSOLE_SIGNED_IN_PATH`, which never
 *   reaches a server or a log. Nobody matched is `not_invited`.
 * - A provider without its client ID and secret is listed as not configured, and its start route sends the person
 *   back to the sign-in page with `?error=not_configured`, so the console can say so.
 * - Nothing here logs a token, a code or a link.
 */
import {
	AUTH_LINK_PATH,
	AUTH_PROVIDERS_PATH,
	AUTH_SESSION_END_PATH,
	type AuthProvidersResponse,
	authCallbackPath,
	authStartPath,
	type Clock,
	CONSOLE_SIGN_IN_PATH,
	CONSOLE_SIGNED_IN_PATH,
	type ExternalIdentity,
	type IdentityDirectory,
	isKantelError,
	type SessionResponse,
	type SignIn,
	type SignInError,
	systemClock,
	systemContext,
} from "@kantel/contracts";
import { type OAuthProvider, pkcePair } from "./oauth.ts";
import { randomToken, type Sessions, sessionBearer } from "./sessions.ts";
import { hashSignInLink, isSignInLinkToken, type SignInLinkStore, signInLinkIdentity } from "./sign-in-links.ts";

const SIGN_IN_CONTEXT = systemContext("identity.sign-in");
const STATE_COOKIE = "kantel_oauth";
const STATE_COOKIE_PATH = "/api/auth/";
const STATE_TTL_SECONDS = 10 * 60;
/** The longest return path kept, in characters. */
const MAX_RETURN_LENGTH = 512;

export interface SignInHandlerOptions {
	readonly identity: Pick<IdentityDirectory, "signIn">;
	readonly sessions: Sessions;
	/** The providers this deployment offers, configured or not, in the order the console shows them. */
	readonly providers: readonly OAuthProvider[];
	/** One-time sign-in links. Without them `AUTH_LINK_PATH` is 404. */
	readonly links?: SignInLinkStore;
	/**
	 * The console's origin, as people reach it (`KANTEL_PUBLIC_URL`): providers send people back here, so it must be
	 * the origin registered with them. Default the origin the request came to.
	 */
	readonly publicOrigin?: string;
	readonly clock?: Clock;
	/** Told about a sign-in that failed for a reason other than the person's (the provider down). Never given a token. */
	readonly onError?: (error: unknown) => void;
}

const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...noStore },
	});

const errorJson = (status: number, code: string, message: string) => json(status, { error: { code, message } });

function redirect(location: string, cookie?: string): Response {
	const headers = new Headers({ location, ...noStore });
	if (cookie !== undefined) headers.append("set-cookie", cookie);
	return new Response(null, { status: 302, headers });
}

/** `value` if it is a path on this origin (one leading slash, no scheme or host), else `/`. */
export function safeReturnPath(value: string | null | undefined): string {
	if (typeof value !== "string" || value.length > MAX_RETURN_LENGTH) return "/";
	if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
	if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
	// Never back into the sign-in pages themselves.
	if (value === CONSOLE_SIGN_IN_PATH || value.startsWith(`${CONSOLE_SIGN_IN_PATH}/`)) return "/";
	return value;
}

function cookieValue(request: Request, name: string): string | undefined {
	const header = request.headers.get("cookie");
	if (header === null) return undefined;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return undefined;
}

function stateCookie(value: string, secure: boolean, maxAge: number): string {
	return [
		`${STATE_COOKIE}=${value}`,
		`Path=${STATE_COOKIE_PATH}`,
		`Max-Age=${maxAge}`,
		"HttpOnly",
		"SameSite=Lax",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

const encodeReturn = (path: string): string =>
	btoa(String.fromCharCode(...new TextEncoder().encode(path)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

function decodeReturn(value: string): string {
	try {
		const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
		return safeReturnPath(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
	} catch {
		return "/";
	}
}

/** The first of `identities` `signIn` accepts, or undefined when it refuses them all. */
async function firstAccepted(
	identity: Pick<IdentityDirectory, "signIn">,
	identities: readonly ExternalIdentity[],
): Promise<{ external: ExternalIdentity; signIn: SignIn } | undefined> {
	for (const external of identities) {
		try {
			return { external, signIn: await identity.signIn(SIGN_IN_CONTEXT, external) };
		} catch (error) {
			if (!isKantelError(error, "forbidden")) throw error;
		}
	}
	return undefined;
}

/** The sign-in routes, as a handler for `/api/auth/…`; anything else under it is 404. */
export function createSignInHandler(options: SignInHandlerOptions): (request: Request) => Promise<Response> {
	const { identity, sessions, providers, links } = options;
	const clock = options.clock ?? systemClock;
	const onError =
		options.onError ??
		((error: unknown) => {
			console.error("kantel: a sign-in failed", error instanceof Error ? error.message : error);
		});

	const originOf = (request: Request): string => options.publicOrigin ?? new URL(request.url).origin;
	const signInPage = (request: Request, error: SignInError): string =>
		`${originOf(request)}${CONSOLE_SIGN_IN_PATH}?error=${error}`;

	const sessionOf = (started: Awaited<ReturnType<Sessions["start"]>>): SessionResponse => ({
		token: started.token,
		expiresAt: started.expiresAt,
		user: started.signIn.user,
		organisationIds: started.signIn.organisationIds,
	});

	async function start(request: Request, provider: OAuthProvider): Promise<Response> {
		if (!provider.configured) return redirect(signInPage(request, "not_configured"));
		const origin = originOf(request);
		const state = randomToken("");
		const { verifier, challenge } = await pkcePair();
		const back = safeReturnPath(new URL(request.url).searchParams.get("return"));
		const location = provider.authorizeUrl({
			redirectUri: `${origin}${authCallbackPath(provider.id)}`,
			state,
			codeChallenge: challenge,
		});
		const secure = origin.startsWith("https:");
		return redirect(location, stateCookie(`${state}.${verifier}.${encodeReturn(back)}`, secure, STATE_TTL_SECONDS));
	}

	async function callback(request: Request, provider: OAuthProvider): Promise<Response> {
		const origin = originOf(request);
		const secure = origin.startsWith("https:");
		const clear = stateCookie("", secure, 0);
		const fail = (error: SignInError) => redirect(signInPage(request, error), clear);
		if (!provider.configured) return fail("not_configured");
		const params = new URL(request.url).searchParams;
		const [state, verifier, back] = (cookieValue(request, STATE_COOKIE) ?? "").split(".");
		const given = params.get("state");
		if (state === undefined || state === "" || verifier === undefined || given === null || given !== state) {
			return fail("state");
		}
		if (params.get("error") !== null) return fail("denied");
		const code = params.get("code");
		if (code === null || code === "") return fail("denied");
		let identities: readonly ExternalIdentity[];
		try {
			identities = await provider.identities(code, `${origin}${authCallbackPath(provider.id)}`, verifier);
		} catch (error) {
			if (isKantelError(error, "refused")) return fail("denied");
			onError(error);
			return fail("failed");
		}
		let accepted: Awaited<ReturnType<typeof firstAccepted>>;
		try {
			accepted = await firstAccepted(identity, identities);
		} catch (error) {
			onError(error);
			return fail("failed");
		}
		if (accepted === undefined) return fail("not_invited");
		const started = await sessions.start(accepted.external, accepted.signIn);
		const fragment = new URLSearchParams({
			token: started.token,
			expiresAt: String(started.expiresAt),
			return: decodeReturn(back ?? ""),
		});
		return redirect(`${origin}${CONSOLE_SIGNED_IN_PATH}#${fragment.toString()}`, clear);
	}

	async function redeemLink(request: Request): Promise<Response> {
		if (links === undefined) return errorJson(404, "not_found", "No such route");
		if (request.method !== "POST") return errorJson(405, "invalid", "Use POST");
		if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
			return errorJson(415, "invalid", "Send the token as application/json");
		}
		let token: unknown;
		try {
			token = ((await request.json()) as { token?: unknown })?.token;
		} catch {
			return errorJson(400, "invalid", "The body must be JSON");
		}
		const refused = () => errorJson(401, "unauthenticated", "This sign-in link is unknown, used or expired");
		if (!isSignInLinkToken(token)) return refused();
		const link = await links.redeem(await hashSignInLink(token), clock.now());
		if (link === undefined) return refused();
		const external = signInLinkIdentity(link.userId);
		let signedIn: SignIn;
		try {
			signedIn = await identity.signIn(SIGN_IN_CONTEXT, external);
		} catch (error) {
			if (isKantelError(error, "forbidden")) return refused();
			throw error;
		}
		return json(200, sessionOf(await sessions.start(external, signedIn)));
	}

	async function endSession(request: Request): Promise<Response> {
		if (request.method !== "POST") return errorJson(405, "invalid", "Use POST");
		const token = sessionBearer(request);
		if (token !== undefined) await sessions.end(token);
		return new Response(null, { status: 204, headers: noStore });
	}

	return async (request) => {
		const path = new URL(request.url).pathname;
		if (path === AUTH_PROVIDERS_PATH) {
			const body: AuthProvidersResponse = {
				providers: providers.map((provider) => ({
					id: provider.id,
					name: provider.name,
					configured: provider.configured,
					startPath: authStartPath(provider.id),
				})),
			};
			return json(200, body);
		}
		if (path === AUTH_LINK_PATH) return redeemLink(request);
		if (path === AUTH_SESSION_END_PATH) return endSession(request);
		for (const provider of providers) {
			if (path === authStartPath(provider.id) && request.method === "GET") return start(request, provider);
			if (path === authCallbackPath(provider.id) && request.method === "GET") return callback(request, provider);
		}
		return errorJson(404, "not_found", "No such route");
	};
}
