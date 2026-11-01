import type { ConnectionRuleInput, DecisionInput, HttpMethod, Proposal } from "@kantel/contracts";
import { type ConnectionApprovalCard, isConnectionApprovalCard, type TranscriptItem } from "@kantel/protocol";
import { decisionRefusal } from "../vault/vault-page-model.ts";
import { CONNECTION_TOOLS, SCRIPT_TOOL } from "./connection-calls-model.ts";
import { describeRequest } from "./connection-operations.ts";

// A connection request waiting on a person, shown in the call that waits on it (#460): the session's
// `connection.approval` card names its call (`callId`), so a host that renders the call shows the approval there and
// leaves the card out of the transcript. The API's stream keeps the card, for hosts that don't render calls.

/**
 * The approval cards the calls on screen wait on, by the call (`callId`): a connection call's own, or a script's inner
 * call's (`<scriptCallId>/<key>`). Make one with `callApprovals`.
 */
export type CallApprovalCards = {
	/** The card the call waits on, or waited on. */
	readonly of: (callId: string) => ConnectionApprovalCard | undefined;
	/** The cards a script's inner calls wait on, in the order they came. */
	readonly inScript: (scriptCallId: string) => readonly ConnectionApprovalCard[];
};

/** The script a script's inner call (`toolu_01/c9`) belongs to, by its call ID. */
const scriptOf = (callId: string): string | undefined => /^(.+)\/[^/]+$/.exec(callId)?.[1];

/**
 * The transcript with every connection approval card whose call is on screen taken out, and those cards by their call.
 * A card's call is on screen when a `connection_request` or `connection_call` item has its `callId`, or a `codemode`
 * item is the script its inner call belongs to. A card with no `callId`, or whose call isn't loaded, stays where it is.
 * The items are the same array when no card moves.
 */
export function callApprovals(items: readonly TranscriptItem[]): {
	readonly items: readonly TranscriptItem[];
	readonly cards: CallApprovalCards;
} {
	const calls = new Set<string>();
	const scripts = new Set<string>();
	for (const item of items) {
		if (item.kind !== "tool") continue;
		if (CONNECTION_TOOLS.includes(item.name)) calls.add(item.callId);
		else if (item.name === SCRIPT_TOOL) scripts.add(item.callId);
	}
	const byCall = new Map<string, ConnectionApprovalCard>();
	const byScript = new Map<string, ConnectionApprovalCard[]>();
	const kept: TranscriptItem[] = [];
	for (const item of items) {
		const card = item.kind === "card" && isConnectionApprovalCard(item.card) ? item.card : undefined;
		const callId = card?.callId;
		const script = callId === undefined ? undefined : scriptOf(callId);
		if (card === undefined || callId === undefined) {
			kept.push(item);
			continue;
		}
		// The deprecated `vault.approval` type never carries a call; a current card is read as one.
		const current: ConnectionApprovalCard = { ...card, type: "connection.approval" };
		if (calls.has(callId)) byCall.set(callId, current);
		else if (script !== undefined && scripts.has(script)) {
			byCall.set(callId, current);
			byScript.set(script, [...(byScript.get(script) ?? []), current]);
		} else kept.push(item);
	}
	return {
		items: kept.length === items.length ? items : kept,
		cards: { of: (callId) => byCall.get(callId), inScript: (scriptCallId) => byScript.get(scriptCallId) ?? [] },
	};
}

/** What the approval asks to do, in one sentence: the operation in words, or the request as it goes out. */
export function approvalTitle(card: ConnectionApprovalCard): string {
	const request = card.request;
	if (request === undefined) return card.what;
	if (request.kind === "mcp_call") return `Call ${request.tool ?? "a tool"} on ${request.connectionName}`;
	if (request.kind === "mcp_tools") return `List the tools on ${request.connectionName}`;
	return describeRequest({ method: request.method, url: request.url });
}

/** Where an approval stands as the session shows it: the card's status, or how the person here just decided it. */
export type ApprovalState = ConnectionApprovalCard["status"];

/**
 * The approval's state now: the card's, unless it still says pending and the person here has decided it (the card
 * follows within a poll), or its time has run out.
 */
