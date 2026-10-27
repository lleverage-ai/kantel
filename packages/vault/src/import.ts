/**
 * Imports a host's grants (such as Sal's) as vault items and policies: the vault side of "Imports Sal's grants that
 * have a host mapping". Only grants mapped to hosts can be imported; a local-only grant has nowhere the egress proxy
 * could inject it, so it is listed as refused rather than imported.
 */
import {
	type CallContext,
	HarbourError,
	type InjectionRule,
	isHarbourError,
	type OwnerRef,
	type PolicySelector,
	type RouteScope,
	type Vault,
	type VaultItem,
	type VaultPolicy,
} from "@harbour/contracts";
import { canonicalJson } from "./index.ts";

/** One grant as a host exports it: a credential, the hosts it is mapped to, and the routes and sessions it allows. */
export interface HostGrant {
	readonly name: string;
	readonly description?: string;
	/** The hosts the credential is mapped to. Empty for a local-only grant, which is refused. */
	readonly hosts: readonly string[];
	readonly injection: InjectionRule;
	/** The credential, set on a newly created item. A reused item keeps the value it has. */
	readonly value?: string;
	/** One policy per route; each route's host must be one of `hosts`. */
	readonly routes: readonly RouteScope[];
	/** Who the policies apply to. A selector naming a project puts the item in that project; else the organisation. */
	readonly selector: PolicySelector;
}

export interface ImportedHostGrant {
	readonly name: string;
	readonly itemId: string;
	/** `created` for a new item, `reused` for an existing item of the same name and owner. */
	readonly item: "created" | "reused";
	/** The grant's policies, one per route: those created now and those an earlier import created. */
	readonly policyIds: readonly string[];
	readonly createdPolicies: number;
}

export interface RefusedHostGrant {
	readonly name: string;
	readonly code: "invalid" | "refused";
	readonly message: string;
}

export interface HostGrantImport {
	readonly imported: readonly ImportedHostGrant[];
	readonly refused: readonly RefusedHostGrant[];
}

async function everyPage<T>(list: (cursor?: string) => Promise<{ items: readonly T[]; nextCursor?: string }>) {
	const all: T[] = [];
	let cursor: string | undefined;
	do {
		const page = await list(cursor);
		all.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return all;
}

function ownerFor(selector: PolicySelector): OwnerRef {
	return selector.projectId === undefined
		? { kind: "organisation", organisationId: selector.organisationId }
		: { kind: "project", organisationId: selector.organisationId, projectId: selector.projectId };
}

function sameOwner(a: OwnerRef, b: OwnerRef): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

/**
 * Creates an item per grant (or reuses the one of the same name and owner) and a policy per route, through `vault`
 * as `ctx`, so every rule and access check applies. Idempotent: a second run creates nothing and lists the same
 * items and policies. A grant without a host mapping, or with a route to a host it is not mapped to, is listed in
 * `refused` as `invalid`; one the vault refuses (such as a route outside the ceiling) as `refused`. Any other error,
 * such as a caller who may not create items, is thrown.
 */
export async function importHostGrants(
	vault: Vault,
	ctx: CallContext,
	grants: readonly HostGrant[],
): Promise<HostGrantImport> {
	const imported: ImportedHostGrant[] = [];
	const refused: RefusedHostGrant[] = [];
	const items: VaultItem[] = await everyPage((cursor) =>
		vault.listItems(ctx, cursor === undefined ? undefined : { cursor }),
	);
	const policies: VaultPolicy[] = await everyPage((cursor) =>
		vault.listPolicies(ctx, cursor === undefined ? undefined : { cursor }),
	);

	for (const grant of grants) {
		try {
			if (grant.hosts.length === 0 || grant.routes.length === 0) {
				throw new HarbourError("invalid", "The grant has no host mapping: it is local-only and cannot be imported");
			}
			const unmapped = grant.routes.find((route) => !grant.hosts.includes(route.host));
			if (unmapped !== undefined) {
				throw new HarbourError("invalid", `A route goes to ${unmapped.host}, which the grant is not mapped to`);
			}
			const owner = ownerFor(grant.selector);
			let item = items.find((candidate) => candidate.name === grant.name && sameOwner(candidate.owner, owner));
			const reused = item !== undefined;
			if (item === undefined) {
				item = await vault.putItem(ctx, {
					owner,
					name: grant.name,
					...(grant.description === undefined ? {} : { description: grant.description }),
					hosts: grant.hosts,
					injection: grant.injection,
					...(grant.value === undefined ? {} : { value: grant.value }),
				});
				items.push(item);
			}
			const policyIds: string[] = [];
			let createdPolicies = 0;
			for (const route of grant.routes) {
				const existing = policies.find(
					(policy) =>
						policy.itemId === item.id &&
						policy.revokedAt === undefined &&
						canonicalJson(policy.selector) === canonicalJson(grant.selector) &&
						canonicalJson(policy.route) === canonicalJson(route),
				);
				if (existing !== undefined) {
					policyIds.push(existing.id);
					continue;
				}
				const policy = await vault.putPolicy(ctx, { itemId: item.id, selector: grant.selector, route });
				policies.push(policy);
				policyIds.push(policy.id);
				createdPolicies += 1;
			}
			imported.push({
				name: grant.name,
				itemId: item.id,
				item: reused ? "reused" : "created",
				policyIds,
				createdPolicies,
			});
		} catch (error) {
			if (isHarbourError(error, "invalid") || isHarbourError(error, "refused")) {
				refused.push({ name: grant.name, code: error.code as "invalid" | "refused", message: error.message });
				continue;
			}
			throw error;
		}
	}
	return { imported, refused };
}
