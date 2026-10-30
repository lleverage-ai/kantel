/**
 * Harbour's public API, version 1: every route a host app (or the console) may call, under `/v1`. Add a route here and
 * the server must implement it (`createRouter` takes a handler for each), and the OpenAPI document and the SDK pick it
 * up when they are generated (`pnpm --filter @harbour/api generate`; CI fails while they are stale).
 */

import { HistoryQuery, ServerFrame, SessionHistoryPage, StreamQuery } from "./protocol-schema.ts";
import { defineRoute } from "./route.ts";
import { PendingRun, RunResult, RunResultQuery } from "./run-schema.ts";
import {
	AbortSessionBody,
	AccessRequest,
	AccessRequestDecided,
	AccessRequestPage,
	AccessRequestPath,
	BindingBody,
	BrowserEmbed,
	BrowserSessionPath,
	Concept,
	ConceptPage,
	ConceptPath,
	CreatedSession,
	CreateMemorySpaceBody,
	CreateResourceShareBody,
	CreateScheduleBody,
	CreateSessionBody,
	DecideAccessRequestBody,
	EmbedBrowserBody,
	FileShare,
	FileSharePage,
	ForkSessionBody,
	ImportSkillBody,
	ListAccessRequestsQuery,
	ListBindingsQuery,
	ListConceptsQuery,
	ListPromptRulesQuery,
	ListResourceSharesQuery,
	ListSchedulesQuery,
	ListSessionsQuery,
	ListSharesQuery,
	ListShareUsesQuery,
	ListSkillsQuery,
	MemorySearchBody,
	MemorySearchResult,
	MemorySnapshot,
	MemorySpace,
	MemorySpacePage,
	MemorySpacePath,
	MessageBody,
	NewSessionModelsQuery,
	OccurrencePage,
	PageQuery,
	PreviewScheduleQuery,
	ProfilePath,
	PromptRule,
	PromptRuleList,
	PromptRulePath,
	PutPromptRuleBody,
	Recall,
	RecallBody,
	RegisteredResource,
	RegisterResourceBody,
	RequestAccessBody,
	ResolvedPromptRulesQuery,
	ResourceBinding,
	ResourceBindingPage,
	ResourcePolicy,
	ResourceQuery,
	ResourceShare,
	ResourceSharePage,
	ResourceSharePath,
	RevokeResourceShareBody,
	Schedule,
	SchedulePage,
	SchedulePath,
	SchedulePreview,
	SessionModelState,
	SessionPage,
	SessionPath,
	SessionRecord,
	SessionWarmth,
	SetResourcePolicyBody,
	ShareFileBody,
	ShareInviteBody,
	SharePath,
	ShareUseList,
	SkillFileContent,
	SkillFileQuery,
	SkillListingPage,
	SkillPackage,
	SkillPath,
	SkillRevision,
	SkillRevisionPage,
	SkillRevisionPath,
	Submission,
	UpdateScheduleBody,
	UpdateShareBody,
	WorkspaceSharesPath,
} from "./schema.ts";

/** The version's base path, before every route's own path. */
export const API_VERSION_BASE = "/v1";

export const createSession = defineRoute({
	operationId: "createSession",
	method: "POST",
	path: "/sessions",
	tag: "sessions",
	summary: "Create a session",
	description:
		"Starts a session of an agent profile in a project, and sends it `message` when there is one. Needs the operator " +
		"role on the project. If the first message is refused, the session is closed and the refusal answered.",
	body: CreateSessionBody,
	answer: { status: 201, description: "The new session.", schema: CreatedSession },
	errors: ["invalid", "forbidden", "not_found", "refused"],
});

export const listSessions = defineRoute({
	operationId: "listSessions",
	method: "GET",
	path: "/sessions",
	tag: "sessions",
	summary: "List sessions",
	description: "The sessions the caller may see, newest first, a page at a time.",
	query: ListSessionsQuery,
	answer: { status: 200, description: "A page of sessions.", schema: SessionPage },
	errors: ["invalid", "forbidden"],
});

export const getSession = defineRoute({
	operationId: "getSession",
	method: "GET",
	path: "/sessions/{sessionId}",
	tag: "sessions",
	summary: "Get a session",
	params: SessionPath,
	answer: { status: 200, description: "The session.", schema: SessionRecord },
	errors: ["forbidden", "not_found"],
});

export const closeSession = defineRoute({
	operationId: "closeSession",
	method: "POST",
	path: "/sessions/{sessionId}/close",
	tag: "sessions",
	summary: "Close a session",
	description:
		"Ends the session for good: its sandbox leases, browser sessions and grants end. Closing a closed session does nothing.",
	params: SessionPath,
	answer: { status: 204, description: "Closed." },
	errors: ["forbidden", "not_found"],
});

