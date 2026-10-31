import { type CallContext, type SessionEndHook, type SessionTeardown, systemContext } from "@kantel/contracts";
import { createMemoryVault } from "@kantel/vault/memory";
import { describe, expect, it } from "vitest";

const human: CallContext = { actor: { kind: "human", userId: "approver-1" }, organisationId: "org-a" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: "org-a",
	projectId: "proj-a",
};
const system: CallContext = { actor: { kind: "system", component: "session-end" }, organisationId: "org-a" };

function recordingHook() {
	const registered: { readonly name: string; readonly teardown: SessionTeardown }[] = [];
	const hook: SessionEndHook = {
		register(name, teardown) {
			registered.push({ name, teardown });
			return { close: async () => {} };
		},
	};
	return { hook, registered };
}

describe("createMemoryVault with a session-end hook", () => {
	it("registers its teardown once as vault, and the teardown ends the session's grants and proposals", async () => {
		const { hook, registered } = recordingHook();
		const vault = createMemoryVault({ sessionEnd: hook });
		expect(registered.map((entry) => entry.name)).toEqual(["vault"]);

		const item = await vault.putItem(human, {
			owner: { kind: "project", organisationId: "org-a", projectId: "proj-a" },
			name: "github-token",
			hosts: ["api.github.com"],
			injection: { header: "Authorization", template: "Bearer {key}" },
			value: "value",
		});
		const route = { host: "api.github.com", methods: ["GET"], pathPrefix: "/" } as const;
		const granted = await vault.propose(agent, { itemId: item.id, route, lifetime: {}, reason: "Read" });
		const decision = await vault.decide(human, {
			proposalId: granted.id,
			outcome: "approve",
			termsHash: granted.termsHash,
			pickedCode: granted.bindingCode,
		});
		const pending = await vault.propose(agent, { itemId: item.id, route, lifetime: { maxUses: 1 }, reason: "Read" });
		const request = {
			organisationId: "org-a",
			projectId: "proj-a",
			agentId: "agent-1",
			sessionId: "session-1",
			method: "GET",
			url: "https://api.github.com/user",
		} as const;
		expect((await vault.decideEgress(systemContext("test"), request)).allow).toBe(true);

		await registered[0]!.teardown(system, {
			sessionId: "session-1",
			organisationId: "org-a",
			projectId: "proj-a",
			agentId: "agent-1",
			reason: "session_ended",
			endedBy: human.actor,
			at: 0,
		});
		expect((await vault.getGrant(human, decision.grantId!)).status).toBe("revoked");
		expect((await vault.getProposal(human, pending.id)).status).toBe("withdrawn");
		expect((await vault.decideEgress(systemContext("test"), request)).allow).toBe(false);
		expect(registered).toHaveLength(1);
	});
});
