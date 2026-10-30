/**
 * Sharing across projects: shares, access requests, resource bindings and per-resource policy. See
 * docs/design/sharing.md.
 *
 * A resource (a skill, a memory space, a vault item, a workspace, a model connector, or a host's own kind) is owned by
 * a project, a user, an organisation or the platform. A share lets a project, an agent, a user or one session use it
 * (or change it) outside its owner; it is assigned outright or answers a request, and it records who granted it, when,
 * until when, and what it was passed on from. Separately, relation tuples bind people, services and groups to one
 * resource as its maintainers or approvers.
 *
 * Harbour decides every check in one place, `ProjectAccess.resource` (access.ts), over the read seam here
 * (`SharingLookup`). Components call it; they don't read shares themselves.
 *
 * Not to be confused with `FileShares` (shares.ts), which shares one workspace file by link.
 */
import type {
	Actor,
	AgentId,
	CallContext,
	OrganisationId,
	OwnerRef,
	Page,
	PageRequest,
	ProjectId,
	ServiceId,
	SessionId,
	SystemContext,
	Timestamp,
	UserId,
} from "./common.ts";

/**
 * A resource's kind. Harbour's own are `RESOURCE_KINDS`; a host's are any other dotted lowercase name (such as
 * `acme.brand-guideline`), registered with `Sharing.registerResource` before they are shared.
 */
export type ResourceKind = string;

/** Harbour's own resource kinds, named as their audit subjects are. */
export const RESOURCE_KINDS = Object.freeze({
	skill: "skills.skill",
	memorySpace: "memory.space",
	vaultItem: "vault.item",
	workspace: "workspace",
	modelConnector: "models.connector",
} as const);

/** Prefixes a host kind may not use: Harbour's components'. */
export const RESERVED_RESOURCE_PREFIXES: readonly string[] = Object.freeze([
	"access.",
	"audit.",
	"browser.",
	"capability.",
	"control.",
	"group",
	"identity.",
	"memory.",
	"models.",
	"sandbox.",
	"schedules.",
	"session",
	"sharing.",
	"skills.",
	"vault.",
	"workspace",
]);

/** The shape of every kind, Harbour's and a host's: lowercase words joined by dots, each word letters, digits and dashes. */
export const RESOURCE_KIND_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/** Whether `kind` is one of Harbour's own. */
export function isBuiltInResourceKind(kind: string): boolean {
	return (Object.values(RESOURCE_KINDS) as string[]).includes(kind);
}

/** The resource a share, request or binding is about. */
export interface ResourceRef {
	readonly kind: ResourceKind;
	readonly id: string;
}

/** A resource, optionally at one revision: a share or request with a revision pins it; without one it follows the latest. */
export interface ResourceSelector extends ResourceRef {
	readonly revision?: number;
}

/** Who a share is for. */
export type ShareGrantee =
	/** Every session in the project, and its people within their role there. */
	| { readonly kind: "project"; readonly projectId: ProjectId }
	/** Every session running this agent profile. */
	| { readonly kind: "agent"; readonly agentId: AgentId }
	/** The person, acting as themselves. */
	| { readonly kind: "user"; readonly userId: UserId }
	/** One session: what a supervisor passes on to a child session. */
	| { readonly kind: "session"; readonly sessionId: SessionId };

/** What a share allows, weakest first. Each includes the ones before it. */
export type SharePermission = "use" | "propose" | "edit" | "approve";
export const SHARE_PERMISSIONS: readonly SharePermission[] = Object.freeze(["use", "propose", "edit", "approve"]);

/** Whether `held` includes `needed`. */
export function permissionSatisfies(held: SharePermission, needed: SharePermission): boolean {
	return SHARE_PERMISSIONS.indexOf(held) >= SHARE_PERMISSIONS.indexOf(needed);
}

/** The strongest permission an agent may hold or use: agents draft and propose, never edit or approve. */
export const AGENT_MAX_PERMISSION: SharePermission = "propose";

export type ResourceShareId = string;
export type AccessRequestId = string;

