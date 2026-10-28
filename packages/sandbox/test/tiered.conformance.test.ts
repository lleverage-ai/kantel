import { createInProcessIsolateBackend } from "@harbour/sandbox/isolate";
import { createTieredSandboxes } from "@harbour/sandbox/tiered";
import { registerSandboxConformance } from "@harbour/testing/sandbox";
import { createMemoryProjectFiles } from "@harbour/workspace/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@harbour/workspace/stored";
import { describe, expect, it } from "vitest";
import { SimulatedContainer } from "./backends.ts";

// The tiered sandboxes with the real isolate shell (just-bash, in process) and a simulated container.
registerSandboxConformance(
	{ describe, expect, it },
	"tiered sandboxes (in-process isolate, simulated container)",
	async (deps, use) => {
		const projectFiles = createMemoryProjectFiles({ access: deps.access });
		const workspaces = createStoredWorkspaces({
			store: createMemoryWorkspaceStore(),
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles],
			access: deps.access,
		});
		const sandboxes = createTieredSandboxes({
			workspaces,
			isolate: createInProcessIsolateBackend(workspaces),
			container: new SimulatedContainer(workspaces),
			clock: deps.clock,
			audit: deps.audit,
			access: deps.access,
		});
		await use({ sandboxes, workspaces, projectFiles });
	},
	{ projectAccess: true },
);
