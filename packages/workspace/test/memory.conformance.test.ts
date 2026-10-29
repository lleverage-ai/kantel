import { registerWorkspaceConformance } from "@harbour/testing/workspace";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@harbour/workspace/memory";
import { describe, expect, it } from "vitest";

registerWorkspaceConformance(
	{ describe, expect, it },
	"in-memory workspaces",
	async (deps, use) => {
		const projectFiles = createMemoryProjectFiles({ access: deps.access });
		const workspaces = createMemoryWorkspaces({
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles],
			access: deps.access,
			seeders: deps.seeders,
			onSeedStatus: deps.onSeedStatus,
		});
		await use({ workspaces, projectFiles });
	},
	{ projectAccess: true, keyed: true, seeding: true },
);
