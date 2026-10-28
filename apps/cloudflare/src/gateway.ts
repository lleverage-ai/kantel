/**
 * The gateway's API routes, one fetch handler over a `Stack`:
 *
 * | Prefix | Served by |
 * | --- | --- |
 * | `POST /v1/workspaces` | the workspace write API (`@harbour/workspace/write-api`): a seeded workspace, operators only |
 * | `/v1/workspaces/…` | the workspace read API (`@harbour/workspace/read-api`, PR #58) |
 * | `/v1/audit/…` | the audit query API (`@harbour/audit/http`, PR #60) |
 * | `POST /v1/measurements/isolate-ready` | the isolate-ready measurement (`src/measure.ts`) |
 * | `/v1/me`, `/v1/projects` | who is signed in and their projects (`@harbour/identity/http`) |
 * | `/v1/keys`, `POST /v1/keys/:id/revoke` | host apps' API keys (`@harbour/identity/http`): operator or above to reach, admin of each key's projects to see or change it |
 * | `/v1/vault/…` | the vault approval API (`@harbour/vault/approval-api`), when the stack has a vault |
 * | `/v1/skills`, `/v1/skills/…` | the skills API (`@harbour/skills/http`, #12): reads, and imports for the organisation's admin |
 * | `/v1/memory/…` | the memory API (`@harbour/memory/http`, #12): reads, search and recall; creating a space and loading a snapshot for the organisation's admin |
 * | `GET /v1/sessions/:id/history` | a session's transcript in pages, newest first: the session API over the runtime's `history` |
 * | every other `/v1/…` | the session API (`@harbour/runtime/http`, PR #61) |
 *
 * Every route authenticates with the stack's authenticator: an `hbr_` API key as a bearer (host apps), or the Access
 * token Cloudflare Access puts in `Cf-Access-Jwt-Assertion` (people). The console's static assets never reach here.
 *
 * The approval API's vault is the VaultDO, which has no project roles or sessions of its own, so the API makes the
 * vault contract's project checks here with the runtime's `ProjectAccess` before each call reaches it.
 */
import { createAuditQueryHandler } from "@harbour/audit/http";
import {
	AUDIT_EVENT_PATH,
	AUDIT_EVENTS_PATH,
	type AuthenticatedCaller,
	type CallContext,
	callContextFor,
	type Proposal,
} from "@harbour/contracts";
import { authenticationFailureResponse } from "@harbour/identity/authenticator";
import { createIdentityHandler, isIdentityPath } from "@harbour/identity/http";
import { createMemoryApi } from "@harbour/memory/http";
import { type AcceptWebSocket, createSessionApi, errorResponse, type SessionApi } from "@harbour/runtime/http";
import { createSkillsApi } from "@harbour/skills/http";
import { APPROVAL_API_BASE, createVaultApprovalApi, type RequesterNames } from "@harbour/vault/approval-api";
import { createWorkspaceReadApi, WORKSPACE_READ_API_BASE } from "@harbour/workspace/read-api";
import { createWorkspaceWriteApi } from "@harbour/workspace/write-api";
import {
	MEASURE_PATH,
	type MeasureInput,
	measureIsolateReady,
	measurementWorkspace,
	type PlacementProbe,
} from "./measure.ts";
import { readLimited } from "./route.ts";
import type { Stack } from "./stack.ts";

/** The measurement's body is `{ "backend"?, "placement"?, "keep"?, "sessionId"? }`: a few bytes. */
const MEASURE_BODY_LIMIT = 1024;

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

	// Loading skills and memory (a host adapter's import, a new space) is the organisation admin's, on top of the stores'
	// own rules, which refuse agents and check a project owner's role. Reads follow the stores' rules alone.
	const organisationAdmin = (ctx: CallContext) => stack.identity.authorize(ctx, "admin");
	const skills = createSkillsApi({
		skills: stack.skills,
		authenticate: callContext,
		authorizeImport: organisationAdmin,
		basePath: API_BASE,
	});
	const memory = createMemoryApi({
		memory: stack.memory,
		authenticate: callContext,
		authorizeWrite: organisationAdmin,
		basePath: API_BASE,
	});
	const SKILLS_BASE = `${API_BASE}/skills`;
	const MEMORY_BASE = `${API_BASE}/memory`;

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

	const workspace = measurementWorkspace(stack);
	const measure = async (request: Request): Promise<Response> => {
		if (request.method !== "POST") {
			return Response.json(
				{ error: { code: "invalid", message: "POST only" } },
				{ status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
			);
		}
		const signingIn = performance.now();
		const caller = await authenticate(request);
		if (caller instanceof Response) return caller;
		const signedIn = Math.round((performance.now() - signingIn) * 10) / 10;
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
				| { backend?: unknown; placement?: unknown; keep?: unknown; sessionId?: unknown }
				| undefined;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				(body?.backend !== undefined && typeof body.backend !== "string") ||
				(body?.placement !== undefined && typeof body.placement !== "boolean") ||
				(body?.keep !== undefined && typeof body.keep !== "boolean") ||
				(body?.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId === "")) ||
				// A warm run's session is open already: `keep` is for the cold run that opens it.
				(body?.keep === true && body.sessionId !== undefined)
			) {
				return Response.json(
					{
						error: {
							code: "invalid",
							message:
								'The body is { "backend"?: string, "placement"?: boolean, "keep"?: boolean } or { "sessionId": string, "backend"?: string, "placement"?: boolean }',
						},
					},
					{ status: 400, headers: { "cache-control": "no-store" } },
				);
			}
			input = {
				...(typeof body?.backend === "string" ? { backend: body.backend } : {}),
				...(body?.keep === true ? { keep: true } : {}),
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
			if (path === MEASURE_PATH) return measure(request);
			if (approvals !== undefined && under(path, APPROVAL_API_BASE)) {
				const refused = await signIn(request);
				if (refused !== undefined) return refused;
				return approvals(request);
			}
			if (path === AUDIT_EVENTS_PATH || path === AUDIT_EVENT_PATH) return audit(request);
			if (isIdentityPath(path)) return identity(request);
			if (under(path, SKILLS_BASE) || under(path, MEMORY_BASE)) {
				const caller = await authenticate(request);
				if (caller instanceof Response) {
					await request.body?.cancel().catch(() => undefined);
					return caller;
				}
				callers.set(request, caller);
				const api = under(path, SKILLS_BASE) ? skills : memory;
				return (await api.fetch(request)) ?? notFound();
			}
			if (under(path, API_BASE)) return sessions.fetch(request);
			return notFound();
		},
		close: () => sessions.close(),
	};
}
