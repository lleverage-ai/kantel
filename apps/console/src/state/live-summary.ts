import type { SessionStatus } from "@harbour/protocol";
import type { SessionSummary } from "@harbour/ui";

/**
 * The open session's state as its stream has it, newer than the list's last poll. The sidebar shows it over the
 * listing, so the open session's row says Working the moment the header does, rather than at the next poll.
 */
export type LiveSummary = {
	readonly id: string;
	readonly status: SessionStatus;
	readonly needs?: "approval" | "answer";
	/** The stream's title, once it has one. */
	readonly title?: string;
};

/**
 * The list with the open session's live state laid over its row. The list's own order and other rows are kept. A
 * session the list doesn't have yet, such as one just started (the list is a poll of every session, which takes a
 * few seconds), gets a row of its own while it is working or waiting, dated `now`; a settled one waits for the poll.
 * A row the stream turns to running counts its "Working 12s" from `now`, unless the list already knows when it began.
 */
export function withLive(
	sessions: readonly SessionSummary[],
	live: LiveSummary | undefined,
	now: number = Date.now(),
): readonly SessionSummary[] {
	if (live === undefined) return sessions;
	const index = sessions.findIndex((session) => session.id === live.id);
	const current = sessions[index];
	// An idle session is listed as done, as the listing does.
	const status: SessionStatus = live.status === "idle" ? "done" : live.status;
	if (current === undefined) {
		if (status !== "running" && status !== "waiting") return sessions;
		const needs = status === "waiting" ? live.needs : undefined;
		const title = live.title === undefined || live.title === "" ? "Untitled session" : live.title;
		const row: SessionSummary = {
			id: live.id,
			title,
			status,
			startedAt: now,
			updatedAt: now,
			...(status === "running" ? { workingSince: now } : {}),
		};
		return [needs === undefined ? row : { ...row, needs }, ...sessions];
	}
	const title = live.title === undefined || live.title === "" ? current.title : live.title;
	const needs = status === "waiting" ? live.needs : undefined;
	if (current.status === status && current.needs === needs && current.title === title) return sessions;
	const { needs: _, workingSince: since, ...rest } = current;
	const workingSince = status !== "running" ? undefined : current.status === "running" ? since : now;
	const next: SessionSummary = {
		...rest,
		status,
		title,
		...(needs === undefined ? {} : { needs }),
		...(workingSince === undefined ? {} : { workingSince }),
	};
	return [...sessions.slice(0, index), next, ...sessions.slice(index + 1)];
}
