/**
 * Harbour's public API, version 1: every route a host app (or the console) may call, under `/v1`. Add a route here and
 * the server must implement it (`createRouter` takes a handler for each), and the OpenAPI document and the SDK pick it
 * up when they are generated (`pnpm --filter @harbour/api generate`; CI fails while they are stale).
 */

import { HistoryQuery, ServerFrame, SessionHistoryPage, StreamQuery } from "./protocol-schema.ts";
import { defineRoute } from "./route.ts";
import {
	AbortSessionBody,
	Concept,
	ConceptPage,
	ConceptPath,
	CreatedSession,
	CreateMemorySpaceBody,
	CreateSessionBody,
	ImportSkillBody,
	ListConceptsQuery,
	ListSessionsQuery,
	ListSkillsQuery,
	MemorySearchBody,
	MemorySearchResult,
	MemorySnapshot,
	MemorySpace,
	MemorySpacePage,
	MemorySpacePath,
	MessageBody,
	PageQuery,
	Recall,
	RecallBody,
	SessionPage,
	SessionPath,
	SessionRecord,
	SkillFileContent,
	SkillFileQuery,
	SkillListingPage,
	SkillPackage,
	SkillPath,
	SkillRevision,
	SkillRevisionPage,
	SkillRevisionPath,
	Submission,
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
	description: "Stops what the session is doing now. The session stays open and takes new messages.",
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
		"Sends the session's agent a message, `via` a prompt, a steer or a follow-up. The answer arrives on the " +
		"session's stream. Send an `Idempotency-Key` so a retry can't send it twice: a retry with the same key answers " +
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

export const sessionRoutes = {
	createSession,
	listSessions,
	getSession,
	closeSession,
	abortSession,
	sendMessage,
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

/** Every v1 route, by operation ID, in the order the document and the SDK list them. Each server serves its own group. */
export const routes = { ...sessionRoutes, ...skillRoutes, ...memoryRoutes } as const;

export type Routes = typeof routes;
export type OperationId = keyof Routes;
