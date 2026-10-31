/**
 * Session runtime and directory. A session is one durable agent conversation (one Pi Durable harness), owned by an
 * organisation, scoped to one of its projects or to the organisation itself, and run with an
 * agent profile. A host prompts, steers, follows up, aborts and watches it,
 * and serves host tools over an authenticated callback.
 *
 * Pi types never appear here; the runtime projects Pi Durable's transcript onto `@kantel/protocol` items.
 */
import type { HistoryPage, ServerFrame, SessionSnapshot, SessionStatus, TranscriptItem, Usage } from "@kantel/protocol";
import type {
	Actor,
	AgentId,
	CallContext,
	JsonSchema,
	JsonValue,
	OrganisationId,
	Page,
	PageRequest,
	ProjectId,
	ReplayPolicy,
	SessionId,
	Subscription,
	Timestamp,
	UserId,
	WorkspaceId,
} from "./common.ts";
import type { ModelThinking } from "./models.ts";
import type { SandboxPolicy } from "./sandbox.ts";

export type { SessionStatus } from "@kantel/protocol";

export interface PromptLayer {
	/** Such as `worker`, `role`, `brief`. Layers are joined in order. */
	readonly name: string;
	readonly text: string;
}

/** A named model route, resolved by the runtime (on Kantel, a vault route to a model gateway). */
export interface ModelChoice {
	readonly route: string;
	readonly modelId?: string;
	readonly thinking?: "off" | "low" | "medium" | "high";
}

/** What a session runs with. Host apps register their profiles (such as Sal's `sal-worker`). */
export interface AgentProfile {
	readonly id: AgentId;
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly name: string;
	readonly model: ModelChoice;
	/**
	 * The model the agent makes images with, through the `generate_image` tool: a route (or `<route>` and a model ID) whose
	 * model has `image` in its `output`. Independent of `model`, so a session can chat with one connector and draw with
	 * another. Without it, or when the gateway doesn't list it as an image model, the session has no `generate_image`.
	 * Its `thinking` is ignored.
	 */
	readonly imageModel?: ModelChoice;
	readonly promptLayers: readonly PromptLayer[];
	/**
	 * Tool and capability names the agent may call, including host tools. A tool server's tools are entries
	 * `<server>/<tool>` or `<server>/*` (`parseToolServerEntry` in ./tool-servers.ts); the model sees each as
	 * `<server>__<tool>`, and a name too long for that is refused when the profile is saved.
	 */
	readonly tools: readonly string[];
	/** Skill IDs the session lists, by name, description and path. */
	readonly skills: readonly string[];
	readonly sandbox: SandboxPolicy;
	/** Memory scopes recall may read. */
	readonly memoryScopes: readonly string[];
	/** Host tools are served by this host; see `HostToolBridge`. */
	readonly hostId?: string;
}

/**
 * Where a session works: `project` (the default) in `CreateSessionInput.projectId`, or `organisation`, above every
 * project and in none of them. See `SessionRecord.projectId`.
 */
export type SessionScopeKind = "project" | "organisation";

export interface SessionRecord {
	readonly id: SessionId;
	readonly organisationId: OrganisationId;
	/**
	 * The project the session works in. Absent for an organisation-scoped session, whose agent reaches what the
	 * organisation owns and the session user's own, and no project's records (`scopeOf(record)`).
	 */
	readonly projectId?: ProjectId;
	readonly agentId: AgentId;
	/**
	 * The person the session works for: whose own skills and prompt rules it gets. The creator when that is a human;
	 * a service or Kantel may name another user; a child session has its parent's. It grants no role.
	 */
	readonly userId?: UserId;
	readonly parentSessionId?: SessionId;
	readonly workspaceId?: WorkspaceId;
	readonly title?: string;
	/**
	 * Who may see it (#335). `private`: only the person it acts for (`userId`), the service that made it and Kantel; no
	 * project or organisation member, an admin included. `shared` (absent): everyone with a role on its project or, for
	 * an organisation session, the organisation. A child has its parent's. It decides which connections the session may
	 * use (`sessionAudienceOf`): a person's private connection never reaches a session other people can see.
	 */
	readonly visibility?: SessionVisibility;
	readonly status: SessionStatus;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels: { readonly [key: string]: string };
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
	/**
	 * Proposed: pinned to the top of the session list, and when. Set by `SessionOrganising.update`; session-wide, not per
	 * person, for now.
	 */
	readonly pinnedAt?: Timestamp;
	/**
	 * Proposed: archived, and when: out of the session list's default view, but still readable and usable. Set by
	 * `SessionOrganising.update`; session-wide, not per person, for now.
	 */
	readonly archivedAt?: Timestamp;
	/**
	 * Proposed: someone marked the session unread, and when; a client clears it (`unread: false`) when the session is
	 * next opened. Set by `SessionOrganising.update`; session-wide, not per person, for now.
	 */
	readonly markedUnreadAt?: Timestamp;
}

