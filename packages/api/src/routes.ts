/**
 * Harbour's public API, version 1: every route a host app (or the console) may call, under `/v1`. Add a route here and
 * the server must implement it (`createRouter` takes a handler for each), and the OpenAPI document and the SDK pick it
 * up when they are generated (`pnpm --filter @harbour/api generate`; CI fails while they are stale).
 */
import { defineRoute } from "./route.ts";
import {
	AbortSessionBody,
	CreateSessionBody,
	ListSessionsQuery,
	SessionPage,
	SessionPath,
	SessionRecord,
} from "./schema.ts";

/** The version's base path, before every route's own path. */
export const API_VERSION_BASE = "/v1";

export const createSession = defineRoute({
	operationId: "createSession",
	method: "POST",
	path: "/sessions",
	tag: "sessions",
	summary: "Create a session",
	description: "Starts a session of an agent profile in a project. Needs the operator role on the project.",
	body: CreateSessionBody,
	answer: { status: 201, description: "The new session.", schema: SessionRecord },
	errors: ["invalid", "forbidden", "not_found", "refused"],
});

export const listSessions = defineRoute({
	operationId: "listSessions",
	method: "GET",
	path: "/sessions",
	tag: "sessions",
	summary: "List sessions",
	description: "The sessions the caller may see, newest first, a page at a time.",
	query: ListSessionsQuery,
	answer: { status: 200, description: "A page of sessions.", schema: SessionPage },
	errors: ["invalid", "forbidden"],
});

export const getSession = defineRoute({
	operationId: "getSession",
	method: "GET",
	path: "/sessions/{sessionId}",
	tag: "sessions",
	summary: "Get a session",
	params: SessionPath,
	answer: { status: 200, description: "The session.", schema: SessionRecord },
	errors: ["forbidden", "not_found"],
});

export const closeSession = defineRoute({
	operationId: "closeSession",
	method: "POST",
	path: "/sessions/{sessionId}/close",
	tag: "sessions",
	summary: "Close a session",
	description:
		"Ends the session for good: its sandbox leases, browser sessions and grants end. Closing a closed session does nothing.",
	params: SessionPath,
	answer: { status: 204, description: "Closed." },
	errors: ["forbidden", "not_found"],
});

export const abortSession = defineRoute({
	operationId: "abortSession",
	method: "POST",
	path: "/sessions/{sessionId}/abort",
	tag: "sessions",
	summary: "Abort a session's run",
	description: "Stops what the session is doing now. The session stays open and takes new messages.",
	params: SessionPath,
	body: AbortSessionBody,
	answer: { status: 204, description: "Aborted." },
	errors: ["invalid", "forbidden", "not_found", "conflict"],
});

/** Every v1 route, by operation ID, in the order the document and the SDK list them. */
export const routes = { createSession, listSessions, getSession, closeSession, abortSession } as const;

export type Routes = typeof routes;
export type OperationId = keyof Routes;
