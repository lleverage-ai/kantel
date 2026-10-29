// Harbour's public API: the TypeScript SDK. Generated from packages/api/src/routes.ts by
// `pnpm --filter @harbour/api generate`; don't edit it by hand. CI fails while it is stale.

// Types

export interface AbortSessionBody {
	/** Recorded in the audit trail. */
	readonly reason?: string;
}

/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
export type Actor =
	| {
			readonly kind: "human";
			readonly userId: string;
	  }
	| {
			readonly kind: "service";
			readonly serviceId: string;
			readonly keyId?: string;
	  }
	| {
			readonly kind: "agent";
			readonly agentId: string;
			readonly sessionId: string;
	  }
	| {
			readonly kind: "system";
			readonly component: string;
	  };

export interface AssistantItem {
	readonly kind: "assistant";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly text: string;
	/** True while tokens are still arriving. */
	readonly streaming: boolean;
	readonly thinking?: string;
}

/** How a session list groups the session: working, waiting on someone, or done. */
export type Attention = "working" | "waiting" | "done";

export interface BrowserEmbed {
	/** The page to frame. It holds its token after `#`, so the token reaches no server; treat the URL as a secret. */
	readonly url: string;
	readonly mode: "live" | "replay";
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** What the page posts to its parent once its stream is over. */
	readonly endMessage?: string;
}

export interface BrowserGrantCard {
	readonly type: "browser.grant";
	readonly requestId: string;
	readonly reason: string;
	readonly status: "pending" | "granted" | "denied";
}

export type Card = VaultApprovalCard | QuestionCard | BrowserGrantCard;

export interface CardItem {
	readonly kind: "card";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly card: Card;
}

export interface CheckSettings {
	/** Hours before a finding still present is raised again. Default 6. */
	readonly reraiseHours?: number;
	/** A finding whose value grows by this factor is raised again. Default 2. */
	readonly risingFactor?: number;
	/** Failed runs in a row before a `check-failed` finding is raised. Default 3. */
	readonly failuresBeforeRaise?: number;
	/** Severities, worst first, case-insensitive, for raising a finding that got worse as `escalated`. Default `urgent`, `high`, `medium`, `low`, `warn`, `info`. */
	readonly severityOrder?: readonly string[];
}

