// The recorded-session client: a `ConsoleClient` with no backend, for building the console before the session API
// (M1-BE1) lands. Each recorded session gets a FixtureHost, the in-page stand-in for the session host that serves its
// frames over @kantel/protocol exactly as the host will (hello, snapshot or deltas after a cursor, history pages).
// The list follows every host's stream, so a session that finishes while you watch moves from Working to Done.
// Recorded sessions can't be steered: `control` says so, and the controls reject.

import {
	applyDelta,
	PROTOCOL_VERSION,
	type ServerFrame,
	type SessionSnapshot,
	type SessionStatus,
} from "@kantel/protocol";
import type { SessionSummary } from "@kantel/ui";
import { readRecordedAttachment } from "../recorded/attachments.ts";
import type { Catalogue, RecordedSession } from "../recorded/catalogue.ts";
import { recordedWorkspace } from "../recorded/workspace.ts";
import { FixtureHost, type HostOptions } from "../server-sim/fixture-host.ts";
import { needsOf } from "../state/needs.ts";
import type { Connection, Transport } from "../state/session-client.ts";
import type { ConsoleActor, ConsoleClient, SessionControl, SessionListState } from "./client.ts";
import { ApiError } from "./http.ts";

export const RECORDED_REASON = "This is a recorded session, so it can't be steered.";
/** Why New session is dimmed on recorded sessions: there is no host to start one on. */
export const RECORDED_START_REASON = "These are recorded sessions. Open the console on a Kantel to start one.";

/** Until identity (M1-BE7): everyone is the same stand-in person. */
export const STUB_ACTOR: ConsoleActor = { id: "user-stub", name: "Tom Davies", stubbed: true };

type Entry = {
	readonly recorded: RecordedSession;
	summary: SessionSummary;
	host?: FixtureHost;
	loading?: Promise<FixtureHost>;
	/** Opened at least once, so its live part has been started. */
	opened: boolean;
};

/**
 * The list's status for a protocol status. A finished run is `idle` in the protocol; the list shows it as done (an
 * emerald Done while unread), since `sessionStatus` keeps that for `done`.
 */
const listStatus = (status: SessionStatus): SessionStatus => (status === "idle" ? "done" : status);

export type RecordedClientOptions = HostOptions & {
	/** Opens a session's live part this long after it is first opened, so its snapshot shows first. */
	openDelayMs?: number;
	/** Called just before an opened session's live part starts playing; the profiler takes its baseline here. */
	onPlay?: (sessionId: string) => void;
	/** How long each read of a recorded workspace takes. Default 120 ms. */
	workspaceDelayMs?: number;
};

export type RecordedClient = ConsoleClient & {
	/** The stand-in host serving a session, once it has loaded; for the evidence script and tests. */
	hostFor(sessionId: string): FixtureHost | undefined;
	/** Stops every host's playback. */
	dispose(): void;
};