export interface CreateSessionInput {
	/** The session's project; required for a project session, and not given for an organisation one. */
	readonly projectId?: ProjectId;
	/**
	 * `project` (default) or `organisation`. An organisation session names no project and needs an organisation-wide
	 * operator (or an agent in an organisation session, for a child). A child is in its parent's scope.
	 */
	readonly scope?: SessionScopeKind;
	/**
	 * The person the session works for (`SessionRecord.userId`). A human may name only themselves, an agent none (a
	 * child has its parent's); a service or Kantel may name any user. Default the creator when that is a human.
	 */
	readonly userId?: UserId;
	readonly agentId: AgentId;
	readonly title?: string;
	readonly labels?: { readonly [key: string]: string };
	readonly workspaceId?: WorkspaceId;
	/** Creates a child session owned by this parent; aborting the parent aborts it. */
	readonly parentSessionId?: SessionId;
	/**
	 * Who may see it (`SessionRecord.visibility`). Default `shared`. `private` needs a person to act for; a child takes its
	 * parent's and may not name another.
	 */
	readonly visibility?: SessionVisibility;
}

/** Who may see a session: only the person it acts for, or the project's (or organisation's) members too. */
export type SessionVisibility = "private" | "shared";

/**
 * Who can see a session, for choosing its connections (`SessionAudience` in connections.ts). A session with no person
 * behind it is shared. In a one-person deployment (`personal`, a personal agent such as Sal or Erys) every session
 * acting for that person is theirs alone, so it collapses to "all mine". Otherwise the session's own visibility
 * decides, and an absent one is shared: the safe default, since a personal connection then stays out.
 */
export function sessionAudienceOf(
	record: Pick<SessionRecord, "userId" | "visibility">,
	personal = false,
): { readonly kind: "private"; readonly userId: UserId } | { readonly kind: "shared" } {
	if (record.userId === undefined) return { kind: "shared" };
	if (personal || record.visibility === "private") return { kind: "private", userId: record.userId };
	return { kind: "shared" };
}

/**
 * A file a person attached to a prompt (the composer's picker, a drop or a paste), already uploaded by the host. The
 * host owns the upload: where the bytes are stored, scanning and size limits. The prompt carries only this reference.
 *
 * Implemented (30 Oct 2026): the runtime reads a prompt's attachments through its host (`SessionRuntimeOptions.attachments`
 * in `@kantel/runtime`), which turns each into what the model sees: an image as image content, a text file or a PDF's
 * text as text. A runtime without one refuses a prompt with attachments as `invalid`.
 */
export interface PromptAttachment {
	/** The host's ID for the upload. Unique within the prompt. */
	readonly id: string;
	/** The file's name as the person saw it, such as `invoice.pdf` or `pasted-text.txt`. */
	readonly name: string;
	/** The MIME type, such as `image/png` or `text/plain`. */
	readonly type: string;
	/** In bytes. */
	readonly size: number;
	/**
	 * `image`: a PNG, JPEG, GIF or WebP a model can look at; `file`: any other file; `text`: a large paste the composer
	 * folded into a file instead of the prompt's text.
	 */
	readonly kind: "image" | "file" | "text";
}

