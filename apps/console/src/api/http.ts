// The console on the session API (`@harbour/runtime/http`, served under `/v1` by the gateway). Same-origin: behind
// Cloudflare Access the browser's Access cookie signs every call in, and the edge adds the token the gateway checks,
// so this client sends no credential of its own. `pnpm dev` proxies `/v1` to a local gateway and adds a dev token
// there (vite.config.ts).
//
// What the API has and hasn't yet:
// - Sessions: listed per project, each one's frames streamed as server-sent events, prompt, steer, follow-up and abort.
// - No list of projects and no "who am I": the projects are the ones the caller's sessions are in, named by id, and
//   the actor is whoever Access signed in. Identity's HTTP API (M1-BE7) will answer both.
// - No list events: a project's list is polled, every page of it, every LIST_POLL_MS while it is shown.
// - No history pages: the snapshot is the whole transcript, so a history request is answered with an empty page.

import type { HistoryPage, ServerFrame, SessionStatus } from "@harbour/protocol";
import type { SessionSummary } from "@harbour/ui";
import type { Transport } from "../state/session-client.ts";
import type { ConsoleClient, ProjectSummary, SendOptions, SessionControl } from "./client.ts";
import { readEvents } from "./sse.ts";

export const LIST_POLL_MS = 3000;
const LIST_LIMIT = 100;
const FRAME_EVENTS = new Set<string>(["hello", "snapshot", "delta", "history", "error"]);

/** A session as the API lists it: the parts of `SessionRecord` (`@harbour/contracts`) the console reads. */
type SessionRecord = {
	readonly id: string;
	readonly projectId: string;
	readonly title?: string;
	readonly status: SessionStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
};
type Page<T> = { readonly items: readonly T[]; readonly nextCursor?: string };

export type ApiClientOptions = {
	/** Where the session API is. Default `/v1`, on the console's own origin. */
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Headers for every call; tests sign in with a bearer here. The browser needs none. */
	headers?: () => Record<string, string>;
	listPollMs?: number;
};

/** An error the API answered with, or a network failure, in words for the console. */
export class ApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

async function errorOf(response: Response): Promise<ApiError> {
	if (response.status === 401) return new ApiError("unauthenticated", "You're signed out. Reload the page to sign in.");
	try {
		const body = (await response.json()) as { error?: { code?: string; message?: string } };
		if (body.error?.message !== undefined) return new ApiError(body.error.code ?? "unavailable", body.error.message);
	} catch {
		// Not the API's JSON: a proxy's page, say.
	}
	return new ApiError("unavailable", `Harbour answered ${response.status}`);
}

/** The list's status for a session: an idle session has nothing running, so it reads as settled. */
const listStatus = (status: SessionStatus): SessionStatus => (status === "idle" ? "done" : status);
const active = (status: SessionStatus) => status === "running" || status === "waiting";

