/**
 * The gateway's API routes, one fetch handler over a `Stack`:
 *
 * | Prefix | Served by |
 * | --- | --- |
 * | `POST /v1/workspaces` | the workspace write API (`@harbour/workspace/write-api`): a seeded workspace, operators only |
 * | `/v1/workspaces/…` | the workspace read API (`@harbour/workspace/read-api`, PR #58) |
 * | `GET /v1/git/branches` | a repository's branches for a new session's branch picker (`@harbour/workspace/git-refs`), operators only |
 * | `/v1/audit/…` | the audit query API (`@harbour/audit/http`, PR #60) |
 * | `POST /v1/measurements/isolate-ready` | the isolate-ready measurement (`src/measure.ts`) |
 * | `/v1/me`, `/v1/projects` | who is signed in and their projects (`@harbour/identity/http`) |
 * | `/v1/keys`, `POST /v1/keys/:id/revoke` | host apps' API keys (`@harbour/identity/http`): operator or above to reach, admin of each key's projects to see or change it |
 * | `/v1/me/passkeys…` | the signed-in person's passkeys (`@harbour/identity/passkey/http`), which the approval API asks for |
 * | `/v1/vault/…` | the vault approval API (`@harbour/vault/approval-api`), when the stack has a vault |
 * | `/v1/skills`, `/v1/skills/…` | the skills API (`@harbour/skills/http`, #12): reads, and imports for the organisation's admin or a key with the `import` permission |
 * | `/v1/memory/…` | the memory API (`@harbour/memory/http`, #12): reads, search and recall; creating a space for the organisation's admin, and loading a snapshot for the admin or a key with the `import` permission |
 * | `/v1/rules`, `/v1/rules/…` | the prompt rules API (`@harbour/rules/http`): the platform's, organisation's, projects' and users' rules |
 * | `/v1/onboarding`, `/v1/onboarding/…` | the onboarding API (`@harbour/onboarding/http`): the organisation's first-run progress, read by its members and changed by its admin |
 * | `POST /v1/browser/decisions` | a person's answer to an agent's waiting `browser_request` (`src/browser.ts`), when the stack has a browser |
 * | `POST /v1/browser/live` | a watch-only live-view link to one of a session's open browsers, for the person asking (`src/browser.ts`) |
 * | `POST /v1/browser/replay` | a replay link to one of a session's browsers, open or closed (harbour provider) |
 * | `POST /v1/sessions/:id/browsers/:browserSessionId/embed` | the embed API: a live or replay link for an outside app to frame |
 * | `GET /v1/sessions/:id/history` | a session's transcript in pages, newest first: the session API over the runtime's `history` |
 * | `/v1/schedules`, `/v1/schedules/…` | the schedules API (`@harbour/schedules/http`, #23) over the stack's schedules |
 * | `/v1/sharing/…` | the sharing API (`@harbour/sharing/http`): resource shares, access requests, bindings, policy, uses |
 * | `/v1/connections/…` | the connections API (`@harbour/connections/http`, epic #322), its connect and callback pages, and the client ID metadata document (no sign-in) |
 * | `/v1/workspaces/:id/shares`, `/v1/shares/…` | the shares API (`@harbour/workspace/shares-api`) over the stack's shares |
 * | `GET /shared/:token`, `/shared/:token/raw` | a share link's read-only page and bytes, without sign-in: the token opens that one file |
 * | `POST /v1/attachments` | a file for a prompt, stored under its project (`src/attachments.ts`), operators only |
 * | `GET /v1/attachments/:id` | a stored attachment's bytes, for the console's thumbnail and file panel; viewers and up |
 * | every other `/v1/…` | the session API (`@harbour/runtime/http`, PR #61) |
 *
 * Every route authenticates with the stack's authenticator: an `hbr_` API key as a bearer (host apps), or the Access
 * token Cloudflare Access puts in `Cf-Access-Jwt-Assertion` (people). The console's static assets never reach here.
 *
 * The approval API's vault is the VaultDO, which has no project roles or sessions of its own, so the API makes the
 * vault contract's project checks here with the runtime's `ProjectAccess` before each call reaches it.
 */