export interface PromptInput {
	/** The prompt's words. Proposed: may be empty when `attachments` has at least one item. */
	readonly text: string;
	/** Retrying with the same requestId returns the same submission instead of submitting twice. */
	readonly requestId?: string;
	/** Proposed: files the host uploaded for this prompt, in the order the person attached them. */
	readonly attachments?: readonly PromptAttachment[];
	/**
	 * Proposed: a `ModelOption.id` from `SessionModels.listModels`, which this input's run and the session's later runs
	 * use (a steer's from the run's next model call). Absent keeps the session's current model. An ID the session can't
	 * use is `invalid`, and one with a
	 * `disabledReason` is `refused`; an image attachment for a model whose `capabilities.images` is `false` is `invalid`.
	 * The model is fixed once the session has started (`SessionModelState.locked`): from then on, naming another model
	 * is `conflict`, so everything in a session's transcript comes from one model. Naming the session's own is accepted.
	 */
	readonly model?: string;
	/**
	 * Proposed: the thinking level this input's run and the session's later runs use, as `model` is. A level the model
	 * doesn't support runs as the nearest one it does (pi's `clampThinkingLevel`); choosing another model without a level
	 * keeps the session's level, clamped the same way. Absent keeps the session's current level. Unlike `model`, it can
	 * change at any point in a session, though a change may cost the next call the provider's prompt cache.
	 */
	readonly thinking?: ModelThinking;
}

/**
 * One model a person may choose for a session: one of the models `ModelGateway.config` lists for it (a route, or a
 * route's model override), as the composer's model picker shows it. The organisation's and project's configuration
 * (connectors, routes and the project's policy, see models.ts) decide the list; this only describes it.
 */
export interface ModelOption {
	/** `ModelGatewayModel.id`: a route name such as `default`, or `<route>:<modelId>` for an override. */
	readonly id: string;
	/** What a person reads, such as `Claude Sonnet 4.5`. */
	readonly label: string;
	/** Who serves the model, for grouping the list, such as `Anthropic`. */
	readonly provider?: string;
	/** One short line, such as `Fast, for small edits`. */
	readonly description?: string;
	/** What the model takes. A field left out is unknown, and clients act only on what is given. */
	readonly capabilities?: {
		/** Reads images: `ModelGatewayModel.input` includes `image`. */
		readonly images?: boolean;
		/** The thinking levels it supports: the levels `ModelGatewayModel.thinkingLevelMap` doesn't map to `null`. */
		readonly thinking?: readonly ModelThinking[];
	};
	/**
	 * The model the session runs with when a prompt names none: its agent profile's route, until a prompt names
	 * another. At most one option.
	 */
	readonly default?: boolean;
	/** Set when the model is listed but can't be chosen now, with the reason a person reads. Shown dimmed, not hidden. */
	readonly disabledReason?: string;
}

/** A model and thinking level: what a session runs with, or what its agent profile names. */
export interface ModelSelection {
	/** A `ModelOption.id`. */
	readonly model: string;
	/** Absent for a model that can't think. */
	readonly thinking?: ModelThinking;
}

/** What a client's model and thinking pickers show for a session, or for a session about to be created. */
export interface SessionModelState {
	/** As `listModels` gives them. */
	readonly models: readonly ModelOption[];
	/**
	 * What the session's next model call uses: its agent profile's, until a prompt names another model or level. Kept
	 * with the session's conversation, so it outlives the process. Absent when the session's model isn't one it may name.
	 */
	readonly selected?: ModelSelection;
	/**
	 * What the session's agent profile names, from the organisation's or project's configuration: the `default` option
	 * and the profile's thinking level (`off` when it names none).
	 */
	readonly defaults?: ModelSelection;
	/**
	 * Set once the session has started (it holds a message): its model is `selected`'s for good, and a prompt naming
	 * another is `conflict`. Its thinking level can still change. Absent before the first message and for a session
	 * about to be created.
	 */
	readonly locked?: boolean;
}

/** A session not created yet: the project it will be in (none for an organisation session) and its agent profile. */
export interface SessionModelsStart {
	readonly projectId?: ProjectId;
	/** As `CreateSessionInput.scope`. */
	readonly scope?: SessionScopeKind;
	readonly agentId: AgentId;
}

