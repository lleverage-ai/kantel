/**
 * Types every contract shares: identifiers, actors, owners, call context, errors, clocks and pages.
 *
 * Contracts hold no Pi types and no runtime dependencies. The only values here are the error class, a system clock and
 * small helpers, so every target (Workers, Bun, Node) can import them.
 */

/** Epoch milliseconds, UTC. */
export type Timestamp = number;

export type OrganisationId = string;
export type ProjectId = string;
export type UserId = string;
export type ServiceId = string;
export type ApiKeyId = string;
export type AgentId = string;
export type SessionId = string;
export type WorkspaceId = string;

/** JSON values, for payloads stored or sent as JSON. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A JSON Schema object (draft 2020-12), as tools and capabilities declare their inputs. */
export type JsonSchema = { readonly [key: string]: JsonValue };

/**
 * Who is acting. Every API call carries one, and the audit log records it.
 * - `human`: a signed-in user.
 * - `service`: a host app (such as Lleverage) calling with an API key.
 * - `agent`: an agent running in a session; it acts for that session only.
 * - `system`: Kantel itself (sweepers, schedulers, outboxes).
 */
export type Actor =
	| { readonly kind: "human"; readonly userId: UserId }
	| { readonly kind: "service"; readonly serviceId: ServiceId; readonly keyId?: ApiKeyId }
	| { readonly kind: "agent"; readonly agentId: AgentId; readonly sessionId: SessionId }
	| { readonly kind: "system"; readonly component: string };

/**
 * Who owns a record. Sessions, workspaces, vault items, skills, memory spaces and schedules are each owned by an
 * organisation, a project or a user; `platform` is for built-ins every organisation sees.
 */
export type OwnerRef =
	| { readonly kind: "platform" }
	| { readonly kind: "organisation"; readonly organisationId: OrganisationId }
	| { readonly kind: "project"; readonly organisationId: OrganisationId; readonly projectId: ProjectId }
	| { readonly kind: "user"; readonly organisationId: OrganisationId; readonly userId: UserId };

/**
 * Where a session works, and what an access check resolves to: one project of the organisation, or the organisation
 * itself (above its projects, none of which it reaches unless one is shared with it).
 * The sharing primitive uses the same shape for an owner or grantee at organisation or project level.
 */
export type AccessScope =
	| { readonly kind: "organisation" }
	| { readonly kind: "project"; readonly projectId: ProjectId };

/** The scope of a record that names its project when it has one, such as a `SessionRecord`: no project is the organisation. */
export function scopeOf(record: { readonly projectId?: ProjectId | undefined }): AccessScope {
	return record.projectId === undefined ? { kind: "organisation" } : { kind: "project", projectId: record.projectId };
}

/**
 * The owner of what a scope holds, such as a session's own workspace: its project for a project-scoped record, else
 * its organisation.
 */
export function scopeOwner(record: {
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId | undefined;
}): Extract<OwnerRef, { readonly kind: "organisation" | "project" }> {
	return record.projectId === undefined
		? { kind: "organisation", organisationId: record.organisationId }
		: { kind: "project", organisationId: record.organisationId, projectId: record.projectId };
}

/**
 * `{ projectId }` when the record has a project, else nothing: for spreading a session's project into another record
 * (an audit row, a grant, a usage row) that leaves it out for an organisation-scoped session.
 */
export function projectFields(record: { readonly projectId?: ProjectId | undefined }): {
	readonly projectId?: ProjectId;
} {
	return record.projectId === undefined ? {} : { projectId: record.projectId };
}

/** The context of one API call: who acts, in which tenant, with cancellation. */
export interface CallContext {
	readonly actor: Actor;
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	/** Correlates a call across services and makes retries idempotent where an API says so. */
	readonly requestId?: string;
	readonly signal?: AbortSignal;
}

/**
 * The context of a worker call: one Kantel makes on its own behalf, such as a scheduler tick, an audit append, the
 * egress gateway's decision or a sweep. Every worker call takes one, and refuses
 * with `forbidden`, audited, any actor but `system` (a missing caller included). A worker call may span organisations,
 * so the context need not name one; a `CallContext` with a system actor is one too.
 */
export interface SystemContext {
	readonly actor: Actor;
	readonly organisationId?: OrganisationId;
	readonly requestId?: string;
	readonly signal?: AbortSignal;
}

/** A `SystemContext` for one of Kantel's own components, named by `component` (such as `vault` or `scheduler`). */
export function systemContext(component: string): SystemContext {
	return { actor: { kind: "system", component } };
}

/** Whether `actor` is Kantel itself: a `system` actor naming its component. Checks the shape, as callers may not. */
export function isSystemActor(actor: unknown): actor is Extract<Actor, { readonly kind: "system" }> {
	if (typeof actor !== "object" || actor === null) return false;
	const candidate = actor as { kind?: unknown; component?: unknown };
	return candidate.kind === "system" && typeof candidate.component === "string" && candidate.component.length > 0;
}

export type ErrorCode =
	/** The input is malformed or out of range. */
	| "invalid"
	| "not_found"
	/** The actor may not do this. */
	| "forbidden"
	/** A version, lease or uniqueness check failed. */
	| "conflict"
	/** The record's lifetime has ended. */
	| "expired"
	/** A rule refused it: a binding code mismatch, a read-only mount, a ceiling, an agent choosing its own context. */
	| "refused"
	/** A use limit or quota is spent. */
	| "exhausted"
	| "unavailable"
	| "aborted"
	| "not_supported";

export class KantelError extends Error {
	readonly code: ErrorCode;
	readonly details?: { readonly [key: string]: JsonValue };
	constructor(code: ErrorCode, message: string, details?: { readonly [key: string]: JsonValue }) {
		super(message);
		this.name = "KantelError";
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

/** Whether `error` is a KantelError, optionally with `code`. Works across package copies by checking the shape. */
export function isKantelError(error: unknown, code?: ErrorCode): error is KantelError {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { name?: unknown; code?: unknown };
	if (candidate.name !== "KantelError" || typeof candidate.code !== "string") return false;
	return code === undefined || candidate.code === code;
}

export interface Clock {
	now(): Timestamp;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface PageRequest {
	/** Maximum items; implementations cap it (at least 100 must be allowed). */
	readonly limit?: number;
	/** Opaque cursor from a previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface Page<T> {
	readonly items: readonly T[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** A handle on a subscription or wait. */
export interface Subscription {
	close(): Promise<void>;
}

/** How a tool or capability call may be repeated after a crash. */
export type ReplayPolicy =
	/** No effects outside Kantel's own records: rerun freely. */
	| "safe"
	/** Effects are keyed by the call ID, so a rerun does not repeat them. */
	| "idempotent"
	/** May have partially run: never rerun; the model and the supervisor are told instead. */
	| "unsafe";
