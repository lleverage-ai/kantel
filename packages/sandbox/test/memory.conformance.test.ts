import { createMemorySandboxes } from "@harbour/sandbox/memory";
import { registerSandboxConformance } from "@harbour/testing/sandbox";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@harbour/workspace/memory";
import { describe, expect, it } from "vitest";

registerSandboxConformance(
	{ describe, expect, it },
	"in-memory sandboxes",
	async (deps, use) => {
		const projectFiles = createMemoryProjectFiles({ access: deps.access });
		const workspaces = createMemoryWorkspaces({
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles],
			access: deps.access,
		});
		const sandboxes = createMemorySandboxes({ workspaces, clock: deps.clock, audit: deps.audit, access: deps.access });
		await use({ sandboxes, workspaces, projectFiles });
	},
	{ projectAccess: true },
);