export interface ResourceShare {
	readonly id: ResourceShareId;
	readonly organisationId: OrganisationId;
	readonly resource: ResourceSelector;
	/** The resource's owner when the share was made. */
	readonly owner: OwnerRef;
	readonly grantee: ShareGrantee;
	readonly permission: SharePermission;
	readonly grantedBy: Actor;
	readonly grantedAt: Timestamp;
	/** The request this share answers, when it answers one. */
	readonly requestId?: AccessRequestId;
	/** After this the share no longer covers anything. */
	readonly expiresAt?: Timestamp;
	/** The share a supervisor passed this one on from. Revoking that one revokes this one. */
	readonly parentShareId?: ResourceShareId;
	/** Why it was made, as the granter said. */
	readonly note?: string;
	readonly revokedAt?: Timestamp;
	readonly revokedBy?: Actor;
	readonly revokeReason?: string;
}

/** Whether a share covers anything at `now`: not revoked and not expired. */
export function shareActive(share: ResourceShare, now: Timestamp): boolean {
	return share.revokedAt === undefined && (share.expiresAt === undefined || share.expiresAt > now);
}

export interface CreateShareInput {
	readonly resource: ResourceSelector;
	readonly grantee: ShareGrantee;
	readonly permission: SharePermission;
	readonly expiresAt?: Timestamp;
	/** Required of an agent: the share it holds and passes on. */
	readonly parentShareId?: ResourceShareId;
	readonly note?: string;
}

export type AccessRequestStatus = "pending" | "granted" | "rejected" | "withdrawn";

export interface AccessRequestDecision {
	readonly decidedBy: Actor;
	readonly decidedAt: Timestamp;
	readonly note?: string;
	/** The share a grant created. */
	readonly shareId?: ResourceShareId;
}

export interface AccessRequest {
	readonly id: AccessRequestId;
	readonly organisationId: OrganisationId;
	readonly resource: ResourceSelector;
	readonly owner: OwnerRef;
	/** Who the share would be for. */
	readonly grantee: ShareGrantee;
	readonly permission: SharePermission;
	readonly reason: string;
	readonly requestedBy: Actor;
	/** The session the request came from: an agent's own, or one a person named. */
	readonly sessionId?: SessionId;
	readonly agentId?: AgentId;
	readonly status: AccessRequestStatus;
	readonly createdAt: Timestamp;
	readonly expiresAt?: Timestamp;
	/** Present once granted, rejected or withdrawn. */
	readonly decision?: AccessRequestDecision;
}

export interface RequestAccessInput {
	readonly resource: ResourceSelector;
	/** Default: the project of the caller's session (an agent), or the call's `projectId`. */
	readonly grantee?: ShareGrantee;
	/** Default `use`. */
	readonly permission?: SharePermission;
	readonly reason: string;
	/** For how long the share would hold, asked for; the decider may shorten it. */
	readonly expiresAt?: Timestamp;
	/** A person or service may name the session the request is for. An agent's is always its own. */
	readonly sessionId?: SessionId;
}

export interface DecideRequestInput {
	readonly decision: "grant" | "reject";
	readonly note?: string;
	/** A grant may narrow what was asked: a weaker permission, an earlier expiry, or a pinned revision. Never wider. */
	readonly permission?: SharePermission;
	readonly expiresAt?: Timestamp;
	readonly revision?: number;
}

/** The relations a binding names on a resource, or `member` on a group. */
export type BindingRelation = "maintainer" | "approver" | "member";

export type BindingSubject =
	| { readonly kind: "user"; readonly userId: UserId }
	| { readonly kind: "service"; readonly serviceId: ServiceId }
	/** Every member of the group. Groups hold users and services, not other groups. */
	| { readonly kind: "group"; readonly groupId: string };

/** The object of a binding: a resource, or a group (for `member`). */
export type BindingObject = ResourceRef | { readonly kind: "group"; readonly id: string };

