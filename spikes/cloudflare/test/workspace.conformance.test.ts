import { registerWorkspaceConformance } from "@kantel/testing/workspace";
import { createMemoryProjectFiles } from "@kantel/workspace/memory";
import { describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../src/object-store.ts";
import { ObjectStoreWorkspaces } from "../src/workspace.ts";

// The same class the deployed spike runs over R2, here over an in-memory store with R2's conditional puts.
registerWorkspaceConformance({ describe, expect, it }, "object-store workspaces (R2 layout)", async (deps, use) => {
	const projectFiles = createMemoryProjectFiles();
	const workspaces = new ObjectStoreWorkspaces({
		store: new MemoryObjectStore(),
		clock: deps.clock,
		audit: deps.audit,
		sources: [projectFiles],
	});
	await use({ workspaces, projectFiles });
});
