// The sandbox egress conformance suite (#331) on the Cloudflare stack's sandboxes: the in-process isolate (the only
// backend with a network: dynamic workers have none and containers run with their internet off), built as the stack
// builds it (`createStackSandboxes`), with the suite's connections gate in front of the shell's network.
// apps/selfhosted/test/gateway/egress-conformance.test.ts runs the same cases on the self-hosted gateway.
import { registerSandboxEgressConformance } from "@kantel/connections/egress-conformance";
import { fakeAccess, ORG } from "@kantel/connections/testing";
import type { CallContext } from "@kantel/contracts";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import { describe, expect, it } from "vitest";
import { createStackSandboxes } from "../src/sandboxes.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "admin" }, organisationId: ORG };

registerSandboxEgressConformance({ describe, expect, it }, "Cloudflare stack", async ({ egress, upstream }) => {
	const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore() });
	const workspace = await workspaces.create(ctx, { owner: { kind: "organisation", organisationId: ORG } });
	const { sandboxes } = createStackSandboxes({
		workspaces,
		access: fakeAccess(["admin"]),
		audit: { append: async () => undefined },
		clock: { now: () => Date.now() },
		backend: "in-process",
		egress,
		upstream,
	});
	return {
		run: (sessionId, command) =>
			sandboxes.run(ctx, { sessionId, workspaceId: workspace.id, tool: "bash", request: { command } }),
	};
});
