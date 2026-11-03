// The self-hosted gateway: one fetch handler that mounts every API behind the deployment's authenticator, and
// serves the console's static build beside them.
//
//   /healthz                    liveness, no credentials
//   /auth/otp/start, /verify    email one-time PIN sign-in (@kantel/identity/otp/http), no credentials, limited per
//   /auth/session/end           client address; it issues Kantel sessions (`kts_…`), which every API below accepts
//   /v1/deployment              which implementation backs each contract, and where mail goes (credentials needed)
//   /v1/me, /v1/projects        who is signed in and their projects, and a host app's API keys (@kantel/identity/http);
//   /v1/keys, /v1/keys/:id/...  a 401 there names `email_otp` when sign-in by email is set up, so the console offers it
//   /v1/me/passkeys...          the signed-in person's passkeys (@kantel/identity/passkey/http), which the approval API
//                               asks for once they have one
//   /v1/workspaces/...          workspace read API (@kantel/workspace/read-api)
//   /v1/audit/events, /event    audit query API (@kantel/audit/http)
//   /v1/skills/...              skills API (@kantel/skills/http, #12): reads, and imports for the organisation's admin
//   /v1/memory/...              memory API (@kantel/memory/http, #12): reads and recall, and new spaces and snapshot
//                               imports for the organisation's admin
//   /v1/sharing/...             sharing API (@kantel/sharing/http): resource shares, access requests, bindings,
//                               policy and a session's uses; the store checks every call
//   /v1/connections/...         connections API (@kantel/connections/http, epic #322), its connect and callback pages,
//                               and the client ID metadata document (no sign-in), when there are connections
//   /v1/tool-servers/...        tool servers API (@kantel/tools/http, docs/site/src/content/docs/api/tool-servers.md),
//                               only with KANTEL_TOOL_SERVERS=experimental; its tunnel, /connect,
//                               is an upgrade (tool-servers.ts)
//   /v1/connection-approvals/... the connection request page's approval API (@kantel/vault/approval-api), when there
//                               is a vault, and /v1/vault/... as its deprecated alias; an approval needs the person's
//                               passkey once they have one, and a refusal is audited
//   /v1/egress/decisions, scope the egress proxy's decisions, behind its own shared key, when that is set (egress.ts)
//   /v1/browser/decisions, /live, /replay   the console's browser routes, when there is a browser (browser.ts)
//   /v1/sessions/:id/browsers/:browser/embed the embed API: a watch-only live or replay link for an outside app
//   /v1/browser/view/:browser/...  a viewer's requests to Kantel's own browsers, with the view link's token
//   /browser/:browser           the console's viewer page, framed only by the console and KANTEL_EMBED_ORIGINS
//   /v1/...                     session API (@kantel/runtime/http): sessions, profiles, hosts
//   anything else               the console (apps/console's build), with index.html for its client-side routes
import { createAuditQueryHandler } from "@kantel/audit/http";
import { BROWSER_DECISIONS, BROWSER_LIVE, BROWSER_REPLAY, createBrowserApi } from "@kantel/browser/http";
import { VIEWER_PAGE, viewerPageHeaders } from "@kantel/browser/runtime";
import { createConnectionsApi, isConnectionsPath } from "@kantel/connections/http";
import {
	type Authenticator,
	type CallContext,
	callContextFor,
	OTP_START_PATH,
	OTP_VERIFY_PATH,
	relyingPartyFor,
	SESSION_END_PATH,
} from "@kantel/contracts";
import { boatWebhookPath, isEnvironmentsPath } from "@kantel/environments/http";
import { createAuthenticator, withAuthentication } from "@kantel/identity/authenticator";
import { createIdentityHandler, isIdentityPath } from "@kantel/identity/http";
import { type InviteMailer, isInviteMailer } from "@kantel/identity/invites";
import { createEmailOtp, kantelSessionProvider, type OtpMailer } from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { createPasskeyHandler, isPasskeyPath } from "@kantel/identity/passkey/http";
import { createMemoryApi } from "@kantel/memory/http";
import { createSessionApi, type SessionApi } from "@kantel/runtime/http";
import { createSharingApi, isSharingPath } from "@kantel/sharing/http";
import { createSkillsApi } from "@kantel/skills/http";
import { createToolServersApi, isToolServersPath } from "@kantel/tools/http";
import { createVaultApprovalApi, isApprovalApiPath } from "@kantel/vault/approval-api";
import { createWorkspaceReadApi, WORKSPACE_READ_API_BASE } from "@kantel/workspace/read-api";
import { type AddressLimitOptions, createAddressLimit } from "./address-limit.ts";
import { type BrowserViews, isViewPath } from "./browser.ts";
import type { GatewayComponents } from "./components.ts";
import { createEgressHandler, type EgressScope } from "./egress.ts";
import type { MailDescription } from "./mail.ts";
import { createModelProvidersApi, isModelProvidersPath } from "./model-providers.ts";
import { createStaticHandler } from "./static.ts";

