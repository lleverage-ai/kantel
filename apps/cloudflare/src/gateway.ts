/**
 * The gateway's API routes, one fetch handler over a `Stack`:
 *
 * | Prefix | Served by |
 * | --- | --- |
 * | `/v1/hosts/register`, `/v1/hosts/images/…`, with account hosts on | hosts, with no sign-in (`src/compute.ts`, `@kantel/hosts`) |
 * | `/v1/whoami`, `/v1/sandboxes`, `/v1/snapshots` and the rest of the compute API | the compute plane (`src/compute.ts`, `@kantel/compute`) |
 * | `/v1/me`, `/v1/projects`, `/v1/keys`, members and invites | who is signed in, their projects and keys (`@kantel/identity/http`) |
 * | `/v1/audit/…` | the audit query API (`@kantel/audit/http`) |
 * | `/auth/otp/start`, `/auth/otp/verify`, `/auth/session/end`, on the public origin only | email-code sign-in (`@kantel/identity/otp/http`), with open sign-up (`src/sign-up.ts`) |
 * | every other `/v1/…` | 404 |
 *
 * In that order, as the self-hosted gateway has them (`apps/selfhosted/src/gateway/gateway.ts`): the compute API
 * answers only its own routes and passes on the rest.
 *
 * The agent plane's routes (sessions, workspaces, skills, memory, schedules, sharing, connections, tool servers,
 * approvals, the vault, passkeys, attachments and browsers) were removed with it; they are kept in git history on the
 * `agent-plane-archive` branch and the `agent-plane-archive-2026-11-03` tag (`e496aeb2`).
 *
 * Every route authenticates with the stack's authenticator: the Access token Cloudflare Access puts in
 * `Cf-Access-Jwt-Assertion` (people), or an API key as a bearer: identity's `ktk_` keys for the identity and audit
 * routes, the compute API's own `ksk_` keys for its routes. The compute API asks for a bearer, so a request with only
 * Access's token gets it as its bearer too (`withAccessBearer`). The console's static assets never reach here.
 *
 * On the public origin (KANTEL_PUBLIC_URL, such as app.kantel.dev, with no Access in front) people sign in with an
 * email code instead, and send the Kantel session (`kts_…`) as their bearer. A 401 there names `email_otp`, so the
 * console shows its own sign-in form; anywhere else it names Access, as before. Each code sent counts against the
 * daily mail cap: once it is reached, a start is refused (503) until the next UTC day.
 *
 * Before any of that, a browser's write that doesn't come from the console is refused (403, `@kantel/identity/csrf`):
 * a request that changes something and has no `Authorization` header must say it is from the origin it was sent to
 * (`Origin`, and `Sec-Fetch-Site: same-origin` when sent), so Access's cookie can't sign in a page elsewhere, a sandbox's
 * port under the same site included. An API key or a Kantel session sent as a bearer passes unchanged.
 */
import { createAuditQueryHandler } from "@kantel/audit/http";
import { OTP_START_PATH, OTP_VERIFY_PATH, SESSION_END_PATH } from "@kantel/contracts";
import { crossSiteRefusal } from "@kantel/identity/csrf";
import { createIdentityHandler, isIdentityPath } from "@kantel/identity/http";
import { type AddressLimitOptions, createAddressLimit } from "./address-limit.ts";
import { withAccessBearer } from "./compute.ts";
import type { Stack } from "./stack.ts";

export const API_BASE = "/v1";
const AUDIT_PREFIX = "/v1/audit/";

export interface Gateway {
	fetch(request: Request): Promise<Response>;
}

const NO_STORE = { "cache-control": "no-store" };

const notFound = () =>
	Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404, headers: NO_STORE });

/** The email-code sign-in routes. */
export const SIGN_IN_PATHS: ReadonlySet<string> = new Set([OTP_START_PATH, OTP_VERIFY_PATH, SESSION_END_PATH]);

/** 30 sign-in requests per client address per 15 minutes, as self-hosted: room for a few people mistyping codes. */
export const SIGN_IN_LIMIT: AddressLimitOptions = { requests: 30, windowMilliseconds: 15 * 60 * 1000 };

export interface GatewayOptions {
	/** The per-address sign-in limit. Default `SIGN_IN_LIMIT`. */
	readonly signInLimit?: AddressLimitOptions;
}

export function createGateway(stack: Stack, options: GatewayOptions = {}): Gateway {
	const audit = createAuditQueryHandler({ store: stack.audit, authenticator: stack.authenticator });
	// A 401 here names Access, so the console reloads for Access to sign the person in rather than showing its own form.
	const identity = createIdentityHandler({
		identity: stack.identity,
		authenticator: stack.authenticator,
		signIn: stack.signIn,
	});
	const email = stack.emailSignIn;
	const publicHost = email === undefined ? undefined : new URL(email.publicUrl).host;
	// On the public origin a 401 names email codes, so the console shows its own form; invites are emailed from there.
	const publicIdentity =
		email === undefined
			? undefined
			: createIdentityHandler({
					identity: stack.identity,
					authenticator: stack.authenticator,
					signIn: ["email_otp"],
					invites: {
						mailer: email.invites,
						link: () => new URL("/", email.publicUrl).toString(),
						onMailError: (error, to) =>
							console.error(
								`kantel: invite mail to ${JSON.stringify(to)} failed:`,
								error instanceof Error ? error.message : error,
							),
					},
				});
	const signInLimit = createAddressLimit(options.signInLimit ?? SIGN_IN_LIMIT);

	return {
		async fetch(incoming) {
			// The console and its API share an origin, on the Access hostname and the public one alike. A host's own
			// requests (no `Origin`, no cookie) pass: they authenticate with what they carry.
			const crossSite = crossSiteRefusal(incoming);
			if (crossSite !== undefined) return crossSite;
			// A host has no sign-in: its join token or credential is its own (the stack object takes its WebSocket).
			const forHosts = await stack.compute.hosts?.fetch(incoming);
			if (forHosts !== undefined) return forHosts;
			const url = new URL(incoming.url);
			const path = url.pathname;
			const onPublic = publicHost !== undefined && url.host === publicHost;
			if (SIGN_IN_PATHS.has(path)) {
				if (email === undefined || !onPublic) return notFound();
				return signIn(incoming, email);
			}
			const request = withAccessBearer(incoming);
			const computed = await stack.compute.fetch(request);
			if (computed !== undefined) return computed;
			if (path.startsWith(AUDIT_PREFIX)) return audit(request);
			if (isIdentityPath(path)) return (onPublic && publicIdentity !== undefined ? publicIdentity : identity)(request);
			return notFound();
		},
	};

	/** A sign-in route: limited per client address, and a start only while today's mail cap lasts. */
	async function signIn(request: Request, email: NonNullable<Stack["emailSignIn"]>): Promise<Response> {
		const address = request.headers.get("cf-connecting-ip") ?? "unknown";
		const retryAfter = signInLimit.take(address);
		if (retryAfter !== undefined) {
			return Response.json(
				{ error: { code: "exhausted", message: "Too many sign-in requests" } },
				{ status: 429, headers: { ...NO_STORE, "retry-after": String(retryAfter) } },
			);
		}
		if (new URL(request.url).pathname === OTP_START_PATH && request.method === "POST" && !(await email.budget.take())) {
			console.warn("kantel: today's sign-in mail cap is reached; refusing a sign-in start");
			return Response.json(
				{
					error: {
						code: "unavailable",
						message: "Kantel has sent all the sign-in codes it can today. Try again tomorrow.",
					},
				},
				{ status: 503, headers: NO_STORE },
			);
		}
		return email.handler(request);
	}
}