export const abortSession = defineRoute({
	operationId: "abortSession",
	method: "POST",
	path: "/sessions/{sessionId}/abort",
	tag: "sessions",
	summary: "Abort a session's run",
	description:
		"Interrupts the session's run in progress, and its child sessions' runs. The conversation keeps its history, and " +
		"files the run changed stay changed; what the run held ends (its browsers, sandbox leases and grants). The " +
		"run's result is `aborted`. The session stays open and takes new messages.",
	params: SessionPath,
	body: AbortSessionBody,
	answer: { status: 204, description: "Aborted." },
	errors: ["invalid", "forbidden", "not_found", "conflict"],
});

export const sendMessage = defineRoute({
	operationId: "sendMessage",
	method: "POST",
	path: "/sessions/{sessionId}/messages",
	tag: "messages",
	summary: "Send a message",
	description:
		"Sends the session's agent a message, `via` a prompt, a steer or a follow-up, optionally switching the session's " +
		"`model` or `thinking` level from that run on. The answer arrives on the session's stream, and `getRunResult` " +
		"says when its run has ended. Send an `Idempotency-Key` so a retry can't send it twice: a retry with the same key answers " +
		"the first call's submission without sending anything, and one with another `via` is a `conflict`.",
	params: SessionPath,
	body: MessageBody,
	idempotent: true,
	answer: { status: 202, description: "The session accepted the message.", schema: Submission },
	errors: ["invalid", "forbidden", "not_found", "conflict", "refused"],
});

export const streamSession = defineRoute({
	operationId: "streamSession",
	method: "GET",
	path: "/sessions/{sessionId}/stream",
	tag: "stream",
	summary: "Stream a session",
	description:
		"The session as `@harbour/protocol` frames: `hello`, then a `snapshot` of its state and latest items (or, with " +
		"`after`, the deltas after that cursor when the stream still holds them), then a `delta` for every change, live. " +
		"Fold them with the protocol's `applyFrames`. Over a WebSocket, compressed where the platform can, or as " +
		"server-sent events.",
	params: SessionPath,
	query: StreamQuery,
	stream: { frame: ServerFrame },
	answer: { status: 200, description: "The stream." },
	errors: ["invalid", "forbidden", "not_found"],
});

export const getSessionHistory = defineRoute({
	operationId: "getSessionHistory",
	method: "GET",
	path: "/sessions/{sessionId}/history",
	tag: "stream",
	summary: "Page back through a session",
	description:
		"The session's transcript in pages, newest first, for scrolling back past a snapshot's items: start with " +
		"`before` set to the snapshot's `items[0].id`, then follow `nextCursor`.",
	params: SessionPath,
	query: HistoryQuery,
	answer: { status: 200, description: "One page of items.", schema: SessionHistoryPage },
	errors: ["invalid", "forbidden", "not_found", "not_supported"],
});

export const getRunResult = defineRoute({
	operationId: "getRunResult",
	method: "GET",
	path: "/sessions/{sessionId}/result",
	tag: "messages",
	summary: "Wait for a message's run to end",
	description:
		"How the run that a message started or joined ended: `answered` with its final answer, `failed` or `aborted`. " +
		"Waits up to `timeoutMs` for it and answers 202 `pending` while it goes on, so a host that holds no stream " +
		"polls this until it ends. A steer's result is the run that acted on it: the run in progress when the steer " +
		"reached its next model call, or, when it arrived as that run gave its final answer, the run it started straight " +
		"after on the same conversation. Needs viewer on the session.",
	params: SessionPath,
	query: RunResultQuery,
	answer: { status: 200, description: "The run has ended.", schema: RunResult },
	otherAnswers: [{ status: 202, description: "The run is still going.", schema: PendingRun }],
	errors: ["invalid", "forbidden", "not_found"],
});

export const getSessionModels = defineRoute({
	operationId: "getSessionModels",
	method: "GET",
	path: "/sessions/{sessionId}/models",
	tag: "messages",
	summary: "List the models a session may switch to",
	description:
		"For a model and thinking picker: the models a message's `model` may name, what the session runs with now and " +
		"what its agent profile names. Naming another model on a message switches the session from that run on (a " +
		"steer's from the run's next model call) and keeps the conversation's context. Needs viewer on the session.",
	params: SessionPath,
	answer: { status: 200, description: "The session's models.", schema: SessionModelState },
	errors: ["forbidden", "not_found", "not_supported"],
});

export const getNewSessionModels = defineRoute({
	operationId: "getNewSessionModels",
	method: "GET",
	path: "/profiles/{agentId}/models",
	tag: "messages",
	summary: "List the models a new session could use",
	description:
		"What `getSessionModels` would answer for a session of this agent profile in `projectId`, before it exists, so a " +
		"New session screen can offer the choice; the first message carries it. `selected` is `defaults`. Needs operator " +
		"on the project, as creating the session does; `scope=organisation` with no `projectId` answers for a new " +
		"organisation session, and needs operator across the organisation.",
	params: ProfilePath,
	query: NewSessionModelsQuery,
	answer: { status: 200, description: "The models a new session would list.", schema: SessionModelState },
	errors: ["invalid", "forbidden", "not_found", "not_supported"],
});

