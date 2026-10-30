/**
 * The resolvers for Harbour's own kinds (docs/design/sharing.md), from the components that own them: a skill's
 * package, a memory space, a vault item and a workspace. Each reads as the sharing store's system context, so a
 * resource of another organisation, or none, resolves `undefined`. A target passes the ones it has to the store.
 */
import {
	HarbourError,
	type Memory,
	RESOURCE_KINDS,
	type ResourceResolver,
	type Skills,
	type Vault,
	type Workspaces,
} from "@harbour/contracts";

export interface ComponentResolverSources {
	readonly skills?: Pick<Skills, "get">;
	readonly memory?: Pick<Memory, "getSpace">;
	readonly vault?: Pick<Vault, "getItem">;
	readonly workspaces?: Pick<Workspaces, "get">;
}

/** `undefined` for a missing record; any other failure is the component's and propagates. */
async function found<T>(read: () => Promise<T>): Promise<T | undefined> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof HarbourError && error.code === "not_found") return undefined;
		throw error;
	}
}

/**
 * Resolvers for the components given. Components may be built after the sharing store (they need project access,
 * which reads shares), so each source is asked for per call.
 */
export function componentResolvers(sources: () => ComponentResolverSources): {
	readonly [kind: string]: ResourceResolver;
} {
	return {
		[RESOURCE_KINDS.skill]: {
			async ownerOf(ctx, resource) {
				const skills = sources().skills;
				const pkg = skills === undefined ? undefined : await found(() => skills.get(ctx, resource.id));
				return pkg === undefined ? undefined : { owner: pkg.owner, name: pkg.name };
			},
		},
		[RESOURCE_KINDS.memorySpace]: {
			async ownerOf(ctx, resource) {
				const memory = sources().memory;
				const space = memory === undefined ? undefined : await found(() => memory.getSpace(ctx, resource.id));
				return space === undefined ? undefined : { owner: space.owner, name: space.name };
			},
		},
		[RESOURCE_KINDS.vaultItem]: {
			async ownerOf(ctx, resource) {
				const vault = sources().vault;
				const item = vault === undefined ? undefined : await found(() => vault.getItem(ctx, resource.id));
				return item === undefined ? undefined : { owner: item.owner, name: item.name };
			},
		},
		[RESOURCE_KINDS.workspace]: {
			async ownerOf(ctx, resource) {
				const workspaces = sources().workspaces;
				const record = workspaces === undefined ? undefined : await found(() => workspaces.get(ctx, resource.id));
				// A session's own workspace is not shared: it is the session's.
				if (record === undefined || record.sessionId !== undefined) return undefined;
				return { owner: record.owner, name: record.id };
			},
		},
	};
}