/** Public: authorisation servers fetch it to learn this deployment's OAuth client (CIMD). */
const CLIENT_METADATA_PATH = "/v1/connections/oauth/client-metadata.json";

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
	/** Which host-tool callback URLs the session API may call. Default: `https:` only. */
	readonly allowCallbackUrl?: (url: URL) => boolean;
	/**
	 * The egress proxy's shared key and the organisation and project it decides for. Without it, or without a vault in
	 * the components, `/v1/egress/...` is not mounted.
	 */
	readonly egress?: { readonly key: string; readonly scope: EgressScope };
	/** A viewer's requests to Kantel's own browsers (`browser.ts`), when the browser is the kantel provider. */
	readonly browserViews?: BrowserViews;
	/** The origins that may frame the viewer page, besides the console (KANTEL_EMBED_ORIGINS). */
	readonly embedOrigins?: string;
	/**
	 * Where the console is served (KANTEL_PUBLIC_URL): an embed's absolute link, and the relying party passkeys are
	 * made for and checked against. Default: the request's origin, which behind a TLS proxy is `http:`, so set it there.
	 */
	readonly publicOrigin?: string;
	/**
	 * The compute plane's API (`compute.ts`, always on under `serveGateway`): it answers its own routes under `/v1`, signing
	 * callers in itself, and `undefined` for every other path.
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

const AUDIT_PREFIX = "/v1/audit/";
const BROWSER_ROUTES: ReadonlySet<string> = new Set([
	`/v1${BROWSER_DECISIONS}`,
	`/v1${BROWSER_LIVE}`,
	`/v1${BROWSER_REPLAY}`,
]);
const BROWSER_EMBED = /^\/v1\/sessions\/[^/]+\/browsers\/[^/]+\/embed$/;
const SKILLS_BASE = "/v1/skills";
const MEMORY_BASE = "/v1/memory";

/** Whether `path` is `base` or under it. */
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