/**
 * Proposed (27 Oct 2026): the models a session's prompts may name, for a client's model picker. A separate interface so
 * that no existing `SessionRuntime` has to change to adopt it.
 */
export interface SessionModels {
	/**
	 * The models the session may use, in the order to show them: what the gateway's `config` lists for the session,
	 * after the project's policy, with exactly one `default` when the session's own route is among them. The caller needs
	 * viewer on the session's project; another organisation's session is `not_found`.
	 */
	listModels(ctx: CallContext, sessionId: SessionId): Promise<readonly ModelOption[]>;
	/** `listModels`, with what the session runs with now and what its profile names. Access as `listModels`. */
	modelState(ctx: CallContext, sessionId: SessionId): Promise<SessionModelState>;
	/**
	 * What a session the caller is about to create would list, so a New session screen can offer the choice before the
	 * session exists; its first prompt carries the choice. `selected` is `defaults`. The caller needs operator on the
	 * project, as `create` does; a profile for another project is `invalid`.
	 */
	startModels(ctx: CallContext, start: SessionModelsStart): Promise<SessionModelState>;
}

/** Where to fork a session: the answer the new session's history ends with. */
export interface ForkSessionInput {
	/** The transcript item ID of an assistant answer, as the session's stream gives it. */
	readonly itemId: string;
	/** The new session's title. Default the source's title with " (fork)" after it. */
	readonly title?: string;
}

/**
 * What to edit: a message the person sent, and the words to send in its place, with the model and thinking level to
 * rerun on as a prompt takes them (absent keeps the session's as they were before the message).
 */
export interface EditSessionInput extends Pick<PromptInput, "text" | "requestId" | "model" | "thinking"> {
	/** The transcript item ID of a user message, as the session's stream gives it. */
	readonly itemId: string;
}

/**
 * Proposed (28 Oct 2026, the session view's message actions, issue #6): branching a session's history. A separate
 * interface, as `SessionHistory` is, so that no existing `SessionRuntime` has to change to adopt it.
 */
export interface SessionBranching {
	/**
	 * Creates a session in the same project, with the same agent and workspace, whose history is this session's up to and
	 * including the answer `itemId` names. It starts idle: nothing runs until the person prompts it. The caller needs
	 * operator on the project; an item that is not an answer in the session's current transcript is `not_found`. The
	 * source session is unchanged.
	 */
	fork(ctx: CallContext, sessionId: SessionId, input: ForkSessionInput): Promise<SessionRecord>;
	/**
	 * Rewinds the session to just before the message `itemId` names and sends `text` in its place: the message and
	 * everything after it leave the transcript, and a run starts from the edited message. The earlier history stays in
	 * the session's storage but is no longer shown or sent to the model. The session must be idle (`conflict` while a run
	 * is going or once it is closed); an item that is not a user message in its current transcript is `not_found`.
	 * Watchers get a fresh snapshot.
	 */
	edit(ctx: CallContext, sessionId: SessionId, input: EditSessionInput): Promise<Submission>;
}

/** What to change about a session's place in the list. Each field left out is left as it is. */
export interface SessionUpdate {
	/** The session's new title: trimmed, then 1 to 200 characters. */
	readonly title?: string;
	/** Pins the session to the top of the list (`pinnedAt`), or unpins it. */
	readonly pinned?: boolean;
	/** Archives the session (`archivedAt`), taking it out of the list's default view, or brings it back. */
	readonly archived?: boolean;
	/** Marks the session unread (`markedUnreadAt`), or clears the mark. */
	readonly unread?: boolean;
	/**
	 * Who may see it (#335). Only the person the session acts for may change it (or Kantel); a child session follows its
	 * parent, and changing a parent changes its children too. Making a private session shared shows what is already in
	 * it; from then on a person's private connections are refused in it.
	 */
	readonly visibility?: SessionVisibility;
}

/**
 * Proposed (30 Oct 2026, the console's session menu): renaming, pinning, archiving, marking unread and deleting a
 * session. A separate interface, as `SessionBranching` is, so that no existing `SessionRuntime` has to change to adopt
 * it. The marks are on the session, not per person, for now.
 */