export const forkSession = defineRoute({
	operationId: "forkSession",
	method: "POST",
	path: "/sessions/{sessionId}/fork",
	tag: "sessions",
	summary: "Fork a session from an answer",
	description:
		"Starts a new session in the same project, with the same agent profile and workspace, whose history is this " +
		"session's up to and including the answer `itemId` names: a second conversation that carries the first one's " +
		"context and goes its own way. It starts idle. The source session is unchanged. Needs operator on the project; an " +
		"item that is not an answer in the session's transcript is `not_found`.",
	params: SessionPath,
	body: ForkSessionBody,
	answer: { status: 201, description: "The new session.", schema: SessionRecord },
	errors: ["invalid", "forbidden", "not_found", "not_supported"],
});

/** The session plane's routes, served by `@harbour/runtime/http`. */
export const warmSession = defineRoute({
	operationId: "warmSession",
	method: "POST",
	path: "/sessions/{sessionId}/warm",
	tag: "sessions",
	summary: "Warm a session's sandbox",
	description:
		"A hint that a message is coming, such as when someone starts typing: the session's sandbox gets ready for its " +
		"next command, so it waits for no start. Its container starts only if the session has used one. Idempotent and " +
		"cheap to repeat; send it at most every few seconds. Needs the operator role on the session.",
	params: SessionPath,
	answer: { status: 200, description: "What the sandbox did.", schema: SessionWarmth },
	errors: ["forbidden", "not_found"],
});

export const sessionRoutes = {
	createSession,
	listSessions,
	getSession,
	closeSession,
	abortSession,
	forkSession,
	sendMessage,
	getRunResult,
	getSessionModels,
	getNewSessionModels,
	warmSession,
	streamSession,
	getSessionHistory,
} as const;

// Skills (#12): the console's skills page reads these, and a host's adapter imports through the last.

export const listSkills = defineRoute({
	operationId: "listSkills",
	method: "GET",
	path: "/skills",
	tag: "skills",
	summary: "List skills",
	description:
		"The published skills the caller sees, by name: the platform's, the organisation's, the project's named by " +
		"`projectId` and, for a person, their own. Never another project's or another person's.",
	query: ListSkillsQuery,
	answer: { status: 200, description: "A page of skills.", schema: SkillListingPage },
	errors: ["invalid", "forbidden"],
});

export const getSkill = defineRoute({
	operationId: "getSkill",
	method: "GET",
	path: "/skills/{skillId}",
	tag: "skills",
	summary: "Get a skill",
	params: SkillPath,
	answer: {
		status: 200,
		description: "The skill's package: its owner, latest revision and source.",
		schema: SkillPackage,
	},
	errors: ["forbidden", "not_found"],
});

export const listSkillRevisions = defineRoute({
	operationId: "listSkillRevisions",
	method: "GET",
	path: "/skills/{skillId}/revisions",
	tag: "skills",
	summary: "List a skill's revisions",
	params: SkillPath,
	query: PageQuery,
	answer: { status: 200, description: "A page of revisions.", schema: SkillRevisionPage },
	errors: ["invalid", "forbidden", "not_found"],
});

export const getSkillRevision = defineRoute({
	operationId: "getSkillRevision",
	method: "GET",
	path: "/skills/{skillId}/revisions/{revision}",
	tag: "skills",
	summary: "Get a revision",
	description: "A published revision: its digest, its files' paths and sizes, who published it and where it came from.",
	params: SkillRevisionPath,
	answer: { status: 200, description: "The revision.", schema: SkillRevision },
	errors: ["invalid", "forbidden", "not_found"],
});

export const readSkillFile = defineRoute({
	operationId: "readSkillFile",
	method: "GET",
	path: "/skills/{skillId}/revisions/{revision}/file",
	tag: "skills",
	summary: "Read a file of a revision",
	description: "One file of a published revision, such as its `SKILL.md`, by its path in the package.",
	params: SkillRevisionPath,
	query: SkillFileQuery,
	answer: { status: 200, description: "The file.", schema: SkillFileContent },
	errors: ["invalid", "forbidden", "not_found"],
});

export const importSkill = defineRoute({
	operationId: "importSkill",
	method: "POST",
	path: "/skills/import",
	tag: "skills",
	summary: "Import a skill from a host's source",
	description:
		"A host adapter's publish path: creates the skill if needed and publishes the files as its next revision, once " +
		"per `source` (`sourceId` and `ref`); files identical to the latest revision publish nothing. People and API keys " +
		"only, never an agent; a deployment may ask for more, such as the organisation's admin role.",
	body: ImportSkillBody,
	answer: { status: 200, description: "The revision the files are now.", schema: SkillRevision },
	errors: ["invalid", "forbidden", "conflict"],
});

export const skillRoutes = {
	listSkills,
	getSkill,
	listSkillRevisions,
	getSkillRevision,
	readSkillFile,
	importSkill,
} as const;

// Memory (#12): the console's memory page reads these, and a host's adapter loads a snapshot through the last two.

