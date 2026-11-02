/**
 * The session API's wire format, shared by the server (`createSessionApi`) and the client (`createSessionApiClient`).
 * It depends only on `@kantel/contracts`, `@kantel/protocol` and `@kantel/api`, so a host app can import it
 * without Pi.
 */
import { STATUS_BY_CODE } from "@kantel/api";
import {
	type AgentProfile,
	type CreateSessionInput,
	type ErrorCode,
	type HostToolDefinition,
	isKantelError,
	type JsonValue,
	KantelError,
	type ProjectId,
	type PromptInput,
} from "@kantel/contracts";

/** The prefix every route has unless the server is given another. */
export const DEFAULT_BASE_PATH = "/v1";

/** Headers the API reads or sends. */
export const HEADERS = {
	/** Correlates a call; it becomes `CallContext.requestId`. */
	requestId: "kantel-request-id",
	/** On a host-tool callback: `t=<epoch ms>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
	signature: "kantel-signature",
	hostId: "kantel-host-id",
	callId: "kantel-call-id",
} as const;

/** The SSE event the server sends after the first frames of a watch: hello, then a snapshot or the missed deltas. */
export const READY_EVENT = "ready";

export interface ApiErrorBody {
	readonly error: {
		readonly code: ErrorCode | "unauthenticated";
		readonly message: string;
		readonly details?: { readonly [key: string]: JsonValue };
	};
}

export function statusForCode(code: ErrorCode): number {
	return STATUS_BY_CODE[code];
}

const ERROR_CODES = new Set<string>(Object.keys(STATUS_BY_CODE));

/** The response for an error: a KantelError keeps its code and message; anything else is a bare `unavailable`. */
export function errorResponse(error: unknown): Response {
	if (isKantelError(error)) {
		const body: ApiErrorBody = {
			error: {
				code: error.code,
				message: error.message,
				...(error.details === undefined ? {} : { details: error.details }),
			},
		};
		return json(body, statusForCode(error.code));
	}
	// Never echo an unexpected error's message: it may hold anything.
	return json({ error: { code: "unavailable", message: "The session API failed" } } satisfies ApiErrorBody, 500);
}

export function unauthenticated(): Response {
	return json(
		{ error: { code: "unauthenticated", message: "The request needs a valid credential" } } satisfies ApiErrorBody,
		401,
		{ "www-authenticate": 'Bearer realm="kantel"' },
	);
}

/** A KantelError from an error response; `unauthenticated` becomes `forbidden`. */
export async function errorFromResponse(response: Response): Promise<KantelError> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const error = (body as Partial<ApiErrorBody> | undefined)?.error;
	const code: ErrorCode =
		typeof error?.code === "string" && ERROR_CODES.has(error.code)
			? (error.code as ErrorCode)
			: response.status === 401
				? "forbidden"
				: response.status === 404
					? "not_found"
					: "unavailable";
	const message = typeof error?.message === "string" ? error.message : `The session API answered ${response.status}`;
	return new KantelError(code, message, error?.details);
}

export function json(body: unknown, status = 200, headers: { readonly [name: string]: string } = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});
}

/** Request bodies. */
export type CreateSessionBody = CreateSessionInput;
export type PromptBody = PromptInput;
export interface AbortBody {
	readonly reason?: string;
}
export type PutProfileBody = AgentProfile;

/** Registers a host's tools, served by an HTTPS callback the runtime signs with `callback.secret`. */
export interface RegisterHostBody {
	/** The project the host serves; absent to serve every project of the organisation. */
	readonly projectId?: ProjectId;
	readonly tools: readonly HostToolDefinition[];
	readonly callback: {
		readonly url: string;
		/** At least 32 characters. Generated, and returned once, when absent. */
		readonly secret?: string;
	};
}

export interface RegisterHostResponse {
	readonly hostId: string;
	/** Names this registration: `DELETE …?registration=` removes it only while it is the current one. */
	readonly registration: string;
	readonly tools: readonly HostToolDefinition[];
	/** Present only when the server generated the secret. */
	readonly secret?: string;
}

/** `GET …/result` while the run is still going. */
export interface PendingResult {
	readonly status: "pending";
	readonly sessionId: string;
	readonly submissionId: string;
}

export const MIN_CALLBACK_SECRET_LENGTH = 32;
/** The longest a request body may be. */
export const MAX_BODY_BYTES = 1024 * 1024;