export interface SessionOrganising {
	/**
	 * Changes what `change` names and answers the record as now stored. The caller needs operator on the session's
	 * project; another organisation's session is `not_found`. A title is trimmed and must then be 1 to 200 characters
	 * (`invalid` otherwise). `pinned: true` sets `pinnedAt` to now, keeping the time it was pinned when it already is,
	 * and `pinned: false` removes it; `archived` and `archivedAt`, and `unread` and `markedUnreadAt`, work the same way.
	 * It doesn't change `updatedAt`, which is the session's last activity: its status changes. An empty change changes
	 * nothing.
	 */
	update(ctx: CallContext, sessionId: SessionId, change: SessionUpdate): Promise<SessionRecord>;
	/**
	 * Deletes the session. It is closed first, as `SessionRuntime.close` closes it (its work stops, and its leases,
	 * browsers and grants end), then it is never found again: every call naming it answers `not_found`, and it leaves
	 * every list. Its stored transcript is kept in storage for now (a soft delete). The caller needs operator on the
	 * session's project; removing a removed session is `not_found`.
	 */
	remove(ctx: CallContext, sessionId: SessionId): Promise<void>;
}

/** The most items one history page holds; a larger `limit` is cut to it. */
export const SESSION_HISTORY_MAX_LIMIT = 200;
/** Items in a history page when the request gives no `limit`. */
export const SESSION_HISTORY_DEFAULT_LIMIT = 50;

/**
 * Which page of a session's transcript to read. With neither `cursor` nor `before`, the latest page: the newest
 * `limit` items. Give at most one of the two.
 */
export interface SessionHistoryRequest {
	/** A previous page's `nextCursor`: the page of items older than that page's oldest. Opaque. */
	readonly cursor?: string;
	/**
	 * The page of items older than this item ID, such as a snapshot's `items[0].id`: what the protocol's `history` frame
	 * names as `before`, so a client holding a snapshot pages back from it.
	 */
	readonly before?: string;
	/** At most this many items, from 1. Default `SESSION_HISTORY_DEFAULT_LIMIT`, cut to `SESSION_HISTORY_MAX_LIMIT`. */
	readonly limit?: number;
}

/** One page of a session's transcript, newest first. */
export interface SessionHistoryPage {
	readonly sessionId: SessionId;
	/** Newest first: `items[0]` is the newest item in the page, `items.at(-1)` its oldest. */
	readonly items: readonly TranscriptItem[];
	/** Present when older items exist: pass it as `cursor` for the page before this one. */
	readonly nextCursor?: string;
}

/**
 * Proposed (28 Oct 2026, for the session view's scroll-back, issue #6): a session's transcript in pages, newest first,
 * so a client shows the latest turns at once and loads older ones as the reader scrolls back. A separate interface, as
 * `SessionModels` is, so that no existing `SessionRuntime` has to change to adopt it.
 *
 * A cursor names the oldest item of the page that gave it, and items are only ever appended (an item that changes, an
 * answer streaming, keeps its ID and place), so the pages behind a cursor stay the same while new turns arrive: paging
 * back never repeats or skips an item. Items are the ones a snapshot and `watch` deliver, with the same IDs, and the
 * IDs survive the runtime reopening the session, so a cursor does too.
 */
export interface SessionHistory {
	/**
	 * A page of the session's items, newest first. The caller needs viewer on the session's project; another
	 * organisation's session is `not_found`. A malformed cursor, a `limit` below 1, or both `cursor` and `before`, is
	 * `invalid`; a `before` or cursor naming an item the session doesn't have is `not_found`.
	 */
	history(ctx: CallContext, sessionId: SessionId, request?: SessionHistoryRequest): Promise<SessionHistoryPage>;
}

/** An image a session's transcript names by reference, as its bytes. */
export interface TranscriptImage {
	/** A raster type: `image/png`, `image/jpeg`, `image/webp` or `image/gif`. */
	readonly mimeType: string;
	readonly bytes: Uint8Array;
}

/**
 * The images a session's transcript names by reference (TASK-4223): a tool item's image is
 * `/v1/sessions/<sessionId>/images/<imageId>`, the image ID the SHA-256 of its bytes, rather than its base64, so a
 * snapshot and a stream carry no pictures. A separate interface, as `SessionHistory` is, so that no existing
 * `SessionRuntime` has to change to adopt it.
 */
