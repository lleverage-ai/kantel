/**
 * Sessions as the dormant libraries still name them: the record and directory that access checks, sandbox leases and
 * browser grants are scoped by, and the session-end hook their teardowns register with. The agent runtime that made
 * sessions, and its prompt, model, history and host-tool contracts, were removed in TASK-4721; they are on the
 * `agent-plane-archive` branch.
 */
import type {
	Actor,
	AgentId,
	CallContext,
	OrganisationId,
	Page,
	PageRequest,
	ProjectId,
	SessionId,
	Subscription,
	Timestamp,
	UserId,
	WorkspaceId,
} from "./common.ts";

/** Where a session's run is. */
export type SessionStatus = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled";

export type SessionScopeKind = "project" | "organisation";

export interface SessionRecord {
	readonly id: SessionId;
	readonly organisationId: OrganisationId;
	/**
	 * The project the session works in. Absent for an organisation-scoped session, whose agent reaches what the
	 * organisation owns and the session user's own, and no project's records (`scopeOf(record)`).
	 */
	readonly projectId?: ProjectId;
	readonly agentId: AgentId;
	/**
	 * The person the session works for: whose own skills and prompt rules it gets. The creator when that is a human;
	 * a service or Kantel may name another user; a child session has its parent's. It grants no role.
	 */
	readonly userId?: UserId;
	/** Started by a schedule, with no person watching (#335): the schedule and occurrence it runs for. */
	readonly unattended?: SessionUnattended;
	readonly parentSessionId?: SessionId;
	readonly workspaceId?: WorkspaceId;
	readonly title?: string;
	/**
	 * Who may see it (#335). `private`: only the person it acts for (`userId`), the service that made it and Kantel; no
	 * project or organisation member, an admin included. `shared` (absent): everyone with a role on its project or, for
	 * an organisation session, the organisation. A child has its parent's.
	 */
	readonly visibility?: SessionVisibility;
	readonly status: SessionStatus;
	/** Host labels, such as `{ ticket: "PROJ-12" }`. */
	readonly labels: { readonly [key: string]: string };
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
	/** Pinned to the top of the session list, and when. */
	readonly pinnedAt?: Timestamp;
	/** Archived, and when: out of the session list's default view, but still readable. */
	readonly archivedAt?: Timestamp;
	/** Someone marked the session unread, and when. */
	readonly markedUnreadAt?: Timestamp;
}

/** Who may see a session: only the person it acts for, or the project's (or organisation's) members too. */
export type SessionVisibility = "private" | "shared";

/** What started a session no person is watching (`SessionRecord.unattended`): a schedule's occurrence. */
export interface SessionUnattended {
	readonly scheduleId: string;
	readonly occurrenceId?: string;
}

/**
 * Why the session-end hook runs: `aborted` (the session stays usable, and later input starts a new run) or
 * `session_ended` (closed for good).
 */
export type SessionEndReason = "aborted" | "session_ended";

/** What the session-end hook tells each teardown. */
export interface SessionEnd {
	readonly sessionId: SessionId;
	readonly organisationId: OrganisationId;
	/** Absent for an organisation-scoped session. */
	readonly projectId?: ProjectId;
	readonly agentId: AgentId;
	readonly parentSessionId?: SessionId;
	readonly reason: SessionEndReason;
	/** Who closed or aborted the session (for a child, whoever aborted its parent). */
	readonly endedBy: Actor;
	readonly at: Timestamp;
}

/**
 * One component's teardown: it ends everything it holds for `end.sessionId`. `ctx` is a `system` context in the
 * session's organisation, so a teardown never fails a permission check. A teardown must be idempotent: when the session
 * holds nothing more in the component, it changes nothing and audits nothing.
 */
export type SessionTeardown = (ctx: CallContext, end: SessionEnd) => Promise<void>;

/**
 * One session-end hook, run when a session is closed and when it is aborted. Components register their teardown once,
 * at wiring time: the sandbox releases its leases, and the browser closes its browser sessions and ends its grants.
 *
 * Every registered teardown runs, in registration order, even when one before it fails. A failure is audited as
 * `session.teardown.failed` with the teardown's name and error code, never its message. Closing a closed session runs
 * nothing.
 */
export interface SessionEndHook {
	/** Adds a teardown under a unique name (`conflict` if the name is taken). Closing the subscription removes it. */
	register(name: string, teardown: SessionTeardown): Subscription;
}

export interface SessionFilter {
	readonly projectId?: ProjectId;
	/** Only organisation-scoped sessions, or only project ones. */
	readonly scope?: SessionScopeKind;
	readonly agentId?: AgentId;
	readonly status?: SessionStatus;
	readonly parentSessionId?: SessionId;
	/** The sessions that run in this workspace. */
	readonly workspaceId?: WorkspaceId;
	/** Every label given must match. */
	readonly labels?: { readonly [key: string]: string };
}

/** Where sessions are found: by organisation, project, agent, parent and labels. */
export interface SessionDirectory {
	get(ctx: CallContext, sessionId: SessionId): Promise<SessionRecord>;
	/** Newest first. Only sessions in `ctx.organisationId`. */
	list(ctx: CallContext, filter?: SessionFilter, page?: PageRequest): Promise<Page<SessionRecord>>;
	children(ctx: CallContext, sessionId: SessionId): Promise<readonly SessionRecord[]>;
}