import { createAuditQueryHandler } from "@harbour/audit/http";
import { BROWSER_DECISIONS, BROWSER_LIVE, BROWSER_REPLAY, createBrowserApi } from "@harbour/browser/http";
import { createConnectionsApi, isConnectionsPath } from "@harbour/connections/http";
import {
	AUDIT_EVENT_PATH,
	AUDIT_EVENTS_PATH,
	type AuthenticatedCaller,
	type CallContext,
	callContextFor,
	isHarbourError,
	type Proposal,
} from "@harbour/contracts";
import { authenticationFailureResponse } from "@harbour/identity/authenticator";
import { createIdentityHandler, isIdentityPath } from "@harbour/identity/http";
import { createPasskeyHandler, isPasskeyPath } from "@harbour/identity/passkey/http";
import { createMemoryApi } from "@harbour/memory/http";
import { createModelProvidersApi } from "@harbour/models/providers-http";
import { createOnboardingApi } from "@harbour/onboarding/http";
import { createRulesApi } from "@harbour/rules/http";
import { type AcceptWebSocket, createSessionApi, errorResponse, type SessionApi } from "@harbour/runtime/http";
import { createSchedulesApi } from "@harbour/schedules/http";
import { createSharingApi, isSharingPath } from "@harbour/sharing/http";
import { createSkillsApi } from "@harbour/skills/http";
import { APPROVAL_API_BASE, createVaultApprovalApi, type RequesterNames } from "@harbour/vault/approval-api";
import { createGitBranchesApi, GIT_BRANCHES_PATH } from "@harbour/workspace/git-refs";
import { createWorkspaceReadApi, WORKSPACE_READ_API_BASE } from "@harbour/workspace/read-api";
import {
	createSharedLinkHandler,
	createSharesApi,
	isSharesPath,
	SHARED_LINK_BASE,
} from "@harbour/workspace/shares-api";
import { createWorkspaceWriteApi } from "@harbour/workspace/write-api";
import { ATTACHMENTS_PATH, createAttachmentsApi } from "./attachments.ts";
import { sessionWorkspaceId } from "./coding-tools.ts";
import { createConnectorsApi, isConnectorsPath } from "./connectors.ts";
import { mayImport } from "./import-access.ts";
import {
	MEASURE_PATH,
	type MeasureInput,
	measureIsolateReady,
	measurementWorkspace,
	type PlacementProbe,
} from "./measure.ts";
import { readLimited } from "./route.ts";
import { renderMissingShare, renderSharedPage } from "./shared-page.ts";
import type { Stack } from "./stack.ts";

/** The measurement's body is `{ "backend"?, "placement"?, "keep"?, "sessionId"?, "tools"? }`: a few bytes. */
const MEASURE_BODY_LIMIT = 1024;

/** A person allows or declines an agent's waiting browser request: `{ "sessionId", "callId", "allow" }`. */
export const BROWSER_DECISIONS_PATH = `/v1${BROWSER_DECISIONS}`;
/**
 * A person asks to watch one of a session's browsers: `{ "sessionId", "browserSessionId" }` ->
 * `{ kind: "embed", url, endMessage?, expiresAt? }`, a provider-neutral live source: a page to embed, and what it posts
 * to its parent once its stream is over. Other kinds (frames over Harbour's own socket, replays) can join it later.
 */
export const BROWSER_LIVE_PATH = `/v1${BROWSER_LIVE}`;

/** A person asks to replay one of a session's browsers: `{ "sessionId", "browserSessionId" }` -> `{ url, expiresAt }`. */
export const BROWSER_REPLAY_PATH = `/v1${BROWSER_REPLAY}`;
const BROWSER_CONSOLE_PATHS: ReadonlySet<string> = new Set([
	BROWSER_DECISIONS_PATH,
	BROWSER_LIVE_PATH,
	BROWSER_REPLAY_PATH,
]);