export interface TranscriptImages {
	/**
	 * The image `imageId` names in the session's transcript. The caller needs viewer on the session; another
	 * organisation's session is `not_found`. An ID that isn't a SHA-256 in lowercase hex is `invalid`; one the session's
	 * transcript doesn't name is `not_found`. The same ID always answers the same bytes.
	 */
	image(ctx: CallContext, sessionId: SessionId, imageId: string): Promise<TranscriptImage>;
}

/**
 * A history page as the protocol's `history` frame carries it, for a client that keeps its transcript oldest first and
 * puts each page in front: the same items, oldest first, with `hasEarlier` when older items exist.
 */
export function protocolHistoryPage(page: SessionHistoryPage): HistoryPage {
	return { sessionId: page.sessionId, items: [...page.items].reverse(), hasEarlier: page.nextCursor !== undefined };
}

export interface Submission {
	readonly id: string;
	readonly sessionId: SessionId;
	readonly via: "prompt" | "steer" | "followUp";
	readonly requestId?: string;
}

/** How a run (an input to its final answer) ended. */
export interface RunResult {
	readonly sessionId: SessionId;
	readonly submissionId: string;
	readonly status: "answered" | "failed" | "aborted";
	readonly answer?: string;
	readonly error?: string;
	readonly usage?: Usage;
}

export interface WatchOptions {
	/** Resume after this cursor; a snapshot is sent when the runtime cannot resume from it. */
	readonly after?: string;
}

/**
 * Why the session-end hook runs: `aborted` (the session stays usable, and later input starts a new run) or
 * `session_ended` (closed for good).
 */
export type SessionEndReason = "aborted" | "session_ended";

/** What the session-end hook tells each teardown. */
export interface SessionEnd {
	readonly sessionId: SessionId;
	readonly organisationId: OrganisationId;
	/** Absent for an organisation-scoped session. */
	readonly projectId?: ProjectId;
	readonly agentId: AgentId;
	readonly parentSessionId?: SessionId;
	readonly reason: SessionEndReason;
	/** Who closed or aborted the session (for a child, whoever aborted its parent). */
	readonly endedBy: Actor;
	readonly at: Timestamp;
}

/**
 * One component's teardown: it ends everything it holds for `end.sessionId`. `ctx` is a `system` context in the
 * session's organisation, so a teardown never fails a permission check. A teardown must be idempotent: when the session
 * holds nothing more in the component, it changes nothing and audits nothing.
 */
export type SessionTeardown = (ctx: CallContext, end: SessionEnd) => Promise<void>;

/**
 * Settled 27 Oct 2026 (open question 8): one session-end hook. The runtime runs it when a session is closed and when
 * it is aborted (a parent's abort or close runs it for each child too). Components register their teardown once, at
 * wiring time: the sandbox releases its leases, the browser closes its browser sessions and ends its grants (grants
 * passed on from them end too), and the capability registry and the vault end the session's grants.
 *
 * Every registered teardown runs, in registration order, even when one before it fails. A failure is audited as
 * `session.teardown.failed` with the teardown's name and error code, never its message, and does not fail `close` or
 * `abort`. Closing a closed session runs nothing.
 */
export interface SessionEndHook {
	/** Adds a teardown under a unique name (`conflict` if the name is taken). Closing the subscription removes it. */
	register(name: string, teardown: SessionTeardown): Subscription;
}

