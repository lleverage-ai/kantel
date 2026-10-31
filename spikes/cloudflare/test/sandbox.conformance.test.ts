import { registerSandboxConformance } from "@kantel/testing/sandbox";
import { createMemoryProjectFiles } from "@kantel/workspace/memory";
import { describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../src/object-store.ts";
import { CloudflareSandboxes } from "../src/sandbox.ts";
import { ObjectStoreWorkspaces } from "../src/workspace.ts";
import { inProcessIsolate, SimulatedContainer } from "./backends.ts";

// The spike's Sandboxes with the real isolate shell and a simulated container (see backends.ts).
registerSandboxConformance(
	{ describe, expect, it },
	"cloudflare sandboxes (isolate shell, simulated container)",
	async (deps, use) => {
		const projectFiles = createMemoryProjectFiles();
		const workspaces = new ObjectStoreWorkspaces({
			store: new MemoryObjectStore(),
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles],
		});
		const sandboxes = new CloudflareSandboxes({
			workspaces,
			isolate: inProcessIsolate(workspaces),
			container: new SimulatedContainer(workspaces),
			clock: deps.clock,
			audit: deps.audit,
		});
		await use({ sandboxes, workspaces, projectFiles });
	},
);
