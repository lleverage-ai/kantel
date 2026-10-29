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

export interface AssistantItem {
	readonly kind: "assistant";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly text: string;
	/** True while tokens are still arriving. */
	readonly streaming: boolean;
	readonly thinking?: string;
}

/** How a session list groups the session: working, waiting on someone, or done. */
export type Attention = "working" | "waiting" | "done";

export interface BrowserGrantCard {
	readonly type: "browser.grant";
	readonly requestId: string;
	readonly reason: string;
	readonly status: "pending" | "granted" | "denied";
}

export type Card = VaultApprovalCard | QuestionCard | BrowserGrantCard;

export interface CardItem {
	readonly kind: "card";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly card: Card;
}

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

/** An opaque position in a session's stream. */
export type Cursor = string;

/** `append` adds an item, `replace` swaps the item with the same id, `text` appends streamed text to an assistant item, and `status`, `title` and `usage` set the session's. */
export type DeltaOp =
	| {
			readonly op: "append";
			readonly item: TranscriptItem;
	  }
	| {
			readonly op: "replace";
			readonly item: TranscriptItem;
	  }
	| {
			readonly op: "text";
			readonly itemId: string;
			readonly append: string;
			readonly field?: "text" | "thinking";
	  }
	| {
			readonly op: "status";
			readonly status: SessionStatus;
			/** How a session list groups the session: working, waiting on someone, or done. */
			readonly attention: Attention;
	  }
	| {
			readonly op: "title";
			readonly title: string;
	  }
	| {
			readonly op: "usage";
			readonly usage: Usage;
	  };

/** The session's first prompt, sent as soon as it exists. */
export interface FirstMessage {
	/** The message's words. */
	readonly text: string;
	/** A model ID the session may use, for this run and the session's later runs. Absent keeps the session's model. */
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
}

export interface HistoryPage {
	readonly sessionId: string;
	/** Oldest first. */
	readonly items: readonly TranscriptItem[];
	readonly hasEarlier: boolean;
}

