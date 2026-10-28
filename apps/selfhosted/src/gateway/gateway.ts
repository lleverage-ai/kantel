// The self-hosted gateway: one fetch handler that mounts every M1 API behind the deployment's authenticator, and
// serves the console's static build beside them.
//
//   /healthz                    liveness, no credentials
//   /auth/otp/start, /verify    email one-time PIN sign-in (@harbour/identity/otp/http), no credentials, limited per
//   /auth/session/end           client address; it issues Harbour sessions (`hbs_…`), which every API below accepts
//   /v1/deployment              which implementation backs each contract, and where mail goes (credentials needed)
//   /v1/workspaces/...          workspace read API (@harbour/workspace/read-api)
//   /v1/audit/events, /event    audit query API (@harbour/audit/http)
//   /v1/...                     session API (@harbour/runtime/http): sessions, profiles, hosts
//   anything else               the console (apps/console's build), with index.html for its client-side routes
import { createAuditQueryHandler } from "@harbour/audit/http";
import {
	type Authenticator,
	type CallContext,
	callContextFor,
	OTP_START_PATH,
	OTP_VERIFY_PATH,
	SESSION_END_PATH,
} from "@harbour/contracts";
import { createAuthenticator, withAuthentication } from "@harbour/identity/authenticator";
import { createEmailOtp, harbourSessionProvider, type OtpMailer } from "@harbour/identity/otp";
import { createOtpHandler } from "@harbour/identity/otp/http";
import { createSessionApi, type SessionApi } from "@harbour/runtime/http";
import { createWorkspaceReadApi, WORKSPACE_READ_API_BASE } from "@harbour/workspace/read-api";
import { type AddressLimitOptions, createAddressLimit } from "./address-limit.ts";
import type { GatewayComponents } from "./components.ts";
import type { MailDescription } from "./mail.ts";
import { createStaticHandler } from "./static.ts";

export interface GatewayOptions {
	readonly components: GatewayComponents;
	/** The mail configuration, without credentials, shown at `/v1/deployment`. */
	readonly mail?: MailDescription;
	/**
	 * Sends sign-in codes. Without it the sign-in routes answer 503: nobody could read a code. Harbour sessions still
	 * authenticate.
	 */
	readonly mailer?: OtpMailer;
	/** Sign-in requests one client address may make. Default: `SIGN_IN_LIMIT`. */
	readonly signInLimit?: AddressLimitOptions;
	/**
	 * Default: API keys and Harbour sessions through `createAuthenticator` over the components' identity directory and
	 * sign-in sessions.
	 */
	readonly authenticator?: Authenticator;
	/** The console's build directory (`apps/console/dist`). Without it, non-API paths are 404. */
	readonly consoleDir?: string;
	/** Which host-tool callback URLs the session API may call. Default: `https:` only. */
	readonly allowCallbackUrl?: (url: URL) => boolean;
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

const AUDIT_PREFIX = "/v1/audit/";

const SIGN_IN_PATHS: ReadonlySet<string> = new Set([OTP_START_PATH, OTP_VERIFY_PATH, SESSION_END_PATH]);

/** 30 sign-in requests per client address per 15 minutes: room for a few people mistyping codes. */
export const SIGN_IN_LIMIT: AddressLimitOptions = { requests: 30, windowMilliseconds: 15 * 60 * 1000 };

export function createGateway(options: GatewayOptions): Gateway {
	const { components } = options;
	const authenticator =
		options.authenticator ??
		createAuthenticator({
			identity: components.identity,
			providers: [harbourSessionProvider({ sessions: components.otp.sessions })],
		});

	const signIn =
		options.mailer === undefined
			? undefined
			: createOtpHandler({
					otp: createEmailOtp({
						identity: components.identity,
						codes: components.otp.codes,
						sessions: components.otp.sessions,
						mailer: options.mailer,
						audit: components.audit,
						// Never the code: the identity lane passes only the error and the address typed.
						onMailError: (error, to) => console.error(`[gateway] sign-in mail to ${JSON.stringify(to)} failed:`, error),
					}),
				});
	const signInLimit = createAddressLimit(options.signInLimit ?? SIGN_IN_LIMIT);
	const runtime = components.runtime;

	const sessions: SessionApi = createSessionApi({
		runtime: runtime.runtime,
		directory: runtime.directory,
		profiles: runtime.profiles,
		hostTools: runtime.hostTools,
		authenticator,
		...(options.allowCallbackUrl === undefined ? {} : { allowCallbackUrl: options.allowCallbackUrl }),
	});

	const audit = createAuditQueryHandler({ store: components.audit, authenticator });

	// The read API takes a context per request; the authentication wrapper turns failures into 401 and 403 first.
	const callers = new WeakMap<Request, CallContext>();
	const readWorkspaces = createWorkspaceReadApi({
		workspaces: components.workspaces,
		authenticate: async (request) => {
			const ctx = callers.get(request);
			if (ctx === undefined) throw new Error("workspace read API reached without authentication");
			return ctx;
		},
	});
	const workspaces = withAuthentication(authenticator, async (request, caller) => {
		callers.set(request, callContextFor(caller));
		return (await readWorkspaces(request)) ?? json({ error: { code: "not_found", message: "No such route" } }, 404);
	});

	const deployment = withAuthentication(authenticator, async () =>
		json({ target: "selfhosted", bindings: components.bindings, mail: options.mail ?? null }),
	);

	const consoleAssets = options.consoleDir === undefined ? undefined : createStaticHandler(options.consoleDir);

	return {
		async fetch(request, client = {}) {
			const path = new URL(request.url).pathname;
			try {
				if (path === "/healthz") return json({ ok: true });
				if (SIGN_IN_PATHS.has(path)) {
					if (signIn === undefined) {
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
					return await signIn(request);
				}
				if (path === "/v1/deployment") return await deployment(request);
				if (path === WORKSPACE_READ_API_BASE || path.startsWith(`${WORKSPACE_READ_API_BASE}/`)) {
					return await workspaces(request);
				}
				if (path.startsWith(AUDIT_PREFIX)) return await audit(request);
				if (path === "/v1" || path.startsWith("/v1/")) return await sessions.fetch(request);
				if (consoleAssets !== undefined) return await consoleAssets(request);
				return json({ error: { code: "not_found", message: "No such route" } }, 404);
			} catch (error) {
				// Each API answers its own errors; this is only for one that escapes, such as a directory that is down.
				console.error("[gateway]", error);
				return json({ error: { code: "unavailable", message: "The gateway could not answer" } }, 500);
			}
		},
		async close() {
			await sessions.close();
		},
	};
}
