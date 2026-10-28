/**
 * Harbour's public API, version 1: every route a host app (or the console) may call, under `/v1`. Add a route here and
 * the server must implement it (`createRouter` takes a handler for each), and the OpenAPI document and the SDK pick it
 * up when they are generated (`pnpm --filter @harbour/api generate`; CI fails while they are stale).
 */
import { defineRoute } from "./route.ts";
import {
	AbortSessionBody,
	CreatedSession,
	CreateSessionBody,
	ListSessionsQuery,
	MessageBody,
	SessionPage,
	SessionPath,
	SessionRecord,
	Submission,
} from "./schema.ts";

/** The version's base path, before every route's own path. */
export const API_VERSION_BASE = "/v1";

export const createSession = defineRoute({
	operationId: "createSession",
	method: "POST",
	path: "/sessions",
	tag: "sessions",
	summary: "Create a session",
	description:
		"Starts a session of an agent profile in a project, and sends it `message` when there is one. Needs the operator " +
		"role on the project. If the first message is refused, the session is closed and the refusal answered.",
	body: CreateSessionBody,
	answer: { status: 201, description: "The new session.", schema: CreatedSession },
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

export const sendMessage = defineRoute({
	operationId: "sendMessage",
	method: "POST",
	path: "/sessions/{sessionId}/messages",
	tag: "messages",
	summary: "Send a message",
	description:
		"Sends the session's agent a message, `via` a prompt, a steer or a follow-up. The answer arrives on the " +
		"session's stream. Send an `Idempotency-Key` so a retry can't send it twice: a retry with the same key answers " +
		"the first call's submission without sending anything, and one with another `via` is a `conflict`.",
	params: SessionPath,
	body: MessageBody,
	idempotent: true,
	answer: { status: 202, description: "The session accepted the message.", schema: Submission },
	errors: ["invalid", "forbidden", "not_found", "conflict", "refused"],
});

/** Every v1 route, by operation ID, in the order the document and the SDK list them. */
export const routes = {
	createSession,
	listSessions,
	getSession,
	closeSession,
	abortSession,
	sendMessage,
} as const;

export type Routes = typeof routes;
export type OperationId = keyof Routes;
