import type { ToolItem } from "@harbour/protocol";
import { SubagentCard, subagentActivity, subagentOf } from "@harbour/ui";
import { useEffect, useState } from "react";
import type { SessionClient } from "../state/session-client.ts";

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
	/**
	 * A client for a subagent's own session, not yet started, so a working card can say what it is doing now. Without
	 * it a working card shows its task.
	 */
	readonly watch?: (sessionId: string) => Pick<SessionClient, "start" | "stop" | "subscribe" | "getState">;
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

/**
 * What a working subagent is doing now, from its own session's stream, followed only while the call runs: a card that
 * has ended (or isn't found yet) follows nothing. Each change of activity is one render of the card, no more.
 */
export function useSubagentActivity(
	links: SubagentLinks,
	sessionId: string | undefined,
	running: boolean,
): string | undefined {
	const [activity, setActivity] = useState<string>();
	const watch = links.watch;
	useEffect(() => {
		if (!running || sessionId === undefined || watch === undefined) return;
		const session = watch(sessionId);
		const read = () => setActivity(subagentActivity(session.getState().items));
		const unsubscribe = session.subscribe(read);
		session.start();
		read();
		return () => {
			unsubscribe();
			session.stop();
		};
	}, [watch, sessionId, running]);
	return running ? activity : undefined;
}

/** A subagent call's card, linked to its session when that is found, saying what it is doing while it works. */
export function ConsoleSubagent({ item, links }: { item: ToolItem; links: SubagentLinks }) {
	const sessionId = useSubagentSession(links, item.callId);
	const activity = useSubagentActivity(links, sessionId, item.status === "running");
	return (
		<SubagentCard
			{...subagentOf(item)}
			{...(activity === undefined ? {} : { activity })}
			status={item.status}
			startedAt={item.at}
			endedAt={item.endedAt}
			href={sessionId === undefined ? undefined : links.href(sessionId)}
		/>
	);
}
