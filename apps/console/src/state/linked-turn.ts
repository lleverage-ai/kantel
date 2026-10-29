// A `#turn=<id>` link into a session (the audit log links its rows this way): whether the turn it names is loaded,
// needs older pages to find it, or isn't in the session at all. Apart from React, so it is tested without a page.

import { findTurn } from "@harbour/ui";
import type { SessionClient, SessionState } from "./session-client.ts";

/**
 * Where a `#turn=<id>` link stands: no link, its turn loaded (the transcript lands on it), earlier pages being read to
 * find it, or not found once the whole session is loaded.
 */
export type TurnSearch = "none" | "found" | "paging" | "missing";

/** Whether the session's state shows the turn, needs another earlier page to find it, or has it nowhere. */
export function turnSearch(
	state: Pick<SessionState, "items" | "hasEarlier" | "cursor" | "olderError">,
	turn: string | undefined,
): TurnSearch {
	if (turn === undefined) return "none";
	if (findTurn(state.items, turn) !== undefined) return "found";
	// Until the first snapshot is in (it sets the cursor), the session's length isn't known.
	if (state.cursor === undefined) return "paging";
	return state.hasEarlier && state.olderError === undefined ? "paging" : "missing";
}

/**
 * Looks for `turn` in the session: tells `onSearch` where the search stands now and as the session changes, and pages
 * back through its history, a page at a time, while the turn isn't loaded and there is anything older. Returns the way
 * to stop.
 */
export function followTurn(
	session: Pick<SessionClient, "getState" | "subscribe" | "loadOlder">,
	turn: string | undefined,
	onSearch: (search: TurnSearch) => void,
): () => void {
	const check = () => {
		const state = session.getState();
		const search = turnSearch(state, turn);
		onSearch(search);
		if (search === "paging" && state.cursor !== undefined && !state.loadingOlder) session.loadOlder();
	};
	check();
	return session.subscribe(check);
}
