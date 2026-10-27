import { createMemorySandboxes } from "@harbour/sandbox/memory";
import { registerSandboxConformance } from "@harbour/testing/sandbox";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@harbour/workspace/memory";
import { describe, expect, it } from "vitest";

registerSandboxConformance({ describe, expect, it }, "in-memory sandboxes", async (deps, use) => {
	const projectFiles = createMemoryProjectFiles();
	const workspaces = createMemoryWorkspaces({ clock: deps.clock, audit: deps.audit, sources: [projectFiles] });
	const sandboxes = createMemorySandboxes({ workspaces, clock: deps.clock, audit: deps.audit });
	await use({ sandboxes, workspaces, projectFiles });
});
