import { type CallContext, systemContext } from "@harbour/contracts";
import { createAesGcmCipher, randomCipherKey } from "@harbour/vault/cipher";
import { createVault, type HarbourVault } from "@harbour/vault/engine";
import { createMemoryVaultStore, VAULT_TABLES, type VaultStore } from "@harbour/vault/store";
import { describe, expect, it } from "vitest";

const human: CallContext = { actor: { kind: "human", userId: "approver-1" }, organisationId: "org-a" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: "org-a",
	projectId: "proj-a",
};
const gateway = systemContext("egress-gateway");
const VALUE = "engine-test-value-3b7e";
const egress = {
	organisationId: "org-a",
	projectId: "proj-a",
	agentId: "agent-1",
	sessionId: "session-1",
	method: "GET",
	url: "https://api.github.com/repos/harbour",
} as const;

/** Two vault instances over one store, as two processes would build them. */
function twoInstances(): { readonly store: VaultStore; readonly a: HarbourVault; readonly b: HarbourVault } {
	const store = createMemoryVaultStore();
	const key = randomCipherKey();
	const open = () => createVault({ store, cipher: createAesGcmCipher({ key }), expiryPollMs: 5 });
	return { store, a: open(), b: open() };
}

async function tokenItem(vault: HarbourVault) {
	return vault.putItem(human, {
		owner: { kind: "organisation", organisationId: "org-a" },
		name: "github-token",
		hosts: ["api.github.com"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: VALUE,
	});
}

describe("createVault over one store from two instances", () => {
	it("keeps values sealed in the store", async () => {
		const { store, a } = twoInstances();
		await tokenItem(a);
		for (const table of VAULT_TABLES) {
			for (const row of await store.list(table, "org-a")) expect(row.data).not.toContain(VALUE);
		}
	});

	it("settles concurrent decisions through both instances exactly once", async () => {
		const { a, b } = twoInstances();
		const item = await tokenItem(a);
		const proposal = await a.propose(agent, {
			itemId: item.id,
			route: { host: "api.github.com", methods: ["POST"], pathPrefix: "/" },
			lifetime: { maxUses: 1 },
			reason: "Open an issue",
		});
		const approve = {
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
		} as const;
		const results = await Promise.allSettled([
			a.decide(human, approve),
			b.decide(human, approve),
			b.decide(human, { proposalId: proposal.id, outcome: "deny" }),
			a.withdraw(agent, proposal.id),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		for (const result of results) {
			if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "conflict" });
		}
		const stored = (await b.getProposal(human, proposal.id)).status;
		const grants = (await a.listGrants(human)).items.length;
		expect(grants).toBe(stored === "approved" ? 1 : 0);
	});

	it("never spends a grant past maxUses under concurrent egress from both instances", async () => {
		const { a, b } = twoInstances();
		const item = await tokenItem(a);
		const proposal = await a.propose(agent, {
			itemId: item.id,
			route: { host: "api.github.com", methods: ["GET"], pathPrefix: "/repos" },
			lifetime: { maxUses: 3 },
			reason: "Read the repository",
		});
		const decision = await b.decide(human, {
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
		});
		const decisions = await Promise.all(
			Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? a : b).decideEgress(gateway, egress)),
		);
		expect(decisions.filter((result) => result.allow)).toHaveLength(3);
		expect(await a.getGrant(human, decision.grantId!)).toMatchObject({ uses: 3, status: "exhausted" });
	});

	it("resolves a wait on one instance for a decision made through the other", async () => {
		const { a, b } = twoInstances();
		const item = await tokenItem(a);
		const proposal = await a.propose(agent, {
			itemId: item.id,
			route: { host: "api.github.com", methods: ["GET"], pathPrefix: "/" },
			lifetime: {},
			reason: "Read",
		});
		const waiting = a.waitForOutcome(agent, proposal.id);
		await b.decide(human, {
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
		});
		expect(await waiting).toMatchObject({ status: "approved", effectiveTerms: { itemId: item.id } });
	});
});
