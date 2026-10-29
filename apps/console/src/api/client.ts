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

/** A repository a new session's workspace starts from, at a branch. */
export type RepositoryChoice = {
	/** `owner/name` on GitHub. */
	readonly repo: string;
	readonly branch: string;
};

/** A session to create: the project, the agent, its title and the repository its workspace starts from, if any. */
export type CreateInput = {
	readonly projectId: string;
	readonly agentId: string;
	readonly title?: string;
	/** Seeds a new workspace with the repository's files at the branch, then starts the session on it. */
	readonly repository?: RepositoryChoice;
};

/** A repository's branches, as New session's branch picker lists them. */
export type RepositoryBranches = {
	readonly repo: string;
	readonly defaultBranch?: string;
	readonly branches: readonly { readonly name: string; readonly commit: string }[];
	/** More branches than were listed. */
	readonly truncated: boolean;
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

/** A watch-only live view of one of a session's browsers: the link to embed, and when it stops working (epoch ms). */
export type BrowserLiveLink = {
	/** A page to embed. The only kind today; Harbour's own browser runtime may add a frames stream or a replay. */
	readonly kind: "embed";
	readonly url: string;
	/** What the page posts to its parent once its stream is over. */
	readonly endMessage?: string;
	readonly expiresAt?: number;
};

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
	/**
	 * A repository's branches, for New session's branch picker; rejects with `not_found` when Harbour can't read it.
	 * Absent on a client that can't start a session on a repository (a recorded session).
	 */
	branches?(projectId: string, repo: string, signal?: AbortSignal): Promise<RepositoryBranches>;
	/**
	 * Creates an idle session and resolves with its id; its first message is a `prompt`. With `repository`, it first
	 * creates the session's workspace from the repository at the branch.
	 */
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
	 * Starts a new idle session in the same project with the history up to the answer `itemId`, and resolves with its
	 * id. Undefined when the host can't branch a session.
	 */
	readonly fork?: (sessionId: string, itemId: string) => Promise<string>;
	/**
	 * Rewinds the session to the person's message `itemId` and sends `text` in its place; what came after it leaves the
	 * session. The session must be idle. Undefined when the host can't branch a session.
	 */
	readonly edit?: (sessionId: string, itemId: string, text: string, options?: SendOptions) => Promise<void>;
	/**
	 * Allows or declines the agent's waiting `browser_request` call (its tool item's `callId`): allowing grants the sites
	 * it asked for, as the signed-in person. Absent on a client that can't (a recorded session).
	 */
	decideBrowser?(sessionId: string, callId: string, allow: boolean): Promise<void>;
	/**
	 * A watch-only live-view link to one of the session's browsers (a tool item's `browserSessionId`), for the signed-in
	 * person: a brwsr share link that can't take control, and expires. Rejects with `expired` once the browser has
	 * closed, and `not_found` for a browser the session doesn't have. Absent on a client that has no live browsers.
	 */
	browserLive?(sessionId: string, browserSessionId: string, signal?: AbortSignal): Promise<BrowserLiveLink>;
	/**
	 * A replay link to one of the session's browsers, open or closed, for the signed-in person: Harbour's own browsers
	 * record what they show (a deployment on brwsr answers `unavailable`). Rejects with `not_found` when nothing was
	 * recorded and `expired` once the recording is past its retention. Absent on a client with no browsers.
	 */
	browserReplay?(sessionId: string, browserSessionId: string, signal?: AbortSignal): Promise<BrowserLiveLink>;
	/**
	 * The session is on screen: it is no longer unread, and doesn't become unread while it stays shown. Call the
	 * returned function when it leaves the screen.
	 */
	markRead(sessionId: string): () => void;
	/** The session's workspace, read-only, or undefined when it has none. Rejects when there's no such session. */
	workspace(sessionId: string): Promise<WorkspaceFiles | undefined>;
}
