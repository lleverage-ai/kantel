/**
 * Audit events. Components never write to the audit store directly: each emits events through an outbox to an
 * `AuditSink`, which is idempotent by organisation and event id so outbox retries never duplicate a row. Event data never holds a
 * secret value.
 *
 * Appending, draining, `pending` and retention are worker calls (settled question 13): each takes a `SystemContext` and
 * refuses any actor but `system` with `forbidden`, audited as `access.denied`, so no caller can write or erase a row.
 */
import {
	type Actor,
	type AgentId,
	type CallContext,
	HarbourError,
	type JsonValue,
	type OrganisationId,
	type Page,
	type PageRequest,
	type ProjectId,
	type SessionId,
	type SystemContext,
	type Timestamp,
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
	| "access"
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
	| "session.teardown.failed"
	| "access.denied"
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
	| "identity.user.linked"
	| "identity.session.started"
	| "identity.session.ended"
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
	| "memory.snapshot.imported"
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

/**
 * Where components send audit events. Implementations must be idempotent by `(organisationId, id)`. Components append
 * as themselves (`systemContext("vault")`), whoever made the call being audited; the event's `actor` names that caller.
 */
export interface AuditSink {
	append(ctx: SystemContext, events: readonly AuditEventInput[]): Promise<void>;
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
	/**
	 * Events about this vault item: its subject is the `vault.item`, or else `data.itemId` is this ID as a string (uses,
	 * requests, approvals and policies name the item they are for).
	 */
	readonly itemId?: string;
	/**
	 * Events about this vault grant: its subject is the `vault.grant`, or else `data.grantId` is this ID as a string (the
	 * approval that made the grant, and every use through it).
	 */
	readonly grantId?: string;
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
	applyRetention(ctx: SystemContext): Promise<number>;
}

/**
 * An outbox: components write events into it inside their own transaction, and a relay drains it to the store with
 * retries. Draining twice never duplicates a row, because the store is idempotent by organisation and event id.
 */
export interface AuditOutbox extends AuditSink {
	/** Sends every pending event to `sink`; events stay pending if the sink throws. Returns how many were sent. */
	drain(ctx: SystemContext, sink: AuditSink): Promise<number>;
	pending(ctx: SystemContext): Promise<number>;
}

/**
 * The audit query API over HTTP (M1-BE8), which the audit view (M1-FE3) reads. Both routes are `GET`, authenticated by
 * the deployment's `Authenticator`, and answer JSON:
 *
 * - `GET /v1/audit/events?<query>` → `AuditEventsResponse`: `AuditStore.query` with the query and page in the search
 *   parameters, as `auditQueryToSearchParams` writes them and `auditQueryFromSearchParams` reads them.
 * - `GET /v1/audit/event?id=<id>` → `AuditEventResponse`: `AuditStore.get`. The id is a search parameter, not a path
 *   segment, because ids are chosen by sources and may be `.` or hold a `/`.
 *
 * The organisation is always the caller's. Failures answer `AuditErrorResponse` with the `HarbourError` code: 400
 * `invalid` (a malformed parameter), 401 (no or bad credentials), 403 `forbidden` (an agent, or a project the caller
 * may not view), 404 `not_found`, 503 `unavailable`.
 */
export const AUDIT_EVENTS_PATH = "/v1/audit/events";
export const AUDIT_EVENT_PATH = "/v1/audit/event";

export interface AuditEventsResponse {
	readonly items: readonly AuditEvent[];
	/** Present when more rows follow; pass it back as `cursor`. */
	readonly nextCursor?: string;
}

export interface AuditEventResponse {
	readonly event: AuditEvent;
}

export interface AuditErrorResponse {
	readonly error: { readonly code: string; readonly message: string };
}

/**
 * Search parameter names. An actor is `actorKind` with `actorId` (a user, service or agent ID, or a system component),
 * plus `actorKeyId` for a service's key and `actorSessionId` for an agent's session. A subject is `subjectKind` with
 * `subjectId`. `itemId` and `grantId` are `AuditQuery`'s. Times are epoch milliseconds. `order` is `oldest` (default)
 * or `newest`.
 */
export const AUDIT_QUERY_PARAMS = [
	"projectId",
	"sessionId",
	"agentId",
	"actorKind",
	"actorId",
	"actorKeyId",
	"actorSessionId",
	"source",
	"type",
	"subjectKind",
	"subjectId",
	"itemId",
	"grantId",
	"from",
	"to",
	"order",
	"limit",
	"cursor",
] as const;

/** Writes a query and page as search parameters. Absent fields are left out. */
export function auditQueryToSearchParams(query: AuditQuery, page: PageRequest = {}): URLSearchParams {
	const params = new URLSearchParams();
	const set = (name: (typeof AUDIT_QUERY_PARAMS)[number], value: string | number | undefined) => {
		if (value !== undefined) params.set(name, String(value));
	};
	set("projectId", query.projectId);
	set("sessionId", query.sessionId);
	set("agentId", query.agentId);
	if (query.actor !== undefined) {
		const actor = query.actor;
		set("actorKind", actor.kind);
		switch (actor.kind) {
			case "human":
				set("actorId", actor.userId);
				break;
			case "service":
				set("actorId", actor.serviceId);
				set("actorKeyId", actor.keyId);
				break;
			case "agent":
				set("actorId", actor.agentId);
				set("actorSessionId", actor.sessionId);
				break;
			case "system":
				set("actorId", actor.component);
				break;
		}
	}
	set("source", query.source);
	set("type", query.type);
	set("subjectKind", query.subject?.kind);
	set("subjectId", query.subject?.id);
	set("itemId", query.itemId);
	set("grantId", query.grantId);
	set("from", query.from);
	set("to", query.to);
	if (query.newestFirst === true) set("order", "newest");
	set("limit", page.limit);
	set("cursor", page.cursor);
	return params;
}

/**
 * Reads a query and page from search parameters. Rejects with `invalid` on an unknown parameter, a repeated one, an
 * actor or subject missing its other half, a time or limit that is not a whole number, or an unknown order.
 */
export function auditQueryFromSearchParams(params: URLSearchParams): {
	readonly query: AuditQuery;
	readonly page: PageRequest;
} {
	const known: ReadonlySet<string> = new Set(AUDIT_QUERY_PARAMS);
	const seen = new Set<string>();
	for (const name of params.keys()) {
		if (!known.has(name)) throw new HarbourError("invalid", `Unknown audit query parameter ${name}`);
		if (seen.has(name)) throw new HarbourError("invalid", `Audit query parameter ${name} is repeated`);
		seen.add(name);
	}
	const text = (name: (typeof AUDIT_QUERY_PARAMS)[number]): string | undefined => {
		const value = params.get(name);
		if (value === null) return undefined;
		if (value === "") throw new HarbourError("invalid", `Audit query parameter ${name} is empty`);
		return value;
	};
	const whole = (name: (typeof AUDIT_QUERY_PARAMS)[number]): number | undefined => {
		const value = text(name);
		if (value === undefined) return undefined;
		if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
			throw new HarbourError("invalid", `Audit query parameter ${name} must be a whole number`);
		}
		return Number(value);
	};

	const actorKind = text("actorKind");
	const actorId = text("actorId");
	const actorKeyId = text("actorKeyId");
	const actorSessionId = text("actorSessionId");
	let actor: Actor | undefined;
	if (actorKind !== undefined || actorId !== undefined) {
		if (actorKind === undefined || actorId === undefined) {
			throw new HarbourError("invalid", "An actor needs both actorKind and actorId");
		}
		if (actorKeyId !== undefined && actorKind !== "service") {
			throw new HarbourError("invalid", "actorKeyId is only for a service actor");
		}
		if (actorSessionId !== undefined && actorKind !== "agent") {
			throw new HarbourError("invalid", "actorSessionId is only for an agent actor");
		}
		switch (actorKind) {
			case "human":
				actor = { kind: "human", userId: actorId };
				break;
			case "service":
				actor = { kind: "service", serviceId: actorId, ...(actorKeyId === undefined ? {} : { keyId: actorKeyId }) };
				break;
			case "agent":
				if (actorSessionId === undefined) throw new HarbourError("invalid", "An agent actor needs actorSessionId");
				actor = { kind: "agent", agentId: actorId, sessionId: actorSessionId };
				break;
			case "system":
				actor = { kind: "system", component: actorId };
				break;
			default:
				throw new HarbourError("invalid", "actorKind must be human, service, agent or system");
		}
	} else if (actorKeyId !== undefined || actorSessionId !== undefined) {
		throw new HarbourError("invalid", "An actor needs both actorKind and actorId");
	}

	const subjectKind = text("subjectKind");
	const subjectId = text("subjectId");
	if ((subjectKind === undefined) !== (subjectId === undefined)) {
		throw new HarbourError("invalid", "A subject needs both subjectKind and subjectId");
	}

	const order = text("order");
	if (order !== undefined && order !== "oldest" && order !== "newest") {
		throw new HarbourError("invalid", "order must be oldest or newest");
	}
	const limit = whole("limit");
	if (limit !== undefined && limit < 1) throw new HarbourError("invalid", "limit must be at least 1");

	const optional = <K extends string, V>(key: K, value: V | undefined) =>
		(value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
	const query: AuditQuery = {
		...optional("projectId", text("projectId")),
		...optional("sessionId", text("sessionId")),
		...optional("agentId", text("agentId")),
		...optional("actor", actor),
		...optional("source", text("source") as AuditSource | undefined),
		...optional("type", text("type")),
		...optional(
			"subject",
			subjectKind === undefined || subjectId === undefined ? undefined : { kind: subjectKind, id: subjectId },
		),
		...optional("itemId", text("itemId")),
		...optional("grantId", text("grantId")),
		...optional("from", whole("from")),
		...optional("to", whole("to")),
		...(order === "newest" ? { newestFirst: true } : {}),
	};
	const page: PageRequest = { ...optional("limit", limit), ...optional("cursor", text("cursor")) };
	return { query, page };
}