export const listMemorySpaces = defineRoute({
	operationId: "listMemorySpaces",
	method: "GET",
	path: "/memory/spaces",
	tag: "memory",
	summary: "List memory spaces",
	description:
		"The spaces the caller may read, oldest first: the organisation's, a project's to those who may view it, and a " +
		"person's own. A person never sees another person's space.",
	query: PageQuery,
	answer: { status: 200, description: "A page of spaces.", schema: MemorySpacePage },
	errors: ["invalid"],
});

export const listConcepts = defineRoute({
	operationId: "listConcepts",
	method: "GET",
	path: "/memory/spaces/{spaceId}/concepts",
	tag: "memory",
	summary: "List a space's concepts",
	description: "By ID, every status unless `status` names one.",
	params: MemorySpacePath,
	query: ListConceptsQuery,
	answer: { status: 200, description: "A page of concepts.", schema: ConceptPage },
	errors: ["invalid", "forbidden", "not_found"],
});

export const getConcept = defineRoute({
	operationId: "getConcept",
	method: "GET",
	path: "/memory/spaces/{spaceId}/concepts/{conceptId}",
	tag: "memory",
	summary: "Get a concept",
	params: ConceptPath,
	answer: { status: 200, description: "The concept.", schema: Concept },
	errors: ["forbidden", "not_found"],
});

export const searchMemory = defineRoute({
	operationId: "searchMemory",
	method: "POST",
	path: "/memory/search",
	tag: "memory",
	summary: "Search memory",
	description: "Keyword search over the named spaces' concepts, best first, as a person browsing them would.",
	body: MemorySearchBody,
	answer: { status: 200, description: "The matches.", schema: MemorySearchResult },
	errors: ["invalid", "forbidden", "not_found"],
});

export const recallMemory = defineRoute({
	operationId: "recallMemory",
	method: "POST",
	path: "/memory/recall",
	tag: "memory",
	summary: "Recall memory for a task",
	description:
		"What a session would be given for this query: the profile, the best matches (BM25) and their exceptions, " +
		"rendered, with a manifest of what was recalled and why.",
	body: RecallBody,
	answer: { status: 200, description: "The recall.", schema: Recall },
	errors: ["invalid", "forbidden", "not_found"],
});

export const createMemorySpace = defineRoute({
	operationId: "createMemorySpace",
	method: "POST",
	path: "/memory/spaces",
	tag: "memory",
	summary: "Create a memory space",
	description:
		"People and API keys only, never an agent; a deployment may ask for more, such as the organisation's admin role.",
	body: CreateMemorySpaceBody,
	answer: { status: 201, description: "The new space.", schema: MemorySpace },
	errors: ["invalid", "forbidden"],
});

export const importMemorySnapshot = defineRoute({
	operationId: "importMemorySnapshot",
	method: "POST",
	path: "/memory/spaces/{spaceId}/snapshot",
	tag: "memory",
	summary: "Load a snapshot into a space",
	description:
		"A host adapter's load path: the space's concepts become the snapshot's, recorded with its source and ref, so " +
		"every recall names what it read. People and API keys only; a deployment may ask for more.",
	params: MemorySpacePath,
	body: MemorySnapshot,
	answer: { status: 200, description: "The space, with its snapshot.", schema: MemorySpace },
	errors: ["invalid", "forbidden", "not_found", "conflict"],
});

export const memoryRoutes = {
	listMemorySpaces,
	createMemorySpace,
	listConcepts,
	getConcept,
	searchMemory,
	recallMemory,
	importMemorySnapshot,
} as const;

// Schedules (#23): the console's schedules page reads and writes these, like any other client.

const scheduleErrors = ["forbidden", "not_found"] as const;

export const listSchedules = defineRoute({
	operationId: "listSchedules",
	method: "GET",
	path: "/schedules",
	tag: "schedules",
	summary: "List schedules",
	description:
		"The organisation's schedules the caller may see, a page at a time. A project's schedules are listed only to those with the viewer role on it.",
	query: ListSchedulesQuery,
	answer: { status: 200, description: "A page of schedules.", schema: SchedulePage },
	errors: ["invalid", "forbidden"],
});

export const createSchedule = defineRoute({
	operationId: "createSchedule",
	method: "POST",
	path: "/schedules",
	tag: "schedules",
	summary: "Create a schedule",
	description:
		"Exactly one of `at` (a one-off) and `repeat`. A task's runs each start a session, in the schedule's project (the default project for one owned by the organisation or a user), running the payload's agent with its prompt sent exactly as written. Agents may not create schedules. Needs the operator role on a project-owned schedule's project.",
	body: CreateScheduleBody,
	answer: { status: 201, description: "The new schedule, with its first due time.", schema: Schedule },
	errors: ["invalid", "forbidden", "not_found"],
});

export const getSchedule = defineRoute({
	operationId: "getSchedule",
	method: "GET",
	path: "/schedules/{scheduleId}",
	tag: "schedules",
	summary: "Get a schedule",
	params: SchedulePath,
	answer: { status: 200, description: "The schedule.", schema: Schedule },
	errors: scheduleErrors,
});

