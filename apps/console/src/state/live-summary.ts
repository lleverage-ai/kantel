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

/** The list with the open session's live state laid over its row. The list's own order and other rows are kept. */
export function withLive(
	sessions: readonly SessionSummary[],
	live: LiveSummary | undefined,
): readonly SessionSummary[] {
	if (live === undefined) return sessions;
	const index = sessions.findIndex((session) => session.id === live.id);
	const current = sessions[index];
	if (current === undefined) return sessions;
	// An idle session is listed as done, as the listing does.
	const status: SessionStatus = live.status === "idle" ? "done" : live.status;
	const title = live.title === undefined || live.title === "" ? current.title : live.title;
	const needs = status === "waiting" ? live.needs : undefined;
	if (current.status === status && current.needs === needs && current.title === title) return sessions;
	const { needs: _, ...rest } = current;
	const next: SessionSummary = { ...rest, status, title, ...(needs === undefined ? {} : { needs }) };
	return [...sessions.slice(0, index), next, ...sessions.slice(index + 1)];
}
