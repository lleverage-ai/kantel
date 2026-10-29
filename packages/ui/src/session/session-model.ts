// What the session list shows for a session, as pure functions so the list, the inbox and tests agree.
//
// After T3 Code's sidebar (pingdotgg/t3code@1152e9171a9ce6ede20e0cc1f16ed0dbe103da9b,
// apps/web/src/components/Sidebar.logic.ts:871-898): approval wins, then an answer, then working, then failed or an
// unseen completion. A settled session you have already seen shows no status at all, only its time.

import type { SessionStatus } from "@harbour/protocol";
import type { Status } from "../tokens/tokens.ts";

/**
 * A session as the session list shows it. Not in the protocol yet: the list API arrives with M1-BE1, and this is the
 * shape the list needs from it.
 */
export type SessionSummary = {
	id: string;
	title: string;
	project?: string;
	branch?: string;
	status: SessionStatus;
	/** What the session is waiting on, when status is "waiting". */
	needs?: "approval" | "answer";
	startedAt: number;
	updatedAt: number;
	/**
	 * When the run under way started, while status is "running": the row's "Working 12s" counts from it. Without it the
	 * row counts from `startedAt`.
	 */
	workingSince?: number;
	/** Finished since you last opened it. */
	unread?: boolean;
};

/** Where the list puts a session: waiting on you, still working, or settled. */
export type AttentionGroup = "needs-you" | "working" | "done";

/** The groups in the order the list shows them, with their headings. */
export const attentionGroups: readonly { group: AttentionGroup; label: string }[] = [
	{ group: "needs-you", label: "Needs you" },
	{ group: "working", label: "Working" },
	{ group: "done", label: "Done" },
];

/**
 * The status a session's row shows, or undefined for a settled session you have already seen (done and read, idle,
 * cancelled), which shows just its time.
 */
export function sessionStatus(summary: SessionSummary): Status | undefined {
	switch (summary.status) {
		case "waiting":
			return summary.needs === "approval" ? "approval" : "waiting";
		case "running":
			return "working";
		case "failed":
			return "error";
		case "done":
			return summary.unread === true ? "done" : undefined;
		default:
			return undefined;
	}
}

/** Which group a session belongs in: waiting sessions need you, running ones are working, the rest are done. */
export function attentionGroup(summary: SessionSummary): AttentionGroup {
	if (summary.status === "waiting") return "needs-you";
	if (summary.status === "running") return "working";
	return "done";
}

export type SessionGroup = { group: AttentionGroup; label: string; sessions: SessionSummary[] };

const newestFirst = (a: SessionSummary, b: SessionSummary): number => b.updatedAt - a.updatedAt;

/**
 * Sessions grouped as Needs you, Working, Done, in that order, each newest first by `updatedAt`. Empty groups are
 * left out. The input is not changed.
 */
export function groupSessions(list: readonly SessionSummary[]): SessionGroup[] {
	const buckets: Record<AttentionGroup, SessionSummary[]> = { "needs-you": [], working: [], done: [] };
	for (const summary of list) buckets[attentionGroup(summary)].push(summary);
	return attentionGroups
		.map(({ group, label }) => ({ group, label, sessions: buckets[group].sort(newestFirst) }))
		.filter((entry) => entry.sessions.length > 0);
}