export function createApiClient(options: ApiClientOptions = {}): ConsoleClient {
	const base = (options.baseUrl ?? "/v1").replace(/\/+$/, "");
	const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const pollMs = options.listPollMs ?? LIST_POLL_MS;
	const sessionUrl = (id: string, rest = "") => `${base}/sessions/${encodeURIComponent(id)}${rest}`;

	/** The project each session we've seen is in. */
	const projectOfSession = new Map<string, string>();
	/**
	 * Unread: a settled session that has changed since it was last on screen. `seen` holds each session's `updatedAt`
	 * when it was last on screen, or when it was first listed (so nothing is unread on opening the console). A
	 * session first listed later than its project's first listing, which ran and settled in between, starts unread.
	 */
	const seen = new Map<string, number>();
	const latest = new Map<string, number>();
	const listedProjects = new Set<string>();
	/** Sessions on screen, with how many screens show each. */
	const open = new Map<string, number>();

	const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers(init.headers);
		for (const [name, value] of Object.entries(options.headers?.() ?? {})) headers.set(name, value);
		let response: Response;
		try {
			response = await doFetch(path, { ...init, headers });
		} catch (reason) {
			if (init.signal?.aborted) throw reason;
			throw new ApiError("unavailable", "Can't reach Harbour. Check your connection.");
		}
		if (!response.ok) throw await errorOf(response);
		return response;
	};
	const getJson = async <T>(path: string): Promise<T> => (await (await call(path)).json()) as T;
	const post = async (path: string, body: unknown, requestId?: string): Promise<void> => {
		await call(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(requestId === undefined ? {} : { "harbour-request-id": requestId }),
			},
			body: JSON.stringify(body),
		});
	};

	/** Every session matching `filter`, following the API's pages. */
	const listSessions = async (filter: Record<string, string> = {}): Promise<SessionRecord[]> => {
		const records: SessionRecord[] = [];
		let cursor: string | undefined;
		do {
			const query = new URLSearchParams({ ...filter, limit: String(LIST_LIMIT) });
			if (cursor !== undefined) query.set("cursor", cursor);
			const page = await getJson<Page<SessionRecord>>(`${base}/sessions?${query}`);
			for (const record of page.items) projectOfSession.set(record.id, record.projectId);
			records.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return records;
	};

	const isUnread = (record: SessionRecord, firstListing: boolean): boolean => {
		latest.set(record.id, record.updatedAt);
		if (open.has(record.id)) seen.set(record.id, record.updatedAt);
		else if (!seen.has(record.id)) seen.set(record.id, firstListing ? record.updatedAt : record.createdAt);
		return !active(record.status) && record.updatedAt > (seen.get(record.id) ?? record.updatedAt);
	};

	const summaryOf = (record: SessionRecord, firstListing: boolean): SessionSummary => {
		const unread = isUnread(record, firstListing);
		return {
			id: record.id,
			title: record.title ?? "Untitled session",
			status: listStatus(record.status),
			startedAt: record.createdAt,
			updatedAt: record.updatedAt,
			...(unread ? { unread: true } : {}),
		};
	};

	const send = (sessionId: string, action: string, text: string, sendOptions?: SendOptions) =>
		post(
			sessionUrl(sessionId, `/${action}`),
			{ text, ...(sendOptions?.requestId === undefined ? {} : { requestId: sendOptions.requestId }) },
			sendOptions?.requestId,
		);

	return {
		actor: { id: "access", name: "Signed in", stubbed: false },

		async projects(): Promise<readonly ProjectSummary[]> {
			const recent = new Map<string, number>();
			for (const record of await listSessions()) {
				recent.set(record.projectId, Math.max(recent.get(record.projectId) ?? 0, record.updatedAt));
			}
			// The most recently active project first, so the home page opens it.
			return [...recent].sort((a, b) => b[1] - a[1]).map(([id]) => ({ id, name: id }));
		},

		watchSessions(projectId, onChange) {
			let stopped = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let sessions: readonly SessionSummary[] = [];
			const poll = async () => {
				try {
					const records = await listSessions({ projectId });
					if (stopped) return;
					const firstListing = !listedProjects.has(projectId);
					listedProjects.add(projectId);
					sessions = records.map((record) => summaryOf(record, firstListing));
					onChange({ sessions, loading: false });
				} catch (reason) {
					if (stopped) return;
					// Keep what was listed; say why it may be out of date.
					onChange({ sessions, loading: false, error: reason instanceof Error ? reason.message : String(reason) });
				}
				if (!stopped) timer = setTimeout(poll, pollMs);
			};
			void poll();
			return () => {
				stopped = true;
				clearTimeout(timer);
			};
		},

		transport(sessionId): Transport {
			return {
				connect(receive, lost) {
					const controller = new AbortController();
					let closed = false;
					const stream = async (after: string | undefined) => {
						const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
						let response: Response;
						try {
							response = await call(sessionUrl(sessionId, `/events${query}`), {
								headers: { accept: "text/event-stream" },
								signal: controller.signal,
							});
						} catch (reason) {
							if (closed) return;
							// Refused (signed out, no such session): say so and stop. Anything else: try again.
							if (reason instanceof ApiError && reason.code !== "unavailable") {
								receive({ type: "error", code: reason.code, message: reason.message });
							} else lost?.();
							return;
						}
						if (response.body === null) {
							if (!closed) lost?.();
							return;
						}
						try {
							await readEvents(response.body, (event) => {
								if (closed || !FRAME_EVENTS.has(event.event)) return;
								receive(JSON.parse(event.data) as ServerFrame);
							});
						} catch {
							// The stream broke; treated as its end.
						}
						if (!closed) lost?.();
					};
					return {
						send(frame) {
							if (closed) return;
							if (frame.type === "hello") void stream(frame.after);
							else {
								const page: HistoryPage = { sessionId, items: [], hasEarlier: false };
								queueMicrotask(() => {
									if (!closed) receive({ type: "history", page });
								});
							}
						},
						close() {
							closed = true;
							controller.abort();
						},
					};
				},
			};
		},

		async projectOf(sessionId) {
			const known = projectOfSession.get(sessionId);
			if (known !== undefined) return known;
			try {
				const record = await getJson<SessionRecord>(sessionUrl(sessionId));
				projectOfSession.set(record.id, record.projectId);
				return record.projectId;
			} catch (reason) {
				if (reason instanceof ApiError && reason.code === "not_found") return undefined;
				throw reason;
			}
		},

		control: (): SessionControl => ({ live: true }),

		prompt: (sessionId, text, sendOptions) => send(sessionId, "prompt", text, sendOptions),
		steer: (sessionId, text, sendOptions) => send(sessionId, "steer", text, sendOptions),
		followUp: (sessionId, text, sendOptions) => send(sessionId, "follow-up", text, sendOptions),
		cancel: (sessionId) => post(sessionUrl(sessionId, "/abort"), {}),

		markRead(sessionId) {
			open.set(sessionId, (open.get(sessionId) ?? 0) + 1);
			const read = () => {
				const updated = latest.get(sessionId);
				if (updated !== undefined) seen.set(sessionId, updated);
			};
			read();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				// It was on screen until now, so what it did meanwhile has been seen.
				read();
				const count = (open.get(sessionId) ?? 1) - 1;
				if (count > 0) open.set(sessionId, count);
				else open.delete(sessionId);
			};
		},
	};
}
