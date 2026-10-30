/**
 * Sharing across projects (docs/design/sharing.md): the input checks every store applies, and the record copies.
 * The stores are `./memory.ts` and `./sql.ts`; both run the same rules (`./rules.ts`).
 */
import {
	type BindingInput,
	type BindingObject,
	type BindingSubject,
	HarbourError,
	isBuiltInResourceKind,
	type OwnerRef,
	permissionAllowsAgentWrites,
	RESERVED_RESOURCE_PREFIXES,
	RESOURCE_KIND_PATTERN,
	type ResourceRef,
	type ResourceSelector,
	SHARE_PERMISSIONS,
	type ShareGrantee,
	type SharePermission,
} from "@harbour/contracts";

export type { SharingStore } from "./rules.ts";

/** The longest note, reason or name a store keeps, in characters. */
export const MAX_SHARING_TEXT = 2000;
/** The longest resource or group ID. */
export const MAX_SHARING_ID = 256;

function text(value: unknown, what: string, max = MAX_SHARING_TEXT): string {
	if (typeof value !== "string" || value.trim() === "") throw new HarbourError("invalid", `${what} is required`);
	if (value.length > max) throw new HarbourError("invalid", `${what} is longer than ${max} characters`);
	return value;
}

function optionalText(value: unknown, what: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new HarbourError("invalid", `${what} must be text`);
	if (value.length > MAX_SHARING_TEXT)
		throw new HarbourError("invalid", `${what} is longer than ${MAX_SHARING_TEXT} characters`);
	return value.trim() === "" ? undefined : value;
}

/** A resource kind's shape; Harbour's own kinds and well-formed host kinds pass. */
export function validateResourceKind(kind: unknown): string {
	if (typeof kind !== "string" || !RESOURCE_KIND_PATTERN.test(kind) || kind.length > 100) {
		throw new HarbourError("invalid", "A resource kind is lowercase words joined by dots");
	}
	return kind;
}

/** A host kind: well formed, not Harbour's own, and outside Harbour's reserved prefixes. */
export function validateHostKind(kind: unknown): string {
	const checked = validateResourceKind(kind);
	if (isBuiltInResourceKind(checked) || RESERVED_RESOURCE_PREFIXES.some((prefix) => checked.startsWith(prefix))) {
		throw new HarbourError("invalid", `${checked} is one of Harbour's own kinds; only a host's kinds are registered`);
	}
	return checked;
}

export function validateResource(resource: unknown): ResourceRef {
	if (typeof resource !== "object" || resource === null) throw new HarbourError("invalid", "A resource is required");
	const candidate = resource as { kind?: unknown; id?: unknown };
	return { kind: validateResourceKind(candidate.kind), id: text(candidate.id, "A resource ID", MAX_SHARING_ID) };
}

export function validateSelector(resource: unknown): ResourceSelector {
	const ref = validateResource(resource);
	const revision = (resource as { revision?: unknown }).revision;
	if (revision === undefined) return ref;
	return { ...ref, revision: validateRevision(revision) };
}

export function validateRevision(revision: unknown): number {
	if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
		throw new HarbourError("invalid", "A revision is a whole number from 1");
	}
	return revision;
}

export function validatePermission(permission: unknown): SharePermission {
	if (!SHARE_PERMISSIONS.includes(permission as SharePermission)) {
		throw new HarbourError("invalid", `A permission is one of ${SHARE_PERMISSIONS.join(", ")}`);
	}
	return permission as SharePermission;
}

/** A share's `agentWrites`: false unless asked for, and only on a share that allows `edit`. */
export function validateAgentWrites(agentWrites: unknown, permission: SharePermission): boolean {
	if (agentWrites === undefined || agentWrites === false) return false;
	if (agentWrites !== true) throw new HarbourError("invalid", "agentWrites is true or false");
	if (!permissionAllowsAgentWrites(permission)) {
		throw new HarbourError("invalid", "Only an edit or approve share may let agents write");
	}
	return true;
}

