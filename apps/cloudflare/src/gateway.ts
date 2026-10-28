/**
 * The gateway's API routes, one fetch handler over a `Stack`:
 *
 * | Prefix | Served by |
 * | --- | --- |
 * | `/v1/workspaces/…` | the workspace read API (`@harbour/workspace/read-api`, PR #58) |
 * | `/v1/audit/…` | the audit query API (`@harbour/audit/http`, PR #60) |
 * | `POST /v1/measurements/isolate-ready` | the isolate-ready measurement (`src/measure.ts`) |
 * | every other `/v1/…` | the session API (`@harbour/runtime/http`, PR #61) |
 *
 * Every route authenticates with the stack's authenticator: an `hbr_` API key as a bearer (host apps), or the Access
 * token Cloudflare Access puts in `Cf-Access-Jwt-Assertion` (people). The console's static assets never reach here.
 */
import { createAuditQueryHandler } from "@harbour/audit/http";
import { AUDIT_EVENT_PATH, AUDIT_EVENTS_PATH, type AuthenticatedCaller, callContextFor } from "@harbour/contracts";
import { authenticationFailureResponse } from "@harbour/identity/authenticator";
import { createSessionApi, errorResponse, type SessionApi } from "@harbour/runtime/http";
import { createWorkspaceReadApi, WORKSPACE_READ_API_BASE } from "@harbour/workspace/read-api";
import { MEASURE_PATH, measureIsolateReady, measurementWorkspace } from "./measure.ts";
import { readLimited } from "./route.ts";
import type { Stack } from "./stack.ts";

/** The measurement's body is `{ "backend"?: string }`: a few bytes. */
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

export function createGateway(stack: Stack): Gateway {
	const sessions: SessionApi = createSessionApi({
		runtime: stack.runtime.runtime,
		directory: stack.runtime.directory,
		profiles: stack.runtime.profiles,
		hostTools: stack.runtime.hostTools,
		// Durable host registrations, served after the object restarts by the runtime's callback host handlers.
		...(stack.hosts === undefined ? {} : { hosts: stack.hosts }),
		authenticator: stack.authenticator,
		basePath: API_BASE,
	});

	const audit = createAuditQueryHandler({ store: stack.audit, authenticator: stack.authenticator });

	// The read API takes a call context, not an authenticator, and answers a refused one as 403. The gateway
	// authenticates first, so a missing or bad credential is a 401 with a challenge, as on every other route.
	const callers = new WeakMap<Request, AuthenticatedCaller>();
	const workspaces = createWorkspaceReadApi({
		workspaces: stack.workspaces,
		async authenticate(request) {
			const caller = callers.get(request);
			if (caller === undefined) throw new Error("the gateway did not authenticate this request");
			const requestId = request.headers.get("harbour-request-id") ?? undefined;
			return callContextFor(caller, { ...(requestId === undefined ? {} : { requestId }), signal: request.signal });
		},
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

	const workspace = measurementWorkspace(stack);
	const measure = async (request: Request): Promise<Response> => {
		if (request.method !== "POST") {
			return Response.json(
				{ error: { code: "invalid", message: "POST only" } },
				{ status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
			);
		}
		const caller = await authenticate(request);
		if (caller instanceof Response) return caller;
		let input: { backend?: string } = {};
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
			const backend = (parsed as { backend?: unknown } | undefined)?.backend;
			if (typeof parsed !== "object" || parsed === null || (backend !== undefined && typeof backend !== "string")) {
				return Response.json(
					{ error: { code: "invalid", message: 'The body is { "backend"?: string }' } },
					{ status: 400, headers: { "cache-control": "no-store" } },
				);
			}
			input = backend === undefined ? {} : { backend };
		}
		try {
			const ctx = callContextFor(caller, { signal: request.signal });
			return Response.json(await measureIsolateReady(stack, ctx, workspace, input), {
				headers: { "cache-control": "no-store" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};

	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (under(path, WORKSPACE_READ_API_BASE)) {
				const caller = await authenticate(request);
				if (caller instanceof Response) return caller;
				callers.set(request, caller);
				return (await workspaces(request)) ?? notFound();
			}
			if (path === MEASURE_PATH) return measure(request);
			if (path === AUDIT_EVENTS_PATH || path === AUDIT_EVENT_PATH) return audit(request);
			if (under(path, API_BASE)) return sessions.fetch(request);
			return notFound();
		},
		close: () => sessions.close(),
	};
}
