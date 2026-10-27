import type { SessionStatus } from "@harbour/protocol";
import type { ComposerState } from "@harbour/ui";
import type { SessionControl } from "../api/client.ts";

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
	/** Why the last send or stop failed, shown on the composer until the next one. */
	failure?: string;
};

/**
 * The composer's state for a session: disabled (with the reason) when it can't be controlled, a spinner while a send
 * is on its way, Steer and Stop while the agent runs, and Send otherwise.
 */
export function composerState(control: SessionControl, status: SessionStatus, sending: boolean): ComposerState {
	if (!control.live) return "disabled";
	if (sending) return "sending";
	return status === "running" ? "running" : "idle";
}

/** Whether the composer offers "Send after this run": the agent is running and there is something to send. */
export function offersFollowUp(control: SessionControl, status: SessionStatus, sending: boolean, draft: string) {
	return control.live && !sending && status === "running" && draft.trim() !== "";
}
