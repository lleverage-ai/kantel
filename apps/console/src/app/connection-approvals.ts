import type { ConnectionRuleInput, Proposal } from "@kantel/contracts";
import type { ConnectionApprovalCard } from "@kantel/protocol";
import {
	alwaysAllowRule,
	type ConnectionApprovalActions,
	type ConnectionApprovalDecided,
	inCallDecision,
	PasskeyCancelled,
	PasskeyUnchecked,
	RuleNotSaved,
	sessionRule,
} from "@kantel/ui";
import type { ConsoleVault } from "../api/oversight.ts";

// Deciding a connection request from the session it waits in (#460), over the vault page's seam: the request the vault
// holds, checked against the card, the person's passkey where the organisation asks for one, then the decision with
// the card's binding code. "Allow for this session" and "Always allow…" save their rule from the approval first, so
// the next request like it doesn't ask again however soon the agent sends it.

export type ConnectionApprovalsOptions = {
	readonly vault: Pick<ConsoleVault, "request" | "decide" | "passkey" | "alwaysAllow" | "viewer">;
	/** Whether the person manages a connection, and so may add rules to it. */
	readonly canManage: (connectionId: string) => boolean;
	/** How the person here decided an approval, kept until the card says so. */
	readonly decided: (proposalId: string) => ConnectionApprovalDecided | undefined;
	/** Called once the vault has the decision. */
	readonly onDecided: (proposalId: string, decided: ConnectionApprovalDecided) => void;
};

/** The in-call approval's actions (`ConnectionApprovalActions`) over the console's vault. */
export function connectionApprovalActions(options: ConnectionApprovalsOptions): ConnectionApprovalActions {
	const { vault } = options;
	const by = vault.viewer.name;
	const standing = vault.alwaysAllow;

	/**
	 * Approves: the passkey, then the rule `rule` makes, if any, then the decision. Nothing is approved when any of them
	 * fails, or when the rule can't be made.
	 */
	const approve = async (
		card: ConnectionApprovalCard,
		scope: NonNullable<ConnectionApprovalDecided["scope"]>,
		rule: ((proposal: Proposal) => ConnectionRuleInput | undefined) | undefined,
		onApproving: (() => void) | undefined,
	) => {
		const { proposal } = await vault.request(card.proposalId);
		const decision = inCallDecision(card, proposal);
		if (vault.passkey !== undefined) {
			let checked: "confirmed" | "cancelled";
			try {
				checked = await vault.passkey({ proposalId: proposal.id, termsHash: proposal.termsHash, action: "approve" });
			} catch {
				throw new PasskeyUnchecked();
			}
			if (checked === "cancelled") throw new PasskeyCancelled();
		}
		onApproving?.();
		if (rule !== undefined) {
			const saving = rule(proposal);
			const connectionId = proposal.terms.request?.connectionId;
			if (saving === undefined || standing === undefined || connectionId === undefined) {
				throw new RuleNotSaved(undefined);
			}
			try {
				await standing(connectionId, proposal.id, saving);
			} catch (error) {
				throw new RuleNotSaved(error);
			}
		}
		await vault.decide(decision);
		options.onDecided(card.proposalId, { outcome: "approved", by, scope });
	};

	return {
		approve: (card, { scope, onApproving }) =>
			approve(card, scope, scope === "session" ? sessionRule : undefined, onApproving),
		deny: async (card) => {
			await vault.decide({ proposalId: card.proposalId, outcome: "deny" });
			options.onDecided(card.proposalId, { outcome: "denied", by });
		},
		alwaysAllowRule: async (card) => alwaysAllowRule((await vault.request(card.proposalId)).proposal),
		alwaysAllow: (card, rule, { onApproving }) => approve(card, "always", () => rule, onApproving),
		// Saving a rule from an approval needs the vault's seam for it.
		canManage: (connectionId) => standing !== undefined && options.canManage(connectionId),
		passkey: vault.passkey !== undefined,
		decided: options.decided,
	};
}
