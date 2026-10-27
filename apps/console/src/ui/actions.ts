import type { SessionStatus } from "@harbour/protocol";
import type { ComposerState } from "@harbour/ui";
import type { SessionControl } from "../api/client.ts";

/** What the person can do from the composer: send, steer or stop, or nothing, with the reason. */
export type SessionActions = {
	control: SessionControl;
	onSend: (text: string) => void;
	onSteer: (text: string) => void;
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
