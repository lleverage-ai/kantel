// Loads what the vault page shows from any `Vault`: the in-memory one in the workbench, and lane 5's decision API in
// the console once it lands. Only contract calls, so the page never depends on one implementation.

import {
	type CallContext,
	type Decision,
	type Grant,
	isKantelError,
	type Proposal,
	type Vault,
} from "@kantel/contracts";
import { codeRequiredFor, type RequesterLabels, type RequestItem, type VaultRequest } from "./vault-page-model.ts";

/** The calls the page needs. */
export type VaultPageApi = Pick<
	Vault,
	"approvalView" | "getProposal" | "getItem" | "listGrants" | "getGrant" | "decide" | "revokeGrant"
>;

/** Names for a proposal's requester, from the host's identity and session directories. */
export type DescribeRequester = (proposal: Proposal) => RequesterLabels | Promise<RequesterLabels>;

/**
 * Loads one proposal for the vault page as the viewer `ctx`. The approval view (with the codes to pick from) needs the
 * operator role on the proposal's project; a viewer who lacks it but may still see the proposal gets it read-only, so a
 * forwarded link shows who asked and why it can't be approved. A viewer who may not see it at all gets the vault's
 * `forbidden`, for the page to say so.
 */
export async function loadVaultRequest(
	vault: VaultPageApi,
	ctx: CallContext,
	proposalId: string,
	describe: DescribeRequester,
	known: {
		/** Decisions the host already has, by ID: the contract has no read for a past decision yet. */
		readonly decisions?: ReadonlyMap<string, Decision>;
		/** The decider's name, from the identity directory. */
		readonly decider?: (decision: Decision) => string | undefined;
	} = {},
): Promise<VaultRequest> {
	let proposal: Proposal;
	let codeChoices: readonly string[] | undefined;
	let readOnly: "role" | undefined;
	try {
		const view = await vault.approvalView(ctx, proposalId);
		proposal = view.proposal;
		codeChoices = view.codeChoices;
	} catch (error) {
		if (!isKantelError(error, "forbidden")) throw error;
		proposal = await vault.getProposal(ctx, proposalId);
		readOnly = "role";
	}

	const [requester, item, grant] = await Promise.all([
		describe(proposal),
		itemFor(vault, ctx, proposal),
		proposal.status === "approved" ? grantFor(vault, ctx, proposal) : Promise.resolve(undefined),
	]);
	const decision = proposal.decisionId === undefined ? undefined : known.decisions?.get(proposal.decisionId);
	const decider = decision === undefined ? undefined : known.decider?.(decision);
	return {
		proposal,
		...(codeChoices === undefined ? {} : { codeChoices }),
		codeRequired: codeRequiredFor(proposal),
		...(readOnly === undefined ? {} : { readOnly }),
		requester,
		...(item === undefined ? {} : { item }),
		...(decision === undefined ? {} : { decision }),
		...(decider === undefined ? {} : { decider }),
		...(grant === undefined ? {} : { grant }),
	};
}

async function itemFor(vault: VaultPageApi, ctx: CallContext, proposal: Proposal): Promise<RequestItem | undefined> {
	const secret = proposal.terms.secret;
	if (secret !== undefined) {
		return {
			name: secret.name,
			...(secret.description === undefined ? {} : { description: secret.description }),
			injection: `${secret.injection.header}: ${secret.injection.template}`,
		};
	}
	if (proposal.terms.itemId === undefined) return undefined;
	try {
		const item = await vault.getItem(ctx, proposal.terms.itemId);
		return {
			name: item.name,
			...(item.description === undefined ? {} : { description: item.description }),
			injection: `${item.injection.header}: ${item.injection.template}`,
			...(item.owner.kind === "user" ? { personalTo: item.owner.userId } : {}),
		};
	} catch (error) {
		if (isKantelError(error, "forbidden") || isKantelError(error, "not_found")) return undefined;
		throw error;
	}
}

/** The grant an approval created. The contract lists grants by session, so the session's are searched. */
async function grantFor(vault: VaultPageApi, ctx: CallContext, proposal: Proposal): Promise<Grant | undefined> {
	try {
		const sessionId = proposal.requester.sessionId;
		let cursor: string | undefined;
		do {
			const page = await vault.listGrants(
				ctx,
				sessionId === undefined ? undefined : { sessionId },
				cursor === undefined ? { limit: 500 } : { limit: 500, cursor },
			);
			const found = page.items.find((grant) => grant.proposalId === proposal.id);
			if (found !== undefined) return found;
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return undefined;
	} catch (error) {
		if (isKantelError(error, "forbidden")) return undefined;
		throw error;
	}
}

/** One active grant, with the names the list shows. */
export interface GrantSummary {
	readonly grant: Grant;
	readonly itemName?: string;
	readonly requester?: RequesterLabels;
}

/** The viewer's active grants, newest first, with their items' names. */
export async function loadActiveGrants(
	vault: Pick<Vault, "listGrants" | "getItem" | "getProposal">,
	ctx: CallContext,
	describe?: DescribeRequester,
): Promise<GrantSummary[]> {
	const grants: Grant[] = [];
	let cursor: string | undefined;
	do {
		const page = await vault.listGrants(
			ctx,
			{ status: "active" },
			cursor === undefined ? { limit: 500 } : { limit: 500, cursor },
		);
		grants.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	grants.sort((a, b) => b.createdAt - a.createdAt);
	const names = new Map<string, Promise<string | undefined>>();
	const nameOf = (itemId: string) => {
		let name = names.get(itemId);
		if (name === undefined) {
			name = vault.getItem(ctx, itemId).then(
				(item) => item.name,
				() => undefined,
			);
			names.set(itemId, name);
		}
		return name;
	};
	return Promise.all(
		grants.map(async (grant) => {
			const [itemName, requester] = await Promise.all([
				nameOf(grant.itemId),
				describe === undefined ? undefined : vault.getProposal(ctx, grant.proposalId).then(describe, () => undefined),
			]);
			return {
				grant,
				...(itemName === undefined ? {} : { itemName }),
				...(requester === undefined ? {} : { requester }),
			};
		}),
	);
}
