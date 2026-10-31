import { registerWorkspaceConformance } from "@kantel/testing/workspace";
import { createMemoryProjectFiles } from "@kantel/workspace/memory";
import { createWorkspaceOrgFiles, createWorkspaceProjectFiles } from "@kantel/workspace/mounts";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import { describe, expect, it } from "vitest";

// The stored workspaces every durable target wraps, over an in-memory store: the targets add only storage.
registerWorkspaceConformance(
	{ describe, expect, it },
	"stored workspaces",
	async (deps, use) => {
		const projectFiles = createMemoryProjectFiles({ access: deps.access });
		const workspaces = createStoredWorkspaces({
			store: createMemoryWorkspaceStore(),
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles],
			access: deps.access,
			seeders: deps.seeders,
			onSeedStatus: deps.onSeedStatus,
		});
		await use({ workspaces, projectFiles });
	},
	{ projectAccess: true, keyed: true, seeding: true, fork: true },
);

// The same with lazy hydration for every seed, however small: each case reads its seeded files out of staging packs
// until the background pass has copied them, and nothing a caller sees may differ.
registerWorkspaceConformance(
	{ describe, expect, it },
	"stored workspaces, lazily hydrated",
	async (deps, use) => {
		const projectFiles = createMemoryProjectFiles({ access: deps.access });
		const workspaces = createStoredWorkspaces({
			store: createMemoryWorkspaceStore(),
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles],
			access: deps.access,
			seeders: deps.seeders,
			onSeedStatus: deps.onSeedStatus,
			hydration: { minBodies: 0 },
		});
		await use({ workspaces, projectFiles });
		await workspaces.hydrationSettled();
	},
	{ projectAccess: true, keyed: true, seeding: true, fork: true },
);

registerWorkspaceConformance(
	{ describe, expect, it },
	"stored workspaces with workspace-backed project files",
	async (deps, use) => {
		const store = createMemoryWorkspaceStore();
		const trees = createStoredWorkspaces({ store, clock: deps.clock, access: deps.access });
		const projectFiles = createWorkspaceProjectFiles({ workspaces: trees, access: deps.access });
		const orgFiles = createWorkspaceOrgFiles({ workspaces: trees, access: deps.access });
		const workspaces = createStoredWorkspaces({
			store,
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles, orgFiles],
			access: deps.access,
		});
		await use({ workspaces, projectFiles, orgFiles });
	},
	{ projectAccess: true, keyed: true, orgFiles: true },
);
