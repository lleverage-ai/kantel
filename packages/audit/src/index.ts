/**
 * Portable audit logic shared by every target: event validation, query matching and the secret check suites use. No
 * storage and no clock here.
 */
import {
	type Actor,
	type AuditEventInput,
	type AuditQuery,
	type AuditSource,
	HarbourError,
	type JsonValue,
	MAX_AUDIT_QUERY_TYPES,
} from "@harbour/contracts";

export const AUDIT_SOURCES: readonly AuditSource[] = [
	"session",
	"sandbox",
	"workspace",
	"vault",
	"browser",
	"identity",
	"schedules",
	"capability",
	"skills",
	"memory",
	"access",
	"control",
	"sharing",
];

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Whether `value` is a well-formed actor: a known kind with its identifying fields. */
export function isValidActor(value: unknown): value is Actor {
	if (typeof value !== "object" || value === null) return false;
	const actor = value as { readonly [key: string]: unknown };
	switch (actor.kind) {
		case "human":
			return isNonEmptyString(actor.userId);
		case "service":
			return isNonEmptyString(actor.serviceId) && (actor.keyId === undefined || isNonEmptyString(actor.keyId));
		case "agent":
			return isNonEmptyString(actor.agentId) && isNonEmptyString(actor.sessionId);
		case "system":
			return isNonEmptyString(actor.component);
		default:
			return false;
	}
}

/**
 * Rejects with `invalid` unless the event has an id, a finite `at`, a known source, a type, a well-formed actor and an
 * organisation. A row without an actor can never be stored.
 */
export function assertValidAuditEvent(event: AuditEventInput): void {
	if (typeof event !== "object" || event === null)
		throw new HarbourError("invalid", "An audit event must be an object");
	if (!isNonEmptyString(event.id)) throw new HarbourError("invalid", "An audit event needs an id");
	if (typeof event.at !== "number" || !Number.isFinite(event.at)) {
		throw new HarbourError("invalid", `Audit event ${event.id} needs a finite time`);
	}
	if (!AUDIT_SOURCES.includes(event.source)) {
		throw new HarbourError("invalid", `Audit event ${event.id} has an unknown source ${String(event.source)}`);
	}
	if (!isNonEmptyString(event.type) || event.type.endsWith(".")) {
		throw new HarbourError("invalid", `Audit event ${event.id} needs a type that does not end in "."`);
	}
	if (!isValidActor(event.actor)) throw new HarbourError("invalid", `Audit event ${event.id} needs an actor`);
	if (!isNonEmptyString(event.organisationId)) {
		throw new HarbourError("invalid", `Audit event ${event.id} needs an organisation`);
	}
}

/** Whether `actual` is the actor `wanted`, compared by kind and ID. A service's `keyId` counts only if `wanted` has one. */
export function actorMatches(actual: Actor, wanted: Actor): boolean {
	switch (wanted.kind) {
		case "human":
			return actual.kind === "human" && actual.userId === wanted.userId;
		case "service":
			return (
				actual.kind === "service" &&
				actual.serviceId === wanted.serviceId &&
				(wanted.keyId === undefined || actual.keyId === wanted.keyId)
			);
		case "agent":
			return actual.kind === "agent" && actual.agentId === wanted.agentId && actual.sessionId === wanted.sessionId;
		case "system":
			return actual.kind === "system" && actual.component === wanted.component;
	}
}

/** Whether `type` is `wanted`, or lies under it when `wanted` is a prefix ending in `.`. */
export function typeMatches(type: string, wanted: string): boolean {
	return wanted.endsWith(".") ? type.startsWith(wanted) : type === wanted;
}

/**
 * Rejects with `invalid` unless the query's `types`, when set, lists 1 to `MAX_AUDIT_QUERY_TYPES` non-empty types
 * without a comma. Stores check it before reading, so every target refuses the same queries.
 */
export function assertValidAuditQuery(query: AuditQuery): void {
	const { types } = query;
	if (types === undefined) return;
	if (!Array.isArray(types) || types.length === 0) {
		throw new HarbourError("invalid", "An audit query's types must list at least one type");
	}
	if (types.length > MAX_AUDIT_QUERY_TYPES) {
		throw new HarbourError("invalid", `An audit query's types may list at most ${MAX_AUDIT_QUERY_TYPES} types`);
	}
	for (const type of types) {
		if (!isNonEmptyString(type) || type.includes(",")) {
			throw new HarbourError("invalid", "Each of an audit query's types must be a non-empty type without a comma");
		}
	}
}

/**
 * The vault record of `kind` (`vault.item` or `vault.grant`) an event is about: its subject when the subject is of that
 * kind, or else `data[key]` (`itemId` or `grantId`) when it is a string. The SQL store indexes the same expression.
 */
function aboutRecord(event: AuditEventInput, kind: string, key: string): string | undefined {
	if (event.subject?.kind === kind) return event.subject.id;
	const value = event.data?.[key];
	return typeof value === "string" ? value : undefined;
}

/** The vault item an event is about, as `AuditQuery.itemId` matches it. */
export function eventItemId(event: AuditEventInput): string | undefined {
	return aboutRecord(event, "vault.item", "itemId");
}

/** The vault grant an event is about, as `AuditQuery.grantId` matches it. */
export function eventGrantId(event: AuditEventInput): string | undefined {
	return aboutRecord(event, "vault.grant", "grantId");
}

/**
 * Whether `event` matches every field `query` sets. `from` is inclusive and `to` exclusive. The organisation and the
 * order (`newestFirst`) are the store's business, not this check's.
 */
export function matchesQuery(event: AuditEventInput, query: AuditQuery): boolean {
	return (
		(query.projectId === undefined || event.projectId === query.projectId) &&
		(query.sessionId === undefined || event.sessionId === query.sessionId) &&
		(query.agentId === undefined || event.agentId === query.agentId) &&
		(query.actor === undefined || actorMatches(event.actor, query.actor)) &&
		(query.source === undefined || event.source === query.source) &&
		(query.type === undefined || typeMatches(event.type, query.type)) &&
		(query.types === undefined || query.types.some((wanted) => typeMatches(event.type, wanted))) &&
		(query.subject === undefined ||
			(event.subject?.kind === query.subject.kind && event.subject.id === query.subject.id)) &&
		(query.itemId === undefined || eventItemId(event) === query.itemId) &&
		(query.grantId === undefined || eventGrantId(event) === query.grantId) &&
		(query.from === undefined || event.at >= query.from) &&
		(query.to === undefined || event.at < query.to)
	);
}

function jsonContains(value: JsonValue | undefined, needles: readonly string[]): boolean {
	if (typeof value === "string") return needles.some((needle) => value.includes(needle));
	if (typeof value !== "object" || value === null) return false;
	if (Array.isArray(value)) return value.some((entry: JsonValue) => jsonContains(entry, needles));
	const record = value as { readonly [key: string]: JsonValue };
	return Object.keys(record).some((key) => jsonContains(key, needles) || jsonContains(record[key], needles));
}

/** Whether any string anywhere in the event's `data`, keys included, contains one of `needles`. Empty needles are ignored. */
export function findSecret(event: AuditEventInput, needles: readonly string[]): boolean {
	const nonEmpty = needles.filter((needle) => needle.length > 0);
	return nonEmpty.length > 0 && event.data !== undefined && jsonContains(event.data, nonEmpty);
}