export interface Concept {
	readonly spaceId: string;
	/** A stable path, such as `projects/harbour/vault-binding-codes`. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** The fact itself, short. */
	readonly statement: string;
	/** Where a concept applies. A `job` concept is an exception for one job. */
	readonly scope: ConceptScope;
	/** What backs it: URLs, `owner/repo@commit:path:lines`, ticket IDs. */
	readonly sources: readonly string[];
	/** After this, recall marks it stale (epoch milliseconds). */
	readonly staleAfter?: number;
	/** A job exception's general concept. */
	readonly overrides?: string;
	/** Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
	readonly tags: readonly string[];
	/** `owner`: set by the space's owner. `learned`: from an approved agent proposal. */
	readonly setBy: "owner" | "learned";
	/** Increases with every change. */
	readonly version: number;
	readonly status: ConceptStatus;
	readonly supersededBy?: string;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface ConceptPage {
	readonly items: readonly Concept[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** Where a concept applies. A `job` concept is an exception for one job. */
export type ConceptScope =
	| {
			readonly kind: "global";
	  }
	| {
			readonly kind: "project";
			readonly project: string;
	  }
	| {
			readonly kind: "job";
			readonly job: string;
	  };

export type ConceptStatus = "active" | "superseded" | "forgotten";

/** A new session, with its first message's submission when it was sent one. */
export interface CreatedSession {
	/** The session's ID. */
	readonly id: string;
	readonly organisationId: string;
	readonly projectId: string;
	/** The agent profile the session runs. */
	readonly agentId: string;
	readonly parentSessionId?: string;
	readonly workspaceId?: string;
	readonly title?: string;
	readonly status: SessionStatus;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels: Labels;
	/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
	/** A message the session accepted. */
	readonly submission?: Submission;
}

export interface CreateMemorySpaceBody {
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name: string;
}

/** A new schedule. Needs the operator role on a project-owned schedule's project. */
export interface CreateScheduleBody {
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** What runs. A `task` starts a session with its payload `{ "agentId"?, "prompt" }` and sends the prompt exactly as written; a `check` runs its payload (a command line or an argument list) with no model. */
	readonly kind: ScheduleKind;
	readonly title: string;
	/** An IANA time zone, such as `Europe/London`. */
	readonly timezone: string;
	/** A one-off at this instant (epoch milliseconds). Exactly one of `at` and `repeat`. */
	readonly at?: number;
	readonly repeat?: Recurrence;
	/** No occurrence is due after this (epoch milliseconds). */
	readonly until?: number;
	/** At most this many occurrences. */
	readonly count?: number;
	/** Any JSON value. */
	readonly payload: JsonValue;
	readonly check?: CheckSettings;
}

/** Put the host's own reference for the session in `labels`, such as `{ lleverageRunId: "run-42" }`, and find it again with `GET /sessions?label.lleverageRunId=run-42`. */
export interface CreateSessionBody {
	/** The project the session runs in. */
	readonly projectId: string;
	/** The agent profile it runs. */
	readonly agentId: string;
	readonly title?: string;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels?: Labels;
	/** An existing workspace to run in. */
	readonly workspaceId?: string;
	/** Creates a child session owned by this parent; aborting the parent aborts it. */
	readonly parentSessionId?: string;
	/** The session's first prompt, sent as soon as it exists. */
	readonly message?: FirstMessage;
}

/** An opaque position in a session's stream. */
export type Cursor = string;

/** `append` adds an item, `replace` swaps the item with the same id, `text` appends streamed text to an assistant item, and `status`, `title` and `usage` set the session's. */
export type DeltaOp =
	| {
			readonly op: "append";
			readonly item: TranscriptItem;
	  }
	| {
			readonly op: "replace";
			readonly item: TranscriptItem;
	  }
	| {
			readonly op: "text";
			readonly itemId: string;
			readonly append: string;
			readonly field?: "text" | "thinking";
	  }
	| {
			readonly op: "status";
			readonly status: SessionStatus;
			/** How a session list groups the session: working, waiting on someone, or done. */
			readonly attention: Attention;
	  }
	| {
			readonly op: "title";
			readonly title: string;
	  }
	| {
			readonly op: "usage";
			readonly usage: Usage;
	  };

export interface EmbedBrowserBody {
	/** `live`: the open browser as it is now, watch-only. `replay`: its recording. */
	readonly mode: "live" | "replay";
	/** How long the link lasts. Default 15. */
	readonly minutes?: number;
}

/** The session's first prompt, sent as soon as it exists. */
export interface FirstMessage {
	/** The message's words. */
	readonly text: string;
	/** A model ID the session may use, for this run and the session's later runs. Absent keeps the session's model. */
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
}

export interface HistoryPage {
	readonly sessionId: string;
	/** Oldest first. */
	readonly items: readonly TranscriptItem[];
	readonly hasEarlier: boolean;
}

export interface HistoryQuery {
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
	/** Items older than this item ID, such as a snapshot's `items[0].id`. */
	readonly before?: string;
	/** At most this many items. Default 50, cut to 200. */
	readonly limit?: number;
}

export interface ImportSkillBody {
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name: string;
	readonly description: string;
	/** Every file of the package, `SKILL.md` among them. */
	readonly files: readonly SkillFile[];
	/** Where a host's adapter imported something from. */
	readonly source: SourceRef;
	/** Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
}

/** Any JSON value. */
export type JsonValue = unknown;

/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
export interface Labels {
	readonly [key: string]: string;
}

export interface ListConceptsQuery {
	readonly status?: ConceptStatus;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSchedulesQuery {
	/** What runs. A `task` starts a session with its payload `{ "agentId"?, "prompt" }` and sends the prompt exactly as written; a `check` runs its payload (a command line or an argument list) with no model. */
	readonly kind?: ScheduleKind;
	readonly status?: ScheduleStatus;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSessionsQuery {
	readonly projectId?: string;
	readonly agentId?: string;
	readonly status?: SessionStatus;
	readonly parentSessionId?: string;
	/** Sessions with every one of these labels, each sent as `label.<key>=<value>`, such as `label.docketTask=TASK-3347`. */
	readonly label?: {
		readonly [key: string]: string;
	};
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSkillsQuery {
	/** Also list this project's skills. Needs the viewer role on it. */
	readonly projectId?: string;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface MemorySearchBody {
	/** The spaces to read. */
	readonly spaceIds: readonly string[];
	readonly query: string;
	/** Default 5. */
	readonly limit?: number;
	/** Also list superseded and forgotten concepts, scoring a quarter. */
	readonly includeInactive?: boolean;
}

export interface MemorySearchHit {
	readonly concept: Concept;
	readonly score: number;
	readonly stale: boolean;
	/** The first statement line holding a term, cut to 160 characters. */
	readonly snippet: string;
}

export interface MemorySearchResult {
	readonly hits: readonly MemorySearchHit[];
}

/** A whole space's concepts at one ref of a source. */
export interface MemorySnapshot {
	readonly sourceId: string;
	readonly ref: string;
	readonly concepts: readonly SnapshotConcept[];
}

/** Where a space's snapshot came from, and when it was imported. */
export interface MemorySnapshotRef {
	readonly sourceId: string;
	readonly ref: string;
	/** Epoch milliseconds, UTC. */
	readonly importedAt: number;
}

export interface MemorySpace {
	/** The space's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name: string;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Where a space's snapshot came from, and when it was imported. */
	readonly snapshot?: MemorySnapshotRef;
}

export interface MemorySpacePage {
	readonly items: readonly MemorySpace[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** A message to the session's agent. `via` defaults to `prompt`. */
export interface MessageBody {
	/** How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in progress at its next model call, and `followUp` runs after the current run ends. */
	readonly via?: MessageVia;
	/** The message's words. */
	readonly text: string;
	/** A model ID the session may use, for this run and the session's later runs. Absent keeps the session's model. */
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
}

/** How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in progress at its next model call, and `followUp` runs after the current run ends. */
export type MessageVia = "prompt" | "steer" | "followUp";

export interface NoticeItem {
	readonly kind: "notice";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly level: "info" | "warning" | "error";
	readonly text: string;
	readonly code?: string;
}

/** One run of a schedule. */
export interface Occurrence {
	/** `<scheduleId>@<dueAt>`: unique per schedule and due time. */
	readonly id: string;
	readonly scheduleId: string;
	/** Epoch milliseconds, UTC. */
	readonly dueAt: number;
	/** How many due times this run stands for (more than 1 after missed runs). */
	readonly coalesced: number;
	readonly status: OccurrenceStatus;
	readonly attempt: number;
	readonly claimedBy?: string;
	/** Epoch milliseconds, UTC. */
	readonly leaseUntil?: number;
	/** Epoch milliseconds, UTC. */
	readonly finishedAt?: number;
	/** How the run went: a task's `{ sessionId, submissionId }` (the session it started), a check's `{ exitCode, raised }`, or `{ error }` for a failed run. */
	readonly result?: unknown;
}

export interface OccurrencePage {
	readonly items: readonly Occurrence[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export type OccurrenceStatus = "due" | "running" | "succeeded" | "failed";

/** Who owns a record: an organisation, a project, a user, or the platform. */
export type OwnerRef =
	| {
			readonly kind: "platform";
	  }
	| {
			readonly kind: "organisation";
			readonly organisationId: string;
	  }
	| {
			readonly kind: "project";
			readonly organisationId: string;
			readonly projectId: string;
	  }
	| {
			readonly kind: "user";
			readonly organisationId: string;
			readonly userId: string;
	  };

export interface PageQuery {
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

/** A file the agent presented to the person (`present_files`). Read its bytes through the workspace read API with your own credentials. */
export interface PresentedFile {
	/** The session's workspace the file is in. */
	readonly workspaceId: string;
	/** Its path in the workspace, for `GET /v1/workspaces/{workspaceId}/content?path=`: "out/report.pdf", or "/project/README.md" under a mount. */
	readonly path: string;
	/** Its file name: "report.pdf". */
	readonly name: string;
	/** Its media type, from its name: "application/pdf". */
	readonly mimeType: string;
	/** Its size in bytes when it was presented. */
	readonly size: number;
	/** The first lines of a text file, for a preview card. */
	readonly preview?: string;
}

export interface PreviewScheduleQuery {
	/** How many due times. Default 5. */
	readonly n?: number;
}

export interface QuestionCard {
	readonly type: "question";
	readonly questionId: string;
	readonly text: string;
	readonly options?: readonly string[];
	readonly status: "open" | "answered" | "withdrawn";
	readonly answer?: string;
}

export interface Recall {
	readonly concepts: readonly Concept[];
	/** What was recalled and why, in the same order. */
	readonly manifest: readonly RecallManifestEntry[];
	/** The recall as a prompt shows it. */
	readonly text: string;
	readonly skipped: readonly {
		readonly conceptId: string;
		readonly reason: string;
	}[];
	readonly profileOmitted: readonly string[];
	readonly truncated: boolean;
}

export interface RecallBody {
	/** The spaces to read. */
	readonly spaceIds: readonly string[];
	/** The task or message text to search by. */
	readonly query: string;
	readonly scopes?: {
		readonly projects?: readonly string[];
		readonly jobs?: readonly string[];
	};
	/** Concept IDs recalled whatever the query, within their own limits. */
	readonly profile?: readonly string[];
	/** Concept IDs never recalled. */
	readonly exclude?: readonly string[];
	/** Default 5 search matches. */
	readonly maxConcepts?: number;
	/** Default 4096. */
	readonly maxBytes?: number;
	readonly maxProfileConcepts?: number;
	/** Default 24576. */
	readonly maxProfileBytes?: number;
}

export interface RecallManifestEntry {
	readonly spaceId: string;
	readonly conceptId: string;
	readonly version: number;
	readonly reason: "profile" | "search" | "exception";
	readonly score?: number;
	readonly matched?: readonly string[];
	readonly stale: boolean;
	readonly truncated: boolean;
	readonly snapshotRef?: string;
}

export type Recurrence =
	| {
			readonly every: "minutes" | "hours";
			readonly interval: number;
			/** Epoch milliseconds, UTC. */
			readonly from: number;
	  }
	| {
			readonly every: "day";
			/** A local wall-clock time, `HH:MM`, in the schedule's time zone. */
			readonly at: string;
			readonly interval?: number;
	  }
	| {
			readonly every: "weekday";
			/** A local wall-clock time, `HH:MM`, in the schedule's time zone. */
			readonly at: string;
	  }
	| {
			readonly every: "week";
			/** A local wall-clock time, `HH:MM`, in the schedule's time zone. */
			readonly at: string;
			readonly on: readonly Weekday[];
	  }
	| {
			readonly every: "month";
			/** A local wall-clock time, `HH:MM`, in the schedule's time zone. */
			readonly at: string;
			readonly day: number;
	  };

export interface Schedule {
	/** The schedule's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** What runs. A `task` starts a session with its payload `{ "agentId"?, "prompt" }` and sends the prompt exactly as written; a `check` runs its payload (a command line or an argument list) with no model. */
	readonly kind: ScheduleKind;
	readonly title: string;
	/** An IANA time zone, such as `Europe/London`. */
	readonly timezone: string;
	/** A one-off at this instant (epoch milliseconds). Exactly one of `at` and `repeat`. */
	readonly at?: number;
	readonly repeat?: Recurrence;
	/** No occurrence is due after this (epoch milliseconds). */
	readonly until?: number;
	/** At most this many occurrences. */
	readonly count?: number;
	/** Any JSON value. */
	readonly payload: JsonValue;
	readonly check?: CheckSettings;
	readonly status: ScheduleStatus;
	/** The next due time; absent when ended or paused. */
	readonly nextDueAt?: number;
	/** Occurrences so far; a coalesced one counts once. */
	readonly occurrences: number;
	/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** What runs. A `task` starts a session with its payload `{ "agentId"?, "prompt" }` and sends the prompt exactly as written; a `check` runs its payload (a command line or an argument list) with no model. */
export type ScheduleKind = "reminder" | "task" | "summary" | "check" | "heartbeat" | "program";

export interface SchedulePage {
	readonly items: readonly Schedule[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface SchedulePreview {
	/** The next due times, soonest first. */
	readonly dueAt: readonly number[];
}

export type ScheduleStatus = "active" | "paused" | "ended";

/** One frame of `@harbour/protocol`: `hello`, then a `snapshot` (or the deltas after the client's cursor), then live `delta`s. */
export type ServerFrame =
	| {
			readonly type: "hello";
			readonly v: 1;
			readonly sessionId: string;
			/** An opaque position in a session's stream. */
			readonly cursor: Cursor;
			/** True when deltas after the client's cursor follow, false for a snapshot. */
			readonly resumed: boolean;
	  }
	| {
			readonly type: "snapshot";
			readonly snapshot: SessionSnapshot;
	  }
	| {
			readonly type: "delta";
			readonly delta: SessionDelta;
	  }
	| {
			readonly type: "history";
			readonly page: HistoryPage;
	  }
	| {
			readonly type: "error";
			readonly code: string;
			readonly message: string;
	  };

export interface SessionDelta {
	readonly sessionId: string;
	/** An opaque position in a session's stream. */
	readonly cursor: Cursor;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly ops: readonly DeltaOp[];
}

export interface SessionHistoryPage {
	readonly sessionId: string;
	/** Newest first. */
	readonly items: readonly TranscriptItem[];
	/** Present when older items exist; pass it as `cursor`. */
	readonly nextCursor?: string;
}

export interface SessionPage {
	readonly items: readonly SessionRecord[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface SessionRecord {
	/** The session's ID. */
	readonly id: string;
	readonly organisationId: string;
	readonly projectId: string;
	/** The agent profile the session runs. */
	readonly agentId: string;
	readonly parentSessionId?: string;
	readonly workspaceId?: string;
	readonly title?: string;
	readonly status: SessionStatus;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels: Labels;
	/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface SessionSnapshot {
	readonly v: 1;
	readonly sessionId: string;
	/** An opaque position in a session's stream. */
	readonly cursor: Cursor;
	readonly status: SessionStatus;
	/** How a session list groups the session: working, waiting on someone, or done. */
	readonly attention: Attention;
	readonly title?: string;
	/** The latest page of items, oldest first. */
	readonly items: readonly TranscriptItem[];
	/** True when items before `items[0]` exist. */
	readonly hasEarlier: boolean;
	readonly usage?: Usage;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export type SessionStatus = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled";

export interface SkillFile {
	/** A relative path inside the package, such as `SKILL.md` or `scripts/run.sh`. */
	readonly path: string;
	readonly content: string;
}

/** One file of a revision, as UTF-8 text. */
export interface SkillFileContent {
	readonly path: string;
	readonly content: string;
}

export interface SkillFileQuery {
	/** The file's path in the package, such as `SKILL.md`. */
	readonly path: string;
}

/** What a session is shown of a skill: enough to decide whether to read it. */
export interface SkillListing {
	readonly skillId: string;
	readonly name: string;
	readonly description: string;
	/** The latest published revision. */
	readonly revision: number;
	/** Where a session finds it, such as `/skills/pr-review/SKILL.md`. */
	readonly path: string;
}

export interface SkillListingPage {
	readonly items: readonly SkillListing[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface SkillPackage {
	/** The skill's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** Unique per owner: lowercase letters, digits and dashes. */
	readonly name: string;
	readonly description: string;
	/** The newest published revision. */
	readonly latestRevision?: number;
	/** Present while a draft is open. */
	readonly draftDigest?: string;
	/** Where a host's adapter imported something from. */
	readonly source?: SourceRef;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface SkillRevision {
	readonly skillId: string;
	/** 1, 2, 3… per skill. A published revision never changes. */
	readonly revision: number;
	/** Hex SHA-256 over the sorted paths and contents. */
	readonly digest: string;
	readonly name: string;
	readonly description: string;
	readonly files: readonly {
		readonly path: string;
		/** Bytes, UTF-8. */
		readonly size: number;
	}[];
	/** Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
	/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
	readonly publishedBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly publishedAt: number;
	/** Where a host's adapter imported something from. */
	readonly source?: SourceRef;
}

export interface SkillRevisionPage {
	readonly items: readonly SkillRevision[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** One concept as a host's source holds it. */
export interface SnapshotConcept {
	/** A stable path, such as `projects/harbour/vault-binding-codes`. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** The fact itself, short. */
	readonly statement: string;
	/** Where a concept applies. A `job` concept is an exception for one job. */
	readonly scope: ConceptScope;
	/** What backs it: URLs, `owner/repo@commit:path:lines`, ticket IDs. */
	readonly sources: readonly string[];
	/** After this, recall marks it stale (epoch milliseconds). */
	readonly staleAfter?: number;
	/** A job exception's general concept. */
	readonly overrides?: string;
	/** Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
	readonly tags?: readonly string[];
	/** `owner`: set by the space's owner. `learned`: from an approved agent proposal. */
	readonly setBy: "owner" | "learned";
	readonly status: ConceptStatus;
	readonly supersededBy?: string;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** Where a host's adapter imported something from. */
export interface SourceRef {
	/** The host's skill or memory source, such as `sal-skills`. */
	readonly sourceId: string;
	/** Its ref: a commit or a version. */
	readonly ref: string;
}

export interface StreamQuery {
	/** Resume after this cursor (a snapshot's or a delta's): the stream sends the deltas after it, or a snapshot when it no longer holds them. */
	readonly after?: string;
}

/** A message the session accepted. */
export interface Submission {
	/** The submission's ID, which names the run the message started or joined. */
	readonly id: string;
	readonly sessionId: string;
	/** How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in progress at its next model call, and `followUp` runs after the current run ends. */
	readonly via: MessageVia;
	/** The `Idempotency-Key` it was sent with. */
	readonly requestId?: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolItem {
	readonly kind: "tool";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly callId: string;
	readonly name: string;
	/** A plain-language label, such as "Reading notes/x.md". */
	readonly label: string;
	readonly status: "running" | "done" | "error" | "interrupted";
	readonly args?: unknown;
	readonly output?: string;
	/** The files the call presented to the person (`present_files`), the most relevant first. */
	readonly files?: readonly PresentedFile[];
	readonly tier?: "isolate" | "container";
	/** Epoch milliseconds, UTC. */
	readonly endedAt?: number;
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | CardItem | NoticeItem;

/** The fields to change; a field left out stays as it is, and `null` on `at`, `repeat`, `until` or `count` clears it. The owner and the kind are fixed at create. */
export interface UpdateScheduleBody {
	readonly title?: string;
	/** An IANA time zone, such as `Europe/London`. */
	readonly timezone?: string;
	/** A one-off at this instant (epoch milliseconds), or `null` to clear it, as when it becomes a recurrence. Exactly one of `at` and `repeat` is left set. */
	readonly at?: number | null;
	/** The recurrence, or `null` to clear it, as when it becomes a one-off. */
	readonly repeat?: Recurrence | null;
	/** No occurrence is due after this (epoch milliseconds), or `null` to drop the end date. */
	readonly until?: number | null;
	/** At most this many occurrences, or `null` to drop the run limit. */
	readonly count?: number | null;
	/** Any JSON value. */
	readonly payload?: JsonValue;
	readonly check?: CheckSettings;
}

export interface Usage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly costUsd?: number;
}

export interface UserItem {
	readonly kind: "user";
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly text: string;
	readonly via: "prompt" | "steer" | "followUp";
	readonly requestId?: string;
}

/** A vault proposal waiting on a person. The secret is never part of it. */
export interface VaultApprovalCard {
	readonly type: "vault.approval";
	readonly proposalId: string;
	readonly status: "pending" | "approved" | "denied" | "expired" | "withdrawn";
	readonly bindingCode: string;
	readonly what: string;
	readonly why: string;
	readonly host: string;
	readonly methods: readonly string[];
	readonly pathPrefix: string;
	readonly injectionTemplate?: string;
	readonly termsSource: "agent-proposed" | "approved";
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
	readonly link: string;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

// Runtime

// The SDK's runtime, copied into `generated/sdk.ts` as it is, so the SDK is one file with no imports. Keep it free of
// imports and of anything but `fetch`.

export interface HarbourClientOptions {
	/** The API's base URL with its version, such as `https://harbour.example/v1`, or `/v1` on the same origin. */
	readonly baseUrl: string;
	/**
	 * The bearer for every call: a host app's API key (`hbr_…`), or a function that gives one per call. Absent when the
	 * browser is signed in another way, such as Cloudflare Access's cookie.
	 */
	readonly token?: string | (() => string | undefined | Promise<string | undefined>);
	/** More headers for every call. */
	readonly headers?: () => { readonly [name: string]: string } | Promise<{ readonly [name: string]: string }>;
	/** Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/**
	 * Opens a stream's WebSocket. Default the global `WebSocket`; with a bearer it passes `{ headers }`, which Node's
	 * (undici's) takes. A browser can't put a header on a socket, so in a browser the page must be signed in by cookie.
	 */
	readonly webSocket?: (url: string, headers: { readonly [name: string]: string }) => WebSocketLike;
}

/** The parts of a WHATWG WebSocket a stream uses. */
export interface WebSocketLike {
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	close(code?: number, reason?: string): void;
}

/** What a stream calls as frames arrive. */
export interface StreamHandlers<Frame> {
	/** The frames of one message, in order: `hello`, then a snapshot or the deltas after `after`, then live deltas. */
	onFrames(frames: readonly Frame[]): void;
	onOpen?(): void;
	/** The socket closed, by either side. Reconnect with `{ after: handle.cursor }` to resume. */
	onClose?(event: { readonly code: number; readonly reason: string }): void;
}

/** An open stream. */
export interface StreamHandle {
	/** The latest cursor the stream has sent (a hello's, a snapshot's or a delta's), to resume from. */
	readonly cursor: string | undefined;
	close(): void;
}

/** Per call. */
export interface CallOptions {
	readonly signal?: AbortSignal;
	/** Sent as `harbour-request-id`, which correlates the call in Harbour's audit trail. */
	readonly requestId?: string;
	/**
	 * Sent as `Idempotency-Key` on the calls that take one (their docs say so): a retry with the same key gets the first
	 * call's answer and does nothing again. Use a new key, such as a UUID, for each new call.
	 */
	readonly idempotencyKey?: string;
	readonly headers?: { readonly [name: string]: string };
}

/** An error Harbour answered with: its HarbourError code (or `unauthenticated`), message and HTTP status. */
export class HarbourApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: { readonly [key: string]: unknown };
	constructor(status: number, code: string, message: string, details?: { readonly [key: string]: unknown }) {
		super(message);
		this.name = "HarbourApiError";
		this.status = status;
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

/** One call, as the generated methods describe it. */
export interface ApiCall {
	readonly method: string;
	/** Relative to the base URL, with path parameters already encoded. */
	readonly path: string;
	/** Query parameters; a record value, such as `label`, is sent as `label.<key>=<value>`. */
	readonly query?: object;
	readonly body?: unknown;
	readonly headers?: { readonly [name: string]: string | undefined };
}

const queryString = (query: object | undefined): string => {
	if (query === undefined) return "";
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "object") {
			// A record, such as `label`: `label.<key>=<value>`.
			for (const [key, item] of Object.entries(value as { [key: string]: unknown })) {
				if (item !== undefined) params.append(`${name}.${key}`, String(item));
			}
		} else params.append(name, String(value));
	}
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
};

async function errorOf(response: Response): Promise<HarbourApiError> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
	const code =
		typeof error?.code === "string" ? error.code : response.status === 401 ? "unauthenticated" : "unavailable";
	const message = typeof error?.message === "string" ? error.message : `Harbour answered ${response.status}`;
	const details =
		typeof error?.details === "object" && error.details !== null
			? (error.details as { [key: string]: unknown })
			: undefined;
	return new HarbourApiError(response.status, code, message, details);
}

/** Sends one call and reads its JSON answer; a 204 resolves undefined. Rejects with a `HarbourApiError`. */
export async function send<T>(options: HarbourClientOptions, call: ApiCall, callOptions: CallOptions = {}): Promise<T> {
	const headers: { [name: string]: string } = { accept: "application/json" };
	Object.assign(headers, (await options.headers?.()) ?? {});
	const token = typeof options.token === "function" ? await options.token() : options.token;
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	if (call.body !== undefined) headers["content-type"] = "application/json";
	if (callOptions.requestId !== undefined) headers["harbour-request-id"] = callOptions.requestId;
	if (callOptions.idempotencyKey !== undefined) headers["idempotency-key"] = callOptions.idempotencyKey;
	for (const [name, value] of Object.entries(call.headers ?? {})) if (value !== undefined) headers[name] = value;
	Object.assign(headers, callOptions.headers ?? {});
	const doFetch = options.fetch ?? fetch;
	const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}${call.path}${queryString(call.query)}`, {
		method: call.method,
		headers,
		...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
		...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
	});
	if (!response.ok) throw await errorOf(response);
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

const cursorOf = (frame: unknown): string | undefined => {
	const value = frame as {
		type?: string;
		cursor?: string;
		snapshot?: { cursor?: string };
		delta?: { cursor?: string };
	};
	if (value.type === "snapshot") return value.snapshot?.cursor;
	if (value.type === "delta") return value.delta?.cursor;
	if (value.type === "hello") return value.cursor;
	return undefined;
};

function defaultWebSocket(url: string, headers: { readonly [name: string]: string }): WebSocketLike {
	const Socket = (globalThis as { WebSocket?: unknown }).WebSocket as
		| (new (
				url: string,
				init?: { headers: { readonly [name: string]: string } },
		  ) => WebSocketLike)
		| undefined;
	if (Socket === undefined) throw new HarbourApiError(0, "not_supported", "This platform has no WebSocket");
	return Object.keys(headers).length === 0 ? new Socket(url) : new Socket(url, { headers });
}

/** Opens a stream route's WebSocket and hands each message's frames to `handlers`. */
export function openStream<Frame>(
	options: HarbourClientOptions,
	call: ApiCall,
	handlers: StreamHandlers<Frame>,
	callOptions: CallOptions = {},
): StreamHandle {
	const base = options.baseUrl.replace(/\/+$/, "");
	const origin = (globalThis as { location?: { href?: string } }).location?.href;
	const url = new URL(`${base}${call.path}${queryString(call.query)}`, origin);
	url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
	let cursor: string | undefined;
	let socket: WebSocketLike | undefined;
	let closed = false;
	const handle: StreamHandle = {
		get cursor() {
			return cursor;
		},
		close() {
			closed = true;
			socket?.close(1000, "The client closed the stream");
		},
	};
	void (async () => {
		const headers: { [name: string]: string } = {};
		Object.assign(headers, (await options.headers?.()) ?? {});
		const token = typeof options.token === "function" ? await options.token() : options.token;
		if (token !== undefined) headers.authorization = `Bearer ${token}`;
		if (callOptions.requestId !== undefined) headers["harbour-request-id"] = callOptions.requestId;
		Object.assign(headers, callOptions.headers ?? {});
		if (closed) return;
		socket = (options.webSocket ?? defaultWebSocket)(url.href, headers);
		socket.onopen = () => handlers.onOpen?.();
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			let frames: unknown;
			try {
				frames = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!Array.isArray(frames) || frames.length === 0) return;
			for (const frame of frames) cursor = cursorOf(frame) ?? cursor;
			handlers.onFrames(frames as Frame[]);
		};
		socket.onerror = () => undefined;
		socket.onclose = (event) => {
			closed = true;
			handlers.onClose?.({ code: event.code, reason: event.reason });
		};
		callOptions.signal?.addEventListener("abort", () => handle.close(), { once: true });
	})().catch((error: unknown) => {
		closed = true;
		handlers.onClose?.({ code: 1006, reason: error instanceof Error ? error.message : "The stream failed to open" });
	});
	return handle;
}

// Client

/** Harbour's public API, one method per route. */
export interface HarbourClient {
	/** Create a session. Starts a session of an agent profile in a project, and sends it `message` when there is one. Needs the operator role on the project. If the first message is refused, the session is closed and the refusal answered. `POST /sessions` */
	createSession(body: CreateSessionBody, options?: CallOptions): Promise<CreatedSession>;
	/** List sessions. The sessions the caller may see, newest first, a page at a time. `GET /sessions` */
	listSessions(query?: ListSessionsQuery, options?: CallOptions): Promise<SessionPage>;
	/** Get a session. `GET /sessions/{sessionId}` */
	getSession(sessionId: string, options?: CallOptions): Promise<SessionRecord>;
	/** Close a session. Ends the session for good: its sandbox leases, browser sessions and grants end. Closing a closed session does nothing. `POST /sessions/{sessionId}/close` */
	closeSession(sessionId: string, options?: CallOptions): Promise<void>;
	/** Abort a session's run. Stops what the session is doing now. The session stays open and takes new messages. `POST /sessions/{sessionId}/abort` */
	abortSession(sessionId: string, body?: AbortSessionBody, options?: CallOptions): Promise<void>;
	/** Send a message. Sends the session's agent a message, `via` a prompt, a steer or a follow-up. The answer arrives on the session's stream. Send an `Idempotency-Key` so a retry can't send it twice: a retry with the same key answers the first call's submission without sending anything, and one with another `via` is a `conflict`. Idempotent with `options.idempotencyKey`. `POST /sessions/{sessionId}/messages` */
	sendMessage(sessionId: string, body: MessageBody, options?: CallOptions): Promise<Submission>;
	/** Stream a session. The session as `@harbour/protocol` frames: `hello`, then a `snapshot` of its state and latest items (or, with `after`, the deltas after that cursor when the stream still holds them), then a `delta` for every change, live. Fold them with the protocol's `applyFrames`. Over a WebSocket, compressed where the platform can, or as server-sent events. `GET /sessions/{sessionId}/stream` */
	streamSession(
		sessionId: string,
		handlers: StreamHandlers<ServerFrame>,
		query?: StreamQuery,
		options?: CallOptions,
	): StreamHandle;
	/** Page back through a session. The session's transcript in pages, newest first, for scrolling back past a snapshot's items: start with `before` set to the snapshot's `items[0].id`, then follow `nextCursor`. `GET /sessions/{sessionId}/history` */
	getSessionHistory(sessionId: string, query?: HistoryQuery, options?: CallOptions): Promise<SessionHistoryPage>;
	/** List skills. The published skills the caller sees, by name: the platform's, the organisation's, the project's named by `projectId` and, for a person, their own. Never another project's or another person's. `GET /skills` */
	listSkills(query?: ListSkillsQuery, options?: CallOptions): Promise<SkillListingPage>;
	/** Get a skill. `GET /skills/{skillId}` */
	getSkill(skillId: string, options?: CallOptions): Promise<SkillPackage>;
	/** List a skill's revisions. `GET /skills/{skillId}/revisions` */
	listSkillRevisions(skillId: string, query?: PageQuery, options?: CallOptions): Promise<SkillRevisionPage>;
	/** Get a revision. A published revision: its digest, its files' paths and sizes, who published it and where it came from. `GET /skills/{skillId}/revisions/{revision}` */
	getSkillRevision(skillId: string, revision: string, options?: CallOptions): Promise<SkillRevision>;
	/** Read a file of a revision. One file of a published revision, such as its `SKILL.md`, by its path in the package. `GET /skills/{skillId}/revisions/{revision}/file` */
	readSkillFile(
		skillId: string,
		revision: string,
		query: SkillFileQuery,
		options?: CallOptions,
	): Promise<SkillFileContent>;
	/** Import a skill from a host's source. A host adapter's publish path: creates the skill if needed and publishes the files as its next revision, once per `source` (`sourceId` and `ref`); files identical to the latest revision publish nothing. People and API keys only, never an agent; a deployment may ask for more, such as the organisation's admin role. `POST /skills/import` */
	importSkill(body: ImportSkillBody, options?: CallOptions): Promise<SkillRevision>;
	/** List memory spaces. The spaces the caller may read, oldest first: the organisation's, a project's to those who may view it, and a person's own. A person never sees another person's space. `GET /memory/spaces` */
	listMemorySpaces(query?: PageQuery, options?: CallOptions): Promise<MemorySpacePage>;
	/** Create a memory space. People and API keys only, never an agent; a deployment may ask for more, such as the organisation's admin role. `POST /memory/spaces` */
	createMemorySpace(body: CreateMemorySpaceBody, options?: CallOptions): Promise<MemorySpace>;
	/** List a space's concepts. By ID, every status unless `status` names one. `GET /memory/spaces/{spaceId}/concepts` */
	listConcepts(spaceId: string, query?: ListConceptsQuery, options?: CallOptions): Promise<ConceptPage>;
	/** Get a concept. `GET /memory/spaces/{spaceId}/concepts/{conceptId}` */
	getConcept(spaceId: string, conceptId: string, options?: CallOptions): Promise<Concept>;
	/** Search memory. Keyword search over the named spaces' concepts, best first, as a person browsing them would. `POST /memory/search` */
	searchMemory(body: MemorySearchBody, options?: CallOptions): Promise<MemorySearchResult>;
	/** Recall memory for a task. What a session would be given for this query: the profile, the best matches (BM25) and their exceptions, rendered, with a manifest of what was recalled and why. `POST /memory/recall` */
	recallMemory(body: RecallBody, options?: CallOptions): Promise<Recall>;
	/** Load a snapshot into a space. A host adapter's load path: the space's concepts become the snapshot's, recorded with its source and ref, so every recall names what it read. People and API keys only; a deployment may ask for more. `POST /memory/spaces/{spaceId}/snapshot` */
	importMemorySnapshot(spaceId: string, body: MemorySnapshot, options?: CallOptions): Promise<MemorySpace>;
	/** List schedules. The organisation's schedules the caller may see, a page at a time. A project's schedules are listed only to those with the viewer role on it. `GET /schedules` */
	listSchedules(query?: ListSchedulesQuery, options?: CallOptions): Promise<SchedulePage>;
	/** Create a schedule. Exactly one of `at` (a one-off) and `repeat`. A task's runs each start a session, in the schedule's project (the default project for one owned by the organisation or a user), running the payload's agent with its prompt sent exactly as written. Agents may not create schedules. Needs the operator role on a project-owned schedule's project. `POST /schedules` */
	createSchedule(body: CreateScheduleBody, options?: CallOptions): Promise<Schedule>;
	/** Get a schedule. `GET /schedules/{scheduleId}` */
	getSchedule(scheduleId: string, options?: CallOptions): Promise<Schedule>;
	/** Change a schedule. Changes the fields given and works out the next due time again. A change that leaves the schedule never due again ends it. `PATCH /schedules/{scheduleId}` */
	updateSchedule(scheduleId: string, body?: UpdateScheduleBody, options?: CallOptions): Promise<Schedule>;
	/** Pause a schedule. Nothing runs while it is paused. `POST /schedules/{scheduleId}/pause` */
	pauseSchedule(scheduleId: string, options?: CallOptions): Promise<Schedule>;
	/** Resume a paused schedule. Runs from the next due time after now; the paused time is not made up. `POST /schedules/{scheduleId}/resume` */
	resumeSchedule(scheduleId: string, options?: CallOptions): Promise<Schedule>;
	/** End a schedule. Ends the schedule for good: nothing more runs. It stays listed, as `ended`, with its run history and the sessions its runs started. Ending an ended schedule does nothing. `DELETE /schedules/{scheduleId}` */
	deleteSchedule(scheduleId: string, options?: CallOptions): Promise<Schedule>;
	/** Preview a schedule's next due times. `GET /schedules/{scheduleId}/preview` */
	previewSchedule(scheduleId: string, query?: PreviewScheduleQuery, options?: CallOptions): Promise<SchedulePreview>;
	/** List a schedule's runs. The run history, a page at a time: each occurrence's status and times, and its result. A task's result names the session it started (`sessionId`). `GET /schedules/{scheduleId}/runs` */
	listScheduleRuns(scheduleId: string, query?: PageQuery, options?: CallOptions): Promise<OccurrencePage>;
	/** Embed a session's browser. A link for an iframe: a watch-only live view of one of the session's open browsers, or a replay of one, open or closed. Needs viewer on the session; never an agent. The link carries a short-lived token scoped to that one view (never control), lasting `minutes`. A closed browser has no live view (`expired`); a deployment whose browsers keep no recordings has no replay (`unavailable`), and a recording past its retention is `expired`. Audited as `browser.session.embedded`, without the link. `POST /sessions/{sessionId}/browsers/{browserSessionId}/embed` */
	embedBrowserSession(
		sessionId: string,
		browserSessionId: string,
		body: EmbedBrowserBody,
		options?: CallOptions,
	): Promise<BrowserEmbed>;
}

/** A client for Harbour's public API over `fetch`. */
export function createHarbourClient(options: HarbourClientOptions): HarbourClient {
	return {
		createSession: (body, callOptions) => send(options, { method: "POST", path: "/sessions", body }, callOptions),
		listSessions: (query, callOptions) => send(options, { method: "GET", path: "/sessions", query }, callOptions),
		getSession: (sessionId, callOptions) =>
			send(options, { method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}` }, callOptions),
		closeSession: (sessionId, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/close` }, callOptions),
		abortSession: (sessionId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/abort`, body }, callOptions),
		sendMessage: (sessionId, body, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/messages`, body }, callOptions),
		streamSession: (sessionId, handlers, query, callOptions) =>
			openStream(
				options,
				{ method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}/stream`, query },
				handlers,
				callOptions,
			),
		getSessionHistory: (sessionId, query, callOptions) =>
			send(options, { method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}/history`, query }, callOptions),
		listSkills: (query, callOptions) => send(options, { method: "GET", path: "/skills", query }, callOptions),
		getSkill: (skillId, callOptions) =>
			send(options, { method: "GET", path: `/skills/${encodeURIComponent(skillId)}` }, callOptions),
		listSkillRevisions: (skillId, query, callOptions) =>
			send(options, { method: "GET", path: `/skills/${encodeURIComponent(skillId)}/revisions`, query }, callOptions),
		getSkillRevision: (skillId, revision, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/skills/${encodeURIComponent(skillId)}/revisions/${encodeURIComponent(revision)}` },
				callOptions,
			),
		readSkillFile: (skillId, revision, query, callOptions) =>
			send(
				options,
				{
					method: "GET",
					path: `/skills/${encodeURIComponent(skillId)}/revisions/${encodeURIComponent(revision)}/file`,
					query,
				},
				callOptions,
			),
		importSkill: (body, callOptions) => send(options, { method: "POST", path: "/skills/import", body }, callOptions),
		listMemorySpaces: (query, callOptions) =>
			send(options, { method: "GET", path: "/memory/spaces", query }, callOptions),
		createMemorySpace: (body, callOptions) =>
			send(options, { method: "POST", path: "/memory/spaces", body }, callOptions),
		listConcepts: (spaceId, query, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/memory/spaces/${encodeURIComponent(spaceId)}/concepts`, query },
				callOptions,
			),
		getConcept: (spaceId, conceptId, callOptions) =>
			send(
				options,
				{
					method: "GET",
					path: `/memory/spaces/${encodeURIComponent(spaceId)}/concepts/${encodeURIComponent(conceptId)}`,
				},
				callOptions,
			),
		searchMemory: (body, callOptions) => send(options, { method: "POST", path: "/memory/search", body }, callOptions),
		recallMemory: (body, callOptions) => send(options, { method: "POST", path: "/memory/recall", body }, callOptions),
		importMemorySnapshot: (spaceId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/memory/spaces/${encodeURIComponent(spaceId)}/snapshot`, body },
				callOptions,
			),
		listSchedules: (query, callOptions) => send(options, { method: "GET", path: "/schedules", query }, callOptions),
		createSchedule: (body, callOptions) => send(options, { method: "POST", path: "/schedules", body }, callOptions),
		getSchedule: (scheduleId, callOptions) =>
			send(options, { method: "GET", path: `/schedules/${encodeURIComponent(scheduleId)}` }, callOptions),
		updateSchedule: (scheduleId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/schedules/${encodeURIComponent(scheduleId)}`, body }, callOptions),
		pauseSchedule: (scheduleId, callOptions) =>
			send(options, { method: "POST", path: `/schedules/${encodeURIComponent(scheduleId)}/pause` }, callOptions),
		resumeSchedule: (scheduleId, callOptions) =>
			send(options, { method: "POST", path: `/schedules/${encodeURIComponent(scheduleId)}/resume` }, callOptions),
		deleteSchedule: (scheduleId, callOptions) =>
			send(options, { method: "DELETE", path: `/schedules/${encodeURIComponent(scheduleId)}` }, callOptions),
		previewSchedule: (scheduleId, query, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/schedules/${encodeURIComponent(scheduleId)}/preview`, query },
				callOptions,
			),
		listScheduleRuns: (scheduleId, query, callOptions) =>
			send(options, { method: "GET", path: `/schedules/${encodeURIComponent(scheduleId)}/runs`, query }, callOptions),
		embedBrowserSession: (sessionId, browserSessionId, body, callOptions) =>
			send(
				options,
				{
					method: "POST",
					path: `/sessions/${encodeURIComponent(sessionId)}/browsers/${encodeURIComponent(browserSessionId)}/embed`,
					body,
				},
				callOptions,
			),
	};
}