/** A relation tuple: `subject` has `relation` on `object`. */
export interface ResourceBinding {
	readonly organisationId: OrganisationId;
	readonly object: BindingObject;
	readonly relation: BindingRelation;
	readonly subject: BindingSubject;
	readonly grantedBy: Actor;
	readonly grantedAt: Timestamp;
}

export interface BindingInput {
	readonly object: BindingObject;
	readonly relation: BindingRelation;
	readonly subject: BindingSubject;
}

export interface ResourcePolicy {
	/** Whoever publishes an edit may not be one of its authors. */
	readonly twoPersonRule: boolean;
}

export const DEFAULT_RESOURCE_POLICY: ResourcePolicy = Object.freeze({ twoPersonRule: false });

/** A host's resource as registered: Harbour knows its kinds' owners only this way. */
export interface RegisteredResource {
	readonly organisationId: OrganisationId;
	readonly resource: ResourceRef;
	readonly owner: OwnerRef;
	readonly name?: string;
	readonly registeredBy: Actor;
	readonly registeredAt: Timestamp;
}

/** One use of a resource through a share by a session: which revision, under which share. Recorded once per session. */
export interface ShareUse {
	readonly organisationId: OrganisationId;
	readonly sessionId: SessionId;
	readonly resource: ResourceSelector;
	readonly shareId: ResourceShareId;
	readonly usedAt: Timestamp;
}

export interface ShareQuery {
	readonly resource?: ResourceRef;
	readonly grantee?: ShareGrantee;
	/** Shares of resources this project owns. */
	readonly ownerProjectId?: ProjectId;
	/** Default false: revoked and expired shares are left out. */
	readonly includeInactive?: boolean;
}

export interface AccessRequestQuery {
	readonly resource?: ResourceRef;
	readonly grantee?: ShareGrantee;
	readonly status?: AccessRequestStatus;
	/** Requests for resources this project owns. */
	readonly ownerProjectId?: ProjectId;
	/** Only the requests the caller may decide: its inbox. */
	readonly decidable?: boolean;
	readonly sessionId?: SessionId;
}

export interface BindingQuery {
	readonly object?: BindingObject;
	readonly subject?: BindingSubject;
	readonly relation?: BindingRelation;
}

/**
 * The sharing store. Every change is audited under the `sharing` source and every check goes through
 * `ProjectAccess`:
 *
 * - `createShare`, `decideRequest`, bindings and policy need authority over the resource: `approver` on it (directly
 *   or through a group), or admin where it lives (its project, the organisation, or the user themselves). Agents never
 *   hold it, except that a supervisor may pass on a share it holds to a child session (`parentShareId`), no wider.
 * - `revokeShare` needs that authority, or admin on the grantee's project (detaching), or for a passed-on share, the
 *   session that passed it on.
 * - `requestAccess` needs operator on the grantee's project; an agent requests through its own session for its own
 *   session, agent or project.
 * - Reads need viewer on the resource's project or the grantee's project, or authority over the resource.
 */
export interface Sharing {
	/** Registers a host's resource and its owner (idempotent; the owner can't change). Harbour's own kinds are `invalid`. */
	registerResource(
		ctx: CallContext,
		input: { readonly resource: ResourceRef; readonly owner: OwnerRef; readonly name?: string },
	): Promise<RegisteredResource>;
	createShare(ctx: CallContext, input: CreateShareInput): Promise<ResourceShare>;
	getShare(ctx: CallContext, shareId: ResourceShareId): Promise<ResourceShare>;
	/** Newest first. */
	listShares(ctx: CallContext, query: ShareQuery, page?: PageRequest): Promise<Page<ResourceShare>>;
	/** Revokes the share and every share passed on from it. Revoking a revoked share returns it unchanged. */
	revokeShare(ctx: CallContext, shareId: ResourceShareId, input?: { readonly reason?: string }): Promise<ResourceShare>;

