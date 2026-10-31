import { createMemoryCapabilityRegistry } from "@kantel/codemode/memory";
import type { CallContext, SessionEndHook, SessionTeardown } from "@kantel/contracts";
import { describe, expect, it } from "vitest";

describe("createMemoryCapabilityRegistry with a session-end hook", () => {
	it("registers its teardown once as capability, and the teardown revokes the session's grants", async () => {
		const registered: { readonly name: string; readonly teardown: SessionTeardown }[] = [];
		const hook: SessionEndHook = {
			register(name, teardown) {
				registered.push({ name, teardown });
				return { close: async () => {} };
			},
		};
		const registry = createMemoryCapabilityRegistry({ sessionEnd: hook });
		expect(registered.map((entry) => entry.name)).toEqual(["capability"]);

		const operator: CallContext = { actor: { kind: "human", userId: "operator-1" }, organisationId: "org-a" };
		const ended = await registry.grant(operator, { selector: { sessionId: "session-1" }, capabilities: ["tool.run"] });
		const kept = await registry.grant(operator, { selector: { sessionId: "session-2" }, capabilities: ["tool.run"] });
		await registered[0]!.teardown(
			{ actor: { kind: "system", component: "session-end" }, organisationId: "org-a" },
			{
				sessionId: "session-1",
				organisationId: "org-a",
				projectId: "proj-a",
				agentId: "agent-1",
				reason: "session_ended",
				endedBy: operator.actor,
				at: 0,
			},
		);
		const statuses = Object.fromEntries(
			(await registry.listGrants(operator)).items.map((grant) => [grant.id, grant.status]),
		);
		expect(statuses).toEqual({ [ended.id]: "revoked", [kept.id]: "active" });
		expect(registered).toHaveLength(1);
	});
});
