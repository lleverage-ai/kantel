import { type ConnectionRuleInput, type DecisionInput, KantelError, type Proposal } from "@kantel/contracts";
import type { ConnectionApprovalCard } from "@kantel/protocol";
import { approvalRefusal, type ConnectionApprovalDecided, type PasskeyCheck } from "@kantel/ui";
import { describe, expect, it } from "vitest";
import { type ConnectionApprovalsOptions, connectionApprovalActions } from "./connection-approvals.ts";

// Deciding a connection request from its call (#460) over the vault page's seam: one click approves with the card's
// own code, the passkey first where there is one, and a choice's rule saved before the approval, so nothing is
// approved when it isn't saved.

const NOW = 1_793_500_000_000;

const proposal: Proposal = {
	id: "prop_pr",
	organisationId: "org_1" as Proposal["organisationId"],
	requester: {
		actor: { kind: "agent", agentId: "agent_1" as never, sessionId: "sess_1" as never },
		agentId: "agent_1" as never,
		sessionId: "sess_1" as never,
	},
	kind: "request",
	terms: {
		route: { host: "api.github.com", methods: ["POST"], pathPrefix: "/repos/tvdavies/harbour/pulls" },
		lifetime: { maxUses: 1 },
		reason: "Opening the PR you asked for.",
		request: {
			connectionId: "conn_github",
			connectionName: "GitHub",
			kind: "http",
			method: "POST",
			host: "api.github.com",
			path: "/repos/tvdavies/harbour/pulls",
			digest: "d1",
		} as never,
	},
	termsHash: "hash_1",
	bindingCode: "K7Q-2MX",
	status: "pending",
	createdAt: NOW - 5000,
	expiresAt: NOW + 600_000,
	link: "/connections/requests/prop_pr",
};

const card: ConnectionApprovalCard = {
	type: "connection.approval",
	proposalId: "prop_pr",
	status: "pending",
	bindingCode: "K7Q-2MX",
	what: "POST api.github.com/repos/tvdavies/harbour/pulls through GitHub",
	why: "Opening the PR you asked for.",
	host: "api.github.com",
	methods: ["POST"],
	pathPrefix: "/repos/tvdavies/harbour/pulls",
	termsSource: "agent-proposed",
	expiresAt: NOW + 600_000,
	link: "https://kantel.example/connections/requests/prop_pr",
	request: {
		connectionId: "conn_github",
		connectionName: "GitHub",
		kind: "http",
		method: "POST",
		url: "https://api.github.com/repos/tvdavies/harbour/pulls",
		digest: "d1",
	},
	callId: "toolu_pr",
};

/** A vault that records what is asked of it, in order. */
function fakeVault(options: { passkey?: "confirmed" | "cancelled"; ruleFails?: boolean } = {}) {
	const log: string[] = [];
	const decisions: DecisionInput[] = [];
	const rules: ConnectionRuleInput[] = [];
	const decided: Record<string, ConnectionApprovalDecided> = {};
	const passkey: PasskeyCheck | undefined =
		options.passkey === undefined
			? undefined
			: async () => {
					log.push("passkey");
					return options.passkey!;
				};
	const vault: ConnectionApprovalsOptions["vault"] = {
		viewer: { userId: "user_tom" as never, name: "Tom Davies" },
		request: async () => ({ proposal, codeRequired: true, requester: {} as never }),
		decide: async (input) => {
			log.push(`decide ${input.outcome}`);
			decisions.push(input);
			return {} as never;
		},
		alwaysAllow: async (_connectionId, approvalId, rule) => {
			log.push(`rule ${approvalId}`);
			if (options.ruleFails === true) throw new KantelError("forbidden", "Not yours");
			rules.push(rule);
		},
		...(passkey === undefined ? {} : { passkey }),
	};
	const actions = connectionApprovalActions({
		vault,
		canManage: () => true,
		decided: (id) => decided[id],
		onDecided: (id, next) => {
			decided[id] = next;
		},
	});
	return { actions, log, decisions, rules, decided };
}

describe("connectionApprovalActions", () => {
	it("approves once with the card's own code and the terms the vault holds, and says who did", async () => {
		const { actions, decisions, decided, rules } = fakeVault();
		await actions.approve(card, { scope: "once" });
		expect(decisions).toEqual([
			{ proposalId: "prop_pr", outcome: "approve", termsHash: "hash_1", pickedCode: "K7Q-2MX" },
		]);
		expect(rules).toEqual([]);
		expect(decided.prop_pr).toEqual({ outcome: "approved", by: "Tom Davies", scope: "once" });
	});

	it("asks for the passkey first, and approves nothing when it is cancelled", async () => {
		const confirmed = fakeVault({ passkey: "confirmed" });
		await confirmed.actions.approve(card, { scope: "once" });
		expect(confirmed.log).toEqual(["passkey", "decide approve"]);

		const cancelled = fakeVault({ passkey: "cancelled" });
		const refusal = await cancelled.actions.approve(card, { scope: "once" }).catch(approvalRefusal);
		expect(refusal).toBe("You cancelled the passkey, so nothing was approved.");
		expect(cancelled.decisions).toEqual([]);
		expect(cancelled.decided.prop_pr).toBeUndefined();
	});

	it("saves the session's rule from the approval before approving, so the next request like it goes out", async () => {
		const { actions, log, rules, decided } = fakeVault({ passkey: "confirmed" });
		await actions.approve(card, { scope: "session" });
		expect(log).toEqual(["passkey", "rule prop_pr", "decide approve"]);
		expect(rules).toEqual([
			{
				who: { kind: "session", sessionId: "sess_1" },
				what: { kind: "endpoint", method: "POST", path: "/repos/tvdavies/harbour/pulls", host: "api.github.com" },
				action: "allow",
				note: "From approval prop_pr, for this session",
			},
		]);
		expect(decided.prop_pr?.scope).toBe("session");
	});

	it("approves nothing when the rule isn't saved", async () => {
		const { actions, decisions } = fakeVault({ ruleFails: true });
		const refusal = await actions.approve(card, { scope: "session" }).catch(approvalRefusal);
		expect(refusal).toBe("You can't add rules to this connection, so nothing was approved. Approve it once instead.");
		expect(decisions).toEqual([]);
	});

	it("reads the standing rule from the vault's request and saves it before approving", async () => {
		const { actions, log, rules, decided } = fakeVault();
		const rule = await actions.alwaysAllowRule(card);
		expect(rule?.who).toEqual({ kind: "agent", agentId: "agent_1" });
		await actions.alwaysAllow(card, rule!, {});
		expect(log).toEqual(["rule prop_pr", "decide approve"]);
		expect(rules).toEqual([rule]);
		expect(decided.prop_pr?.scope).toBe("always");
	});

	it("approves nothing when the vault holds another request than the card shows", async () => {
		const { actions, decisions } = fakeVault();
		await expect(actions.approve({ ...card, bindingCode: "ZZZ-000" }, { scope: "once" })).rejects.toThrow();
		expect(decisions).toEqual([]);
	});

	it("denies", async () => {
		const { actions, decisions, decided } = fakeVault();
		await actions.deny(card);
		expect(decisions).toEqual([{ proposalId: "prop_pr", outcome: "deny" }]);
		expect(decided.prop_pr).toEqual({ outcome: "denied", by: "Tom Davies" });
	});
});
