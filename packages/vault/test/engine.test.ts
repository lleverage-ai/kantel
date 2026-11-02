import { type CallContext, systemContext } from "@kantel/contracts";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import { createVault, type KantelVault } from "@kantel/vault/engine";
import { createMemoryVaultStore, VAULT_TABLES, type VaultStore } from "@kantel/vault/store";
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
	url: "https://api.github.com/repos/kantel",
} as const;

/** Two vault instances over one store, as two processes would build them. */
function twoInstances(): { readonly store: VaultStore; readonly a: KantelVault; readonly b: KantelVault } {
	const store = createMemoryVaultStore();
	const key = randomCipherKey();
	const open = () => createVault({ store, cipher: createAesGcmCipher({ key }), expiryPollMs: 5 });
	return { store, a: open(), b: open() };
}

/**
 * Two instances over one store, where instance A's reads go through `hook` first: a test uses it to land a change
 * through B at an exact point between two of A's reads.
 */
function hookedInstances(hook: (table: string, op: "get" | "list", id?: string) => Promise<void>) {
	const store = createMemoryVaultStore();
	const key = randomCipherKey();
	const hooked: VaultStore = {
		async get(table, id) {
			await hook(table, "get", id);
			return store.get(table, id);
		},
		async list(table, organisationId) {
			await hook(table, "list");
			return store.list(table, organisationId);
		},
		commit: (writes) => store.commit(writes),
	};
	const a = createVault({ store: hooked, cipher: createAesGcmCipher({ key }), expiryPollMs: 5 });
	const b = createVault({ store, cipher: createAesGcmCipher({ key }), expiryPollMs: 5 });
	return { store, a, b };
}

async function tokenItem(vault: KantelVault) {
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

	it("revokes a grant approved through another instance while the session is being torn down", async () => {
		let armed = false;
		let approve: (() => Promise<unknown>) | undefined;
		const { a, b } = hookedInstances(async (table, op) => {
			// The approval lands just as teardown starts reading the session's proposals.
			if (armed && table === "proposals" && op === "list" && approve !== undefined) {
				const run = approve;
				approve = undefined;
				await run();
			}
		});
		const item = await tokenItem(b);
		const proposal = await b.propose(agent, {
			itemId: item.id,
			route: { host: "api.github.com", methods: ["GET"], pathPrefix: "/" },
			lifetime: {},
			reason: "Read",
		});
		approve = () =>
			b.decide(human, {
				proposalId: proposal.id,
				outcome: "approve",
				termsHash: proposal.termsHash,
				pickedCode: proposal.bindingCode,
			});
		armed = true;
		await a.endSession(human, "session-1", "session_ended");
		armed = false;
		expect(approve).toBeUndefined();
		expect(await b.getProposal(human, proposal.id)).toMatchObject({ status: "approved" });
		expect((await b.decideEgress(gateway, egress)).allow).toBe(false);
		for (const grant of (await b.listGrants(human)).items) expect(grant.status).toBe("revoked");
	});

	it("never overwrites a value another instance's approval pasted onto the same item", async () => {
		let itemReads = 0;
		let second: (() => Promise<unknown>) | undefined;
		const { a, b } = hookedInstances(async (table, op) => {
			// B's approval commits between A's check of the item and the read its conditional update is built from.
			if (table === "items" && op === "get" && second !== undefined && ++itemReads === 2) {
				const run = second;
				second = undefined;
				await run();
			}
		});
		const item = await b.putItem(human, {
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "linear-key",
			hosts: ["api.linear.app"],
			injection: { header: "Authorization", template: "Bearer {key}" },
		});
		const terms = {
			itemId: item.id,
			secret: {
				name: "linear-key",
				hosts: ["api.linear.app"],
				injection: { header: "Authorization", template: "Bearer {key}" },
			},
			route: { host: "api.linear.app", methods: ["POST"], pathPrefix: "/graphql" },
			lifetime: {},
			reason: "Paste the Linear key",
		} as const;
		const first = await b.propose(agent, terms);
		const other = await b.propose(agent, terms);
		const approval = (proposal: typeof first, secretValue: string) => ({
			proposalId: proposal.id,
			outcome: "approve" as const,
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
			secretValue,
		});
		second = () => b.decide(human, approval(other, "value-from-b"));
		await expect(a.decide(human, approval(first, "value-from-a"))).rejects.toMatchObject({ code: "conflict" });
		expect(second).toBeUndefined();
		expect(await b.getItem(human, item.id)).toMatchObject({ hasValue: true, valueVersion: 1 });
		expect(await b.getProposal(human, first.id)).toMatchObject({ status: "pending" });
		const decision = await b.decideEgress(gateway, {
			...egress,
			method: "POST",
			url: "https://api.linear.app/graphql",
		});
		expect(decision.inject?.value).toBe("Bearer value-from-b");
	});

	it("spends no use when the value cannot be opened", async () => {
		const store = createMemoryVaultStore();
		const good = createVault({ store, cipher: createAesGcmCipher({ key: randomCipherKey() }) });
		const wrongKey = createVault({ store, cipher: createAesGcmCipher({ key: randomCipherKey() }) });
		const item = await tokenItem(good);
		const proposal = await good.propose(agent, {
			itemId: item.id,
			route: { host: "api.github.com", methods: ["GET"], pathPrefix: "/" },
			lifetime: { maxUses: 1 },
			reason: "Read once",
		});
		const decision = await good.decide(human, {
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
		});
		await expect(wrongKey.decideEgress(gateway, egress)).rejects.toMatchObject({ code: "unavailable" });
		expect(await good.getGrant(human, decision.grantId!)).toMatchObject({ uses: 0, status: "active" });
		expect((await good.decideEgress(gateway, egress)).allow).toBe(true);
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
