import { isConnectionApprovalCard, type TranscriptItem } from "@harbour/protocol";

/**
 * What a waiting session is waiting on, from the newest card still open: an approval (a connection request, by its
 * type or the deprecated `vault.approval`, or a browser grant) or an answer to a question. Undefined when no card is open.
 */
export function needsOf(items: readonly TranscriptItem[]): "approval" | "answer" | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind !== "card") continue;
		const { card } = item;
		if (isConnectionApprovalCard(card) && card.status === "pending") return "approval";
		if (card.type === "browser.grant" && card.status === "pending") return "approval";
		if (card.type === "question" && card.status === "open") return "answer";
	}
	return undefined;
}