const SIGN_IN_PATHS: ReadonlySet<string> = new Set([OTP_START_PATH, OTP_VERIFY_PATH, SESSION_END_PATH]);

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
		models: runtime.models,
		// The console's message actions: fork from an answer, edit a message and rerun from it.
		branching: runtime.branching,
		// The console's session menu: rename, pin, archive, mark unread and delete a session.
		organising: runtime.organising,
		directory: runtime.directory,
		profiles: runtime.profiles,
		hostTools: runtime.hostTools,
		...(components.hosts === undefined ? {} : { hosts: components.hosts }),
		authenticator,
		...(options.allowCallbackUrl === undefined ? {} : { allowCallbackUrl: options.allowCallbackUrl }),
	});

	// Connections events from a private session the reader can't open are redacted, as Recent uses are (#335).
	const auditConnections = components.connections;
	const audit = createAuditQueryHandler({
		store: components.audit,
		authenticator,
		...(auditConnections === undefined
			? {}
			: { present: (ctx, events) => auditConnections.redactAuditEvents(ctx, events) }),
	});

	// The console asks `/v1/me` first; its 401 says how a person signs in here, and without a mailer nobody can.
	const identity = createIdentityHandler({
		identity: components.identity,
		authenticator,
		signIn: signIn === undefined ? [] : ["email_otp"],
		// An invite links to the console's public origin, as a passkey is made for it: the request URL here is always `http:`.
		invites: {
			...(isInviteMailer(options.mailer) ? { mailer: options.mailer } : {}),
			...(options.publicOrigin === undefined ? {} : { link: () => new URL("/", options.publicOrigin).toString() }),
			onMailError: (error, to) => console.error(`[gateway] invite mail to ${JSON.stringify(to)} failed:`, error),
		},
	});

	// A passkey is made for, and checked against, the console's public origin: the HTTP adapter's request URL is always
	// `http:`, which a browser behind a TLS proxy never signs.
	const relyingParty =
		options.publicOrigin === undefined
			? (request: Request) => relyingPartyFor(request.url)
			: (() => {
					const rp = relyingPartyFor(options.publicOrigin);
					return () => rp;
				})();
	const passkeys = createPasskeyHandler({
		passkeys: components.passkeys,
		authenticator,
		relyingParty,
		signIn: signIn === undefined ? [] : ["email_otp"],
	});

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

	const vault = components.vault;
	const approval =
		vault === undefined
			? undefined
			: (() => {
					const api = createVaultApprovalApi({
						vault,
						authenticate: async (request) => {
							const ctx = callers.get(request);
							if (ctx === undefined) throw new Error("vault approval API reached without authentication");
							return ctx;
						},
						// As on Cloudflare: an approval needs the person's passkey once they have one; a refusal is audited.
						passkeys: components.passkeys,
						relyingParty,
						audit: components.audit,
					});
					return withAuthentication(authenticator, async (request, caller) => {
						callers.set(request, callContextFor(caller));
						return await api(request);
					});
				})();
	// Loading skills and memory (a host adapter's import, a new space) is the organisation admin's, on top of the stores'
	// own rules, which refuse agents and check a project owner's role. Reads follow the stores' rules alone. As on
	// Cloudflare (apps/cloudflare/src/gateway.ts).
	const organisationAdmin = (ctx: CallContext) => components.identity.authorize(ctx, "admin");
	const signedIn = async (request: Request): Promise<CallContext> => {
		const ctx = callers.get(request);
		if (ctx === undefined) throw new Error("skills, memory or sharing API reached without authentication");
		return ctx;
	};
	const skillsApi = createSkillsApi({
		skills: components.skills,
		authenticate: signedIn,
		authorizeImport: organisationAdmin,
	});
	const memoryApi = createMemoryApi({
		memory: components.memory,
		authenticate: signedIn,
		authorizeWrite: organisationAdmin,
	});
	const notFound = () => json({ error: { code: "not_found", message: "No such route" } }, 404);
	const skills = withAuthentication(authenticator, async (request, caller) => {
		callers.set(request, callContextFor(caller));
		return (await skillsApi.fetch(request)) ?? notFound();
	});
	const memory = withAuthentication(authenticator, async (request, caller) => {
		callers.set(request, callContextFor(caller));
		return (await memoryApi.fetch(request)) ?? notFound();
	});
	const sharingApi = createSharingApi({ sharing: components.sharing, authenticate: signedIn });
	const sharing = withAuthentication(authenticator, async (request, caller) => {
		callers.set(request, callContextFor(caller));
		return (await sharingApi.fetch(request)) ?? notFound();
	});
	const connectionsApi =
		components.connections === undefined
			? undefined
			: createConnectionsApi({ connections: components.connections, authenticate: signedIn });
	const connections =
		connectionsApi === undefined
			? undefined
			: withAuthentication(authenticator, async (request, caller) => {
					callers.set(request, callContextFor(caller));
					return (await connectionsApi.fetch(request)) ?? notFound();
				});
	// Model providers (`model-providers.ts`): organisations' own inference, as the console's onboarding connects it.
	const modelProvidersApi =
		components.modelProviders === undefined
			? undefined
			: createModelProvidersApi({ providers: components.modelProviders, authenticate: signedIn });
	const modelProviders =
		modelProvidersApi === undefined
			? undefined
			: withAuthentication(authenticator, async (request, caller) => {
					callers.set(request, callContextFor(caller));
					return modelProvidersApi(request);
				});
	const toolServersApi =
		components.toolServers === undefined
			? undefined
			: createToolServersApi({ toolServers: components.toolServers.service, authenticate: signedIn });
	const toolServers =
		toolServersApi === undefined
			? undefined
			: withAuthentication(authenticator, async (request, caller) => {
					callers.set(request, callContextFor(caller));
					return (await toolServersApi.fetch(request)) ?? notFound();
				});

	// Environments: their routes need a sign-in; boat's webhook is checked by its signature, so it needs none.
	const environmentsApi = components.environments?.api(signedIn);
	const environments =
		environmentsApi === undefined
			? undefined
			: withAuthentication(authenticator, async (request, caller) => {
					callers.set(request, callContextFor(caller));
					return (await environmentsApi.fetch(request)) ?? notFound();
				});

	const sessionBrowser = components.browser;
	const browserApi =
		sessionBrowser === undefined
			? undefined
			: createBrowserApi({
					browser: sessionBrowser.broker,
					session: sessionBrowser,
					authenticate: signedIn,
					basePath: "/v1",
					...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
				});
	const browser = withAuthentication(authenticator, async (request, caller) => {
		if (browserApi === undefined) {
			return json({ error: { code: "unavailable", message: "This deployment has no browser" } }, 503);
		}
		callers.set(request, callContextFor(caller, { signal: request.signal }));
		return (await browserApi.fetch(request)) ?? notFound();
	});

	const egress =
		vault === undefined || options.egress === undefined
			? undefined
			: createEgressHandler({ vault, key: options.egress.key, scope: options.egress.scope });

	const deployment = withAuthentication(authenticator, async () =>
		json({ target: "selfhosted", bindings: components.bindings, mail: options.mail ?? null }),
	);

	const consoleAssets = options.consoleDir === undefined ? undefined : createStaticHandler(options.consoleDir);

	return {
		async fetch(request, client = {}) {
			const path = new URL(request.url).pathname;
			try {
				if (options.computePorts !== undefined) {
					const answer = await options.computePorts(request, client);
					if (answer !== undefined) return answer;
				}
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
				if (options.computeHosts !== undefined && path.startsWith("/v1/hosts/")) {
					const answer = await options.computeHosts(request);
					if (answer !== undefined) return answer;
				}
				if (options.compute !== undefined && path.startsWith("/v1/")) {
					const answer = await options.compute.fetch(request);
					if (answer !== undefined) return answer;
				}
				if (path === WORKSPACE_READ_API_BASE || path.startsWith(`${WORKSPACE_READ_API_BASE}/`)) {
					return await workspaces(request);
				}
				if (path.startsWith(AUDIT_PREFIX)) return await audit(request);
				if (under(path, SKILLS_BASE)) return await skills(request);
				if (under(path, MEMORY_BASE)) return await memory(request);
				if (isSharingPath(path)) return await sharing(request);
				if (connectionsApi !== undefined && connections !== undefined && isConnectionsPath(path)) {
					// The metadata document is public: authorisation servers fetch it to learn this deployment's client.
					if (path === CLIENT_METADATA_PATH) return (await connectionsApi.fetch(request)) ?? notFound();
					return await connections(request);
				}
				if (toolServers !== undefined && isToolServersPath(path)) return await toolServers(request);
				if (modelProviders !== undefined && isModelProvidersPath(path)) return await modelProviders(request);
				if (environmentsApi !== undefined && path === boatWebhookPath()) {
					return (await environmentsApi.fetch(request)) ?? notFound();
				}
				if (environments !== undefined && isEnvironmentsPath(path)) return await environments(request);
				if (approval !== undefined && isApprovalApiPath(path)) {
					return await approval(request);
				}
				if (egress?.matches(path)) return await egress.fetch(request);
				if (isViewPath(path)) {
					return options.browserViews === undefined ? notFound() : await options.browserViews.fetch(request);
				}
				if (BROWSER_ROUTES.has(path) || BROWSER_EMBED.test(path)) {
					// A console route answers anything but a POST with 405 before it signs anyone in, as on Cloudflare.
					if (request.method !== "POST" && BROWSER_ROUTES.has(path) && browserApi !== undefined) {
						return (await browserApi.fetch(request)) ?? notFound();
					}
					return await browser(request);
				}
				if (isPasskeyPath(path)) return await passkeys(request);
				if (isIdentityPath(path)) return await identity(request);
				if (path === "/v1" || path.startsWith("/v1/")) return await sessions.fetch(request);
				if (consoleAssets !== undefined && VIEWER_PAGE.test(path)) {
					const page = await consoleAssets(request);
					return new Response(page.body, {
						status: page.status,
						headers: viewerPageHeaders(page.headers, options.embedOrigins),
					});
				}
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