export function approvalState(
	card: Pick<ConnectionApprovalCard, "status" | "expiresAt">,
	decided: "approved" | "denied" | undefined,
	now: number,
): ApprovalState {
	if (card.status !== "pending") return card.status;
	if (decided !== undefined) return decided;
	return now >= card.expiresAt ? "expired" : "pending";
}

/** How a settled approval reads under its call: "Approved by Tom Davies", "Expired, nobody answered". */
export function settledWords(state: Exclude<ApprovalState, "pending">, decidedBy: string | undefined): string {
	const by = decidedBy ?? "a person";
	switch (state) {
		case "approved":
			return `Approved by ${by}`;
		case "denied":
			return `Denied by ${by}`;
		case "expired":
			return "Expired, nobody answered";
		case "withdrawn":
			return "Withdrawn";
	}
}

/** "9:42 left": the time left to decide, by the second. */
export function timeLeftText(expiresAt: number, now: number): string {
	const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
	const minutes = Math.floor(left / 60);
	const seconds = left % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")} left`;
}

/**
 * The decision the session sends for "Approve once": the terms hash the vault holds and the card's binding code, picked
 * on the person's behalf because the card they approved from is the one in their own session. The vault's checks are
 * unchanged: a request page opened from a link still asks for the code. Throws when the request the vault holds isn't
 * the one on the card (another binding code, or another digest), so nothing is approved that the person didn't see.
 */
export function inCallDecision(card: ConnectionApprovalCard, proposal: Proposal): DecisionInput {
	const digest = proposal.terms.request?.digest;
	if (
		proposal.id !== card.proposalId ||
		proposal.bindingCode !== card.bindingCode ||
		(card.request !== undefined && digest !== card.request.digest)
	) {
		throw new ApprovalMismatch();
	}
	return { proposalId: proposal.id, outcome: "approve", termsHash: proposal.termsHash, pickedCode: card.bindingCode };
}

/** The request the vault holds isn't the one on the card. */
export class ApprovalMismatch extends Error {
	constructor() {
		super("The request the vault holds isn't the one on the card");
		this.name = "ApprovalMismatch";
	}
}

/** The person cancelled the passkey prompt, so nothing was approved. */
export class PasskeyCancelled extends Error {
	constructor() {
		super("The passkey was cancelled");
		this.name = "PasskeyCancelled";
	}
}

/**
 * "Allow for this session": an allow rule for this session alone on the request's method and path (and host), or its
 * MCP tool. Not its body or query, which vary between requests of one operation. Undefined for an approval that isn't
 * of one request, or of an MCP connection's tool list.
 */
export function sessionRule(card: ConnectionApprovalCard, sessionId: string): ConnectionRuleInput | undefined {
	const request = card.request;
	if (request === undefined || request.kind === "mcp_tools") return undefined;
	return {
		who: { kind: "session", sessionId },
		what:
			request.kind === "mcp_call" && request.tool !== undefined
				? { kind: "tool", tool: request.tool }
				: {
						kind: "endpoint",
						method: request.method.toUpperCase() as HttpMethod,
						path: card.pathPrefix,
						host: card.host,
					},
		action: "allow",
		note: `From approval ${card.proposalId}, for this session`,
	};
}

/** Why a decision from the session didn't go through, in the words the session shows. */
export function approvalRefusal(error: unknown, outcome: "approve" | "deny" = "approve"): string {
	if (error instanceof PasskeyCancelled) return "You cancelled the passkey, so nothing was approved.";
	if (error instanceof ApprovalMismatch)
		return "The request waiting isn't the one shown here, so nothing was approved. Open the request page to check it.";
	const reason = decisionRefusal(error);
	if (outcome === "deny") {
		if (reason.kind === "role" || reason.kind === "expired" || reason.kind === "decided")
			return reason.message.replace("Nothing was approved.", "").trim();
		return "Kantel didn't answer, so the request wasn't denied. Try again in a moment.";
	}
	// The session picks the card's own code, so a refused pick means the request changed under it.
	if (reason.kind === "code")
		return "Kantel refused the approval: the request may have changed. Nothing was approved. Open the request page to check it.";
	return reason.message;
}
