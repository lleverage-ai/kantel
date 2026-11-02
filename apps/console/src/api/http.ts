// The console on the session API (`@kantel/runtime/http`, served under `/v1` by the gateway). Same-origin: behind
// Cloudflare Access the browser's Access cookie signs every call in, and the edge adds the token the gateway checks,
// so this client sends no credential of its own; signed in with an email code, `headers` adds the session's bearer
// (identity.ts). `pnpm dev` proxies `/v1` to a local gateway and adds a dev token there (vite.config.ts).
//
// What the API has and hasn't yet:
// - Sessions: listed per project, each one's frames streamed over a compressed WebSocket (socket.ts) or, where there is
//   none, as server-sent events; prompt, steer, follow-up and abort.
// - Who is signed in and their projects: identity's `GET /v1/me` (identity.ts, before this client is made) and
//   `GET /v1/projects`, every page, named, the most recently active first.
// - No list events: a project's list is polled every LIST_POLL_MS while it is shown. The API lists sessions newest
//   first and reads every session for each page it serves, so the console shows the first page as soon as it comes,
//   reads the rest in the largest pages the API serves, and between full listings (every LIST_FULL_EVERY polls) asks
//   for the first page only: a new session is always on it, and the rows it has replace the ones held.
// - History pages: the stream's snapshot is the latest page; a `history` frame the client sends is `GET
//   /v1/sessions/:id/history?before=<its first item>`, whose newest-first page comes back as a `history` frame,
//   oldest first. A page that fails comes back as an error frame with code `history`, which leaves the session open.
// - A session's workspace, read-only, through the workspace read API (`@kantel/workspace/read-api`, under
//   `/v1/workspaces`), GET routes only: browsing never acquires a sandbox.
// - A session on a repository: New session lists its branches (`GET /v1/git/branches`), then creates the workspace
//   from the repository at the branch (`POST /v1/workspaces`, a git seed) and the session on it (`workspaceId`).
//   Seeding writes files and never acquires a sandbox; the repository's credentials, when it needs any, are the
//   gateway's (the vault's egress), never the console's.

import {
	type AgentProfile,
	type HeldRole,
	type Project,
	protocolHistoryPage,
	roleSatisfies,
	type SessionHistoryPage,
	type SessionModelState,
} from "@kantel/contracts";
import type { ServerFrame, SessionStatus, UserAttachment } from "@kantel/protocol";
import type { SessionSummary, WorkspaceEntry } from "@kantel/ui";
import { HISTORY_ERROR, type Transport } from "../state/session-client.ts";
import type {
	ConsoleActor,
	ConsoleClient,
	FileShareRecord,
	ModelChoices,
	ProjectSummary,
	RepositoryBranches,
	SendOptions,
	SessionChange,
	SessionControl,
	StartAccess,
	StartOptions,
	WorkspaceFiles,
	WorkspaceListing,
	WorkspaceShares,
	WrittenFile,
} from "./client.ts";
import { ORGANISATION_SCOPE } from "./client.ts";
import { type OpenSocket, type SocketHandlers, type SocketWatch, socketUrl, watchOverSocket } from "./socket.ts";
import { readEvents } from "./sse.ts";

export const LIST_POLL_MS = 3000;
/** Every this many polls the list is read in full; the polls between read its first page only. */
export const LIST_FULL_EVERY = 10;
const LIST_LIMIT = 100;
/** The largest page the API serves (`MAX_PAGE_LIMIT` in @kantel/runtime): fewer round trips for the rest of a list. */
const LIST_PAGE_MAX = 500;
/** The label a subagent's session has naming the `subagent` call that started it (the stack's `src/subagent.ts`). */
export const SUBAGENT_CALL_LABEL = "subagentCall";
/** The most entries the console reads from one directory; past it the tree says some aren't shown. */
export const DIRECTORY_CAP = 2000;
const FRAME_EVENTS = new Set<string>(["hello", "snapshot", "delta", "history", "error"]);
/** The longest what waits for the first paint (`firstPaint`) waits: a session that is slow to open holds up nothing. */
export const FIRST_PAINT_MS = 4000;
/** How long a stream opened ahead of its screen (`preconnect`) waits for the screen before it closes. */
const UNCLAIMED_MS = 15_000;

/** A stream opened before its screen: the frames it has had, until the screen's connection takes it over. */
type EarlyStream = {
	readonly sessionId: string;
	watch: SocketWatch;
	readonly frames: ServerFrame[];
	extensions?: string;
	/** It closed, or never opened, before the screen took it over. */
	ended?: true;
	/** The screen's, once it has taken the stream over. */
	handlers?: SocketHandlers;
	readonly unclaimed: ReturnType<typeof setTimeout>;
};

/**
 * A session as the console keeps it: the parts of `SessionRecord` (`@kantel/contracts`) it reads, with an
 * organisation session's absent project as `ORGANISATION_SCOPE` (`recordOf`).
 */