export const updateSchedule = defineRoute({
	operationId: "updateSchedule",
	method: "PATCH",
	path: "/schedules/{scheduleId}",
	tag: "schedules",
	summary: "Change a schedule",
	description:
		"Changes the fields given and works out the next due time again. A change that leaves the schedule never due again ends it.",
	params: SchedulePath,
	body: UpdateScheduleBody,
	answer: { status: 200, description: "The schedule as changed.", schema: Schedule },
	errors: ["invalid", "forbidden", "not_found"],
});

export const pauseSchedule = defineRoute({
	operationId: "pauseSchedule",
	method: "POST",
	path: "/schedules/{scheduleId}/pause",
	tag: "schedules",
	summary: "Pause a schedule",
	description: "Nothing runs while it is paused.",
	params: SchedulePath,
	answer: { status: 200, description: "The paused schedule.", schema: Schedule },
	errors: ["forbidden", "not_found", "conflict"],
});

export const resumeSchedule = defineRoute({
	operationId: "resumeSchedule",
	method: "POST",
	path: "/schedules/{scheduleId}/resume",
	tag: "schedules",
	summary: "Resume a paused schedule",
	description: "Runs from the next due time after now; the paused time is not made up.",
	params: SchedulePath,
	answer: { status: 200, description: "The resumed schedule, with its next due time.", schema: Schedule },
	errors: ["forbidden", "not_found", "conflict"],
});

export const deleteSchedule = defineRoute({
	operationId: "deleteSchedule",
	method: "DELETE",
	path: "/schedules/{scheduleId}",
	tag: "schedules",
	summary: "End a schedule",
	description:
		"Ends the schedule for good: nothing more runs. It stays listed, as `ended`, with its run history and the sessions its runs started. Ending an ended schedule does nothing.",
	params: SchedulePath,
	answer: { status: 200, description: "The ended schedule.", schema: Schedule },
	errors: scheduleErrors,
});

export const previewSchedule = defineRoute({
	operationId: "previewSchedule",
	method: "GET",
	path: "/schedules/{scheduleId}/preview",
	tag: "schedules",
	summary: "Preview a schedule's next due times",
	params: SchedulePath,
	query: PreviewScheduleQuery,
	answer: { status: 200, description: "The next due times, from now.", schema: SchedulePreview },
	errors: ["invalid", "forbidden", "not_found"],
});

export const listScheduleRuns = defineRoute({
	operationId: "listScheduleRuns",
	method: "GET",
	path: "/schedules/{scheduleId}/runs",
	tag: "schedules",
	summary: "List a schedule's runs",
	description:
		"The run history, a page at a time: each occurrence's status and times, and its result. A task's result names the session it started (`sessionId`).",
	params: SchedulePath,
	query: PageQuery,
	answer: { status: 200, description: "A page of runs.", schema: OccurrencePage },
	errors: ["invalid", "forbidden", "not_found"],
});

/** The schedules' routes (control plane), served by `@harbour/schedules/http`. */
export const scheduleRoutes = {
	listSchedules,
	createSchedule,
	getSchedule,
	updateSchedule,
	pauseSchedule,
	resumeSchedule,
	deleteSchedule,
	previewSchedule,
	listScheduleRuns,
} as const;

// Browsers (docs/design/browser-runtime.md): an outside app frames a session's browser.

export const embedBrowserSession = defineRoute({
	operationId: "embedBrowserSession",
	method: "POST",
	path: "/sessions/{sessionId}/browsers/{browserSessionId}/embed",
	tag: "browsers",
	summary: "Embed a session's browser",
	description:
		"A link for an iframe: a watch-only live view of one of the session's open browsers, or a replay of one, open or " +
		"closed. Needs viewer on the session; never an agent. The link carries a short-lived token scoped to that one view " +
		"(never control), lasting `minutes`. A closed browser has no live view (`expired`); a deployment whose browsers " +
		"keep no recordings has no replay (`unavailable`), and a recording past its retention is `expired`. Audited as " +
		"`browser.session.embedded`, without the link.",
	params: BrowserSessionPath,
	body: EmbedBrowserBody,
	answer: { status: 200, description: "The link to frame.", schema: BrowserEmbed },
	errors: ["invalid", "forbidden", "not_found", "expired", "unavailable"],
});

/** The browsers' routes, served by `@harbour/browser/http`. */
export const browserRoutes = { embedBrowserSession } as const;

// Sharing (`FileShares`): a file an agent made, shared after Claude's Share popover. The link's page is
// `/shared/<token>`, outside the API: it needs no sign-in and reads that one file only.

const shareErrors = ["forbidden", "not_found"] as const;
const shareChangeErrors = ["invalid", "forbidden", "not_found", "conflict"] as const;

