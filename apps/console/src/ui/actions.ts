import type { PresentedFile, SessionStatus, TranscriptItem } from "@harbour/protocol";
import type { ComposerProps, ComposerState } from "@harbour/ui";
import type { SessionControl, WorkspaceFile, WrittenFile } from "../api/client.ts";
import type { BrowserLiveStore } from "./browser-live.ts";

/**
 * What the person can do from the composer: send, steer, queue a follow-up or stop, or nothing, with the reason. The
 * draft is held here, so it can go as a follow-up and stays put when a send fails.
 */
export type SessionActions = {
	control: SessionControl;
	draft: string;
	onDraft: (text: string) => void;
	onSend: (text: string) => void;
	onSteer: (text: string) => void;
	/** Queues the draft to run when the current run finishes. */
	onFollowUp: (text: string) => void;
	onStop: () => void;
	/** A send is on its way. */
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
	 * Saves a document the person edited (`create_document`'s), only if it is still the digest they read. Absent, a
	 * document opens read-only.
	 */
	writePresented?: (file: PresentedFile, markdown: string, ifMatch: string | undefined) => Promise<WrittenFile>;
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
