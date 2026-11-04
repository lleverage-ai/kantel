// The self-hosted gateway: one fetch handler that mounts the compute plane and Kantel's identity behind the
// deployment's authenticator, and serves the console's static build beside them.
//
//   an exposed port's name      a sandbox's exposed port (compute.ts), before any other route
//   /healthz                    liveness, no credentials
//   /auth/otp/start, /verify    email one-time PIN sign-in (@kantel/identity/otp/http), no credentials, limited per
//   /auth/session/end           client address; it issues Kantel sessions (`kts_…`), which every API below accepts
//   /auth/oauth/<provider>/...  sign-in with GitHub and Google (@kantel/identity/oauth), for each provider whose OAuth
//   /auth/oauth/session         client is set (with KANTEL_PUBLIC_URL); the same limit and the same sessions. Invite-only
//                               as email codes are: a verified email matches an invited person. Off, they are 404
//   /v1/deployment              which implementation backs each contract, and where mail goes (credentials needed)
//   /v1/hosts/...               what `kantel-host` calls: registration, its tunnel, the host images and its sandboxes'
//                               bundles (compute.ts)
//   /v1/file-urls/{token}       a signed file URL (with KANTEL_MOUNTS), whose token is its grant: no credentials
//   /v1/...                     the compute plane's API (@kantel/compute, compute.ts): sandboxes, snapshots, keys,
//                               webhooks, OpenTelemetry, organisations, billing and hosts
//   /v1/audit/events, /event    audit query API (@kantel/audit/http)
//   /v1/me, /v1/projects        who is signed in and their projects, members and a host app's API keys
//   /v1/keys, /v1/members, ...  (@kantel/identity/http); a 401 there names `email_otp` when sign-in by email is set up,
//                               and `github` and `google` when they are, so the console offers them
//   any other /v1/...           404: the agent plane's session, model, connection, approval, vault, skills, memory,
//                               sharing, workspace and browser APIs were removed
//   anything else               the console (apps/console's build), with index.html for its client-side routes
//
// Every route but an exposed port's refuses a browser's write that doesn't come from the console (403,
// @kantel/identity/csrf): a request that changes something and has no Authorization header must name the console's
// origin in Origin (this host over http or https, or KANTEL_PUBLIC_URL), with Sec-Fetch-Site: same-origin when sent. An
// API key or a Kantel session sent as a bearer passes unchanged. Kantel sessions are never read from a cookie.
import { createAuditQueryHandler } from "@kantel/audit/http";
import {
	type Authenticator,
	OTP_START_PATH,
	OTP_VERIFY_PATH,
	SESSION_END_PATH,
	type SignInMethod,
} from "@kantel/contracts";
import { createAuthenticator, withAuthentication } from "@kantel/identity/authenticator";
import { crossSiteRefusal } from "@kantel/identity/csrf";
import { createIdentityHandler, isIdentityPath } from "@kantel/identity/http";
import { type InviteMailer, isInviteMailer } from "@kantel/identity/invites";
import { createOAuthSignIn, isOAuthPath, type OAuthClients, type OAuthSignInOptions } from "@kantel/identity/oauth";
import { createEmailOtp, kantelSessionProvider, type OtpMailer } from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { type AddressLimitOptions, createAddressLimit } from "./address-limit.ts";
import type { GatewayComponents } from "./components.ts";
import type { MailDescription } from "./mail.ts";
import { createStaticHandler } from "./static.ts";