export const listShares = defineRoute({
	operationId: "listShares",
	method: "GET",
	path: "/workspaces/{workspaceId}/shares",
	tag: "shares",
	summary: "List a workspace's shares",
	description: "The live shares of the workspace's files, or of one file, with their invites. Needs viewer on it.",
	params: WorkspaceSharesPath,
	query: ListSharesQuery,
	answer: { status: 200, description: "The shares, oldest first.", schema: FileSharePage },
	errors: shareErrors,
});

export const shareFile = defineRoute({
	operationId: "shareFile",
	method: "POST",
	path: "/workspaces/{workspaceId}/shares",
	tag: "shares",
	summary: "Share a file",
	description:
		"The file's share, made if it has none: a file has one live share, and sharing it again returns that one unchanged. " +
		"A new share is `restricted` unless `access` says otherwise. Needs operator on the workspace's project, as a person " +
		"(never an agent or an API key). Audited as `workspace.share.created`, without the token.",
	params: WorkspaceSharesPath,
	body: ShareFileBody,
	answer: { status: 200, description: "The file's share.", schema: FileShare },
	errors: shareChangeErrors,
});

export const getShare = defineRoute({
	operationId: "getShare",
	method: "GET",
	path: "/shares/{shareId}",
	tag: "shares",
	summary: "Get a share",
	params: SharePath,
	answer: { status: 200, description: "The share.", schema: FileShare },
	errors: shareErrors,
});

export const updateShare = defineRoute({
	operationId: "updateShare",
	method: "PATCH",
	path: "/shares/{shareId}",
	tag: "shares",
	summary: "Set a share's general access",
	description:
		"`link` lets anyone with the link read the file; `restricted` stops the link at once, and `link` again restarts " +
		"the same link. Needs operator, as a person. Audited as `workspace.share.changed`.",
	params: SharePath,
	body: UpdateShareBody,
	answer: { status: 200, description: "The share as changed.", schema: FileShare },
	errors: shareChangeErrors,
});

export const revokeShare = defineRoute({
	operationId: "revokeShare",
	method: "DELETE",
	path: "/shares/{shareId}",
	tag: "shares",
	summary: "Revoke a share",
	description:
		"Its link stops for good; sharing the file again makes a new link. Needs operator, as a person. Audited as " +
		"`workspace.share.revoked`.",
	params: SharePath,
	answer: { status: 200, description: "The revoked share.", schema: FileShare },
	errors: shareErrors,
});

export const inviteToShare = defineRoute({
	operationId: "inviteToShare",
	method: "POST",
	path: "/shares/{shareId}/invites",
	tag: "shares",
	summary: "Invite someone by email",
	description:
		"Adds the email to the share's invites (one already invited stays as it is). Harbour stores and lists invites but " +
		"sends no email, and an invite grants no access of its own. Needs operator, as a person.",
	params: SharePath,
	body: ShareInviteBody,
	answer: { status: 200, description: "The share with its invites.", schema: FileShare },
	errors: shareChangeErrors,
});

export const removeShareInvite = defineRoute({
	operationId: "removeShareInvite",
	method: "POST",
	path: "/shares/{shareId}/invites/remove",
	tag: "shares",
	summary: "Remove an invite",
	params: SharePath,
	body: ShareInviteBody,
	answer: { status: 200, description: "The share with its invites.", schema: FileShare },
	errors: shareChangeErrors,
});

/** The shares' routes, served by `@harbour/workspace/shares-api`. */
export const shareRoutes = {
	listShares,
	shareFile,
	getShare,
	updateShare,
	revokeShare,
	inviteToShare,
	removeShareInvite,
} as const;

// Resource sharing (docs/design/sharing.md): a project's resources shared with another project, agent, person or
// session, with access requests to the owner's approvers, bindings (maintainer, approver, group member) and policies.
// Every check is the sharing store's, through `ProjectAccess`.

const sharingErrors = ["invalid", "forbidden", "not_found"] as const;
const sharingChangeErrors = ["invalid", "forbidden", "not_found", "conflict"] as const;

export const listResourceShares = defineRoute({
	operationId: "listResourceShares",
	method: "GET",
	path: "/sharing/shares",
	tag: "sharing",
	summary: "List resource shares",
	description:
		"Newest first, active ones unless `includeInactive`. Filter by resource, grantee or `ownerProjectId`. Each share is " +
		"listed only to those who may read it: viewer on the owner's or the grantee's project, or authority over the resource.",
	query: ListResourceSharesQuery,
	answer: { status: 200, description: "A page of shares.", schema: ResourceSharePage },
	errors: sharingErrors,
});

export const createResourceShare = defineRoute({
	operationId: "createResourceShare",
	method: "POST",
	path: "/sharing/shares",
	tag: "sharing",
	summary: "Share a resource",
	description:
		"Needs authority over the resource: `approver` on it, or admin where it lives. An agent may only pass on a share it " +
		"holds (`parentShareId`) to a session it supervises, never wider, later or at another revision. Audited as " +
		"`sharing.share.created`.",
	body: CreateResourceShareBody,
	answer: { status: 201, description: "The share.", schema: ResourceShare },
	errors: sharingChangeErrors,
});

