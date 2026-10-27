/**
 * Identity and tenancy. Organisations own projects; users and service identities hold a role per project (or across
 * the organisation); host apps call with API keys scoped to projects. Every call resolves to an `Actor`.
 */
import type {
	Actor,
	ApiKeyId,
	CallContext,
	OrganisationId,
	Page,
	PageRequest,
	ProjectId,
	ServiceId,
	SystemContext,
	Timestamp,
	UserId,
} from "./common.ts";

/** Roles, weakest first. Each includes what the ones before it may do. */
export type Role = "viewer" | "operator" | "admin";
export const ROLES: readonly Role[] = ["viewer", "operator", "admin"];

/** Whether `held` includes `needed`. */
export function roleSatisfies(held: Role, needed: Role): boolean {
	return ROLES.indexOf(held) >= ROLES.indexOf(needed);
}

export interface Organisation {
	readonly id: OrganisationId;
	readonly name: string;
	readonly createdAt: Timestamp;
}

export interface Project {
	readonly id: ProjectId;
	readonly organisationId: OrganisationId;
	readonly name: string;
	readonly createdAt: Timestamp;
}

export interface User {
	readonly id: UserId;
	readonly name: string;
	readonly email?: string;
	/** The subject at the sign-in provider (Cloudflare Access or OIDC). */
	readonly externalSubject?: string;
	readonly createdAt: Timestamp;
}

/** A host app (Sal's supervisor, Lleverage) acting inside one organisation. */
export interface ServiceIdentity {
	readonly id: ServiceId;
	readonly organisationId: OrganisationId;
	readonly name: string;
	readonly createdAt: Timestamp;
}

export type Principal =
	| { readonly kind: "user"; readonly userId: UserId }
	| { readonly kind: "service"; readonly serviceId: ServiceId };

/** A role held by a principal on one project, or on every project of the organisation when `projectId` is absent. */
export interface RoleBinding {
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly principal: Principal;
	readonly role: Role;
	readonly grantedAt: Timestamp;
	readonly grantedBy: Actor;
}

/** An API key's record. The secret is never stored or returned after issue; only its prefix is. */
export interface ApiKey {
	readonly id: ApiKeyId;
	readonly serviceId: ServiceId;
	readonly organisationId: OrganisationId;
	/** The only projects this key may act in. */
	readonly projectIds: readonly ProjectId[];
	readonly role: Role;
	readonly prefix: string;
	readonly createdAt: Timestamp;
	readonly expiresAt?: Timestamp;
	readonly revokedAt?: Timestamp;
}

export interface IssuedApiKey {
	readonly key: ApiKey;
	/** Shown once. */
	readonly secret: string;
}

/** What an authenticated credential may do. */
export interface Authentication {
	readonly actor: Actor;
	readonly organisationId: OrganisationId;
	/** For an API key, its projects; for a user, absent (roles decide per project). */
	readonly projectIds?: readonly ProjectId[];
	readonly role?: Role;
}

export interface IdentityDirectory {
	/** Creates an organisation. Only a `system` actor may (bootstrap); the creator names its first admin. */
	createOrganisation(
		ctx: CallContext,
		input: { readonly name: string; readonly admin: Principal },
	): Promise<Organisation>;
	getOrganisation(ctx: CallContext, id: OrganisationId): Promise<Organisation>;

	/** Needs admin on the organisation. */
	createProject(ctx: CallContext, input: { readonly name: string }): Promise<Project>;
	getProject(ctx: CallContext, id: ProjectId): Promise<Project>;
	/** Projects of `ctx.organisationId` that the actor holds any role on. */
	listProjects(ctx: CallContext, page?: PageRequest): Promise<Page<Project>>;

	createUser(
		ctx: CallContext,
		input: { readonly name: string; readonly email?: string; readonly externalSubject?: string },
	): Promise<User>;
	getUser(ctx: CallContext, id: UserId): Promise<User>;

	createServiceIdentity(ctx: CallContext, input: { readonly name: string }): Promise<ServiceIdentity>;

	/** Needs admin on the project (or organisation). Replaces an existing binding for the same principal and scope. */
	grantRole(
		ctx: CallContext,
		input: { readonly principal: Principal; readonly role: Role; readonly projectId?: ProjectId },
	): Promise<RoleBinding>;
	revokeRole(ctx: CallContext, input: { readonly principal: Principal; readonly projectId?: ProjectId }): Promise<void>;
	listRoleBindings(ctx: CallContext, input?: { readonly projectId?: ProjectId }): Promise<readonly RoleBinding[]>;

	/** Issues a key for a service identity, scoped to projects in its organisation. Needs admin on each project. */
	issueApiKey(
		ctx: CallContext,
		input: {
			readonly serviceId: ServiceId;
			readonly projectIds: readonly ProjectId[];
			readonly role: Role;
			readonly expiresAt?: Timestamp;
		},
	): Promise<IssuedApiKey>;
	revokeApiKey(ctx: CallContext, keyId: ApiKeyId): Promise<void>;
	listApiKeys(ctx: CallContext, input?: { readonly serviceId?: ServiceId }): Promise<readonly ApiKey[]>;

	/**
	 * Resolves an API key secret. Unknown, revoked or expired keys reject with `forbidden` (never `not_found`, so a
	 * caller learns nothing about which keys exist). A worker call (settled question 13): Harbour's gateway calls it as
	 * `system` to learn who a request is from; any other actor is `forbidden`.
	 */
	authenticateApiKey(ctx: SystemContext, secret: string): Promise<Authentication>;

	/**
	 * The strongest role `actor` holds on `projectId` (organisation-wide bindings count), or undefined. A worker call
	 * (settled question 13): `ProjectAccess` asks it as `system`; any other actor is `forbidden`.
	 */
	roleOf(
		ctx: SystemContext,
		actor: Actor,
		organisationId: OrganisationId,
		projectId?: ProjectId,
	): Promise<Role | undefined>;

	/**
	 * Rejects with `forbidden` unless `ctx.actor` holds at least `needed` on `ctx.projectId` (or on the organisation
	 * when the call has no project). `system` actors pass. An `agent` actor acts with its session's project only,
	 * resolved by the runtime, and is never authorised here.
	 */
	authorize(ctx: CallContext, needed: Role): Promise<void>;
}