export interface SessionRuntime {
	/**
	 * Creates a session (idle, with no transcript). The actor needs operator on the project, or across the organisation
	 * for an organisation session; an agent may create one only in its own session's scope. A child session is in its
	 * parent's scope.
	 */
	create(ctx: CallContext, input: CreateSessionInput): Promise<SessionRecord>;
	/** Durably admits user input. Starts a run when idle; queues it when busy. */
	prompt(ctx: CallContext, sessionId: SessionId, input: PromptInput): Promise<Submission>;
	/** Joins the running turn after its current tool round; behaves as `prompt` when idle. */
	steer(ctx: CallContext, sessionId: SessionId, input: PromptInput): Promise<Submission>;
	/** Queues input to run after the current run finishes. */
	followUp(ctx: CallContext, sessionId: SessionId, input: PromptInput): Promise<Submission>;
	/**
	 * Stops the running turn, cascades to child sessions and runs the session-end hook (`aborted`), so the session's
	 * browsers, browser, capability and vault grants and sandbox leases end. The session stays usable: a later prompt
	 * starts a new run. Aborting a closed session does nothing.
	 */
	abort(ctx: CallContext, sessionId: SessionId, reason?: string): Promise<void>;
	/** Waits for the run that `submissionId` started or joined to end. */
	wait(ctx: CallContext, sessionId: SessionId, submissionId: string): Promise<RunResult>;
	/** Streams protocol frames: hello, then deltas after `after` or a snapshot, then live deltas. */
	watch(
		ctx: CallContext,
		sessionId: SessionId,
		options: WatchOptions,
		onFrame: (frame: ServerFrame) => void,
	): Promise<Subscription>;
	snapshot(ctx: CallContext, sessionId: SessionId): Promise<SessionSnapshot>;
	/**
	 * Ends the session for good: aborts work, runs the session-end hook (`session_ended`) and marks it done. Later
	 * prompts reject with `conflict`; closing it again does nothing.
	 */
	close(ctx: CallContext, sessionId: SessionId): Promise<void>;
}

export interface SessionFilter {
	readonly projectId?: ProjectId;
	/** Only organisation-scoped sessions, or only project ones. */
	readonly scope?: SessionScopeKind;
	readonly agentId?: AgentId;
	readonly status?: SessionStatus;
	readonly parentSessionId?: SessionId;
	/**
	 * Proposed (30 Oct 2026, session control parity): the sessions that run in this workspace. Several sessions can share
	 * one workspace (`CreateSessionInput.workspaceId`), each its own conversation with its own history, as boat.dev runs
	 * several conversations in one sandbox; this lists them.
	 */
	readonly workspaceId?: WorkspaceId;
	/** Every label given must match. */
	readonly labels?: { readonly [key: string]: string };
}

/** Where sessions are found: by organisation, project, agent, parent and labels. */
export interface SessionDirectory {
	get(ctx: CallContext, sessionId: SessionId): Promise<SessionRecord>;
	/** Newest first. Only sessions in `ctx.organisationId`. */
	list(ctx: CallContext, filter?: SessionFilter, page?: PageRequest): Promise<Page<SessionRecord>>;
	children(ctx: CallContext, sessionId: SessionId): Promise<readonly SessionRecord[]>;
}

export interface AgentProfiles {
	put(ctx: CallContext, profile: AgentProfile): Promise<AgentProfile>;
	get(ctx: CallContext, agentId: AgentId): Promise<AgentProfile>;
	list(ctx: CallContext, page?: PageRequest): Promise<Page<AgentProfile>>;
}

/** A tool served by a host app (Sal's task_outcome, its brokered Slack and Drive tools). */
export interface HostToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly replay: ReplayPolicy;
}

export interface HostToolCall {
	readonly hostId: string;
	readonly sessionId: SessionId;
	readonly organisationId: OrganisationId;
	/** Absent for an organisation-scoped session. */
	readonly projectId?: ProjectId;
	readonly agentId: AgentId;
	/** Stable across retries of the same call. */
	readonly callId: string;
	readonly tool: string;
	readonly args: JsonValue;
}

export interface HostToolResult {
	readonly output: string;
	readonly isError?: boolean;
	readonly structured?: JsonValue;
}

export type HostToolHandler = (call: HostToolCall, signal: AbortSignal) => Promise<HostToolResult>;

/**
 * How a host serves its tools. On a deployed target the handler is an authenticated HTTPS callback; in memory it is a
 * function. A tool named in a profile but not registered fails the call with an error result.
 */
export interface HostToolBridge {
	register(
		ctx: CallContext,
		hostId: string,
		tools: readonly HostToolDefinition[],
		handler: HostToolHandler,
	): Promise<Subscription>;
	list(ctx: CallContext, hostId: string): Promise<readonly HostToolDefinition[]>;
}
