import type { ToolItem } from "@harbour/protocol";
import { SubagentCard, subagentOf } from "@harbour/ui";
import { useEffect, useState } from "react";

// A subagent call's card in a session's thread, linked to the subagent's own session once the console has found it.
// The session is found from the call: the stack labels a subagent's session with the call that started it, so the
// card links while the call still runs. Glue only: the card is @harbour/ui's.

/** How a session's subagent cards find and link to the sessions their calls started. */
export type SubagentLinks = {
	/** The session a call started, when already found: a card that mounts again links at once. */
	readonly known: (callId: string) => string | undefined;
	/** Asks for the session a call started; undefined until the call has started one. */
	readonly find: (callId: string, signal: AbortSignal) => Promise<string | undefined>;
	/** Where a subagent's session is. */
	readonly href: (sessionId: string) => string;
};

/** How long to wait before asking again for a call's session: a call creates its session first thing, so not long. */
const retryDelay = (attempt: number): number => Math.min(500 * 2 ** attempt, 5000);
/** How many times to ask before giving up on a call that never started a session (its tool failed first). */
const MAX_ATTEMPTS = 12;

/** The session a subagent call started, once found. */
export function useSubagentSession(links: SubagentLinks, callId: string): string | undefined {
	const [found, setFound] = useState(() => links.known(callId));
	useEffect(() => {
		if (found !== undefined) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const look = async (attempt: number) => {
			try {
				const sessionId = await links.find(callId, controller.signal);
				if (sessionId !== undefined) return setFound(sessionId);
			} catch {
				// Asked again below, as for a session not created yet.
			}
			if (controller.signal.aborted || attempt + 1 >= MAX_ATTEMPTS) return;
			timer = setTimeout(() => void look(attempt + 1), retryDelay(attempt));
		};
		void look(0);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [links, callId, found]);
	return found;
}

/** A subagent call's card, linked to its session when that is found. */
export function ConsoleSubagent({ item, links }: { item: ToolItem; links: SubagentLinks }) {
	const sessionId = useSubagentSession(links, item.callId);
	return (
		<SubagentCard
			{...subagentOf(item)}
			status={item.status}
			startedAt={item.at}
			endedAt={item.endedAt}
			href={sessionId === undefined ? undefined : links.href(sessionId)}
		/>
	);
}