/**
 * The embed API (`@harbour/browser/http`): an outside app (its API key) or a person asks for a link to frame,
 * `{ "mode": "live" | "replay", "minutes"?: 5..60 }` -> `{ url, mode, expiresAt?, endMessage? }`. The URL is absolute;
 * the token after its `#` is the only auth it needs.
 */
export const BROWSER_EMBED_PATH = /^\/v1\/sessions\/[^/]+\/browsers\/[^/]+\/embed$/;

export const API_BASE = "/v1";

export interface Gateway {
	fetch(request: Request): Promise<Response>;
	close(): Promise<void>;
}

const notFound = () =>
	Response.json(
		{ error: { code: "not_found", message: "No such route" } },
		{ status: 404, headers: { "cache-control": "no-store" } },
	);

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** What `fetch` resolves, or `undefined` when it fails: a name left out rather than the call refused. */
const maybe = <T>(read: () => Promise<T>): Promise<T | undefined> => read().catch(() => undefined);

/**
 * A proposal's requester in names, read as the caller: the organisation, project and person from identity, the session's
 * title from the runtime's directory and the agent's name from its profile. Whatever the caller may not read is left
 * out.
 */
async function requesterNames(stack: Stack, ctx: CallContext, proposal: Proposal): Promise<RequesterNames> {
	const { requester } = proposal;
	const [organisation, project, session, agent, person] = await Promise.all([
		maybe(() => stack.identity.getOrganisation(ctx, proposal.organisationId)),
		proposal.projectId === undefined ? undefined : maybe(() => stack.identity.getProject(ctx, proposal.projectId!)),
		requester.sessionId === undefined ? undefined : maybe(() => stack.runtime.directory.get(ctx, requester.sessionId!)),
		requester.agentId === undefined ? undefined : maybe(() => stack.runtime.profiles.get(ctx, requester.agentId!)),
		requester.onBehalfOf === undefined ? undefined : maybe(() => stack.identity.getUser(ctx, requester.onBehalfOf!)),
	]);
	const agentName = agent?.name ?? requester.agentId;
	return {
		...(organisation === undefined ? {} : { organisation: organisation.name }),
		...(project === undefined ? {} : { project: project.name }),
		...(agentName === undefined ? {} : { agent: agentName }),
		...(session?.title === undefined ? {} : { session: session.title }),
		...(person === undefined ? {} : { person: person.name }),
	};
}

export interface GatewayOptions {
	/** Where the stack runs, for the measurement's `placement` (the Durable Object answers it on Cloudflare). */
	readonly placement?: PlacementProbe;
	/** Serves a session's events over a compressed WebSocket (the Durable Object's `WebSocketPair`). */
	readonly acceptWebSocket?: AcceptWebSocket;
}

