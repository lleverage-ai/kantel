// The console's one seam to a Harbour host. Everything the screens need goes through `ConsoleClient`: who is signed
// in, the projects, a project's sessions, the live connection to one session, and the controls. Two implementations:
// the session API over HTTP (`http.ts`) and the recorded-session client (`recorded.ts`, in the page, no backend).
// Swapping one for the other changes nothing in src/ui.

import type { SessionSummary } from "@harbour/ui";
import type { Transport } from "../state/session-client.ts";

/** Who the console acts as. Stubbed for recorded sessions; the API client is whoever Access signed in. */
export type ConsoleActor = {
	readonly id: string;
	readonly name: string;
	/** True while sign-in is a stand-in, so the shell can say so. */
	readonly stubbed: boolean;
};

export type ProjectSummary = {
	readonly id: string;
	readonly name: string;
};

/** A project's sessions as the list shows them, with how fresh the list is. */
export type SessionListState = {
	readonly sessions: readonly SessionSummary[];
	readonly loading: boolean;
	readonly error?: string;
};

/** What a person may do to a session right now, and why not when they can't. */
export type SessionControl =
	| { readonly live: true }
	| {
			readonly live: false;
			/** Shown in the composer, such as "Replaying a recorded session." */
			readonly reason: string;
	  };

export type SendOptions = {
	/** Retrying with the same id sends once. */
	readonly requestId?: string;
};

export interface ConsoleClient {
	readonly actor: ConsoleActor;
	projects(): Promise<readonly ProjectSummary[]>;
	/** Follows a project's sessions; `onChange` gets every new state. Returns a function that stops following. */
	watchSessions(projectId: string, onChange: (state: SessionListState) => void): () => void;
	/** The protocol connection to one session: hello, a snapshot or the deltas after a cursor, history pages. */
	transport(sessionId: string): Transport;
	/** The project a session belongs to, or undefined when the session is unknown. */
	projectOf(sessionId: string): string | undefined;
	control(sessionId: string): SessionControl;
	/** Starts a run when the session is idle. */
	prompt(sessionId: string, text: string, options?: SendOptions): Promise<void>;
	/** Joins the running turn after its current tool round. */
	steer(sessionId: string, text: string, options?: SendOptions): Promise<void>;
	/** Runs after the current run finishes. */
	followUp(sessionId: string, text: string, options?: SendOptions): Promise<void>;
	/** Stops the running turn; the session stays usable. */
	cancel(sessionId: string): Promise<void>;
	/**
	 * The session is on screen: it is no longer unread, and doesn't become unread while it stays shown. Call the
	 * returned function when it leaves the screen.
	 */
	markRead(sessionId: string): () => void;
}
