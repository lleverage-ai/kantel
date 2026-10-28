// Harbour's public API: the TypeScript SDK. Generated from packages/api/src/routes.ts by
// `pnpm --filter @harbour/api generate`; don't edit it by hand. CI fails while it is stale.

// Types

export interface AbortSessionBody {
	/** Recorded in the audit trail. */
	readonly reason?: string;
}

/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
export type Actor =
	| {
			readonly kind: "human";
			readonly userId: string;
	  }
	| {
			readonly kind: "service";
			readonly serviceId: string;
			readonly keyId?: string;
	  }
	| {
			readonly kind: "agent";
			readonly agentId: string;
			readonly sessionId: string;
	  }
	| {
			readonly kind: "system";
			readonly component: string;
	  };

/** A new session, with its first message's submission when it was sent one. */
export interface CreatedSession {
	/** The session's ID. */
	readonly id: string;
	readonly organisationId: string;
	readonly projectId: string;
	/** The agent profile the session runs. */
	readonly agentId: string;
	readonly parentSessionId?: string;
	readonly workspaceId?: string;
	readonly title?: string;
	readonly status: SessionStatus;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels: Labels;
	/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
	/** A message the session accepted. */
	readonly submission?: Submission;
}

/** Put the host's own reference for the session in `labels`, such as `{ lleverageRunId: "run-42" }`, and find it again with `GET /sessions?label.lleverageRunId=run-42`. */
export interface CreateSessionBody {
	/** The project the session runs in. */
	readonly projectId: string;
	/** The agent profile it runs. */
	readonly agentId: string;
	readonly title?: string;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels?: Labels;
	/** An existing workspace to run in. */
	readonly workspaceId?: string;
	/** Creates a child session owned by this parent; aborting the parent aborts it. */
	readonly parentSessionId?: string;
	/** The session's first prompt, sent as soon as it exists. */
	readonly message?: FirstMessage;
}

/** The session's first prompt, sent as soon as it exists. */
export interface FirstMessage {
	/** The message's words. */
	readonly text: string;
	/** A model ID the session may use, for this run and the session's later runs. Absent keeps the session's model. */
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
}

/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
export interface Labels {
	readonly [key: string]: string;
}