	requestAccess(ctx: CallContext, input: RequestAccessInput): Promise<AccessRequest>;
	getRequest(ctx: CallContext, requestId: AccessRequestId): Promise<AccessRequest>;
	/** Newest first. */
	listRequests(ctx: CallContext, query: AccessRequestQuery, page?: PageRequest): Promise<Page<AccessRequest>>;
	/** Only the requester (or its session's people) may withdraw; only a pending request (`conflict` otherwise). */
	withdrawRequest(ctx: CallContext, requestId: AccessRequestId): Promise<AccessRequest>;
	/** Decides a pending request once (`conflict` after). A grant creates the share in the same write. */
	decideRequest(
		ctx: CallContext,
		requestId: AccessRequestId,
		input: DecideRequestInput,
	): Promise<{ readonly request: AccessRequest; readonly share?: ResourceShare }>;

	addBinding(ctx: CallContext, input: BindingInput): Promise<ResourceBinding>;
	/** Removing a binding that isn't there does nothing. */
	removeBinding(ctx: CallContext, input: BindingInput): Promise<void>;
	listBindings(ctx: CallContext, query: BindingQuery, page?: PageRequest): Promise<Page<ResourceBinding>>;

	setPolicy(ctx: CallContext, resource: ResourceRef, policy: ResourcePolicy): Promise<ResourcePolicy>;
	getPolicy(ctx: CallContext, resource: ResourceRef): Promise<ResourcePolicy>;

	/** What a session used through shares: each resource once, with its revision and share. */
	listUses(ctx: CallContext, query: { readonly sessionId: SessionId }): Promise<readonly ShareUse[]>;
}

/**
 * Where a resource's owner comes from. Each component resolves its own kinds (a skill's package, a memory space); the
 * sharing store resolves registered host kinds. `undefined` when there is no such resource in the organisation.
 */
export interface ResourceResolver {
	ownerOf(
		ctx: SystemContext & { readonly organisationId: OrganisationId },
		resource: ResourceRef,
	): Promise<{ readonly owner: OwnerRef; readonly name?: string } | undefined>;
}

/**
 * The sharing store's read seam for `ProjectAccess.resource`, and the one write it makes: recording a session's use.
 * Worker calls: each takes a system context.
 */
export interface SharingLookup {
	/** The active shares of one resource at `now`, any revision. */
	sharesOf(
		ctx: SystemContext,
		organisationId: OrganisationId,
		resource: ResourceRef,
	): Promise<readonly ResourceShare[]>;
	/** The bindings on one resource, and the groups `subject` is a member of. */
	bindingsOf(
		ctx: SystemContext,
		organisationId: OrganisationId,
		object: BindingObject,
	): Promise<readonly ResourceBinding[]>;
	groupsOf(ctx: SystemContext, organisationId: OrganisationId, subject: BindingSubject): Promise<readonly string[]>;
	policyOf(ctx: SystemContext, organisationId: OrganisationId, resource: ResourceRef): Promise<ResourcePolicy>;
	/** Records a session's use of a resource through a share, once per session and resource (the first one stays). */
	recordUse(ctx: SystemContext, use: ShareUse): Promise<void>;
	/** Active shares into any of these grantees, of resources of `kind`: what is shared into a project or session. */
	sharedInto(
		ctx: SystemContext,
		organisationId: OrganisationId,
		grantees: readonly ShareGrantee[],
		kind?: ResourceKind,
	): Promise<readonly ResourceShare[]>;
}

/** The key a store files a grantee under, such as `project:proj-a`. */
export function granteeKey(grantee: ShareGrantee): string {
	switch (grantee.kind) {
		case "project":
			return `project:${grantee.projectId}`;
		case "agent":
			return `agent:${grantee.agentId}`;
		case "user":
			return `user:${grantee.userId}`;
		case "session":
			return `session:${grantee.sessionId}`;
	}
}

/** The key a store files a binding subject under, such as `group:reviewers`. */
export function bindingSubjectKey(subject: BindingSubject): string {
	switch (subject.kind) {
		case "user":
			return `user:${subject.userId}`;
		case "service":
			return `service:${subject.serviceId}`;
		case "group":
			return `group:${subject.groupId}`;
	}
}
