/**
 * What a sharing store keeps its records in: maps (`./memory.ts`) or SQL tables (`./sql.ts`). The rules
 * (`./rules.ts`) decide everything; a repository only reads and writes, and makes the two conditional writes atomic.
 * Not exported from the package.
 */
import type {
	AccessRequest,
	AccessRequestStatus,
	Actor,
	OrganisationId,
	ProjectId,
	RegisteredResource,
	ResourceBinding,
	ResourcePolicy,
	ResourceRef,
	ResourceShare,
	SessionId,
	ShareUse,
	Timestamp,
} from "@kantel/contracts";

export interface ShareFilter {
	readonly resource?: ResourceRef;
	/** `granteeKey`s; any of them. */
	readonly granteeKeys?: readonly string[];
	readonly ownerProjectId?: ProjectId;
	readonly kind?: string;
	readonly parentShareIds?: readonly string[];
}

export interface RequestFilter {
	readonly resource?: ResourceRef;
	readonly granteeKey?: string;
	readonly status?: AccessRequestStatus;
	readonly ownerProjectId?: ProjectId;
	readonly sessionId?: SessionId;
}

export interface BindingFilter {
	/** `kind:id` of the object. */
	readonly object?: { readonly kind: string; readonly id: string };
	readonly subjectKey?: string;
	readonly relation?: string;
}

export interface Revocation {
	readonly revokedAt: Timestamp;
	readonly revokedBy: Actor;
	readonly reason?: string;
}

export interface SharingRepository {
	getResource(organisationId: OrganisationId, resource: ResourceRef): Promise<RegisteredResource | undefined>;
	/** Inserts unless the resource is registered already; resolves what is stored either way. */
	putResource(record: RegisteredResource): Promise<RegisteredResource>;

	getShare(organisationId: OrganisationId, shareId: string): Promise<ResourceShare | undefined>;
	insertShare(share: ResourceShare): Promise<void>;
	/** Every share matching, revoked ones too, newest first. */
	findShares(organisationId: OrganisationId, filter: ShareFilter): Promise<readonly ResourceShare[]>;
	/** Revokes those of `shareIds` not yet revoked; resolves the IDs it revoked. */
	revokeShares(
		organisationId: OrganisationId,
		shareIds: readonly string[],
		revocation: Revocation,
	): Promise<readonly string[]>;

	getRequest(organisationId: OrganisationId, requestId: string): Promise<AccessRequest | undefined>;
	insertRequest(request: AccessRequest): Promise<void>;
	/** Newest first. */
	findRequests(organisationId: OrganisationId, filter: RequestFilter): Promise<readonly AccessRequest[]>;
	/**
	 * Settles a pending request as `settled` says, and inserts `share` with it, atomically; resolves false, writing
	 * nothing, when the request is no longer pending.
	 */
	settleRequest(settled: AccessRequest, share?: ResourceShare): Promise<boolean>;

	/** Inserts unless the same tuple is there; resolves what is stored. */
	putBinding(binding: ResourceBinding): Promise<ResourceBinding>;
	deleteBinding(binding: Omit<ResourceBinding, "grantedBy" | "grantedAt">): Promise<boolean>;
	findBindings(organisationId: OrganisationId, filter: BindingFilter): Promise<readonly ResourceBinding[]>;

	getPolicy(organisationId: OrganisationId, resource: ResourceRef): Promise<ResourcePolicy | undefined>;
	putPolicy(
		organisationId: OrganisationId,
		resource: ResourceRef,
		policy: ResourcePolicy,
		by: Actor,
		at: Timestamp,
	): Promise<void>;

	/** Keeps the first use per session and resource. */
	putUse(use: ShareUse): Promise<void>;
	findUses(organisationId: OrganisationId, sessionId: SessionId): Promise<readonly ShareUse[]>;
}
