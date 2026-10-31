/**
 * What the session runtime keeps outside Pi Durable: the directory of sessions, agent profiles, submissions, host
 * registrations and the tool-server tools each session was first offered (its pins). Each session's transcript lives in its own Pi Durable storage; this store is the index over them, so
 * a runtime that restarts finds every session, its profile and its host tools again.
 *
 * `createMemorySessionStore` keeps it in maps; `createSqlSessionStore` (`@harbour/runtime/sql`) keeps it in any
 * SQLite-dialect database behind chord's `SqliteDatabase` facade (Node's SQLite, a Durable Object's SQLite, Postgres
 * through the self-hosted target's translation).
 */
import type {
	AgentId,
	AgentProfile,
	HostToolDefinition,
	OrganisationId,
	ProjectId,
	SessionFilter,
	SessionId,
	SessionRecord,
	Submission,
	ToolServerId,
	ToolServerTool,
} from "@harbour/contracts";

/** One session as the runtime stores it. */
export interface StoredSession {
	readonly record: SessionRecord;
	/** The profile as it was when the session was created: editing a profile does not change a running session. */
	readonly profile: AgentProfile;
	/** Creation order, unique within the store; it breaks ties between sessions created in the same millisecond. */
	readonly sequence: number;
	/** How many times the session has been aborted or closed, so audit and teardown IDs stay unique across restarts. */
	readonly aborts: number;
	/** Closed for good; later input is refused. */
	readonly closed: boolean;
	/**
	 * When the session next needs a process to run its work (epoch ms; anything not after now means right away), absent
	 * when it needs none. Set before input is admitted and kept to what its Harness says (`Harness.wake()`), so a
	 * process that starts finds every session a dead one left mid-run, and every sleep that falls due.
	 */
	readonly wakeAt?: number;
}

export interface StoredSubmission {
	readonly submission: Submission;
	/** Pi Durable's submission ID in the session's storage. */
	readonly piSubmissionId: number;
}

/** Where a durable host registration calls back to. */
export interface HostCallback {
	readonly url: string;
	/** The HMAC secret every callback is signed with. */
	readonly secret: string;
}

/** A host's tool registration. One per host in an organisation; a new registration replaces the last. */
export interface StoredHost {
	readonly organisationId: OrganisationId;
	readonly hostId: string;
	/** The project the host registered for; absent when it registered across the organisation. */
	readonly projectId?: ProjectId;
	readonly tools: readonly HostToolDefinition[];
	/** Names this registration, so a stale subscription cannot remove its replacement. */
	readonly registration: string;
	/** Who registered it (an actor key), for hosts that may be removed only by whoever registered them. */
	readonly owner?: string;
	/** Absent for a handler served in this process; such a registration ends with the process. */
	readonly callback?: HostCallback;
}

/**
 * The tools a session was first offered from one tool server, as the server listed them then. A session keeps them for
 * good, so a changed `tools/list` reaches new sessions only and a session's tool list never changes under it.
 */
export interface ToolServerPin {
	readonly toolServerId: ToolServerId;
	/** The server's name when pinned: the `<server>` of the tools' model names. */
	readonly name: string;
	/** The pinned snapshot's hash. */
	readonly hash: string;
	readonly tools: readonly ToolServerTool[];
	readonly pinnedAt: number;
}

/** The store's filter: everything in `SessionFilter` but status and labels, which the runtime applies itself. */
export type StoredSessionFilter = Pick<SessionFilter, "projectId" | "agentId" | "parentSessionId">;

export interface SessionStore {
	profile(organisationId: OrganisationId, agentId: AgentId): Promise<AgentProfile | undefined>;
	/** Every profile in the organisation, by ID. */
	profiles(organisationId: OrganisationId): Promise<readonly AgentProfile[]>;
	putProfile(profile: AgentProfile): Promise<void>;

	session(sessionId: SessionId): Promise<StoredSession | undefined>;
	/** Sessions in the organisation that pass the filter, newest first (creation time, then sequence). */
	sessions(organisationId: OrganisationId, filter?: StoredSessionFilter): Promise<readonly StoredSession[]>;
	/** Adds a session, giving it the next sequence number. */
	createSession(session: Omit<StoredSession, "sequence">): Promise<StoredSession>;
	updateSession(
		sessionId: SessionId,
		change: Partial<Pick<StoredSession, "record" | "aborts" | "closed">>,
	): Promise<void>;
	/** Sessions not closed, oldest first. */
	openSessions(): Promise<readonly StoredSession[]>;
	/** Sets (or, with `undefined`, clears) when the session next needs a process. */
	setWake(sessionId: SessionId, at: number | undefined): Promise<void>;
	/** Sessions not closed whose wake is at or before `before`, earliest first. */
	wakeable(before: number): Promise<readonly StoredSession[]>;
	/** The earliest wake after `after` of any session not closed. */
	nextWake(after: number): Promise<number | undefined>;

	submission(sessionId: SessionId, submissionId: string): Promise<StoredSubmission | undefined>;
	/** Adds a submission; one already stored under its ID is kept. */
	putSubmission(submission: StoredSubmission): Promise<void>;

