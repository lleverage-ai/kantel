import { registerWorkspaceConformance } from "@harbour/testing/workspace";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { createWorkspaceOrgFiles, createWorkspaceProjectFiles } from "@harbour/workspace/mounts";
import { describe, expect, it } from "vitest";

// The whole workspace suite again, with `/project` and `/org` served from trees kept in workspaces rather than in
// memory maps: the sources every target uses.
registerWorkspaceConformance(
	{ describe, expect, it },
	"workspaces with workspace-backed project files",
	async (deps, use) => {
		const trees = createMemoryWorkspaces({ clock: deps.clock, access: deps.access });
		const projectFiles = createWorkspaceProjectFiles({ workspaces: trees, access: deps.access });
		const orgFiles = createWorkspaceOrgFiles({ workspaces: trees, access: deps.access });
		const workspaces = createMemoryWorkspaces({
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles, orgFiles],
			access: deps.access,
		});
		await use({ workspaces, projectFiles, orgFiles });
	},
	{ projectAccess: true, keyed: true, orgFiles: true },
);