type SessionRecord = {
	readonly id: string;
	readonly projectId: string;
	readonly title?: string;
	readonly status: SessionStatus;
	readonly workspaceId?: string;
	/** Set on a subagent's session: the session that started it. */
	readonly parentSessionId?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** Pinned to the top of the list, archived, or marked unread from its menu, and when (`PATCH /v1/sessions/:id`). */
	readonly pinnedAt?: number;
	readonly archivedAt?: number;
	readonly markedUnreadAt?: number;
};
type Page<T> = { readonly items: readonly T[]; readonly nextCursor?: string };
/** A session as the API sends it: an organisation session has no `projectId`. */
type ApiSessionRecord = Omit<SessionRecord, "projectId"> & { readonly projectId?: string };

/** The console's record of a session the API sent: an organisation session's project is `ORGANISATION_SCOPE`. */
export const consoleRecord = (record: ApiSessionRecord): SessionRecord =>
	record.projectId === undefined ? { ...record, projectId: ORGANISATION_SCOPE } : (record as SessionRecord);

/** How a call names the console's project key: the project, or the organisation's scope and no project. */
export const scopeParams = (projectId: string): Record<string, string> =>
	projectId === ORGANISATION_SCOPE ? { scope: "organisation" } : { projectId };

export type ApiClientOptions = {
	/** Where the session API is. Default `/v1`, on the console's own origin. */
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Headers for every call: an email-code session's bearer, or a test's. Behind Access the browser needs none. */
	headers?: () => Record<string, string>;
	listPollMs?: number;
	/** Who `GET /v1/me` said is signed in. */
	actor?: ConsoleActor;
	/**
	 * The roles `GET /v1/me` said they hold, which decide where New session is offered. Without them it is offered
	 * everywhere, and the API refuses a viewer.
	 */
	roles?: readonly HeldRole[];
	/** Called on any 401: the session is over, and the console asks to sign in again. */
	onUnauthenticated?: () => void;
	/**
	 * Opens a session's event socket. Default the browser's `WebSocket`; `false` reads every session as server-sent
	 * events. The socket is used only while `headers` add no credential (behind Access the cookie signs it in; a browser
	 * can't put a bearer on a socket), and once one fails to open the client reads event streams for the rest of its life.
	 */
	openSocket?: OpenSocket | false;
	/** The page the API's paths are relative to, for the socket's URL. Default the page's own location. */
	origin?: string;
	/** Told how each session's events came: over a socket, with its extensions, or as an event stream. */
	onTransport?: (sessionId: string, how: TransportKind) => void;
};

/** How a session's events reach the console. */
export type TransportKind = { readonly kind: "websocket"; readonly extensions: string } | { readonly kind: "sse" };

const browserSocket: OpenSocket | undefined =
	typeof WebSocket === "undefined" ? undefined : (url) => new WebSocket(url) as unknown as ReturnType<OpenSocket>;

const SIGNED_IN: ConsoleActor = { id: "access", name: "Signed in", stubbed: false };

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
	if (response.status === 413) return new ApiError("too_large", "This file is too large to show here.");
	try {
		const body = (await response.json()) as { error?: { code?: string; message?: string } };
		if (body.error?.message !== undefined) return new ApiError(body.error.code ?? "unavailable", body.error.message);
	} catch {
		// Not the API's JSON: a proxy's page, say.
	}
	return new ApiError("unavailable", `Kantel answered ${response.status}`);
}

/** Why a viewer sees New session dimmed. */
export const VIEWER_REASON = "You can watch this project's sessions. Starting one needs the operator role.";

/** Why someone without an organisation-wide role sees an organisation session's New session dimmed. */
export const ORGANISATION_REASON =
	"Starting an organisation-wide session needs the operator role across the organisation.";

/**
 * Whether `roles` let someone start a session in the project: operator or above there, or across the organisation.
 * An organisation session (`ORGANISATION_SCOPE`) needs operator across the organisation.
 */
export function startAccess(roles: readonly HeldRole[] | undefined, projectId: string): StartAccess {
	if (roles === undefined) return { allowed: true };
	const may = roles.some(
		(held) => (held.projectId === undefined || held.projectId === projectId) && roleSatisfies(held.role, "operator"),
	);
	if (may) return { allowed: true };
	return { allowed: false, reason: projectId === ORGANISATION_SCOPE ? ORGANISATION_REASON : VIEWER_REASON };
}

/**
 * The agent a new session in the project runs: one of the project's own profiles, else one for the whole organisation,
 * the first by name. Undefined when none may run there.
 */
export function agentFor(profiles: readonly AgentProfile[], projectId: string): AgentProfile | undefined {
	const byName = (a: AgentProfile, b: AgentProfile) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
	return (
		[...profiles].filter((profile) => profile.projectId === projectId).sort(byName)[0] ??
		[...profiles].filter((profile) => profile.projectId === undefined).sort(byName)[0]
	);
}

