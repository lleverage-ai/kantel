/**
 * The gateway's API routes, one fetch handler over a `Stack`:
 *
 * | Prefix | Served by |
 * | --- | --- |
 * | `/v1/workspaces/…` | the workspace read API (`@harbour/workspace/read-api`, PR #58) |
 * | `/v1/audit/…` | the audit query API (`@harbour/audit/http`, PR #60) |
 * | every other `/v1/…` | the session API (`@harbour/runtime/http`, PR #61) |
 *
 * Every route authenticates with the stack's authenticator: an `hbr_` API key as a bearer (host apps), or the Access
 * token Cloudflare Access puts in `Cf-Access-Jwt-Assertion` (people). The console's static assets never reach here.
 */
import { createAuditQueryHandler } from "@harbour/audit/http";
import { AUDIT_EVENT_PATH, AUDIT_EVENTS_PATH, type AuthenticatedCaller, callContextFor } from "@harbour/contracts";
import { authenticationFailureResponse } from "@harbour/identity/authenticator";
import { createSessionApi, type SessionApi } from "@harbour/runtime/http";
import { createWorkspaceReadApi, WORKSPACE_READ_API_BASE } from "@harbour/workspace/read-api";
import type { Stack } from "./stack.ts";

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

	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (under(path, WORKSPACE_READ_API_BASE)) {
				try {
					callers.set(request, await stack.authenticator.authenticate(request));
				} catch (error) {
					const refused = authenticationFailureResponse(error);
					if (refused !== undefined) return refused;
					return Response.json({ error: { code: "unavailable", message: "Sign-in is unavailable" } }, { status: 503 });
				}
				return (await workspaces(request)) ?? notFound();
			}
			if (path === AUDIT_EVENTS_PATH || path === AUDIT_EVENT_PATH) return audit(request);
			if (under(path, API_BASE)) return sessions.fetch(request);
			return notFound();
		},
		close: () => sessions.close(),
	};
}
