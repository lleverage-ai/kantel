// The console's one seam to a Harbour host. Everything the screens need goes through `ConsoleClient`: who is signed
// in, the projects, a project's sessions, the live connection to one session, the controls, and a session's workspace
// files, read-only. Two implementations:
// the session API over HTTP (`http.ts`) and the recorded-session client (`recorded.ts`, in the page, no backend).
// Swapping one for the other changes nothing in src/ui.

import type { ComposerModelOption, SessionSummary, ThinkingLevel, WorkspaceEntry } from "@harbour/ui";
import type { Transport } from "../state/session-client.ts";

/** Who the console acts as: whoever `GET /v1/me` names on the API, a stand-in for recorded sessions. */
export type ConsoleActor = {
	readonly id: string;
	readonly name: string;
	readonly email?: string;
	/** True while sign-in is a stand-in, so the shell can say so. */
	readonly stubbed: boolean;
	/** Ends the session, when the console signed in itself (an email code). Access ends its own at the edge. */
	readonly signOut?: () => Promise<void>;
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

/** Whether the signed-in person may start a session in a project, and why not when they can't. */
export type StartAccess =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			/** Shown under New session and in the composer, such as a viewer's "Starting one needs the operator role." */
			readonly reason: string;
	  };

/**
 * What a new session in a project runs with: the agent, on its own model. The model and thinking level a person picks
 * on New session go with its first message (`modelChoices` gives what to offer).
 */
export type StartOptions = {
	readonly agentId: string;
	readonly agentName: string;
};

/** A session to create: the project, the agent and its title. */
export type CreateInput = {
	readonly projectId: string;
	readonly agentId: string;
	readonly title?: string;
};

export type SendOptions = {
	/** Retrying with the same id sends once. */
	readonly requestId?: string;
	/** The model the run and the session's later runs use: a `ModelChoices.models` id. Absent keeps the session's. */
	readonly model?: string;
	/** The thinking level, as `model`. Absent keeps the session's, clamped to the model. */
	readonly thinking?: ThinkingLevel;
};

/** The composer's model and thinking pickers for a session, or for one about to start. */
export type ModelChoices = {
	/** The models the session may use, from the organisation's and project's configuration. */
	readonly models: readonly ComposerModelOption[];
	/** What the session runs with now: its agent's until a message names another. */
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
	/** The agent profile's level, marked Default in the thinking picker. */
	readonly defaultThinking?: ThinkingLevel;
};

/** A directory's entries, sorted or not, and whether there were more than the console reads. */
export type WorkspaceListing = {
	readonly entries: readonly WorkspaceEntry[];
	readonly truncated: boolean;
};

/** One file as the workspace read API serves it: its bytes, never run or rendered as HTML. */
export type WorkspaceFile = {
	readonly content: Uint8Array;
	readonly contentType: string;
	/** The workspace version that last changed it, or a mount's pinned version. */
	readonly version: number | string;
};

/**
 * One session's workspace, read-only, over the workspace read API's GET routes. There is nothing here that writes, runs
 * a command or acquires a sandbox, so browsing files never starts one. Errors are `ApiError`s; a file larger than the
 * API serves is refused with the code `too_large`.
 */
export interface WorkspaceFiles {
	readonly id: string;
	/** A directory's entries; `""` is the root and `/project` a mount. Every page, up to a cap. */
	list(path: string, signal?: AbortSignal): Promise<WorkspaceListing>;
	read(path: string, signal?: AbortSignal): Promise<WorkspaceFile>;
}

export interface ConsoleClient {
	readonly actor: ConsoleActor;
	projects(): Promise<readonly ProjectSummary[]>;
	/** Follows a project's sessions; `onChange` gets every new state. Returns a function that stops following. */
	watchSessions(projectId: string, onChange: (state: SessionListState) => void): () => void;
	/** The protocol connection to one session: hello, a snapshot or the deltas after a cursor, history pages. */
	transport(sessionId: string): Transport;
	/** The project a session belongs to, or undefined when there's no such session. */
	projectOf(sessionId: string): Promise<string | undefined>;
	/** Whether New session is offered in a project: the API refuses a viewer, so the console says so first. */
	mayStart(projectId: string): StartAccess;
	/** The agent a new session in the project runs. Rejects when no agent may run there. */
	startOptions(projectId: string, signal?: AbortSignal): Promise<StartOptions>;
	/** Creates an idle session and resolves with its id; its first message is a `prompt`. */
	create(input: CreateInput): Promise<string>;
	control(sessionId: string): SessionControl;
	/**
	 * What the composer's model and thinking pickers offer: a session's, or with `start`, a new session's in the project.
	 * Absent on a client that can't choose (a recorded session); there are no pickers then.
	 */
	modelChoices?(
		target:
			| { readonly sessionId: string }
			| { readonly start: { readonly projectId: string; readonly agentId: string } },
		signal?: AbortSignal,
	): Promise<ModelChoices>;
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
	/** The session's workspace, read-only, or undefined when it has none. Rejects when there's no such session. */
	workspace(sessionId: string): Promise<WorkspaceFiles | undefined>;
}