export function validateGrantee(grantee: unknown): ShareGrantee {
	if (typeof grantee !== "object" || grantee === null) throw new HarbourError("invalid", "A grantee is required");
	const candidate = grantee as {
		kind?: unknown;
		projectId?: unknown;
		agentId?: unknown;
		userId?: unknown;
		sessionId?: unknown;
	};
	switch (candidate.kind) {
		case "project":
			return { kind: "project", projectId: text(candidate.projectId, "A project ID", MAX_SHARING_ID) };
		case "agent":
			return { kind: "agent", agentId: text(candidate.agentId, "An agent ID", MAX_SHARING_ID) };
		case "user":
			return { kind: "user", userId: text(candidate.userId, "A user ID", MAX_SHARING_ID) };
		case "session":
			return { kind: "session", sessionId: text(candidate.sessionId, "A session ID", MAX_SHARING_ID) };
		default:
			throw new HarbourError("invalid", "A grantee is a project, an agent, a user or a session");
	}
}

export function validateSubject(subject: unknown): BindingSubject {
	if (typeof subject !== "object" || subject === null) throw new HarbourError("invalid", "A subject is required");
	const candidate = subject as { kind?: unknown; userId?: unknown; serviceId?: unknown; groupId?: unknown };
	switch (candidate.kind) {
		case "user":
			return { kind: "user", userId: text(candidate.userId, "A user ID", MAX_SHARING_ID) };
		case "service":
			return { kind: "service", serviceId: text(candidate.serviceId, "A service ID", MAX_SHARING_ID) };
		case "group":
			return { kind: "group", groupId: text(candidate.groupId, "A group ID", MAX_SHARING_ID) };
		default:
			throw new HarbourError("invalid", "A subject is a user, a service or a group");
	}
}

export function validateBindingObject(object: unknown): BindingObject {
	if (typeof object === "object" && object !== null && (object as { kind?: unknown }).kind === "group") {
		return { kind: "group", id: text((object as { id?: unknown }).id, "A group ID", MAX_SHARING_ID) };
	}
	return validateResource(object);
}

/** A binding's parts, checked: `member` only on a group and never of a group; the others only on a resource. */
export function validateBinding(input: unknown): BindingInput {
	if (typeof input !== "object" || input === null) throw new HarbourError("invalid", "A binding is required");
	const candidate = input as { object?: unknown; relation?: unknown; subject?: unknown };
	const object = validateBindingObject(candidate.object);
	const subject = validateSubject(candidate.subject);
	const relation = candidate.relation;
	if (relation !== "maintainer" && relation !== "approver" && relation !== "member") {
		throw new HarbourError("invalid", "A relation is maintainer, approver or member");
	}
	if (object.kind === "group") {
		if (relation !== "member") throw new HarbourError("invalid", "A group's only relation is member");
		if (subject.kind === "group") throw new HarbourError("invalid", "Groups hold users and services, not other groups");
	} else if (relation === "member") {
		throw new HarbourError("invalid", "member is a group's relation; a resource has maintainers and approvers");
	}
	return { object, relation, subject };
}

export const reason = (value: unknown): string => text(value, "A reason");
export const note = (value: unknown): string | undefined => optionalText(value, "A note");
export const resourceName = (value: unknown): string | undefined => optionalText(value, "A name");

export function validateOwner(owner: unknown): OwnerRef {
	if (typeof owner !== "object" || owner === null) throw new HarbourError("invalid", "An owner is required");
	const candidate = owner as { kind?: unknown; organisationId?: unknown; projectId?: unknown; userId?: unknown };
	switch (candidate.kind) {
		case "platform":
			return { kind: "platform" };
		case "organisation":
			return {
				kind: "organisation",
				organisationId: text(candidate.organisationId, "An organisation ID", MAX_SHARING_ID),
			};
		case "project":
			return {
				kind: "project",
				organisationId: text(candidate.organisationId, "An organisation ID", MAX_SHARING_ID),
				projectId: text(candidate.projectId, "A project ID", MAX_SHARING_ID),
			};
		case "user":
			return {
				kind: "user",
				organisationId: text(candidate.organisationId, "An organisation ID", MAX_SHARING_ID),
				userId: text(candidate.userId, "A user ID", MAX_SHARING_ID),
			};
		default:
			throw new HarbourError("invalid", "An owner is the platform, an organisation, a project or a user");
	}
}

export function sameResource(a: ResourceRef, b: ResourceRef): boolean {
	return a.kind === b.kind && a.id === b.id;
}

export function sameGrantee(a: ShareGrantee, b: ShareGrantee): boolean {
	switch (a.kind) {
		case "project":
			return b.kind === "project" && b.projectId === a.projectId;
		case "agent":
			return b.kind === "agent" && b.agentId === a.agentId;
		case "user":
			return b.kind === "user" && b.userId === a.userId;
		case "session":
			return b.kind === "session" && b.sessionId === a.sessionId;
	}
}