export function createRecordedClient(catalogue: Catalogue, options: RecordedClientOptions = {}): RecordedClient {
	const entries = new Map<string, Entry>();
	const listeners = new Map<string, Set<() => void>>();
	const timers: unknown[] = [];
	const setTimer = options.timers?.set ?? ((task: () => void, ms: number) => setTimeout(task, ms));
	const clearTimer = options.timers?.clear ?? ((handle: unknown) => clearTimeout(handle as number));
	const openDelay = options.openDelayMs ?? 600;
	/** Sessions on screen, which can't become unread, with how many screens show each. */
	const open = new Map<string, number>();
	/** Set by dispose: nothing pending may start playback or call back afterwards. */
	let disposed = false;

	const notify = (projectId: string) => {
		if (disposed) return;
		for (const listener of listeners.get(projectId) ?? []) listener();
	};

	const update = (entry: Entry, patch: Partial<SessionSummary>) => {
		const next = { ...entry.summary, ...patch };
		const same = (Object.keys(patch) as (keyof SessionSummary)[]).every((key) => entry.summary[key] === next[key]);
		if (same) return;
		entry.summary = next;
		notify(entry.recorded.projectId);
	};

	/** Follows a host's stream and keeps the session's summary up to date. */
	const follow = (entry: Entry, host: FixtureHost) => {
		let state: SessionSnapshot | undefined;
		let previous: SessionStatus | undefined;
		const connection = host.connect((frame: ServerFrame) => {
			if (frame.type === "snapshot") state = frame.snapshot;
			else if (frame.type === "delta" && state !== undefined) state = applyDelta(state, frame.delta);
			else return;
			if (state === undefined) return;
			const finished = previous === "running" && state.status !== "running";
			previous = state.status;
			const first = state.items[0];
			update(entry, {
				title: state.title ?? entry.summary.title,
				status: listStatus(state.status),
				needs: state.status === "waiting" ? needsOf(state.items) : undefined,
				updatedAt: state.updatedAt,
				startedAt: first?.at ?? entry.summary.startedAt,
				// Finishing while nobody has it open makes it unread; markRead clears it.
				unread: finished && !open.has(entry.recorded.id) ? true : entry.summary.unread,
			});
		});
		connection.send({ type: "hello", v: PROTOCOL_VERSION, sessionId: entry.recorded.id });
	};

	const load = (entry: Entry): Promise<FixtureHost> => {
		entry.loading ??= entry.recorded.frames().then((frames) => {
			const host = new FixtureHost(frames, options);
			entry.host = host;
			if (disposed) return host;
			follow(entry, host);
			if (entry.recorded.playOnLoad === true) host.play();
			return host;
		});
		return entry.loading;
	};

	for (const recorded of catalogue.sessions) {
		const preview = recorded.preview;
		const entry: Entry = {
			recorded,
			opened: false,
			summary: {
				id: recorded.id,
				title: preview?.title ?? "",
				status: "done",
				startedAt: preview?.startedAt ?? 0,
				updatedAt: preview?.updatedAt ?? 0,
				...(recorded.branch === undefined ? {} : { branch: recorded.branch }),
				...(recorded.unread === true ? { unread: true } : {}),
			},
		};
		entries.set(recorded.id, entry);
		// Sessions made in the page load now; fetched ones (with a preview) when first opened.
		if (preview === undefined) void load(entry);
	}

	const refuse = () => Promise.reject(new Error(RECORDED_REASON));

	const client: RecordedClient = {
		actor: STUB_ACTOR,
		projects: () => Promise.resolve(catalogue.projects),

		watchSessions(projectId, onChange) {
			const emit = () => {
				const sessions: SessionSummary[] = [];
				for (const entry of entries.values())
					if (entry.recorded.projectId === projectId && entry.summary.title !== "") sessions.push(entry.summary);
				const pending = [...entries.values()].some(
					(entry) => entry.recorded.projectId === projectId && entry.summary.title === "",
				);
				const state: SessionListState = { sessions, loading: pending && sessions.length === 0 };
				onChange(state);
			};
			let set = listeners.get(projectId);
			if (set === undefined) {
				set = new Set();
				listeners.set(projectId, set);
			}
			set.add(emit);
			let active = true;
			// Asynchronously, as a server would answer.
			queueMicrotask(() => {
				if (active && !disposed) emit();
			});
			return () => {
				active = false;
				set.delete(emit);
			};
		},

		projectOf: async (sessionId) => entries.get(sessionId)?.recorded.projectId,

		transport(sessionId): Transport {
			return {
				connect(receive) {
					const entry = entries.get(sessionId);
					let closed = false;
					let upstream: Connection | undefined;
					const queued: Parameters<Connection["send"]>[0][] = [];
					if (entry === undefined) {
						queueMicrotask(() => {
							if (!closed && !disposed)
								receive({ type: "error", code: "not_found", message: "There's no such session." });
						});
					} else {
						load(entry).then(
							(host) => {
								if (closed || disposed) return;
								upstream = host.connect((frame) => {
									if (!closed && !disposed) receive(frame);
								});
								for (const frame of queued.splice(0)) upstream.send(frame);
								if (!entry.opened) {
									entry.opened = true;
									// A recording with a live part that isn't playing yet starts once its snapshot is on screen.
									if (!host.finished)
										timers.push(
											setTimer(() => {
												options.onPlay?.(sessionId);
												host.play();
											}, openDelay),
										);
								}
							},
							(reason: unknown) => {
								if (!closed && !disposed) receive({ type: "error", code: "unavailable", message: String(reason) });
							},
						);
					}
					return {
						send(frame) {
							if (upstream === undefined) queued.push(frame);
							else upstream.send(frame);
						},
						close() {
							closed = true;
							upstream?.close();
						},
					};
				},
			};
		},

		control: (): SessionControl => ({ live: false, reason: RECORDED_REASON }),
		mayStart: () => ({ allowed: false, reason: RECORDED_START_REASON }),
		startOptions: () => Promise.reject(new Error(RECORDED_START_REASON)),
		create: () => Promise.reject(new Error(RECORDED_START_REASON)),
		prompt: refuse,
		steer: refuse,
		followUp: refuse,
		cancel: refuse,

		markRead(sessionId) {
			const entry = entries.get(sessionId);
			if (entry === undefined) return () => {};
			open.set(sessionId, (open.get(sessionId) ?? 0) + 1);
			update(entry, { unread: false });
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const count = (open.get(sessionId) ?? 1) - 1;
				if (count > 0) open.set(sessionId, count);
				else open.delete(sessionId);
			};
		},

		async workspace(sessionId) {
			const entry = entries.get(sessionId);
			if (entry === undefined) throw new ApiError("not_found", "There's no such session.");
			if (entry.recorded.noWorkspace === true) return undefined;
			return recordedWorkspace(`ws-${sessionId}`, {
				...(options.workspaceDelayMs === undefined ? {} : { delayMs: options.workspaceDelayMs }),
			});
		},

		// The recorded messages' files, drawn in the page (recorded/attachments.ts).
		readAttachment: (_projectId, attachmentId, signal) => readRecordedAttachment(attachmentId, signal),

		hostFor: (sessionId) => entries.get(sessionId)?.host,

		dispose() {
			disposed = true;
			for (const timer of timers) clearTimer(timer);
			for (const entry of entries.values()) entry.host?.pause();
		},
	};
	return client;
}
