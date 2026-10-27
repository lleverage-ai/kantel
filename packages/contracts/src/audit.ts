/**
 * Audit events. Components never write to the audit store directly: each emits events through an outbox to an
 * `AuditSink`, which is idempotent by event id so outbox retries never duplicate a row. Event data never holds a
 * secret value.
 */
import type { Actor, AgentId, JsonValue, OrganisationId, ProjectId, SessionId, Timestamp } from "./common.ts";

export type AuditSource =
	| "session"
	| "sandbox"
	| "workspace"
	| "vault"
	| "browser"
	| "identity"
	| "schedules"
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
	| "identity.role.revoked";

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