export interface GatewayOptions {
	readonly components: GatewayComponents;
	/** The mail configuration, without credentials, shown at `/v1/deployment`. */
	readonly mail?: MailDescription;
	/**
	 * Sends sign-in codes. Without it the sign-in routes answer 503: nobody could read a code. Kantel sessions still
	 * authenticate. One that is an `InviteMailer` too (the SMTP mailer is) emails each invite; otherwise the admin copies
	 * the link from the console.
	 */
	readonly mailer?: OtpMailer | (OtpMailer & InviteMailer);
	/** Sign-in requests one client address may make. Default: `SIGN_IN_LIMIT`. */
	readonly signInLimit?: AddressLimitOptions;
	/**
	 * Default: API keys and Kantel sessions through `createAuthenticator` over the components' identity directory and
	 * sign-in sessions.
	 */
	readonly authenticator?: Authenticator;
	/** The console's build directory (`apps/console/dist`). Without it, non-API paths are 404. */
	readonly consoleDir?: string;
	/** Where the console is served (KANTEL_PUBLIC_URL): an invite links to it. Default: the console's own page. */
	readonly publicOrigin?: string;
	/**
	 * Sign-in with GitHub and Google: each provider's OAuth client (`oauthClientsFromEnv`). Needs `publicOrigin`, which
	 * the providers' callbacks are under; without it, or a client, a provider's routes are 404.
	 */
	readonly oauth?: OAuthClients;
	/**
	 * GitHub's and Google's endpoints, and the `fetch` their token and identity calls go through. Default the real ones
	 * and the global `fetch`; tests pass a mock's (`@kantel/identity/testing/oauth`).
	 */
	readonly oauthProviders?: Pick<OAuthSignInOptions, "fetch" | "endpoints">;
	/**
	 * The compute plane's API (`compute.ts`, always on under `serveGateway`): it answers its own routes under `/v1`,
	 * signing callers in itself, and `undefined` for every other path.
	 */
	readonly compute?: { fetch(request: Request): Promise<Response | undefined> };
	/**
	 * What `kantel-host` calls with no sign-in (`compute.ts`'s `hostRoutes`): registration, whose join token is its
	 * authority, and the public host images. `undefined` for every other path.
	 */
	readonly computeHosts?: (request: Request) => Promise<Response | undefined>;
	/**
	 * Exposed sandbox ports (`compute.ts`'s `portRoutes`): a request to a port's own name goes there before any other
	 * route, and nothing else answers that name. `undefined` for every other name.
	 */
	readonly computePorts?: (request: Request, client?: ClientInfo) => Promise<Response | undefined>;
}

/** Who sent a request, as the HTTP server saw it: never from a header the client could set. */
export interface ClientInfo {
	readonly address?: string;
}

