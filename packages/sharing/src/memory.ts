/**
 * The in-memory sharing store: the rules (`./rules.ts`) over maps. For tests and single-process targets; the SQL store
 * (`./sql.ts`) behaves the same and passes the same suite.
 */
import {
	type AccessRequest,
	bindingSubjectKey,
	granteeKey,
	type RegisteredResource,
	type ResourceBinding,
	type ResourcePolicy,
	type ResourceShare,
	type ShareUse,
} from "@kantel/contracts";
import type { SharingRepository } from "./repository.ts";
import { createSharingStore, type SharingOptions, type SharingStore } from "./rules.ts";

const copy = <T>(value: T): T => structuredClone(value);

function bindingKey(binding: Pick<ResourceBinding, "organisationId" | "object" | "relation" | "subject">): string {
	return [
		binding.organisationId,
		binding.object.kind,
		binding.object.id,
		binding.relation,
		bindingSubjectKey(binding.subject),
	].join("\u0000");
}

/** A repository over maps. Writes are synchronous, so each conditional write is atomic. */
export function createMemorySharingRepository(): SharingRepository {
	const resources = new Map<string, RegisteredResource>();
	const shares = new Map<string, ResourceShare>();
	const shareOrder: string[] = [];
	const requests = new Map<string, AccessRequest>();
	const requestOrder: string[] = [];
	const bindings = new Map<string, ResourceBinding>();
	const policies = new Map<string, ResourcePolicy>();
	const uses = new Map<string, ShareUse>();
	const resourceKey = (organisationId: string, resource: { kind: string; id: string }) =>
		`${organisationId}\u0000${resource.kind}\u0000${resource.id}`;
	const recordKey = (organisationId: string, id: string) => `${organisationId}\u0000${id}`;

	return {
		async getResource(organisationId, resource) {
			const found = resources.get(resourceKey(organisationId, resource));
			return found === undefined ? undefined : copy(found);
		},
		async putResource(record) {
			const key = resourceKey(record.organisationId, record.resource);
			if (!resources.has(key)) resources.set(key, copy(record));
			return copy(resources.get(key) as RegisteredResource);
		},

		async getShare(organisationId, shareId) {
			const found = shares.get(recordKey(organisationId, shareId));
			return found === undefined ? undefined : copy(found);
		},
		async insertShare(share) {
			const key = recordKey(share.organisationId, share.id);
			shares.set(key, copy(share));
			shareOrder.push(key);
		},
		async findShares(organisationId, filter) {
			const keys = filter.granteeKeys === undefined ? undefined : new Set(filter.granteeKeys);
			const parents = filter.parentShareIds === undefined ? undefined : new Set(filter.parentShareIds);
			const found: ResourceShare[] = [];
			for (let index = shareOrder.length - 1; index >= 0; index -= 1) {
				const share = shares.get(shareOrder[index] as string) as ResourceShare;
				if (share.organisationId !== organisationId) continue;
				if (
					filter.resource !== undefined &&
					(share.resource.kind !== filter.resource.kind || share.resource.id !== filter.resource.id)
				)
					continue;
				if (filter.kind !== undefined && share.resource.kind !== filter.kind) continue;
				if (keys !== undefined && !keys.has(granteeKey(share.grantee))) continue;
				if (
					filter.ownerProjectId !== undefined &&
					(share.owner.kind !== "project" || share.owner.projectId !== filter.ownerProjectId)
				)
					continue;
				if (parents !== undefined && (share.parentShareId === undefined || !parents.has(share.parentShareId))) continue;
				found.push(copy(share));
			}
			return found;
		},
		async revokeShares(organisationId, shareIds, revocation) {
			const revoked: string[] = [];
			for (const id of shareIds) {
				const key = recordKey(organisationId, id);
				const share = shares.get(key);
				if (share === undefined || share.revokedAt !== undefined) continue;
				shares.set(key, {
					...share,
					revokedAt: revocation.revokedAt,
					revokedBy: copy(revocation.revokedBy),
					...(revocation.reason === undefined ? {} : { revokeReason: revocation.reason }),
				});
				revoked.push(id);
			}
			return revoked;
		},

		async getRequest(organisationId, requestId) {
			const found = requests.get(recordKey(organisationId, requestId));
			return found === undefined ? undefined : copy(found);
		},
		async insertRequest(request) {
			const key = recordKey(request.organisationId, request.id);
			requests.set(key, copy(request));
			requestOrder.push(key);
		},
		async findRequests(organisationId, filter) {
			const found: AccessRequest[] = [];
			for (let index = requestOrder.length - 1; index >= 0; index -= 1) {
				const request = requests.get(requestOrder[index] as string) as AccessRequest;
				if (request.organisationId !== organisationId) continue;
				if (
					filter.resource !== undefined &&
					(request.resource.kind !== filter.resource.kind || request.resource.id !== filter.resource.id)
				)
					continue;
				if (filter.granteeKey !== undefined && granteeKey(request.grantee) !== filter.granteeKey) continue;
				if (filter.status !== undefined && request.status !== filter.status) continue;
				if (
					filter.ownerProjectId !== undefined &&
					(request.owner.kind !== "project" || request.owner.projectId !== filter.ownerProjectId)
				)
					continue;
				if (filter.sessionId !== undefined && request.sessionId !== filter.sessionId) continue;
				found.push(copy(request));
			}
			return found;
		},
		async settleRequest(settled, share) {
			const key = recordKey(settled.organisationId, settled.id);
			if (requests.get(key)?.status !== "pending") return false;
			requests.set(key, copy(settled));
			if (share !== undefined) {
				const shareKey = recordKey(share.organisationId, share.id);
				shares.set(shareKey, copy(share));
				shareOrder.push(shareKey);
			}
			return true;
		},

		async putBinding(binding) {
			const key = bindingKey(binding);
			if (!bindings.has(key)) bindings.set(key, copy(binding));
			return copy(bindings.get(key) as ResourceBinding);
		},
		async deleteBinding(binding) {
			return bindings.delete(bindingKey(binding));
		},
		async findBindings(organisationId, filter) {
			const found: ResourceBinding[] = [];
			for (const binding of bindings.values()) {
				if (binding.organisationId !== organisationId) continue;
				if (
					filter.object !== undefined &&
					(binding.object.kind !== filter.object.kind || binding.object.id !== filter.object.id)
				)
					continue;
				if (filter.subjectKey !== undefined && bindingSubjectKey(binding.subject) !== filter.subjectKey) continue;
				if (filter.relation !== undefined && binding.relation !== filter.relation) continue;
				found.push(copy(binding));
			}
			return found.sort((a, b) => a.grantedAt - b.grantedAt);
		},

		async getPolicy(organisationId, resource) {
			const found = policies.get(resourceKey(organisationId, resource));
			return found === undefined ? undefined : copy(found);
		},
		async putPolicy(organisationId, resource, policy) {
			policies.set(resourceKey(organisationId, resource), copy(policy));
		},

		async putUse(use) {
			const key = `${resourceKey(use.organisationId, use.resource)}\u0000${use.sessionId}`;
			if (!uses.has(key)) uses.set(key, copy(use));
		},
		async findUses(organisationId, sessionId) {
			return [...uses.values()]
				.filter((use) => use.organisationId === organisationId && use.sessionId === sessionId)
				.sort((a, b) => a.usedAt - b.usedAt)
				.map(copy);
		},
	};
}

/** The in-memory sharing store. */
export function createMemorySharing(options: SharingOptions): SharingStore {
	return createSharingStore(createMemorySharingRepository(), options);
}
