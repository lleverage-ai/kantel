/**
 * Audit events. Components never write to the audit store directly: each emits events through an outbox to an
 * `AuditSink`, which is idempotent by event id so outbox retries never duplicate a row. Event data never holds a
 * secret value.
 */
import type {
	Actor,
	AgentId,
	CallContext,
	JsonValue,
	OrganisationId,
	Page,
	PageRequest,
	ProjectId,
	SessionId,
	Timestamp,
} from "./common.ts";

export type AuditSource =
	| "session"
	| "sandbox"
	| "workspace"
	| "vault"
	| "browser"
	| "identity"
	| "schedules"
	| "capability"
	| "skills"
	| "memory"
	| "control";

/**
 * Well-known event types. Components may add their own `<source>.<noun>.<verb>` types; these are the ones other
 * streams rely on.
 */
export type KnownAuditEventType =
	| "session.created"
	| "session.prompted"
	| "session.steered"
	| "session.aborted"
	| "session.settled"
	| "session.tool.started"
	| "session.tool.finished"
	| "sandbox.lease.acquired"
	| "sandbox.lease.released"
	| "sandbox.escalated"
	| "workspace.committed"
	| "workspace.write.refused"
	| "vault.item.created"
	| "vault.policy.created"
	| "vault.policy.revoked"
	| "vault.proposal.created"
	| "vault.decision.approved"
	| "vault.decision.denied"
	| "vault.binding_code.mismatch"
	| "vault.grant.revoked"
	| "vault.use.injected"
	| "vault.use.denied"
	| "browser.grant.created"
	| "browser.grant.refused"
	| "browser.session.opened"
	| "browser.session.closed"
	| "identity.key.issued"
	| "identity.key.revoked"
	| "identity.role.granted"
	| "identity.role.revoked"
	| "capability.registered"
	| "capability.grant.created"
	| "capability.grant.revoked"
	| "capability.call.started"
	| "capability.call.settled"
	| "capability.call.refused"
	| "capability.call.resolved"
	| "skills.revision.published"
	| "memory.proposal.created"
	| "memory.proposal.applied"
	| "memory.proposal.rejected"
	| "schedules.schedule.created"
	| "schedules.finding.raised";

export type AuditEventType = KnownAuditEventType | (string & {});

export interface AuditEventInput {
	/** Stable idempotency key chosen by the source, such as `vault:decision:<id>`. Appending it twice keeps one row. */
	readonly id: string;
	readonly at: Timestamp;
	readonly source: AuditSource;
	readonly type: AuditEventType;
	readonly actor: Actor;
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly sessionId?: SessionId;
	readonly agentId?: AgentId;
	/** The record the event is about, such as `{ kind: "vault.proposal", id }`. */
	readonly subject?: { readonly kind: string; readonly id: string };
	/** Structured detail. Never a credential value. */
	readonly data?: { readonly [key: string]: JsonValue };
}

/** Where components send audit events. Implementations must be idempotent by `id`. */
export interface AuditSink {
	append(events: readonly AuditEventInput[]): Promise<void>;
}

/** A stored event: the input plus the store's own order. */
export interface AuditEvent extends AuditEventInput {
	/** Increases with every stored row, across the whole store; queries return rows in this order. */
	readonly seq: number;
	readonly recordedAt: Timestamp;
}

/** Every field narrows; absent fields match anything. The organisation always comes from the call context. */
export interface AuditQuery {
	readonly projectId?: ProjectId;
	readonly sessionId?: SessionId;
	readonly agentId?: AgentId;
	/** Events by this actor, compared by kind and ID. */
	readonly actor?: Actor;
	readonly source?: AuditSource;
	/** An exact type, or a prefix ending in `.` (`vault.` matches every vault event). */
	readonly type?: string;
	readonly subject?: { readonly kind: string; readonly id: string };
	/** Inclusive lower bound on `at`. */
	readonly from?: Timestamp;
	/** Exclusive upper bound on `at`. */
	readonly to?: Timestamp;
	/** Newest first instead of oldest first. */
	readonly newestFirst?: boolean;
}

/**
 * The append-only audit store. Rows are never changed or deleted by anything but retention, and deleting a session or
 * any other record leaves its rows in place. Agents cannot query it (`forbidden`).
 */
export interface AuditStore extends AuditSink {
	query(ctx: CallContext, query: AuditQuery, page?: PageRequest): Promise<Page<AuditEvent>>;
	get(ctx: CallContext, eventId: string): Promise<AuditEvent>;
	/** How long an organisation's rows are kept. System and humans or services only. */
	setRetention(ctx: CallContext, retentionMs: number): Promise<void>;
	/** Removes rows older than each organisation's retention, as of the clock. Returns how many were removed. */
	applyRetention(): Promise<number>;
}

/**
 * An outbox: components write events into it inside their own transaction, and a relay drains it to the store with
 * retries. Draining twice never duplicates a row, because the store is idempotent by event id.
 */
export interface AuditOutbox extends AuditSink {
	/** Sends every pending event to `sink`; events stay pending if the sink throws. Returns how many were sent. */
	drain(sink: AuditSink): Promise<number>;
	pending(): Promise<number>;
}
