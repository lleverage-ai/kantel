import type { PresentedFile, SessionStatus, TranscriptItem, UserAttachment } from "@harbour/protocol";
import type { ComposerAttachment, ComposerProps, ComposerState, MessageDelivery } from "@harbour/ui";
import type { AttachmentContent, SessionControl, WorkspaceFile, WorkspaceShares, WrittenFile } from "../api/client.ts";
import { inFlight, type Outgoing, outgoingId } from "../state/outbox.ts";
import type { BrowserLiveStore } from "./browser-live.ts";

/**
 * What the person can do from the composer: send, steer, queue a follow-up or stop, or nothing, with the reason. The
 * draft is held here, so it can go as a follow-up and stays put when a send fails.
 */
export type SessionActions = {
	control: SessionControl;
	draft: string;
	onDraft: (text: string) => void;
	onSend: (text: string, attachments?: readonly ComposerAttachment[]) => void;
	onSteer: (text: string, attachments?: readonly ComposerAttachment[]) => void;
	/** The composer's files: the attached ones and their handlers, or why it takes none. */
	files?: Pick<
		ComposerProps,
		"attachments" | "onAttach" | "onRemoveAttachment" | "onRetryAttachment" | "attachmentLimits" | "attachUnavailable"
	>;
	/** Queues the draft to run when the current run finishes. */
	onFollowUp: (text: string) => void;
	onStop: () => void;
	/**
	 * Messages sent from here that the session's stream hasn't brought yet, oldest first (state/outbox.ts). The
	 * transcript shows them at once, after the session's items.
	 */
	outbox?: readonly Outgoing[];
	/** Sends a failed message from the outbox again. Keep it stable. */
	onRetrySend?: (requestId: string) => void;
	/** Takes a failed message out of the outbox and puts its words back in the composer. Keep it stable. */
	onEditUnsent?: (requestId: string) => void;
	/** A stop, a browser decision or a follow-up is on its way (messages and steers go through the outbox). */
	sending: boolean;
	/**
	 * When the person last sent a prompt (epoch ms), until the session's status first moves after it. The transcript
	 * shows the turn working from this moment, before the host has said so.
	 */
	promptedAt?: number;
	/** Why the last send or stop failed, shown on the composer until the next one. */
	failure?: string;
	/**
	 * Allows or declines the agent's waiting browser request (`browserRequestOf`), when the client can. Absent, the
	 * request shows with no buttons.
	 */
	onBrowserDecision?: (callId: string, allow: boolean) => void;
	/** The live views of the session's browsers, when the client can have them. Absent, browser calls show screenshots. */
	browserLive?: BrowserLiveStore;
	/**
	 * Reads a file the agent presented, through the workspace read API, for the viewer. Absent, presented files show as
	 * cards with nothing to open. Rejects with an `ApiError` (`too_large` for a file larger than the API serves).
	 */
	readPresented?: (file: PresentedFile, signal: AbortSignal) => Promise<WorkspaceFile>;
	/**
	 * Reads a file sent with a message, as it was uploaded: for an image's thumbnail above the bubble, and the panel a
	 * card opens. Absent, the cards show their type's icon and open nothing.
	 */
	readAttachment?: (attachment: UserAttachment, signal: AbortSignal) => Promise<AttachmentContent>;
	/**
	 * Saves a document the person edited (`create_document`'s), only if it is still the digest they read. Absent, a
	 * document opens read-only.
	 */
	writePresented?: (file: PresentedFile, markdown: string, ifMatch: string | undefined) => Promise<WrittenFile>;
	/** The shares of a presented file's workspace, for the Share popover. Absent (or undefined), files have Export alone. */
	sharesOf?: (file: PresentedFile) => Promise<WorkspaceShares | undefined>;
	/** The signed-in person, the owner a new share names. */
	sharer?: { readonly name: string; readonly email?: string };
	/** The composer's model and thinking pickers, when the session offers a choice. */
	pickers?: Pick<
		ComposerProps,
		"models" | "model" | "onModelChange" | "thinking" | "defaultThinking" | "onThinkingChange"
	>;
	/** Forks a new session from an answer and opens it. Absent when the host can't. */
	onFork?: (itemId: string) => Promise<void>;
	/** Rewinds the session to a message and sends new words in its place. Absent when the host can't. */
	onEdit?: (itemId: string, text: string) => Promise<void>;
	/** Someone is about to write (the composer's `onEngage`): warms the session's sandbox. Absent when the host can't. */
	onEngage?: () => void;
};

/** The least time between two warm-up hints for one session. A warmed container stays up for minutes. */
export const WARM_INTERVAL_MS = 30_000;

/**
 * The composer's warm-up hint for one session, after the public API's `POST /sessions/{id}/warm`: at most one call
 * every `intervalMs`, and none while one is on its way. The call is idempotent, so this only saves requests; a failed
 * hint is dropped (the next command starts the sandbox anyway) and may be sent again after the interval.
 */
export function createWarmHint(
	warm: () => Promise<unknown>,
	options: { readonly intervalMs?: number; readonly now?: () => number } = {},
): () => void {
	const intervalMs = options.intervalMs ?? WARM_INTERVAL_MS;
	const now = options.now ?? Date.now;
	let last = Number.NEGATIVE_INFINITY;
	let inFlight = false;
	return () => {
		const at = now();
		if (inFlight || at - last < intervalMs) return;
		last = at;
		inFlight = true;
		warm()
			.catch(() => undefined)
			.finally(() => {
				inFlight = false;
			});
	};
}