export interface Gateway {
	fetch(request: Request, client?: ClientInfo): Promise<Response>;
	close(): Promise<void>;
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

const notFound = () => json({ error: { code: "not_found", message: "No such route" } }, 404);

const AUDIT_PREFIX = "/v1/audit/";

const SIGN_IN_PATHS: ReadonlySet<string> = new Set([OTP_START_PATH, OTP_VERIFY_PATH, SESSION_END_PATH]);

/** The mailer behind session ending alone, where email codes are off: never asked to send, as their start is 503. */
const NO_MAILER: OtpMailer = {
	send: async () => {
		throw new Error("Sign-in by email is not set up on this deployment");
	},
};

/** 30 sign-in requests per client address per 15 minutes: room for a few people mistyping codes. */
export const SIGN_IN_LIMIT: AddressLimitOptions = { requests: 30, windowMilliseconds: 15 * 60 * 1000 };

export function createGateway(options: GatewayOptions): Gateway {
	const { components } = options;
	const authenticator =
		options.authenticator ??
		createAuthenticator({
			identity: components.identity,
			providers: [kantelSessionProvider({ sessions: components.otp.sessions })],
		});

	const otpHandler = (mailer: OtpMailer) =>
		createOtpHandler({
			otp: createEmailOtp({
				identity: components.identity,
				codes: components.otp.codes,
				sessions: components.otp.sessions,
				mailer,
				audit: components.audit,
				// Never the code: the identity lane passes only the error and the address typed.
				onMailError: (error, to) => console.error(`[gateway] sign-in mail to ${JSON.stringify(to)} failed:`, error),
			}),
		});
	const signIn = options.mailer === undefined ? undefined : otpHandler(options.mailer);
	const signInLimit = createAddressLimit(options.signInLimit ?? SIGN_IN_LIMIT);

	const oauth =
		options.oauth === undefined || options.publicOrigin === undefined
			? undefined
			: createOAuthSignIn({
					clients: options.oauth,
					publicUrl: options.publicOrigin,
					identity: components.identity,
					sessions: components.otp.sessions,
					audit: components.audit,
					...options.oauthProviders,
					onFailure: (provider, reason) => console.warn(`[gateway] sign-in with ${provider} failed: ${reason}`),
				});

	// Ending a session (signing out) is every sign-in's: with GitHub or Google on and no mailer, it is still served.
	const sessionEnd = signIn ?? (oauth === undefined ? undefined : otpHandler(NO_MAILER));

	const audit = createAuditQueryHandler({ store: components.audit, authenticator });

	// The console asks `/v1/me` first; its 401 says how a person signs in here, and without a mailer or a provider nobody
	// can.
	const methods: readonly SignInMethod[] = [
		...(signIn === undefined ? [] : ["email_otp" as const]),
		...(oauth?.providers ?? []),
	];
	const identity = createIdentityHandler({
		identity: components.identity,
		authenticator,
		signIn: methods,
		// An invite links to the console's public origin: the request URL here is always `http:`.
		invites: {
			...(isInviteMailer(options.mailer) ? { mailer: options.mailer } : {}),
			...(options.publicOrigin === undefined ? {} : { link: () => new URL("/", options.publicOrigin).toString() }),
			onMailError: (error, to) => console.error(`[gateway] invite mail to ${JSON.stringify(to)} failed:`, error),
		},
	});

	const deployment = withAuthentication(authenticator, async () =>
		json({ target: "selfhosted", bindings: components.bindings, mail: options.mail ?? null }),
	);

	const consoleAssets = options.consoleDir === undefined ? undefined : createStaticHandler(options.consoleDir);
	const consoleOrigins = options.publicOrigin === undefined ? [] : [options.publicOrigin];

	return {
		async fetch(request, client = {}) {
			const path = new URL(request.url).pathname;
			try {
				if (options.computePorts !== undefined) {
					const answer = await options.computePorts(request, client);
					if (answer !== undefined) return answer;
				}
				if (path === "/healthz") return json({ ok: true });
				// The request URL here is always http:, so the same host over https (TLS ended in front) is the console too.
				const crossSite = crossSiteRefusal(request, { origins: consoleOrigins, httpsTwin: true });
				if (crossSite !== undefined) return crossSite;
				if (SIGN_IN_PATHS.has(path)) {
					const handler = path === SESSION_END_PATH ? sessionEnd : signIn;
					if (handler === undefined) {
						return json(
							{ error: { code: "unavailable", message: "Sign-in by email is not set up on this deployment" } },
							503,
						);
					}
					const retryAfter = signInLimit.take(client.address ?? "unknown");
					if (retryAfter !== undefined) {
						const limited = json({ error: { code: "exhausted", message: "Too many sign-in requests" } }, 429);
						limited.headers.set("retry-after", String(retryAfter));
						return limited;
					}
					return await handler(request);
				}
				if (isOAuthPath(path)) {
					if (oauth === undefined || !oauth.handles(path)) return notFound();
					const retryAfter = signInLimit.take(client.address ?? "unknown");
					if (retryAfter !== undefined) {
						const limited = json({ error: { code: "exhausted", message: "Too many sign-in requests" } }, 429);
						limited.headers.set("retry-after", String(retryAfter));
						return limited;
					}
					return await oauth.fetch(request);
				}
				if (path === "/v1/deployment") return await deployment(request);
				if (options.computeHosts !== undefined && path.startsWith("/v1/hosts/")) {
					const answer = await options.computeHosts(request);
					if (answer !== undefined) return answer;
				}
				if (options.compute !== undefined && path.startsWith("/v1/")) {
					const answer = await options.compute.fetch(request);
					if (answer !== undefined) return answer;
				}
				if (path.startsWith(AUDIT_PREFIX)) return await audit(request);
				if (isIdentityPath(path)) return await identity(request);
				if (path === "/v1" || path.startsWith("/v1/")) return notFound();
				if (consoleAssets !== undefined) return await consoleAssets(request);
				return notFound();
			} catch (error) {
				// Each API answers its own errors; this is only for one that escapes, such as a directory that is down.
				console.error("[gateway]", error);
				return json({ error: { code: "unavailable", message: "The gateway could not answer" } }, 500);
			}
		},
		async close() {},
	};
}