export interface HistoryQuery {
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
	/** Items older than this item ID, such as a snapshot's `items[0].id`. */
	readonly before?: string;
	/** At most this many items. Default 50, cut to 200. */
	readonly limit?: number;
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

export interface NoticeItem {
	readonly kind: "notice";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly level: "info" | "warning" | "error";
	readonly text: string;
	readonly code?: string;
}

export interface QuestionCard {
	readonly type: "question";
	readonly questionId: string;
	readonly text: string;
	readonly options?: readonly string[];
	readonly status: "open" | "answered" | "withdrawn";
	readonly answer?: string;
}

/** One frame of `@harbour/protocol`: `hello`, then a `snapshot` (or the deltas after the client's cursor), then live `delta`s. */
export type ServerFrame =
	| {
			readonly type: "hello";
			readonly v: 1;
			readonly sessionId: string;
			/** An opaque position in a session's stream. */
			readonly cursor: Cursor;
			/** True when deltas after the client's cursor follow, false for a snapshot. */
			readonly resumed: boolean;
	  }
	| {
			readonly type: "snapshot";
			readonly snapshot: SessionSnapshot;
	  }
	| {
			readonly type: "delta";
			readonly delta: SessionDelta;
	  }
	| {
			readonly type: "history";
			readonly page: HistoryPage;
	  }
	| {
			readonly type: "error";
			readonly code: string;
			readonly message: string;
	  };

export interface SessionDelta {
	readonly sessionId: string;
	/** An opaque position in a session's stream. */
	readonly cursor: Cursor;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly ops: readonly DeltaOp[];
}

export interface SessionHistoryPage {
	readonly sessionId: string;
	/** Newest first. */
	readonly items: readonly TranscriptItem[];
	/** Present when older items exist; pass it as `cursor`. */
	readonly nextCursor?: string;
}

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

export interface SessionSnapshot {
	readonly v: 1;
	readonly sessionId: string;
	/** An opaque position in a session's stream. */
	readonly cursor: Cursor;
	readonly status: SessionStatus;
	/** How a session list groups the session: working, waiting on someone, or done. */
	readonly attention: Attention;
	readonly title?: string;
	/** The latest page of items, oldest first. */
	readonly items: readonly TranscriptItem[];
	/** True when items before `items[0]` exist. */
	readonly hasEarlier: boolean;
	readonly usage?: Usage;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export type SessionStatus = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled";

export interface StreamQuery {
	/** Resume after this cursor (a snapshot's or a delta's): the stream sends the deltas after it, or a snapshot when it no longer holds them. */
	readonly after?: string;
}

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

export interface ToolItem {
	readonly kind: "tool";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly callId: string;
	readonly name: string;
	/** A plain-language label, such as "Reading notes/x.md". */
	readonly label: string;
	readonly status: "running" | "done" | "error" | "interrupted";
	readonly args?: unknown;
	readonly output?: string;
	readonly tier?: "isolate" | "container";
	/** Epoch milliseconds, UTC. */
	readonly endedAt?: number;
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | CardItem | NoticeItem;

export interface Usage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly costUsd?: number;
}

export interface UserItem {
	readonly kind: "user";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly text: string;
	readonly via: "prompt" | "steer" | "followUp";
	readonly requestId?: string;
}

/** A vault proposal waiting on a person. The secret is never part of it. */
export interface VaultApprovalCard {
	readonly type: "vault.approval";
	readonly proposalId: string;
	readonly status: "pending" | "approved" | "denied" | "expired" | "withdrawn";
	readonly bindingCode: string;
	readonly what: string;
	readonly why: string;
	readonly host: string;
	readonly methods: readonly string[];
	readonly pathPrefix: string;
	readonly injectionTemplate?: string;
	readonly termsSource: "agent-proposed" | "approved";
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
	readonly link: string;
}

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
	/**
	 * Opens a stream's WebSocket. Default the global `WebSocket`; with a bearer it passes `{ headers }`, which Node's
	 * (undici's) takes. A browser can't put a header on a socket, so in a browser the page must be signed in by cookie.
	 */
	readonly webSocket?: (url: string, headers: { readonly [name: string]: string }) => WebSocketLike;
}

/** The parts of a WHATWG WebSocket a stream uses. */
export interface WebSocketLike {
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	close(code?: number, reason?: string): void;
}

/** What a stream calls as frames arrive. */
export interface StreamHandlers<Frame> {
	/** The frames of one message, in order: `hello`, then a snapshot or the deltas after `after`, then live deltas. */
	onFrames(frames: readonly Frame[]): void;
	onOpen?(): void;
	/** The socket closed, by either side. Reconnect with `{ after: handle.cursor }` to resume. */
	onClose?(event: { readonly code: number; readonly reason: string }): void;
}

/** An open stream. */
export interface StreamHandle {
	/** The latest cursor the stream has sent (a hello's, a snapshot's or a delta's), to resume from. */
	readonly cursor: string | undefined;
	close(): void;
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

const cursorOf = (frame: unknown): string | undefined => {
	const value = frame as {
		type?: string;
		cursor?: string;
		snapshot?: { cursor?: string };
		delta?: { cursor?: string };
	};
	if (value.type === "snapshot") return value.snapshot?.cursor;
	if (value.type === "delta") return value.delta?.cursor;
	if (value.type === "hello") return value.cursor;
	return undefined;
};

function defaultWebSocket(url: string, headers: { readonly [name: string]: string }): WebSocketLike {
	const Socket = (globalThis as { WebSocket?: unknown }).WebSocket as
		| (new (
				url: string,
				init?: { headers: { readonly [name: string]: string } },
		  ) => WebSocketLike)
		| undefined;
	if (Socket === undefined) throw new HarbourApiError(0, "not_supported", "This platform has no WebSocket");
	return Object.keys(headers).length === 0 ? new Socket(url) : new Socket(url, { headers });
}

/** Opens a stream route's WebSocket and hands each message's frames to `handlers`. */
export function openStream<Frame>(
	options: HarbourClientOptions,
	call: ApiCall,
	handlers: StreamHandlers<Frame>,
	callOptions: CallOptions = {},
): StreamHandle {
	const base = options.baseUrl.replace(/\/+$/, "");
	const origin = (globalThis as { location?: { href?: string } }).location?.href;
	const url = new URL(`${base}${call.path}${queryString(call.query)}`, origin);
	url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
	let cursor: string | undefined;
	let socket: WebSocketLike | undefined;
	let closed = false;
	const handle: StreamHandle = {
		get cursor() {
			return cursor;
		},
		close() {
			closed = true;
			socket?.close(1000, "The client closed the stream");
		},
	};
	void (async () => {
		const headers: { [name: string]: string } = {};
		Object.assign(headers, (await options.headers?.()) ?? {});
		const token = typeof options.token === "function" ? await options.token() : options.token;
		if (token !== undefined) headers.authorization = `Bearer ${token}`;
		if (callOptions.requestId !== undefined) headers["harbour-request-id"] = callOptions.requestId;
		Object.assign(headers, callOptions.headers ?? {});
		if (closed) return;
		socket = (options.webSocket ?? defaultWebSocket)(url.href, headers);
		socket.onopen = () => handlers.onOpen?.();
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			let frames: unknown;
			try {
				frames = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!Array.isArray(frames) || frames.length === 0) return;
			for (const frame of frames) cursor = cursorOf(frame) ?? cursor;
			handlers.onFrames(frames as Frame[]);
		};
		socket.onerror = () => undefined;
		socket.onclose = (event) => {
			closed = true;
			handlers.onClose?.({ code: event.code, reason: event.reason });
		};
		callOptions.signal?.addEventListener("abort", () => handle.close(), { once: true });
	})().catch((error: unknown) => {
		closed = true;
		handlers.onClose?.({ code: 1006, reason: error instanceof Error ? error.message : "The stream failed to open" });
	});
	return handle;
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
	/** Stream a session. The session as `@harbour/protocol` frames: `hello`, then a `snapshot` of its state and latest items (or, with `after`, the deltas after that cursor when the stream still holds them), then a `delta` for every change, live. Fold them with the protocol's `applyFrames`. Over a WebSocket, compressed where the platform can, or as server-sent events. `GET /sessions/{sessionId}/stream` */
	streamSession(
		sessionId: string,
		handlers: StreamHandlers<ServerFrame>,
		query?: StreamQuery,
		options?: CallOptions,
	): StreamHandle;
	/** Page back through a session. The session's transcript in pages, newest first, for scrolling back past a snapshot's items: start with `before` set to the snapshot's `items[0].id`, then follow `nextCursor`. `GET /sessions/{sessionId}/history` */
	getSessionHistory(sessionId: string, query?: HistoryQuery, options?: CallOptions): Promise<SessionHistoryPage>;
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
		streamSession: (sessionId, handlers, query, callOptions) =>
			openStream(
				options,
				{ method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}/stream`, query },
				handlers,
				callOptions,
			),
		getSessionHistory: (sessionId, query, callOptions) =>
			send(options, { method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}/history`, query }, callOptions),
	};
}