/** An agent's request for a browser that waits for a person: the call, why, and the sites it names. */
export type BrowserRequest = {
	readonly callId: string;
	readonly reason: string;
	readonly sites: readonly string[];
};

/**
 * The agent's waiting browser request: the last `browser_request` call still running. It returns once a person allows
 * or declines it, so a finished one needs nothing.
 */
export function browserRequestOf(items: readonly TranscriptItem[]): BrowserRequest | undefined {
	for (let i = items.length - 1; i >= 0; i -= 1) {
		const item = items[i];
		if (item?.kind !== "tool" || item.name !== "browser_request") continue;
		if (item.status !== "running") return undefined;
		const args = (typeof item.args === "object" && item.args !== null ? item.args : {}) as {
			reason?: unknown;
			sites?: unknown;
		};
		return {
			callId: item.callId,
			reason: typeof args.reason === "string" ? args.reason : "",
			sites: Array.isArray(args.sites) ? args.sites.filter((site): site is string => typeof site === "string") : [],
		};
	}
	return undefined;
}

/**
 * Whether the transcript shows the turn working, and from when, after T3 Code (ChatView.tsx:1394-1398): from the moment
 * a prompt is sent, not when the host first says the session runs, so the working row is there before the first token.
 */
export function transcriptWorking(
	status: SessionStatus,
	promptedAt: number | undefined,
): false | true | { readonly since: number } {
	if (promptedAt !== undefined) return { since: promptedAt };
	return status === "running";
}

/**
 * Why Edit from here is off, or undefined when it is on: the session can't be controlled, or a run is going or a send
 * on its way. Rewinding a run under way would lose what it is doing, so the person stops it first.
 */
export function editBlocked(control: SessionControl, status: SessionStatus, sending: boolean): string | undefined {
	if (!control.live) return control.reason;
	if (sending) return "Wait for the message to send";
	return status === "running" || status === "waiting" ? "Stop the run to edit a message" : undefined;
}

/**
 * The composer's state for a session: disabled (with the reason) when it can't be controlled, a spinner while a send
 * is on its way, Steer and Stop while the agent runs, and Send otherwise.
 */
export function composerState(control: SessionControl, status: SessionStatus, sending: boolean): ComposerState {
	if (!control.live) return "disabled";
	if (sending) return "sending";
	return status === "running" ? "running" : "idle";
}

/**
 * Request ids for sends. Sending the same thing the same way again after a failure reuses the failed attempt's id, so
 * a send the host took before its answer was lost still happens once. A send that succeeds clears it.
 */
export function createRequestIds(newId: () => string = () => crypto.randomUUID()) {
	let last: { key: string; id: string } | undefined;
	return {
		for(action: string, text: string): string {
			const key = `${action}\n${text}`;
			if (last?.key !== key) last = { key, id: newId() };
			return last.id;
		},
		sent(): void {
			last = undefined;
		},
	};
}

const SENDING: MessageDelivery = { state: "sending" };

/**
 * What the transcript says of each outgoing message, by its local item's id (`outgoingId`): on its way, or failed with
 * Try again and Edit. Edit puts only words back in the composer, so a message with files offers Try again alone.
 * Undefined when nothing is outgoing.
 */
export function deliveryOf(
	outbox: readonly Outgoing[],
	retry: ((requestId: string) => void) | undefined,
	edit: ((requestId: string) => void) | undefined,
): ReadonlyMap<string, MessageDelivery> | undefined {
	if (outbox.length === 0) return undefined;
	const delivery = new Map<string, MessageDelivery>();
	for (const message of outbox) {
		const { requestId } = message;
		if (message.status !== "failed" || retry === undefined) {
			delivery.set(outgoingId(requestId), SENDING);
			continue;
		}
		const withFiles = (message.attachments?.length ?? 0) > 0;
		delivery.set(outgoingId(requestId), {
			state: "failed",
			...(message.reason === undefined ? {} : { reason: message.reason }),
			onRetry: () => retry(requestId),
			...(edit === undefined || withFiles ? {} : { onEdit: () => edit(requestId) }),
		});
	}
	return delivery;
}

/** Whether a message from the outbox is still going, which holds Edit from here as a send does. */
export const delivering = (outbox: readonly Outgoing[] | undefined): boolean => outbox?.some(inFlight) ?? false;

/** The longest title a new session takes from its first message. */
export const TITLE_MAX = 80;

/**
 * A new session's title from its first message, as T3 Code names a thread: the first line that has words, cut at a
 * word to `TITLE_MAX` characters with an ellipsis. Undefined for a message with no words.
 */
export function titleFrom(text: string): string | undefined {
	const line = text
		.split("\n")
		.map((part) => part.replace(/\s+/g, " ").trim())
		.find((part) => part !== "");
	if (line === undefined) return undefined;
	if (line.length <= TITLE_MAX) return line;
	const cut = line.slice(0, TITLE_MAX - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Whether the composer offers "Send after this run": the agent is running and there is something to send. */
export function offersFollowUp(control: SessionControl, status: SessionStatus, sending: boolean, draft: string) {
	return control.live && !sending && status === "running" && draft.trim() !== "";
}
