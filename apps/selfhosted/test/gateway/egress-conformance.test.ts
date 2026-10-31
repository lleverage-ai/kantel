// The sandbox egress conformance suite (#331) on the self-hosted gateway's sandboxes: its in-process isolate, built as
// the gateway builds it (`createGatewaySandboxes`), with the suite's connections gate in front of the shell's network.
// apps/cloudflare/test/egress-conformance.test.ts runs the same cases on the Cloudflare stack's sandboxes.
import { registerSandboxEgressConformance } from "@kantel/connections/egress-conformance";
import { fakeAccess, ORG } from "@kantel/connections/testing";
import type { CallContext } from "@kantel/contracts";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import { describe, expect, it } from "vitest";
import { createGatewaySandboxes } from "../../src/gateway/sandboxes.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "admin" }, organisationId: ORG };

registerSandboxEgressConformance({ describe, expect, it }, "self-hosted gateway", async ({ egress, upstream }) => {
	const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore() });
	const workspace = await workspaces.create(ctx, { owner: { kind: "organisation", organisationId: ORG } });
	const sandboxes = createGatewaySandboxes().attach({
		workspaces,
		access: fakeAccess(["admin"]),
		audit: { append: async () => undefined },
		egress: () => egress,
		upstream,
	});
	return {
		run: (sessionId, command) =>
			sandboxes.run(ctx, { sessionId, workspaceId: workspace.id, tool: "bash", request: { command } }),
	};
});
