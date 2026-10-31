// A new session's first message, handed from the new-session screen to the session's own screen. The new-session
// screen creates the session and opens it straight away; the session screen sends the message, so it says the turn is
// working from the moment it opens, rather than after the prompt's round trip as well as the create's. A failed send
// stays in the session's composer with the reason, to send again there.
import type { UserAttachment } from "@kantel/protocol";
import type { SendOptions } from "../api/client.ts";

export type FirstMessage = {
	readonly text: string;
	/** The model and thinking picked before the session existed; they go with this message. */
	readonly choice: Pick<SendOptions, "model" | "thinking">;
	/** The files attached to it, uploaded to the project already. */
	readonly attachments?: readonly UserAttachment[];
};

const waiting = new Map<string, FirstMessage>();

/** Leaves `message` for the session screen that opens `sessionId` next. */
export function handOver(sessionId: string, message: FirstMessage): void {
	waiting.set(sessionId, message);
}

/** The first message left for `sessionId`, once: a second look finds nothing, so it is sent once. */
export function takeOver(sessionId: string): FirstMessage | undefined {
	const message = waiting.get(sessionId);
	waiting.delete(sessionId);
	return message;
}