export interface ListSessionsQuery {
	readonly projectId?: string;
	readonly agentId?: string;
	readonly status?: SessionStatus;
	readonly parentSessionId?: string;
	/** Sessions with every one of these labels, each sent as `label.<key>=<value>`, such as `label.docketTask=TASK-3347`. */
	readonly label?: {
		readonly [key: string]: string;
	};
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

/** A message to the session's agent. `via` defaults to `prompt`. */
export interface MessageBody {
	/** How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in progress at its next model call, and `followUp` runs after the current run ends. */
	readonly via?: MessageVia;
	/** The message's words. */
	readonly text: string;
	/** A model ID the session may use, for this run and the session's later runs. Absent keeps the session's model. */
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
}

/** How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in progress at its next model call, and `followUp` runs after the current run ends. */
export type MessageVia = "prompt" | "steer" | "followUp";

export interface SessionPage {
	readonly items: readonly SessionRecord[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface SessionRecord {
	/** The session's ID. */
	readonly id: string;
	readonly organisationId: string;
	readonly projectId: string;
	/** The agent profile the session runs. */
	readonly agentId: string;
	readonly parentSessionId?: string;
	readonly workspaceId?: string;
	readonly title?: string;
	readonly status: SessionStatus;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels: Labels;
	/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export type SessionStatus = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled";

/** A message the session accepted. */
export interface Submission {
	/** The submission's ID, which names the run the message started or joined. */
	readonly id: string;
	readonly sessionId: string;
	/** How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in progress at its next model call, and `followUp` runs after the current run ends. */
	readonly via: MessageVia;
	/** The `Idempotency-Key` it was sent with. */
	readonly requestId?: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Runtime

// The SDK's runtime, copied into `generated/sdk.ts` as it is, so the SDK is one file with no imports. Keep it free of
// imports and of anything but `fetch`.

export interface HarbourClientOptions {
	/** The API's base URL with its version, such as `https://harbour.example/v1`, or `/v1` on the same origin. */
	readonly baseUrl: string;
	/**
	 * The bearer for every call: a host app's API key (`hbr_…`), or a function that gives one per call. Absent when the
	 * browser is signed in another way, such as Cloudflare Access's cookie.
	 */
	readonly token?: string | (() => string | undefined | Promise<string | undefined>);
	/** More headers for every call. */
	readonly headers?: () => { readonly [name: string]: string } | Promise<{ readonly [name: string]: string }>;
	/** Default the global `fetch`. */
	readonly fetch?: typeof fetch;
}

/** Per call. */
export interface CallOptions {
	readonly signal?: AbortSignal;
	/** Sent as `harbour-request-id`, which correlates the call in Harbour's audit trail. */
	readonly requestId?: string;
	/**
	 * Sent as `Idempotency-Key` on the calls that take one (their docs say so): a retry with the same key gets the first
	 * call's answer and does nothing again. Use a new key, such as a UUID, for each new call.
	 */
	readonly idempotencyKey?: string;
	readonly headers?: { readonly [name: string]: string };
}

/** An error Harbour answered with: its HarbourError code (or `unauthenticated`), message and HTTP status. */
export class HarbourApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: { readonly [key: string]: unknown };
	constructor(status: number, code: string, message: string, details?: { readonly [key: string]: unknown }) {
		super(message);
		this.name = "HarbourApiError";
		this.status = status;
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

/** One call, as the generated methods describe it. */
export interface ApiCall {
	readonly method: string;
	/** Relative to the base URL, with path parameters already encoded. */
	readonly path: string;
	/** Query parameters; a record value, such as `label`, is sent as `label.<key>=<value>`. */
	readonly query?: object;
	readonly body?: unknown;
	readonly headers?: { readonly [name: string]: string | undefined };
}

const queryString = (query: object | undefined): string => {
	if (query === undefined) return "";
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "object") {
			// A record, such as `label`: `label.<key>=<value>`.
			for (const [key, item] of Object.entries(value as { [key: string]: unknown })) {
				if (item !== undefined) params.append(`${name}.${key}`, String(item));
			}
		} else params.append(name, String(value));
	}
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
};

async function errorOf(response: Response): Promise<HarbourApiError> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
	const code =
		typeof error?.code === "string" ? error.code : response.status === 401 ? "unauthenticated" : "unavailable";
	const message = typeof error?.message === "string" ? error.message : `Harbour answered ${response.status}`;
	const details =
		typeof error?.details === "object" && error.details !== null
			? (error.details as { [key: string]: unknown })
			: undefined;
	return new HarbourApiError(response.status, code, message, details);
}

/** Sends one call and reads its JSON answer; a 204 resolves undefined. Rejects with a `HarbourApiError`. */
export async function send<T>(options: HarbourClientOptions, call: ApiCall, callOptions: CallOptions = {}): Promise<T> {
	const headers: { [name: string]: string } = { accept: "application/json" };
	Object.assign(headers, (await options.headers?.()) ?? {});
	const token = typeof options.token === "function" ? await options.token() : options.token;
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	if (call.body !== undefined) headers["content-type"] = "application/json";
	if (callOptions.requestId !== undefined) headers["harbour-request-id"] = callOptions.requestId;
	if (callOptions.idempotencyKey !== undefined) headers["idempotency-key"] = callOptions.idempotencyKey;
	for (const [name, value] of Object.entries(call.headers ?? {})) if (value !== undefined) headers[name] = value;
	Object.assign(headers, callOptions.headers ?? {});
	const doFetch = options.fetch ?? fetch;
	const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}${call.path}${queryString(call.query)}`, {
		method: call.method,
		headers,
		...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
		...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
	});
	if (!response.ok) throw await errorOf(response);
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

// Client

/** Harbour's public API, one method per route. */
export interface HarbourClient {
	/** Create a session. Starts a session of an agent profile in a project, and sends it `message` when there is one. Needs the operator role on the project. If the first message is refused, the session is closed and the refusal answered. `POST /sessions` */
	createSession(body: CreateSessionBody, options?: CallOptions): Promise<CreatedSession>;
	/** List sessions. The sessions the caller may see, newest first, a page at a time. `GET /sessions` */
	listSessions(query?: ListSessionsQuery, options?: CallOptions): Promise<SessionPage>;
	/** Get a session. `GET /sessions/{sessionId}` */
	getSession(sessionId: string, options?: CallOptions): Promise<SessionRecord>;
	/** Close a session. Ends the session for good: its sandbox leases, browser sessions and grants end. Closing a closed session does nothing. `POST /sessions/{sessionId}/close` */
	closeSession(sessionId: string, options?: CallOptions): Promise<void>;
	/** Abort a session's run. Stops what the session is doing now. The session stays open and takes new messages. `POST /sessions/{sessionId}/abort` */
	abortSession(sessionId: string, body?: AbortSessionBody, options?: CallOptions): Promise<void>;
	/** Send a message. Sends the session's agent a message, `via` a prompt, a steer or a follow-up. The answer arrives on the session's stream. Send an `Idempotency-Key` so a retry can't send it twice: a retry with the same key answers the first call's submission without sending anything, and one with another `via` is a `conflict`. Idempotent with `options.idempotencyKey`. `POST /sessions/{sessionId}/messages` */
	sendMessage(sessionId: string, body: MessageBody, options?: CallOptions): Promise<Submission>;
}

/** A client for Harbour's public API over `fetch`. */
export function createHarbourClient(options: HarbourClientOptions): HarbourClient {
	return {
		createSession: (body, callOptions) => send(options, { method: "POST", path: "/sessions", body }, callOptions),
		listSessions: (query, callOptions) => send(options, { method: "GET", path: "/sessions", query }, callOptions),
		getSession: (sessionId, callOptions) =>
			send(options, { method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}` }, callOptions),
		closeSession: (sessionId, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/close` }, callOptions),
		abortSession: (sessionId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/abort`, body }, callOptions),
		sendMessage: (sessionId, body, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/messages`, body }, callOptions),
	};
}