export const getResourceShare = defineRoute({
	operationId: "getResourceShare",
	method: "GET",
	path: "/sharing/shares/{shareId}",
	tag: "sharing",
	summary: "Get a resource share",
	params: ResourceSharePath,
	answer: { status: 200, description: "The share.", schema: ResourceShare },
	errors: ["forbidden", "not_found"],
});

export const revokeResourceShare = defineRoute({
	operationId: "revokeResourceShare",
	method: "POST",
	path: "/sharing/shares/{shareId}/revoke",
	tag: "sharing",
	summary: "Revoke a resource share",
	description:
		"Revokes it and every share passed on from it; revoking a revoked share returns it unchanged. Needs authority over " +
		"the resource, admin on the grantee's project (detaching it), or for a passed-on share, the session that passed it " +
		"on. New uses and later reads stop at once.",
	params: ResourceSharePath,
	body: RevokeResourceShareBody,
	answer: { status: 200, description: "The revoked share.", schema: ResourceShare },
	errors: sharingErrors,
});

export const listAccessRequests = defineRoute({
	operationId: "listAccessRequests",
	method: "GET",
	path: "/sharing/requests",
	tag: "sharing",
	summary: "List access requests",
	description: "Newest first. `decidable=true` lists the caller's inbox: the pending requests it may decide.",
	query: ListAccessRequestsQuery,
	answer: { status: 200, description: "A page of requests.", schema: AccessRequestPage },
	errors: sharingErrors,
});

export const requestAccess = defineRoute({
	operationId: "requestAccess",
	method: "POST",
	path: "/sharing/requests",
	tag: "sharing",
	summary: "Request access to a resource",
	description:
		"Goes to the resource owner's approvers, not the requesting project's admins. Needs operator on the grantee's " +
		"project; the grantee defaults to the call's project. Audited as `sharing.request.created`.",
	body: RequestAccessBody,
	answer: { status: 201, description: "The pending request.", schema: AccessRequest },
	errors: sharingChangeErrors,
});

export const getAccessRequest = defineRoute({
	operationId: "getAccessRequest",
	method: "GET",
	path: "/sharing/requests/{requestId}",
	tag: "sharing",
	summary: "Get an access request",
	params: AccessRequestPath,
	answer: { status: 200, description: "The request.", schema: AccessRequest },
	errors: ["forbidden", "not_found"],
});

export const withdrawAccessRequest = defineRoute({
	operationId: "withdrawAccessRequest",
	method: "POST",
	path: "/sharing/requests/{requestId}/withdraw",
	tag: "sharing",
	summary: "Withdraw an access request",
	description: "Only the requester, while it is pending (`conflict` after).",
	params: AccessRequestPath,
	answer: { status: 200, description: "The withdrawn request.", schema: AccessRequest },
	errors: sharingChangeErrors,
});

export const decideAccessRequest = defineRoute({
	operationId: "decideAccessRequest",
	method: "POST",
	path: "/sharing/requests/{requestId}/decision",
	tag: "sharing",
	summary: "Grant or reject an access request",
	description:
		"Once (`conflict` after), by someone with authority over the resource, never by an agent. A grant makes the share in " +
		"the same write and may narrow what was asked.",
	params: AccessRequestPath,
	body: DecideAccessRequestBody,
	answer: {
		status: 200,
		description: "The decided request, and the share a grant made.",
		schema: AccessRequestDecided,
	},
	errors: sharingChangeErrors,
});

export const listResourceBindings = defineRoute({
	operationId: "listResourceBindings",
	method: "GET",
	path: "/sharing/bindings",
	tag: "sharing",
	summary: "List bindings",
	description: "Relation tuples: who maintains or approves a resource, and who is in a group.",
	query: ListBindingsQuery,
	answer: { status: 200, description: "A page of bindings.", schema: ResourceBindingPage },
	errors: sharingErrors,
});

export const addResourceBinding = defineRoute({
	operationId: "addResourceBinding",
	method: "POST",
	path: "/sharing/bindings",
	tag: "sharing",
	summary: "Add a binding",
	description:
		"Needs authority over the resource, or organisation admin for a group. Adding one already there returns it.",
	body: BindingBody,
	answer: { status: 200, description: "The binding.", schema: ResourceBinding },
	errors: sharingErrors,
});

export const removeResourceBinding = defineRoute({
	operationId: "removeResourceBinding",
	method: "POST",
	path: "/sharing/bindings/remove",
	tag: "sharing",
	summary: "Remove a binding",
	description: "Removing a binding that isn't there does nothing.",
	body: BindingBody,
	answer: { status: 204, description: "Removed." },
	errors: sharingErrors,
});

export const getResourcePolicy = defineRoute({
	operationId: "getResourcePolicy",
	method: "GET",
	path: "/sharing/policies",
	tag: "sharing",
	summary: "Get a resource's policy",
	query: ResourceQuery,
	answer: { status: 200, description: "The policy, or the default.", schema: ResourcePolicy },
	errors: sharingErrors,
});