	host(organisationId: OrganisationId, hostId: string): Promise<StoredHost | undefined>;
	/** Replaces the host's registration. */
	putHost(host: StoredHost): Promise<void>;
	/** Removes the host's registration if it is still `registration`; says whether it did. */
	deleteHost(organisationId: OrganisationId, hostId: string, registration: string): Promise<boolean>;
	/** Every durable registration (those with a callback), for a restarted runtime. */
	hosts(): Promise<readonly StoredHost[]>;

	/** The session's tool-server pins, by server ID. */
	toolPins(sessionId: SessionId): Promise<readonly ToolServerPin[]>;
	/** Stores the session's pin for its server. The first pin for a server wins: a later one is ignored. */
	putToolPin(sessionId: SessionId, pin: ToolServerPin): Promise<void>;
}

const keyOf = (organisationId: OrganisationId, id: string) => `${organisationId}\u0000${id}`;

const byId = (left: { readonly id: string }, right: { readonly id: string }) =>
	left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/** Newest first: creation time, then sequence. */
export const newestFirst = (left: StoredSession, right: StoredSession) =>
	right.record.createdAt - left.record.createdAt || right.sequence - left.sequence;

function passes(session: StoredSession, filter: StoredSessionFilter | undefined): boolean {
	const { record } = session;
	if (filter?.projectId !== undefined && record.projectId !== filter.projectId) return false;
	if (filter?.agentId !== undefined && record.agentId !== filter.agentId) return false;
	if (filter?.parentSessionId !== undefined && record.parentSessionId !== filter.parentSessionId) return false;
	return true;
}

/** The store in maps, for the in-memory runtime and tests. Values are kept as given; callers treat them as immutable. */
export function createMemorySessionStore(): SessionStore {
	const profiles = new Map<string, AgentProfile>();
	const sessions = new Map<SessionId, StoredSession>();
	const submissions = new Map<string, StoredSubmission>();
	const hosts = new Map<string, StoredHost>();
	const toolPins = new Map<SessionId, Map<ToolServerId, ToolServerPin>>();
	let sequence = 0;

	return {
		async profile(organisationId, agentId) {
			return profiles.get(keyOf(organisationId, agentId));
		},
		async profiles(organisationId) {
			return [...profiles.values()].filter((profile) => profile.organisationId === organisationId).sort(byId);
		},
		async putProfile(profile) {
			profiles.set(keyOf(profile.organisationId, profile.id), profile);
		},
		async session(sessionId) {
			return sessions.get(sessionId);
		},
		async sessions(organisationId, filter) {
			return [...sessions.values()]
				.filter((session) => session.record.organisationId === organisationId && passes(session, filter))
				.sort(newestFirst);
		},
		async createSession(session) {
			if (sessions.has(session.record.id)) throw new Error(`Session ${session.record.id} is already stored`);
			sequence += 1;
			const stored: StoredSession = { ...session, sequence };
			sessions.set(session.record.id, stored);
			return stored;
		},
		async updateSession(sessionId, change) {
			const current = sessions.get(sessionId);
			if (current === undefined) throw new Error(`Session ${sessionId} is not stored`);
			sessions.set(sessionId, { ...current, ...change });
		},
		async openSessions() {
			return [...sessions.values()].filter((session) => !session.closed).sort((l, r) => l.sequence - r.sequence);
		},
		async setWake(sessionId, at) {
			const current = sessions.get(sessionId);
			if (current === undefined) throw new Error(`Session ${sessionId} is not stored`);
			const { wakeAt: _previous, ...rest } = current;
			sessions.set(sessionId, at === undefined ? rest : { ...rest, wakeAt: at });
		},
		async wakeable(before) {
			return [...sessions.values()]
				.filter((session) => !session.closed && session.wakeAt !== undefined && session.wakeAt <= before)
				.sort((l, r) => (l.wakeAt as number) - (r.wakeAt as number) || l.sequence - r.sequence);
		},
		async nextWake(after) {
			let next: number | undefined;
			for (const session of sessions.values()) {
				if (session.closed || session.wakeAt === undefined || session.wakeAt <= after) continue;
				if (next === undefined || session.wakeAt < next) next = session.wakeAt;
			}
			return next;
		},
		async submission(sessionId, submissionId) {
			const stored = submissions.get(submissionId);
			return stored?.submission.sessionId === sessionId ? stored : undefined;
		},
		async putSubmission(submission) {
			if (!submissions.has(submission.submission.id)) submissions.set(submission.submission.id, submission);
		},
		async host(organisationId, hostId) {
			return hosts.get(keyOf(organisationId, hostId));
		},
		async putHost(host) {
			hosts.set(keyOf(host.organisationId, host.hostId), host);
		},
		async deleteHost(organisationId, hostId, registration) {
			const key = keyOf(organisationId, hostId);
			if (hosts.get(key)?.registration !== registration) return false;
			hosts.delete(key);
			return true;
		},
		async hosts() {
			return [...hosts.values()].filter((host) => host.callback !== undefined);
		},
		async toolPins(sessionId) {
			return [...(toolPins.get(sessionId)?.values() ?? [])].sort((left, right) =>
				left.toolServerId < right.toolServerId ? -1 : left.toolServerId > right.toolServerId ? 1 : 0,
			);
		},
		async putToolPin(sessionId, pin) {
			let pins = toolPins.get(sessionId);
			if (pins === undefined) {
				pins = new Map();
				toolPins.set(sessionId, pins);
			}
			if (!pins.has(pin.toolServerId)) pins.set(pin.toolServerId, pin);
		},
	};
}
