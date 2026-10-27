import { registerWorkspaceConformance } from "@harbour/testing/workspace";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@harbour/workspace/memory";
import { describe, expect, it } from "vitest";

registerWorkspaceConformance({ describe, expect, it }, "in-memory workspaces", async (deps, use) => {
	const projectFiles = createMemoryProjectFiles();
	const workspaces = createMemoryWorkspaces({ clock: deps.clock, audit: deps.audit, sources: [projectFiles] });
	await use({ workspaces, projectFiles });
});