/** The API's model state as the composer's pickers take it. */
export function modelChoicesOf(state: SessionModelState): ModelChoices {
	return {
		models: state.models,
		...(state.selected === undefined ? {} : { model: state.selected.model }),
		...(state.selected?.thinking === undefined ? {} : { thinking: state.selected.thinking }),
		...(state.defaults?.thinking === undefined ? {} : { defaultThinking: state.defaults.thinking }),
		...(state.locked === true ? { locked: true } : {}),
	};
}

/** The list's status for a session: an idle session has nothing running, so it reads as settled. */
const listStatus = (status: SessionStatus): SessionStatus => (status === "idle" ? "done" : status);
const active = (status: SessionStatus) => status === "running" || status === "waiting";

export function createApiClient(options: ApiClientOptions = {}): ConsoleClient {
	const base = (options.baseUrl ?? "/v1").replace(/\/+$/, "");
	const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const pollMs = options.listPollMs ?? LIST_POLL_MS;
	const openSocket = options.openSocket === false ? undefined : (options.openSocket ?? browserSocket);
	const origin = options.origin ?? (typeof location === "undefined" ? undefined : location.href);
	/** Cleared for good when a socket fails to open: the gateway, a proxy or the network won't carry one. */
	let socketsWork = openSocket !== undefined && origin !== undefined;
	const socketAllowed = () => socketsWork && Object.keys(options.headers?.() ?? {}).length === 0;
	const sessionUrl = (id: string, rest = "") => `${base}/sessions/${encodeURIComponent(id)}${rest}`;

	/** The project each session we've seen is in. */
	const projectOfSession = new Map<string, string>();
	/** Each session's record as last read, for its parent and title: lists and reads keep it current. */
	const records = new Map<string, SessionRecord>();
	/** Reads of a record under way, so a screen opening a session asks for it once however many parts want it. */
	const reading = new Map<string, Promise<SessionRecord | undefined>>();
	/** A session's record, as last read or else from the API; undefined when there's no such session. */
	const recordOf = async (sessionId: string, signal?: AbortSignal): Promise<SessionRecord | undefined> => {
		const known = records.get(sessionId);
		if (known !== undefined) return known;
		let read = reading.get(sessionId);
		if (read === undefined) {
			read = (async () => {
				try {
					const record = consoleRecord(await getJson<ApiSessionRecord>(sessionUrl(sessionId)));
					records.set(record.id, record);
					projectOfSession.set(record.id, record.projectId);
					return record;
				} catch (reason) {
					if (reason instanceof ApiError && reason.code === "not_found") return undefined;
					throw reason;
				} finally {
					reading.delete(sessionId);
				}
			})();
			reading.set(sessionId, read);
		}
		if (signal === undefined) return read;
		// Shared, so one caller's abort doesn't cancel the others' read: it only stops this caller waiting.
		signal.throwIfAborted();
		return Promise.race([
			read,
			new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
		]);
	};
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
	/** Sessions just left, whose updatedAt at the time is still being read; never unread meanwhile. */
	const leaving = new Map<string, number>();
	/** The lists being watched, told of a change made here so they show it before the next poll. */
	const listWatchers = new Set<(change: { readonly record: SessionRecord } | { readonly removed: string }) => void>();
	/** Sessions deleted here: a poll that was already under way doesn't bring them back. */
	const removed = new Set<string>();
	const count = (counts: Map<string, number>, sessionId: string, by: 1 | -1) => {
		const next = (counts.get(sessionId) ?? 0) + by;
		if (next > 0) counts.set(sessionId, next);
		else counts.delete(sessionId);
	};

	const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers(init.headers);
		for (const [name, value] of Object.entries(options.headers?.() ?? {})) headers.set(name, value);
		let response: Response;
		try {
			response = await doFetch(path, { ...init, headers });
		} catch (reason) {
			if (init.signal?.aborted) throw reason;
			throw new ApiError("unavailable", "Can't reach Kantel. Check your connection.");
		}
		if (!response.ok) {
			if (response.status === 401) options.onUnauthenticated?.();
			throw await errorOf(response);
		}
		return response;
	};
	const getJson = async <T>(path: string, signal?: AbortSignal): Promise<T> =>
		(await (await call(path, signal === undefined ? {} : { signal })).json()) as T;
	const post = async (path: string, body: unknown, requestId?: string): Promise<void> => {
		await call(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(requestId === undefined ? {} : { "kantel-request-id": requestId }),
			},
			body: JSON.stringify(body),
		});
	};

	/** One page of the sessions matching `filter`, newest first. */
	const sessionsPage = async (
		filter: Record<string, string>,
		cursor: string | undefined,
		limit: number,
	): Promise<Page<SessionRecord>> => {
		const query = new URLSearchParams({ ...filter, limit: String(limit) });
		if (cursor !== undefined) query.set("cursor", cursor);
		const sent = await getJson<Page<ApiSessionRecord>>(`${base}/sessions?${query}`);
		const page = { ...sent, items: sent.items.map(consoleRecord) };
		for (const record of page.items) {
			projectOfSession.set(record.id, record.projectId);
			records.set(record.id, record);
		}
		return page;
	};

	// A session the console was loaded on: its stream, opened before its screen (`preconnect`), until the screen's first
	// connection takes it over, and the first paint the rest of the boot waits for.
	let early: EarlyStream | undefined;
	let preconnected = false;
	let paint: Promise<void> = Promise.resolve();

	const preconnect = (sessionId: string): void => {
		// Once, at boot: later screens connect as they always have.
		if (preconnected || !socketAllowed() || openSocket === undefined || origin === undefined) return;
		preconnected = true;
		let settle: () => void = () => {};
		paint = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const wait = setTimeout(() => settle(), FIRST_PAINT_MS);
		const painted = () => {
			clearTimeout(wait);
			settle();
		};
		const held: EarlyStream = {
			sessionId,
			frames: [],
			watch: { close() {} },
			// A stream nobody claims (the console went elsewhere first) closes rather than stay open.
			unclaimed: setTimeout(() => {
				if (early !== held) return;
				early = undefined;
				held.watch.close();
				painted();
			}, UNCLAIMED_MS),
		};
		const watch = watchOverSocket(openSocket, socketUrl(sessionUrl(sessionId, "/events"), origin), {
			receive(frame) {
				if (frame.type === "snapshot" || frame.type === "error") painted();
				if (held.handlers === undefined) held.frames.push(frame);
				else held.handlers.receive(frame);
			},
			opened(extensions) {
				if (held.handlers === undefined) held.extensions = extensions;
				else held.handlers.opened?.(extensions);
			},
			failed() {
				painted();
				if (held.handlers !== undefined) return held.handlers.failed();
				held.ended = true;
				socketsWork = false;
			},
			lost() {
				painted();
				if (held.handlers !== undefined) return held.handlers.lost();
				held.ended = true;
			},
		});
		// Closed before its snapshot (the screen left, or resumed from its cache instead), nothing waits for it.
		held.watch = {
			close() {
				watch.close();
				painted();
			},
		};
		early = held;
	};

	/** The sessions matching `filter` from `cursor` on, following the API's pages in the largest it serves. */
	const restOfSessions = async (filter: Record<string, string>, from: string | undefined): Promise<SessionRecord[]> => {
		// The rest of a long list is read after the session the console opened on has shown: each page reads every
		// session on the API, ahead of the session's stream.
		await paint;
		const listed: SessionRecord[] = [];
		let cursor = from;
		while (cursor !== undefined) {
			const page = await sessionsPage(filter, cursor, LIST_PAGE_MAX);
			listed.push(...page.items);
			cursor = page.nextCursor;
		}
		return listed;
	};

	/** Every project the caller can see (`GET /v1/projects`), following the pages. */
	const listProjects = async (): Promise<Project[]> => {
		const projects: Project[] = [];
		let cursor: string | undefined;
		do {
			const query = new URLSearchParams({ limit: String(LIST_LIMIT) });
			if (cursor !== undefined) query.set("cursor", cursor);
			const page = await getJson<Page<Project>>(`${base}/projects?${query}`);
			projects.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return projects;
	};

	/** Every agent profile the caller can see (`GET /v1/profiles`), following the pages. */
	const listProfiles = async (signal?: AbortSignal): Promise<AgentProfile[]> => {
		const profiles: AgentProfile[] = [];
		let cursor: string | undefined;
		do {
			const query = new URLSearchParams({ limit: String(LIST_LIMIT) });
			if (cursor !== undefined) query.set("cursor", cursor);
			const page = await getJson<Page<AgentProfile>>(`${base}/profiles?${query}`, signal);
			profiles.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return profiles;
	};

	const isUnread = (record: SessionRecord, firstListing: boolean): boolean => {
		latest.set(record.id, record.updatedAt);
		if (open.has(record.id)) seen.set(record.id, record.updatedAt);
		else if (!seen.has(record.id)) seen.set(record.id, firstListing ? record.updatedAt : record.createdAt);
		if (leaving.has(record.id)) return false;
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
			// The runtime moves a record's updatedAt only when its status changes, so a running one's is when its run started.
			...(record.status === "running" ? { workingSince: record.updatedAt } : {}),
			// Marked unread from the menu stays unread until it is next opened, even while it is on screen.
			...(unread || record.markedUnreadAt !== undefined ? { unread: true } : {}),
			...(record.pinnedAt === undefined ? {} : { pinned: true }),
			...(record.archivedAt === undefined ? {} : { archived: true }),
		};
	};

	/** A workspace through the read API's GET routes; there is nothing else to call. */
	const workspaceFiles = (id: string): WorkspaceFiles => {
		const url = (route: string, query: URLSearchParams) =>
			`${base}/workspaces/${encodeURIComponent(id)}/${route}?${query}`;
		return {
			id,
			async list(path, signal): Promise<WorkspaceListing> {
				const entries: WorkspaceEntry[] = [];
				let cursor: string | undefined;
				do {
					const query = new URLSearchParams({ limit: String(LIST_LIMIT) });
					if (path !== "") query.set("path", path);
					if (cursor !== undefined) query.set("cursor", cursor);
					let page: Page<WorkspaceEntry>;
					try {
						page = await getJson<Page<WorkspaceEntry>>(url("files", query), signal);
					} catch (reason) {
						// A session's own workspace exists once its first tool call makes it; until then it is empty.
						if (path === "" && cursor === undefined && reason instanceof ApiError && reason.code === "not_found") {
							return { entries: [], truncated: false };
						}
						throw reason;
					}
					entries.push(...page.items);
					cursor = page.nextCursor;
				} while (cursor !== undefined && entries.length < DIRECTORY_CAP);
				return { entries, truncated: cursor !== undefined };
			},
			async read(path, signal) {
				const response = await call(
					url("content", new URLSearchParams({ path })),
					signal === undefined ? {} : { signal },
				);
				const content = new Uint8Array(await response.arrayBuffer());
				let version: number | string = "";
				try {
					version = JSON.parse(response.headers.get("kantel-version") ?? '""') as number | string;
				} catch {
					// Not the read API's header; the version is only shown.
				}
				const digest = (response.headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "");
				return {
					content,
					version,
					contentType: response.headers.get("content-type") ?? "application/octet-stream",
					...(digest === "" ? {} : { digest }),
				};
			},
			async write(path, content, ifMatch): Promise<WrittenFile> {
				const response = await call(url("content", new URLSearchParams({ path })), {
					method: "PUT",
					headers: {
						"content-type": "text/markdown; charset=utf-8",
						...(ifMatch === undefined ? {} : { "if-match": `"${ifMatch}"` }),
					},
					body: content,
				});
				const written = (await response.json()) as { version: number; digest?: string | null };
				return {
					version: written.version,
					...(typeof written.digest === "string" ? { digest: written.digest } : {}),
				};
			},
			shares: workspaceShares(id),
		};
	};

	/** A workspace's shares over the shares API. */
	const workspaceShares = (id: string): WorkspaceShares => {
		const send = async (path: string, method: string, body?: unknown): Promise<FileShareRecord> =>
			(await (
				await call(path, {
					method,
					...(body === undefined
						? {}
						: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
				})
			).json()) as FileShareRecord;
		const ofWorkspace = `${base}/workspaces/${encodeURIComponent(id)}/shares`;
		const share = (shareId: string, rest = "") => `${base}/shares/${encodeURIComponent(shareId)}${rest}`;
		return {
			async find(path, signal) {
				const page = await getJson<{ items: FileShareRecord[] }>(
					`${ofWorkspace}?${new URLSearchParams({ path })}`,
					signal,
				);
				return page.items[0];
			},
			share: (path, title) => send(ofWorkspace, "POST", { path, ...(title === undefined ? {} : { title }) }),
			setAccess: (shareId, access) => send(share(shareId), "PATCH", { access }),
			invite: (shareId, email) => send(share(shareId, "/invites"), "POST", { email }),
			uninvite: (shareId, email) => send(share(shareId, "/invites/remove"), "POST", { email }),
			link: (record) => new URL(`/shared/${record.token}`, globalThis.location?.href ?? "https://kantel.invalid").href,
		};
	};

	const send = (sessionId: string, action: string, text: string, sendOptions?: SendOptions) =>
		post(
			sessionUrl(sessionId, `/${action}`),
			{
				text,
				...(sendOptions?.requestId === undefined ? {} : { requestId: sendOptions.requestId }),
				...(sendOptions?.model === undefined ? {} : { model: sendOptions.model }),
				...(sendOptions?.thinking === undefined ? {} : { thinking: sendOptions.thinking }),
				...(sendOptions?.attachments === undefined || sendOptions.attachments.length === 0
					? {}
					: { attachments: sendOptions.attachments }),
			},
			sendOptions?.requestId,
		);

	/** `PATCH /v1/sessions/:id`; the lists being watched show the record it answers at once. */
	const updateSession = async (sessionId: string, change: SessionChange): Promise<void> => {
		const response = await call(sessionUrl(sessionId), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(change),
		});
		const record = consoleRecord((await response.json()) as ApiSessionRecord);
		records.set(record.id, record);
		// Marked read: whatever it has done so far has been seen.
		if (change.unread === false) seen.set(record.id, Math.max(seen.get(record.id) ?? 0, record.updatedAt));
		for (const watcher of listWatchers) watcher({ record });
	};

	return {
		actor: options.actor ?? SIGNED_IN,

		async projects(): Promise<readonly ProjectSummary[]> {
			// The newest sessions are enough to order projects by activity: reading every session took seconds once there
			// were a thousand, all before the console could show anything.
			const [projects, { items: sessions }] = await Promise.all([
				listProjects(),
				sessionsPage({}, undefined, LIST_LIMIT),
			]);
			const recent = new Map<string, number>();
			for (const record of sessions) {
				recent.set(record.projectId, Math.max(recent.get(record.projectId) ?? 0, record.updatedAt));
			}
			// The most recently active project first, so the home page opens it; projects with no sessions by name.
			return [...projects]
				.sort(
					(a, b) =>
						(recent.get(b.id) ?? 0) - (recent.get(a.id) ?? 0) ||
						a.name.localeCompare(b.name) ||
						a.id.localeCompare(b.id),
				)
				.map((project) => ({ id: project.id, name: project.name }));
		},

		watchSessions(projectId, onChange) {
			let stopped = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let sessions: readonly SessionSummary[] = [];
			/** The project's sessions as last listed, newest first. */
			let listed: readonly SessionRecord[] = [];
			let polls = 0;
			/** Whether every page has been read since the list was first shown, so the first page alone keeps it current. */
			let complete = false;
			const filter = scopeParams(projectId);
			const show = (next: readonly SessionRecord[], firstListing: boolean) => {
				listed = removed.size === 0 ? next : next.filter((record) => !removed.has(record.id));
				// A subagent's session is reached from its card in the thread that started it, not listed beside it.
				sessions = listed
					.filter((record) => record.parentSessionId === undefined)
					.map((record) => summaryOf(record, firstListing));
				onChange({ sessions, loading: false });
			};
			const poll = async () => {
				try {
					const full = !complete || polls % LIST_FULL_EVERY === 0;
					polls += 1;
					const firstListing = !listedProjects.has(projectId);
					const first = await sessionsPage(filter, undefined, LIST_LIMIT);
					if (stopped) return;
					if (first.nextCursor === undefined) {
						show(first.items, firstListing);
						complete = true;
					} else if (full) {
						// The first page shows while the rest is read.
						if (listed.length === 0) show(first.items, firstListing);
						const rest = await restOfSessions(filter, first.nextCursor);
						if (stopped) return;
						show([...first.items, ...rest], firstListing);
						complete = true;
					} else {
						// Newest first, so a new session is on the first page; older rows stay as last read.
						const fresh = new Set(first.items.map((record) => record.id));
						show([...first.items, ...listed.filter((record) => !fresh.has(record.id))], firstListing);
					}
					listedProjects.add(projectId);
				} catch (reason) {
					if (stopped) return;
					// Keep what was listed; say why it may be out of date.
					onChange({ sessions, loading: false, error: reason instanceof Error ? reason.message : String(reason) });
				}
				if (!stopped) timer = setTimeout(poll, pollMs);
			};
			// A change made from this console shows at once, in place, rather than at the next poll.
			const changed = (change: { readonly record: SessionRecord } | { readonly removed: string }) => {
				if ("removed" in change) show(listed, false);
				else if (listed.some((record) => record.id === change.record.id)) {
					show(
						listed.map((record) => (record.id === change.record.id ? change.record : record)),
						false,
					);
				}
			};
			listWatchers.add(changed);
			void poll();
			return () => {
				stopped = true;
				listWatchers.delete(changed);
				clearTimeout(timer);
			};
		},

		preconnect,

		firstPaint: () => paint,

		transport(sessionId): Transport {
			return {
				connect(receive, lost) {
					const controller = new AbortController();
					let closed = false;
					let socket: { close(): void } | undefined;
					const stream = (after: string | undefined) => {
						const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
						const handlers: SocketHandlers = {
							receive: (frame) => {
								if (!closed) receive(frame);
							},
							opened: (extensions) => options.onTransport?.(sessionId, { kind: "websocket", extensions }),
							// No socket here: read the event stream now, and from now on.
							failed: () => {
								socket = undefined;
								if (closed) return;
								socketsWork = false;
								void events(query);
							},
							lost: () => {
								socket = undefined;
								if (!closed) lost?.();
							},
						};
						// The stream opened ahead of this screen takes the place of a new one when the screen has nothing to
						// resume from; one for another session, or a screen resuming from its cache, closes it.
						const held = early;
						if (held !== undefined) {
							early = undefined;
							clearTimeout(held.unclaimed);
							if (held.sessionId === sessionId && after === undefined && held.ended === undefined) {
								socket = held.watch;
								held.handlers = handlers;
								if (held.extensions !== undefined) handlers.opened?.(held.extensions);
								for (const frame of held.frames.splice(0)) handlers.receive(frame);
								return;
							}
							held.watch.close();
						}
						if (!socketAllowed() || openSocket === undefined || origin === undefined) return void events(query);
						socket = watchOverSocket(openSocket, socketUrl(sessionUrl(sessionId, `/events${query}`), origin), handlers);
					};
					const events = async (query: string) => {
						options.onTransport?.(sessionId, { kind: "sse" });
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
					// The page before an item the client holds. Anchored on the item, so new turns don't shift it.
					const history = async (before: string, limit: number) => {
						const params = new URLSearchParams({ before, limit: String(limit) });
						try {
							const page = await getJson<SessionHistoryPage>(
								sessionUrl(sessionId, `/history?${params}`),
								controller.signal,
							);
							if (!closed) receive({ type: "history", page: protocolHistoryPage(page) });
						} catch (reason) {
							if (closed) return;
							const message = reason instanceof Error ? reason.message : String(reason);
							receive({ type: "error", code: HISTORY_ERROR, message });
						}
					};
					return {
						send(frame) {
							if (closed) return;
							if (frame.type === "hello") void stream(frame.after);
							else void history(frame.before, frame.limit);
						},
						close() {
							closed = true;
							controller.abort();
							socket?.close();
						},
					};
				},
			};
		},

		async projectOf(sessionId) {
			const known = projectOfSession.get(sessionId);
			if (known !== undefined) return known;
			return (await recordOf(sessionId))?.projectId;
		},

		async parentOf(sessionId, signal) {
			const parentId = (await recordOf(sessionId, signal))?.parentSessionId;
			if (parentId === undefined) return undefined;
			const parent = await recordOf(parentId, signal);
			return parent === undefined ? undefined : { id: parent.id, title: parent.title ?? "Untitled session" };
		},

		async subagentOf(sessionId, callId, signal) {
			const query = new URLSearchParams({
				parentSessionId: sessionId,
				[`label.${SUBAGENT_CALL_LABEL}`]: callId,
				limit: "1",
			});
			const page = await getJson<Page<ApiSessionRecord>>(`${base}/sessions?${query}`, signal);
			const sent = page.items[0];
			if (sent === undefined) return undefined;
			const child = consoleRecord(sent);
			records.set(child.id, child);
			projectOfSession.set(child.id, child.projectId);
			return child.id;
		},

		mayStart: (projectId) => startAccess(options.roles, projectId),

		async startOptions(projectId, signal): Promise<StartOptions> {
			const agent = agentFor(await listProfiles(signal), projectId);
			if (agent === undefined) {
				throw new ApiError(
					"not_found",
					projectId === ORGANISATION_SCOPE
						? "No agent runs organisation-wide yet. An admin needs to add one with no project."
						: "No agent can run in this project yet. An admin needs to add one.",
				);
			}
			return { agentId: agent.id, agentName: agent.name };
		},

		branches: (projectId, repo, signal) =>
			getJson<RepositoryBranches>(`${base}/git/branches?${new URLSearchParams({ projectId, repo })}`, signal),

		organisationSessions: true,

		async create({ repository, projectId, ...input }) {
			// An organisation session starts on no repository: a seeded workspace is a project's.
			if (repository !== undefined && projectId === ORGANISATION_SCOPE) {
				throw new ApiError("invalid", "An organisation session can't start from a repository yet");
			}
			let workspaceId: string | undefined;
			if (repository !== undefined) {
				const seeded = await call(`${base}/workspaces`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						projectId,
						seed: {
							name: repository.repo,
							sources: [{ kind: "git", repo: repository.repo, ref: repository.branch }],
						},
					}),
				});
				workspaceId = ((await seeded.json()) as { id: string }).id;
			}
			const response = await call(`${base}/sessions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...input,
					...scopeParams(projectId),
					...(workspaceId === undefined ? {} : { workspaceId }),
					...(repository === undefined ? {} : { labels: { repo: repository.repo, branch: repository.branch } }),
				}),
			});
			const record = consoleRecord((await response.json()) as ApiSessionRecord);
			projectOfSession.set(record.id, record.projectId);
			// Known at once, so the new session's lineage (none) is too, and the list shows it working without a request.
			records.set(record.id, record);
			return record.id;
		},

		control: (): SessionControl => ({ live: true }),

		async modelChoices(target, signal): Promise<ModelChoices> {
			const path =
				"sessionId" in target
					? sessionUrl(target.sessionId, "/models")
					: `${base}/profiles/${encodeURIComponent(target.start.agentId)}/models?${new URLSearchParams(scopeParams(target.start.projectId))}`;
			return modelChoicesOf(await getJson<SessionModelState>(path, signal));
		},

		// A file for a message: its bytes as the body, stored under the project (`POST /v1/attachments`).
		async uploadAttachment(projectId, file, signal) {
			const query = new URLSearchParams({ ...scopeParams(projectId), name: file.name });
			const response = await call(`${base}/attachments?${query}`, {
				method: "POST",
				headers: { "content-type": file.type === "" ? "application/octet-stream" : file.type },
				body: file,
				...(signal === undefined ? {} : { signal }),
			});
			return (await response.json()) as UserAttachment;
		},

		// And back, for its thumbnail and the file panel (`GET /v1/attachments/:id`).
		async readAttachment(projectId, attachmentId, signal) {
			const response = await call(
				`${base}/attachments/${encodeURIComponent(attachmentId)}?${new URLSearchParams({ projectId })}`,
				signal === undefined ? {} : { signal },
			);
			return {
				content: new Uint8Array(await response.arrayBuffer()),
				contentType: response.headers.get("content-type") ?? "application/octet-stream",
			};
		},

		prompt: (sessionId, text, sendOptions) => send(sessionId, "prompt", text, sendOptions),
		steer: (sessionId, text, sendOptions) => send(sessionId, "steer", text, sendOptions),
		followUp: (sessionId, text, sendOptions) => send(sessionId, "follow-up", text, sendOptions),
		cancel: (sessionId) => post(sessionUrl(sessionId, "/abort"), {}),
		warm: async (sessionId) => {
			await call(sessionUrl(sessionId, "/warm"), { method: "POST" });
		},
		decideBrowser: (sessionId, callId, allow) => post(`${base}/browser/decisions`, { sessionId, callId, allow }),

		async browserReplay(sessionId, browserSessionId, signal) {
			const response = await call(`${base}/browser/replay`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, browserSessionId }),
				...(signal === undefined ? {} : { signal }),
			});
			const link = (await response.json()) as { url?: unknown; expiresAt?: unknown };
			if (typeof link.url !== "string") throw new ApiError("unavailable", "Kantel sent no replay link");
			return {
				kind: "embed",
				url: link.url,
				...(typeof link.expiresAt === "number" ? { expiresAt: link.expiresAt } : {}),
			};
		},

		async browserLive(sessionId, browserSessionId, signal) {
			const response = await call(`${base}/browser/live`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, browserSessionId }),
				...(signal === undefined ? {} : { signal }),
			});
			const link = (await response.json()) as {
				kind?: unknown;
				url?: unknown;
				endMessage?: unknown;
				expiresAt?: unknown;
			};
			// A kind this console doesn't know is no live view, rather than a guess at how to play it.
			if ((link.kind ?? "embed") !== "embed" || typeof link.url !== "string") {
				throw new ApiError("unavailable", "Kantel sent no live view this console can show");
			}
			return {
				kind: "embed",
				url: link.url,
				...(typeof link.endMessage === "string" ? { endMessage: link.endMessage } : {}),
				...(typeof link.expiresAt === "number" ? { expiresAt: link.expiresAt } : {}),
			};
		},

		async fork(sessionId, itemId) {
			const response = await call(sessionUrl(sessionId, "/fork"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ itemId }),
			});
			const record = consoleRecord((await response.json()) as ApiSessionRecord);
			projectOfSession.set(record.id, record.projectId);
			return record.id;
		},

		edit: (sessionId, itemId, text, sendOptions) =>
			post(
				sessionUrl(sessionId, "/edit"),
				{
					itemId,
					text,
					...(sendOptions?.requestId === undefined ? {} : { requestId: sendOptions.requestId }),
					...(sendOptions?.model === undefined ? {} : { model: sendOptions.model }),
					...(sendOptions?.thinking === undefined ? {} : { thinking: sendOptions.thinking }),
				},
				sendOptions?.requestId,
			),

		updateSession,

		async deleteSession(sessionId) {
			await call(sessionUrl(sessionId), { method: "DELETE" });
			removed.add(sessionId);
			records.delete(sessionId);
			for (const watcher of listWatchers) watcher({ removed: sessionId });
		},

		markRead(sessionId) {
			// Opening a session marked unread clears the mark, for everyone.
			if (records.get(sessionId)?.markedUnreadAt !== undefined) {
				updateSession(sessionId, { unread: false }).catch(() => {});
			}
			count(open, sessionId, 1);
			const markSeen = (updatedAt: number | undefined) => {
				if (updatedAt !== undefined) seen.set(sessionId, Math.max(seen.get(sessionId) ?? 0, updatedAt));
			};
			markSeen(latest.get(sessionId));
			let released = false;
			return () => {
				if (released) return;
				released = true;
				count(open, sessionId, -1);
				markSeen(latest.get(sessionId));
				// It was on screen until now, so whatever it did meanwhile has been seen, though the list may not have
				// caught up. The session's own updatedAt, read now, is the mark; anything after it is unread.
				count(leaving, sessionId, 1);
				getJson<ApiSessionRecord>(sessionUrl(sessionId))
					.then((record) => markSeen(record.updatedAt))
					.catch(() => {})
					.finally(() => count(leaving, sessionId, -1));
			};
		},

		async workspace(sessionId) {
			const record = await getJson<ApiSessionRecord>(sessionUrl(sessionId));
			return record.workspaceId === undefined ? undefined : workspaceFiles(record.workspaceId);
		},
	};
}
