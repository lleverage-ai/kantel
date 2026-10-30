/**
 * The `import` permission an API key can carry (`API_KEY_PERMISSIONS`): a host's import script loads skills and memory
 * snapshots with a key rather than an organisation admin's sign-in. It reaches the two import operations and nothing
 * else: `POST /v1/skills/import` (`skills.importRevision`) and `POST /v1/memory/spaces/{spaceId}/snapshot`
 * (`memory.importSnapshot`). Creating a space, and every other admin route, still needs an organisation admin.
 *
 * Two checks stand in front of an import, and the permission answers both: the gateway's own (`mayImport`, else
 * organisation admin) and the stores' organisation-wide check (`withKeyImports`): a role check for a skill, a resource
 * check on an organisation-owned memory space. A project-owned import is still the key's role on that project, as
 * before.
 */
import {
	type AccessCheck,
	type AccessResult,
	type CallContext,
	DEFAULT_RESOURCE_POLICY,
	type IdentityDirectory,
	type OrganisationId,
	type ProjectAccess,
	type ResourceAccessResult,
	type ResourceCheck,
	type ResourcePolicy,
	type ResourceRef,
	type SystemContext,
	systemContext,
} from "@harbour/contracts";

/** The store operations the `import` permission answers for. */
export const KEY_IMPORT_OPERATIONS: ReadonlySet<string> = new Set(["skills.importRevision", "memory.importSnapshot"]);

/** The stack asks identity about a caller's key as itself: `keyPermits` is a worker call. */
const IMPORT_CONTEXT = systemContext("stack.imports");

/** Whether the caller signed in with a live key of its organisation that carries `import`. */
export function keyMayImport(identity: Pick<IdentityDirectory, "keyPermits">, ctx: CallContext): Promise<boolean> {
	return identity.keyPermits(IMPORT_CONTEXT, ctx.actor, ctx.organisationId, "import");
}

/**
 * The gateway's check before an import: a key with `import`, or else `otherwise` (the organisation admin's role), whose
 * refusal is the answer.
 */
export function mayImport(
	identity: Pick<IdentityDirectory, "keyPermits">,
	otherwise: (ctx: CallContext) => Promise<void>,
): (ctx: CallContext) => Promise<void> {
	return async (ctx) => {
		if (await keyMayImport(identity, ctx)) return;
		await otherwise(ctx);
	};
}

/** A resource's policy (the sharing store's `policyOf`), for an import the permission passes. */
export type ImportPolicyOf = (
	ctx: SystemContext,
	organisationId: OrganisationId,
	resource: ResourceRef,
) => Promise<ResourcePolicy>;

/** Whether a resource check is a change to an organisation-owned resource for one of `KEY_IMPORT_OPERATIONS`. */
function organisationImport(ctx: CallContext, check: ResourceCheck): boolean {
	return (
		KEY_IMPORT_OPERATIONS.has(check.operation) &&
		check.permission !== "use" &&
		check.owner.kind === "organisation" &&
		check.owner.organisationId === ctx.organisationId &&
		check.projectId === undefined &&
		check.sessionId === undefined
	);
}

/**
 * `access`, except that an organisation-wide check for one of `KEY_IMPORT_OPERATIONS` passes for a key with `import`:
 * a role check with no project or session, or a resource check changing an organisation-owned resource (a memory
 * space's snapshot), which passes as the owner would, with the resource's policy from `policyOf`. Every other check, a
 * project's included, is `access`'s.
 */
export function withKeyImports(
	access: ProjectAccess,
	identity: Pick<IdentityDirectory, "keyPermits">,
	policyOf?: ImportPolicyOf,
): ProjectAccess {
	const passed = async (ctx: CallContext, check: ResourceCheck): Promise<ResourceAccessResult> => ({
		via: "owner",
		policy:
			policyOf === undefined
				? DEFAULT_RESOURCE_POLICY
				: await policyOf(IMPORT_CONTEXT, ctx.organisationId, { kind: check.resource.kind, id: check.resource.id }),
	});
	return {
		async require(ctx: CallContext, check: AccessCheck): Promise<AccessResult> {
			if (
				KEY_IMPORT_OPERATIONS.has(check.operation) &&
				check.projectId === undefined &&
				check.sessionId === undefined &&
				(await keyMayImport(identity, ctx))
			) {
				return {};
			}
			return access.require(ctx, check);
		},
		allows: (ctx, check) => access.allows(ctx, check),
		async resource(ctx, check) {
			if (organisationImport(ctx, check) && (await keyMayImport(identity, ctx))) {
				return passed(ctx, check);
			}
			return access.resource(ctx, check);
		},
		allowsResource: (ctx, check) => access.allowsResource(ctx, check),
	};
}