export function createGateway(stack: Stack, options: GatewayOptions = {}): Gateway {
	const sessions: SessionApi = createSessionApi({
		runtime: stack.runtime.runtime,
		// The console's scroll-back: older turns, a page at a time, before the snapshot's.
		history: stack.runtime.history,
		// The composer's model and thinking pickers: a session's models, and a new session's before it exists.
		models: stack.runtime.models,
		// The session view's message actions: fork from an answer, edit a message and rerun from it.
		branching: stack.runtime.branching,
		// The composer's warm-up hint (and a host's): the session's sandbox gets ready for its next command.
		warm: {
			async warm(ctx, session) {
				const workspaceId = session.workspaceId ?? sessionWorkspaceId(session.id);
				try {
					const warmed = await stack.sandboxes.warm(ctx, { sessionId: session.id, workspaceId });
					return { container: warmed.container };
				} catch (error) {
					// A session whose own workspace its tools haven't made yet has nothing to warm.
					if (isHarbourError(error, "not_found")) return { container: "unavailable" };
					throw error;
				}
			},
		},
		// The console's session menu: rename, pin, archive, mark unread and delete a session.
		organising: stack.runtime.organising,
		directory: stack.runtime.directory,
		profiles: stack.runtime.profiles,
		hostTools: stack.runtime.hostTools,
		// Durable host registrations, served after the object restarts by the runtime's callback host handlers.
		...(stack.hosts === undefined ? {} : { hosts: stack.hosts }),
		authenticator: stack.authenticator,
		basePath: API_BASE,
		...(options.acceptWebSocket === undefined ? {} : { acceptWebSocket: options.acceptWebSocket }),
	});

	const audit = createAuditQueryHandler({ store: stack.audit, authenticator: stack.authenticator });
	// A 401 here names Access, so the console reloads for Access to sign the person in rather than showing its own form.
	const identity = createIdentityHandler({
		identity: stack.identity,
		authenticator: stack.authenticator,
		signIn: stack.signIn,
	});
	// The relying party is the hostname the request came to: the Worker forwards the request with its URL unchanged.
	const passkeys = createPasskeyHandler({
		passkeys: stack.passkeys,
		authenticator: stack.authenticator,
		signIn: stack.signIn,
	});

	// The read API and the approval API take a call context, not an authenticator, and answer a refused one as 403. The
	// gateway authenticates first, so a missing or bad credential is a 401 with a challenge, as on every other route.
	const callers = new WeakMap<Request, AuthenticatedCaller>();
	const callContext = async (request: Request): Promise<CallContext> => {
		const caller = callers.get(request);
		if (caller === undefined) throw new Error("the gateway did not authenticate this request");
		const requestId = request.headers.get("harbour-request-id") ?? undefined;
		return callContextFor(caller, { ...(requestId === undefined ? {} : { requestId }), signal: request.signal });
	};
	const workspaces = createWorkspaceReadApi({ workspaces: stack.workspaces, authenticate: callContext });
	// The write route is tried first: it answers only `POST /v1/workspaces`, which the read API would refuse as 405. The
	// stack's workspaces seed git refs with its fetcher; nothing here acquires a sandbox.
	const createWorkspace = createWorkspaceWriteApi({
		workspaces: stack.workspaces,
		access: stack.access,
		authenticate: callContext,
	});

	// A new session's branch picker: the same operator check as creating the workspace, before anything is fetched.
	const gitBranches = createGitBranchesApi({ refs: stack.gitRefs, access: stack.access, authenticate: callContext });

	// Loading skills and memory (a host adapter's import, a new space) is the organisation admin's, on top of the stores'
	// own rules, which refuse agents and check a project owner's role. An API key with the `import` permission may import
	// skills and snapshots too, and nothing else here (`./import-access.ts`). Reads follow the stores' rules alone.
	const organisationAdmin = (ctx: CallContext) => stack.identity.authorize(ctx, "admin");
	const importer = mayImport(stack.identity, organisationAdmin);
	const skills = createSkillsApi({
		skills: stack.skills,
		authenticate: callContext,
		authorizeImport: importer,
		basePath: API_BASE,
	});
	const memory = createMemoryApi({
		memory: stack.memory,
		authenticate: callContext,
		authorizeWrite: organisationAdmin,
		authorizeImport: importer,
		basePath: API_BASE,
	});
	// Prompt rules: the store's own rules decide who writes what (an admin of the owner, a user's own), never an agent.
	const rules = createRulesApi({ rules: stack.rules, authenticate: callContext, basePath: API_BASE });
	// Onboarding: the service's own check decides who changes it (an organisation-wide admin), never an agent.
	const onboarding = createOnboardingApi({
		onboarding: stack.onboarding,
		authenticate: callContext,
		basePath: API_BASE,
	});
	const SKILLS_BASE = `${API_BASE}/skills`;
	const MEMORY_BASE = `${API_BASE}/memory`;
	const RULES_BASE = `${API_BASE}/rules`;
	const ONBOARDING_BASE = `${API_BASE}/onboarding`;
	// Model providers: listed to the organisation; on Cloudflare the gateway reaches only CPA, so none connects here.
	const modelProviders = createModelProvidersApi({
		providers: stack.modelProviders,
		authenticate: callContext,
		basePath: API_BASE,
	});
	const MODEL_PROVIDERS_BASE = `${API_BASE}/model-providers`;
	// Creating, changing or resuming a schedule through it arms the stack's alarm (`stack.schedules`).
	const schedules = createSchedulesApi({ schedules: stack.schedules, authenticate: callContext, basePath: API_BASE });
	const SCHEDULES_BASE = `${API_BASE}/schedules`;
	// Every check is the sharing store's, through the stack's project access.
	const sharing = createSharingApi({ sharing: stack.sharing, authenticate: callContext, basePath: API_BASE });
	// Connections: the service's own rules decide who connects what; agents never do.
	const connections =
		stack.connections === undefined
			? undefined
			: createConnectionsApi({ connections: stack.connections, authenticate: callContext, basePath: API_BASE });
	const CLIENT_METADATA_PATH = `${API_BASE}/connections/oauth/client-metadata.json`;
	const shares =
		stack.shares === undefined
			? undefined
			: createSharesApi({ shares: stack.shares, authenticate: callContext, basePath: API_BASE });
	const sharedLinks =
		stack.shares === undefined
			? undefined
			: createSharedLinkHandler({
					shares: stack.shares,
					workspaces: stack.workspaces,
					renderPage: renderSharedPage,
					renderMissing: renderMissingShare,
				});
	const browsers =
		stack.browser === undefined
			? undefined
			: createBrowserApi({
					browser: stack.browser.broker,
					session: stack.browser,
					authenticate: callContext,
					basePath: API_BASE,
				});

	const { vault } = stack;
	// The VaultDO checks only the organisation; the project checks here use the runtime's roles (`stack.access`).
	const approvals =
		vault === undefined
			? undefined
			: createVaultApprovalApi({
					vault,
					access: stack.access,
					authenticate: callContext,
					describeRequester: (ctx, proposal) => requesterNames(stack, ctx, proposal),
					viewerName: async (ctx) =>
						ctx.actor.kind === "human" ? (await stack.identity.getUser(ctx, ctx.actor.userId)).name : undefined,
					basePath: APPROVAL_API_BASE,
					// An approval needs the person's passkey once they have one; a refusal is audited with the vault's events.
					passkeys: stack.passkeys,
					audit: stack.audit,
				});

	/** The caller, or the response refusing them: 401 with a challenge for a missing or bad credential. */
	const authenticate = async (request: Request): Promise<AuthenticatedCaller | Response> => {
		try {
			return await stack.authenticator.authenticate(request);
		} catch (error) {
			const refused = authenticationFailureResponse(error);
			if (refused !== undefined) return refused;
			return Response.json({ error: { code: "unavailable", message: "Sign-in is unavailable" } }, { status: 503 });
		}
	};

	/** Signs the request in for an API that takes a context: a bad credential is a 401 with a challenge, as elsewhere. */
	const signIn = async (request: Request): Promise<Response | undefined> => {
		const caller = await authenticate(request);
		if (caller instanceof Response) return caller;
		callers.set(request, caller);
		return undefined;
	};

	// The composer's uploads: a file for a prompt, stored under the project before the message is sent.
	const attachments = createAttachmentsApi({
		store: stack.attachments,
		access: stack.access,
		authenticate: callContext,
	});

	// The console's connectors page: what each connector offers, and a test image (`src/connectors.ts`).
	const connectors = createConnectorsApi({ gateway: stack.modelGateway, authenticate: callContext });

	const workspace = measurementWorkspace(stack);
	const measure = async (request: Request): Promise<Response> => {
		if (request.method !== "POST") {
			return Response.json(
				{ error: { code: "invalid", message: "POST only" } },
				{ status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
			);
		}
		const signingIn = performance.now();
		const enteredAt = Date.now();
		const caller = await authenticate(request);
		if (caller instanceof Response) return caller;
		const signedIn = Math.round((performance.now() - signingIn) * 10) / 10;
		const signedInAt = Date.now();
		let input: MeasureInput = {};
		let placement = false;
		const bytes = await readLimited(request, MEASURE_BODY_LIMIT).catch(() => undefined);
		if (bytes === undefined) {
			return Response.json(
				{ error: { code: "invalid", message: `The body is unreadable or larger than ${MEASURE_BODY_LIMIT} bytes` } },
				{ status: 413, headers: { "cache-control": "no-store" } },
			);
		}
		const text = new TextDecoder().decode(bytes);
		if (text.trim() !== "") {
			const parsed: unknown = (() => {
				try {
					return JSON.parse(text);
				} catch {
					return undefined;
				}
			})();
			const body = parsed as
				| { backend?: unknown; placement?: unknown; keep?: unknown; sessionId?: unknown; tools?: unknown }
				| undefined;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				(body?.backend !== undefined && typeof body.backend !== "string") ||
				(body?.placement !== undefined && typeof body.placement !== "boolean") ||
				(body?.keep !== undefined && typeof body.keep !== "boolean") ||
				(body?.tools !== undefined && typeof body.tools !== "boolean") ||
				(body?.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId === "")) ||
				// A warm run's session is open already: `keep` is for the cold run that opens it.
				(body?.keep === true && body.sessionId !== undefined)
			) {
				return Response.json(
					{
						error: {
							code: "invalid",
							message:
								'The body is { "backend"?: string, "placement"?: boolean, "keep"?: boolean, "tools"?: boolean } or { "sessionId": string, "backend"?: string, "placement"?: boolean, "tools"?: boolean }',
						},
					},
					{ status: 400, headers: { "cache-control": "no-store" } },
				);
			}
			input = {
				...(typeof body?.backend === "string" ? { backend: body.backend } : {}),
				...(body?.keep === true ? { keep: true } : {}),
				...(body?.tools === true ? { tools: true } : {}),
				...(typeof body?.sessionId === "string" ? { sessionId: body.sessionId } : {}),
			};
			placement = body?.placement === true;
		}
		try {
			const ctx = callContextFor(caller, { signal: request.signal });
			const result = await measureIsolateReady(stack, ctx, workspace, input);
			// Probed after the run, so it adds nothing to the run's times.
			const where = placement && options.placement !== undefined ? await options.placement(request) : undefined;
			return Response.json(
				{
					...result,
					// Sign-in comes before the run and is not in `total`.
					timings: { signIn: signedIn, ...result.timings },
					clock: { entered: enteredAt, signedIn: signedInAt, ...result.clock },
					...(where === undefined ? {} : { placement: where }),
				},
				{ headers: { "cache-control": "no-store" } },
			);
		} catch (error) {
			return errorResponse(error);
		}
	};

	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (sharedLinks !== undefined && under(path, SHARED_LINK_BASE)) {
				// No sign-in: the link's token is its only credential, and it opens one file read-only.
				return (await sharedLinks(request)) ?? renderMissingShare();
			}
			if (isSharesPath(path, API_BASE)) {
				if (shares === undefined) return notFound();
				const refused = await signIn(request);
				if (refused !== undefined) {
					await request.body?.cancel().catch(() => undefined);
					return refused;
				}
				return (await shares(request)) ?? notFound();
			}
			if (BROWSER_CONSOLE_PATHS.has(path) || BROWSER_EMBED_PATH.test(path)) {
				if (browsers === undefined) {
					return Response.json(
						{ error: { code: "unavailable", message: "This deployment has no browser" } },
						{ status: 503, headers: { "cache-control": "no-store" } },
					);
				}
				// A console route answers anything but a POST with 405 before it signs anyone in.
				const refused =
					request.method === "POST" || !BROWSER_CONSOLE_PATHS.has(path) ? await signIn(request) : undefined;
				if (refused !== undefined) {
					await request.body?.cancel().catch(() => undefined);
					return refused;
				}
				return (await browsers.fetch(request)) ?? notFound();
			}
			if (under(path, WORKSPACE_READ_API_BASE)) {
				const caller = await authenticate(request);
				if (caller instanceof Response) {
					// A refused write's body is never read; cancel it so the stream isn't left open.
					await request.body?.cancel().catch(() => undefined);
					return caller;
				}
				callers.set(request, caller);
				return (await createWorkspace(request)) ?? (await workspaces(request)) ?? notFound();
			}
			if (path === GIT_BRANCHES_PATH) {
				const refused = await signIn(request);
				if (refused !== undefined) return refused;
				return (await gitBranches(request)) ?? notFound();
			}
			if (path === MEASURE_PATH) return measure(request);
			if (under(path, ATTACHMENTS_PATH)) {
				const refused = await signIn(request);
				if (refused !== undefined) {
					await request.body?.cancel().catch(() => undefined);
					return refused;
				}
				return attachments(request);
			}
			if (isConnectorsPath(path)) {
				const refused = await signIn(request);
				if (refused !== undefined) {
					await request.body?.cancel().catch(() => undefined);
					return refused;
				}
				return connectors(request);
			}
			if (approvals !== undefined && under(path, APPROVAL_API_BASE)) {
				const refused = await signIn(request);
				if (refused !== undefined) return refused;
				return approvals(request);
			}
			if (path === AUDIT_EVENTS_PATH || path === AUDIT_EVENT_PATH) return audit(request);
			if (isPasskeyPath(path)) return passkeys(request);
			if (isIdentityPath(path)) return identity(request);
			if (
				under(path, SKILLS_BASE) ||
				under(path, MEMORY_BASE) ||
				under(path, RULES_BASE) ||
				under(path, ONBOARDING_BASE) ||
				under(path, MODEL_PROVIDERS_BASE)
			) {
				const caller = await authenticate(request);
				if (caller instanceof Response) {
					await request.body?.cancel().catch(() => undefined);
					return caller;
				}
				callers.set(request, caller);
				const api = under(path, SKILLS_BASE)
					? skills
					: under(path, MEMORY_BASE)
						? memory
						: under(path, RULES_BASE)
							? rules
							: under(path, ONBOARDING_BASE)
								? onboarding
								: modelProviders;
				return (await api.fetch(request)) ?? notFound();
			}
			if (under(path, SCHEDULES_BASE)) {
				const refused = await signIn(request);
				if (refused !== undefined) {
					await request.body?.cancel().catch(() => undefined);
					return refused;
				}
				return (await schedules.fetch(request)) ?? notFound();
			}
			if (connections !== undefined && isConnectionsPath(path, API_BASE)) {
				// The metadata document is public: authorisation servers fetch it to learn this deployment's client.
				if (path !== CLIENT_METADATA_PATH) {
					const refused = await signIn(request);
					if (refused !== undefined) {
						await request.body?.cancel().catch(() => undefined);
						return refused;
					}
				}
				return (await connections.fetch(request)) ?? notFound();
			}
			if (isSharingPath(path, API_BASE)) {
				const refused = await signIn(request);
				if (refused !== undefined) {
					await request.body?.cancel().catch(() => undefined);
					return refused;
				}
				return (await sharing.fetch(request)) ?? notFound();
			}
			if (under(path, API_BASE)) return sessions.fetch(request);
			return notFound();
		},
		close: () => sessions.close(),
	};
}
