// The console's one seam to a Harbour host. Everything the screens need goes through `ConsoleClient`: who is signed
// in, the projects, a project's sessions, the live connection to one session, the controls, and a session's workspace
// files, read-only. Two implementations:
// the session API over HTTP (`http.ts`) and the recorded-session client (`recorded.ts`, in the page, no backend).
// Swapping one for the other changes nothing in src/ui.

import type { SessionSnapshot, UserAttachment } from "@harbour/protocol";
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

/** The session a subagent's session was started from. */
export type SessionParent = {
	readonly id: string;
	readonly title: string;
};

/** A project's sessions as the list shows them, with how fresh the list is. */
export type SessionListState = {
	readonly sessions: readonly SessionSummary[];
	readonly loading: boolean;
	readonly error?: string;
};

/** A change from a session's menu: its title, or whether it is pinned, archived or unread. Absent fields stay. */
export type SessionChange = {
	readonly title?: string;
	readonly pinned?: boolean;
	readonly archived?: boolean;
	readonly unread?: boolean;
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
	/** Files uploaded with `uploadAttachment` for this message, in the order they were attached. */
	readonly attachments?: readonly UserAttachment[];
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
	/** Its digest (the read API's `ETag`), for writing it back only if it hasn't changed since. */
	readonly digest?: string;
};

/** A file written back: the workspace version that wrote it, and its new digest. */
export type WrittenFile = {
	readonly version: number;
	readonly digest?: string;
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
	/**
	 * Writes one file (a document the person edited) through `PUT /v1/workspaces/{id}/content`, only if it is still the
	 * digest `ifMatch` names; rejects with the code `conflict` when it changed. Absent on a client that can't write.
	 */
	write?(path: string, content: string, ifMatch: string | undefined): Promise<WrittenFile>;
	/** Sharing the workspace's files (the shares API). Absent on a client that can't share. */
	readonly shares?: WorkspaceShares;
}

/** A file's share as the shares API returns it. */
export type FileShareRecord = {
	readonly id: string;
	readonly path: string;
	readonly title?: string;
	readonly access: "restricted" | "link";
	/** The link's secret: the link is `/shared/<token>` on Harbour's hostname. */
	readonly token: string;
	readonly createdBy: string;
	readonly invites: readonly { readonly email: string }[];
};

/** One workspace's shares: each file has at most one, made the first time it's shared. */
export interface WorkspaceShares {
	/** The file's live share, or undefined when it has none. */
	find(path: string, signal?: AbortSignal): Promise<FileShareRecord | undefined>;
	/** The file's share, made if it has none. */
	share(path: string, title: string | undefined): Promise<FileShareRecord>;
	setAccess(shareId: string, access: "restricted" | "link"): Promise<FileShareRecord>;
	invite(shareId: string, email: string): Promise<FileShareRecord>;
	uninvite(shareId: string, email: string): Promise<FileShareRecord>;
	/** The link a share's token opens, on this host. */
	link(share: FileShareRecord): string;
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
	/**
	 * The session that started this one, when it is a subagent's (a child session): its id and title, for the top bar's
	 * breadcrumbs. Undefined for a top-level session or when there's no such session. Absent on a client whose sessions
	 * have no parents (a recorded session).
	 */
	parentOf?(sessionId: string, signal?: AbortSignal): Promise<SessionParent | undefined>;
	/**
	 * The session a `subagent` call in this session started, by the call's ID: the session its card opens. Undefined
	 * until the call has started it (or when it never did). Absent on a client with no subagents (a recorded session).
	 */
	subagentOf?(sessionId: string, callId: string, signal?: AbortSignal): Promise<string | undefined>;
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
	/**
	 * Uploads a file for a message in the project, and resolves with the reference the message carries. Rejects with an
	 * `ApiError` whose message says why (a type the model can't read, too large). Absent on a client that takes no files.
	 */
	uploadAttachment?(projectId: string, file: File, signal?: AbortSignal): Promise<UserAttachment>;
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
	 * Hints that a message is coming (`POST /sessions/{id}/warm`): the session's sandbox gets ready for its next command.
	 * Idempotent. Undefined when the host doesn't warm.
	 */
	readonly warm?: (sessionId: string) => Promise<void>;
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
	/**
	 * Renames a session, or pins, archives or marks it unread (or the opposite), for the list's menu; the list shows the
	 * change once it resolves. Absent on a client that can't (a recorded session): its rows have no menu.
	 */
	updateSession?(sessionId: string, change: SessionChange): Promise<void>;
	/**
	 * Keeps the person's theme (a theme ID, or "system") as their preference on the server, so it follows them to another
	 * browser. Fire and forget: this browser already shows and remembers it. Absent where there's nowhere to keep it (a
	 * recorded session, an API key).
	 */
	readonly saveTheme?: (preference: string) => void;
	/** Deletes a session for good: it stops and leaves every list. Absent on a client that can't. */
	deleteSession?(sessionId: string): Promise<void>;
	/** The session's workspace, read-only, or undefined when it has none. Rejects when there's no such session. */
	workspace(sessionId: string): Promise<WorkspaceFiles | undefined>;
	/**
	 * The projects as this browser last showed them to the signed-in person, to show while `projects()` answers.
	 * Absent without a local cache (api/cached.ts).
	 */
	cachedProjects?(): Promise<readonly ProjectSummary[] | undefined>;
	/** A session as this browser last held it, to show while its stream connects. Absent without a local cache. */
	cachedSession?(sessionId: string): Promise<SessionSnapshot | undefined>;
	/** Keeps a session as it is on screen, for the next load. Absent without a local cache. */
	rememberSession?(snapshot: SessionSnapshot): void;
}