export const setResourcePolicy = defineRoute({
	operationId: "setResourcePolicy",
	method: "PUT",
	path: "/sharing/policies",
	tag: "sharing",
	summary: "Set a resource's policy",
	description: "Such as the two-person rule. Needs authority over the resource.",
	body: SetResourcePolicyBody,
	answer: { status: 200, description: "The policy as set.", schema: ResourcePolicy },
	errors: sharingErrors,
});

export const registerResource = defineRoute({
	operationId: "registerResource",
	method: "POST",
	path: "/sharing/resources",
	tag: "sharing",
	summary: "Register a host's resource",
	description:
		"Tells Harbour who owns one of the host's own resources, so it can be shared. Idempotent; the owner can't change. " +
		"Harbour's own kinds are `invalid`.",
	body: RegisterResourceBody,
	answer: { status: 200, description: "The registered resource.", schema: RegisteredResource },
	errors: sharingChangeErrors,
});

export const listShareUses = defineRoute({
	operationId: "listShareUses",
	method: "GET",
	path: "/sharing/uses",
	tag: "sharing",
	summary: "What a session used through shares",
	description: "Each resource once, with the revision and the share it was used through: a session's provenance.",
	query: ListShareUsesQuery,
	answer: { status: 200, description: "The uses.", schema: ShareUseList },
	errors: sharingErrors,
});

/** The sharing routes, served by `@harbour/sharing/http`. */
export const sharingRoutes = {
	listResourceShares,
	createResourceShare,
	getResourceShare,
	revokeResourceShare,
	listAccessRequests,
	requestAccess,
	getAccessRequest,
	withdrawAccessRequest,
	decideAccessRequest,
	listResourceBindings,
	addResourceBinding,
	removeResourceBinding,
	getResourcePolicy,
	setResourcePolicy,
	registerResource,
	listShareUses,
} as const;

// Prompt rules (docs/design/org-scope.md, decision 5).

const ruleErrors = ["invalid", "forbidden", "not_found"] as const;

export const listPromptRules = defineRoute({
	operationId: "listPromptRules",
	method: "GET",
	path: "/rules",
	tag: "rules",
	summary: "List an owner's prompt rules",
	description:
		"The platform's, the organisation's, a project's or a user's rules, in order. A project's need the viewer role on " +
		"it; the others are open to the organisation.",
	query: ListPromptRulesQuery,
	answer: { status: 200, description: "The owner's rules.", schema: PromptRuleList },
	errors: ruleErrors,
});

export const resolvePromptRules = defineRoute({
	operationId: "resolvePromptRules",
	method: "GET",
	path: "/rules/resolved",
	tag: "rules",
	summary: "The rules a new session would get",
	description:
		"Platform, organisation, project (for a project session) and user rules, in the order they wrap the profile's " +
		"own prompt: platform, organisation, project, profile, user. A session keeps the rules it started with.",
	query: ResolvedPromptRulesQuery,
	answer: { status: 200, description: "The rules, in layer order.", schema: PromptRuleList },
	errors: ruleErrors,
});

export const getPromptRule = defineRoute({
	operationId: "getPromptRule",
	method: "GET",
	path: "/rules/{ruleId}",
	tag: "rules",
	summary: "Get a prompt rule",
	params: PromptRulePath,
	answer: { status: 200, description: "The rule.", schema: PromptRule },
	errors: ruleErrors,
});

export const putPromptRule = defineRoute({
	operationId: "putPromptRule",
	method: "PUT",
	path: "/rules",
	tag: "rules",
	summary: "Create or replace a prompt rule",
	description:
		"Creates the owner's rule of that name, or replaces its text and order. The organisation's rules need an " +
		"organisation-wide admin, a project's an admin on it, a user's that user or an organisation-wide admin; agents " +
		"never write rules. Audited as `rules.rule.put`, without the text.",
	body: PutPromptRuleBody,
	answer: { status: 200, description: "The rule as stored.", schema: PromptRule },
	errors: ruleErrors,
});

export const removePromptRule = defineRoute({
	operationId: "removePromptRule",
	method: "DELETE",
	path: "/rules/{ruleId}",
	tag: "rules",
	summary: "Remove a prompt rule",
	description: "Needs what writing it needs. New sessions stop getting it; running ones keep theirs.",
	params: PromptRulePath,
	answer: { status: 200, description: "The removed rule.", schema: PromptRule },
	errors: ruleErrors,
});

export const ruleRoutes = {
	listPromptRules,
	resolvePromptRules,
	getPromptRule,
	putPromptRule,
	removePromptRule,
} as const;

/** Every v1 route, by operation ID, in the order the document and the SDK list them. Each server serves its own group. */
export const routes = {
	...sessionRoutes,
	...skillRoutes,
	...ruleRoutes,
	...memoryRoutes,
	...scheduleRoutes,
	...browserRoutes,
	...shareRoutes,
	...sharingRoutes,
} as const;

export type Routes = typeof routes;
export type OperationId = keyof Routes;
