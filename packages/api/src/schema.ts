/**
 * The public API's wire shapes as JSON Schema (TypeBox), each mirroring a type in `@harbour/contracts`. A schema with a
 * `title` is a named type: a component in the OpenAPI document and a named type in the SDK. `test/types.test.ts`
 * checks at compile time that each schema's static type and its contract type match, so the two can't drift.
 */
import Type, { type TSchema } from "typebox";

const id = (description: string) => Type.String({ minLength: 1, description });

export const Timestamp = Type.Integer({ description: "Epoch milliseconds, UTC." });

export const SessionStatus = Type.Union(
	[
		Type.Literal("idle"),
		Type.Literal("running"),
		Type.Literal("waiting"),
		Type.Literal("done"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	],
	{ title: "SessionStatus" },
);

export const Labels = Type.Record(Type.String(), Type.String(), {
	title: "Labels",
	description: 'Host labels, such as `{ docketTask: "TASK-3347" }`.',
});

export const Actor = Type.Union(
	[
		Type.Object({ kind: Type.Literal("human"), userId: Type.String() }),
		Type.Object({ kind: Type.Literal("service"), serviceId: Type.String(), keyId: Type.Optional(Type.String()) }),
		Type.Object({ kind: Type.Literal("agent"), agentId: Type.String(), sessionId: Type.String() }),
		Type.Object({ kind: Type.Literal("system"), component: Type.String() }),
	],
	{ title: "Actor", description: "Who acted: a person, a host app's API key, an agent or Harbour itself." },
);

export const SessionRecord = Type.Object(
	{
		id: id("The session's ID."),
		organisationId: Type.String(),
		projectId: Type.String(),
		agentId: Type.String({ description: "The agent profile the session runs." }),
		parentSessionId: Type.Optional(Type.String()),
		workspaceId: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		status: SessionStatus,
		labels: Labels,
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
		pinnedAt: Type.Optional(
			Type.Integer({ description: "When the session was pinned to the top of the list, in epoch milliseconds." }),
		),
		archivedAt: Type.Optional(
			Type.Integer({ description: "When the session was archived (out of the default list), in epoch milliseconds." }),
		),
		markedUnreadAt: Type.Optional(
			Type.Integer({ description: "When someone marked the session unread, in epoch milliseconds." }),
		),
	},
	{ title: "SessionRecord" },
);

export const ThinkingLevel = Type.Union(
	[
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	],
	{ title: "ThinkingLevel" },
);

export const MessageVia = Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")], {
	title: "MessageVia",
	description:
		"How a message reaches the agent: `prompt` starts a run (queued behind one in progress), `steer` reaches a run in " +
		"progress at its next model call, and `followUp` runs after the current run ends.",
});

const messageFields = {
	text: Type.String({ minLength: 1, description: "The message's words." }),
	model: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"A model ID the session may use, for this run and the session's later runs. Absent keeps the session's model.",
		}),
	),
	thinking: Type.Optional(ThinkingLevel),
};

export const FirstMessage = Type.Object(messageFields, {
	title: "FirstMessage",
	description: "The session's first prompt, sent as soon as it exists.",
});

export const MessageBody = Type.Object(
	{ via: Type.Optional(MessageVia), ...messageFields },
	{ title: "MessageBody", description: "A message to the session's agent. `via` defaults to `prompt`." },
);

export const Submission = Type.Object(
	{
		id: Type.String({ description: "The submission's ID, which names the run the message started or joined." }),
		sessionId: Type.String(),
		via: MessageVia,
		requestId: Type.Optional(Type.String({ description: "The `Idempotency-Key` it was sent with." })),
	},
	{ title: "Submission", description: "A message the session accepted." },
);

export const CreateSessionBody = Type.Object(
	{
		projectId: id("The project the session runs in."),
		agentId: id("The agent profile it runs."),
		title: Type.Optional(Type.String()),
		labels: Type.Optional(Labels),
		workspaceId: Type.Optional(Type.String({ description: "An existing workspace to run in." })),
		parentSessionId: Type.Optional(
			Type.String({ description: "Creates a child session owned by this parent; aborting the parent aborts it." }),
		),
		message: Type.Optional(FirstMessage),
	},
	{
		title: "CreateSessionBody",
		description:
			'Put the host\'s own reference for the session in `labels`, such as `{ lleverageRunId: "run-42" }`, and find it ' +
			"again with `GET /sessions?label.lleverageRunId=run-42`.",
	},
);

export const CreatedSession = Type.Object(
	{
		...SessionRecord.properties,
		submission: Type.Optional(Submission),
	},
	{ title: "CreatedSession", description: "A new session, with its first message's submission when it was sent one." },
);

export const SessionPage = Type.Object(
	{
		items: Type.Array(SessionRecord),
		nextCursor: Type.Optional(Type.String({ description: "Present when more items follow." })),
	},
	{ title: "SessionPage" },
);

export const ListSessionsQuery = Type.Object(
	{
		projectId: Type.Optional(Type.String()),
		agentId: Type.Optional(Type.String()),
		status: Type.Optional(SessionStatus),
		parentSessionId: Type.Optional(Type.String()),
		label: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description:
					"Sessions with every one of these labels, each sent as `label.<key>=<value>`, such as `label.docketTask=TASK-3347`.",
			}),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		cursor: Type.Optional(Type.String({ description: "A previous page's `nextCursor`." })),
	},
	{ title: "ListSessionsQuery" },
);

export const AbortSessionBody = Type.Object(
	{ reason: Type.Optional(Type.String({ description: "Recorded in the audit trail." })) },
	{ title: "AbortSessionBody" },
);

export const SessionPath = Type.Object({ sessionId: id("The session's ID.") });

export const SessionWarmth = Type.Object(
	{
		container: Type.Union(
			[Type.Literal("started"), Type.Literal("running"), Type.Literal("skipped"), Type.Literal("unavailable")],
			{
				description:
					"The session's container: `started` now, already `running`, `skipped` (the session has never needed one, so " +
					"none is started for it) or `unavailable` (this deployment runs no containers, or the session has no workspace).",
			},
		),
	},
	{ title: "SessionWarmth" },
);

/**
 * Any JSON value: a schedule's payload, an occurrence's result and a host's namespaced `extensions` are opaque to
 * Harbour. Its static type is `unknown` rather than the contracts' recursive `JsonValue`, which the router's read-only
 * mapping can't unfold; a body is JSON already, having been parsed from it.
 */
export const JsonValue = Type.Unknown({ title: "JsonValue", description: "Any JSON value." });

export const ScheduleKind = Type.Union(
	[
		Type.Literal("reminder"),
		Type.Literal("task"),
		Type.Literal("summary"),
		Type.Literal("check"),
		Type.Literal("heartbeat"),
		Type.Literal("program"),
	],
	{
		title: "ScheduleKind",
		description:
			'What runs. A `task` starts a session with its payload `{ "agentId"?, "prompt" }` and sends the prompt exactly as written; a `check` runs its payload (a command line or an argument list) with no model.',
	},
);

export const ScheduleStatus = Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("ended")], {
	title: "ScheduleStatus",
});

export const Weekday = Type.Union(
	[
		Type.Literal("mon"),
		Type.Literal("tue"),
		Type.Literal("wed"),
		Type.Literal("thu"),
		Type.Literal("fri"),
		Type.Literal("sat"),
		Type.Literal("sun"),
	],
	{ title: "Weekday" },
);

const localTime = Type.String({ description: "A local wall-clock time, `HH:MM`, in the schedule's time zone." });

export const Recurrence = Type.Union(
	[
		Type.Object(
			{
				every: Type.Union([Type.Literal("minutes"), Type.Literal("hours")]),
				interval: Type.Integer({ minimum: 1 }),
				from: Timestamp,
			},
			{ description: "Every `interval` minutes or hours counted from `from`, unaffected by daylight saving." },
		),
		Type.Object({ every: Type.Literal("day"), at: localTime, interval: Type.Optional(Type.Integer({ minimum: 1 })) }),
		Type.Object({ every: Type.Literal("weekday"), at: localTime }),
		Type.Object({ every: Type.Literal("week"), at: localTime, on: Type.Array(Weekday) }),
		Type.Object(
			{ every: Type.Literal("month"), at: localTime, day: Type.Integer({ minimum: 1, maximum: 31 }) },
			{ description: "`day` 31 means the last day of the month." },
		),
	],
	{ title: "Recurrence" },
);

export const CheckSettings = Type.Object(
	{
		reraiseHours: Type.Optional(
			Type.Number({ description: "Hours before a finding still present is raised again. Default 6." }),
		),
		risingFactor: Type.Optional(
			Type.Number({ description: "A finding whose value grows by this factor is raised again. Default 2." }),
		),
		failuresBeforeRaise: Type.Optional(
			Type.Integer({ description: "Failed runs in a row before a `check-failed` finding is raised. Default 3." }),
		),
		severityOrder: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Severities, worst first, case-insensitive, for raising a finding that got worse as `escalated`. Default `urgent`, `high`, `medium`, `low`, `warn`, `info`.",
			}),
		),
	},
	{ title: "CheckSettings" },
);

export const OwnerRef = Type.Union(
	[
		Type.Object({ kind: Type.Literal("platform") }),
		Type.Object({ kind: Type.Literal("organisation"), organisationId: Type.String() }),
		Type.Object({ kind: Type.Literal("project"), organisationId: Type.String(), projectId: Type.String() }),
		Type.Object({ kind: Type.Literal("user"), organisationId: Type.String(), userId: Type.String() }),
	],
	{ title: "OwnerRef", description: "Who owns a record: an organisation, a project, a user, or the platform." },
);

const scheduleFields = {
	title: Type.String(),
	timezone: Type.String({ description: "An IANA time zone, such as `Europe/London`." }),
	at: Type.Optional(
		Type.Integer({ description: "A one-off at this instant (epoch milliseconds). Exactly one of `at` and `repeat`." }),
	),
	repeat: Type.Optional(Recurrence),
	until: Type.Optional(Type.Integer({ description: "No occurrence is due after this (epoch milliseconds)." })),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "At most this many occurrences." })),
	payload: JsonValue,
	check: Type.Optional(CheckSettings),
};

export const CreateScheduleBody = Type.Object(
	{ owner: OwnerRef, kind: ScheduleKind, ...scheduleFields },
	{
		title: "CreateScheduleBody",
		description: "A new schedule. Needs the operator role on a project-owned schedule's project.",
	},
);

/** `null`, or one of these: on a schedule change, `null` clears the field. */
const clearable = <T extends TSchema>(schema: T, description: string) =>
	Type.Optional(Type.Union([schema, Type.Null()], { description }));

export const UpdateScheduleBody = Type.Object(
	{
		title: Type.Optional(scheduleFields.title),
		timezone: Type.Optional(scheduleFields.timezone),
		at: clearable(
			Type.Integer(),
			"A one-off at this instant (epoch milliseconds), or `null` to clear it, as when it becomes a recurrence. Exactly one of `at` and `repeat` is left set.",
		),
		repeat: clearable(Recurrence, "The recurrence, or `null` to clear it, as when it becomes a one-off."),
		until: clearable(
			Type.Integer(),
			"No occurrence is due after this (epoch milliseconds), or `null` to drop the end date.",
		),
		count: clearable(Type.Integer({ minimum: 1 }), "At most this many occurrences, or `null` to drop the run limit."),
		payload: Type.Optional(JsonValue),
		check: scheduleFields.check,
	},
	{
		title: "UpdateScheduleBody",
		description:
			"The fields to change; a field left out stays as it is, and `null` on `at`, `repeat`, `until` or `count` clears it. The owner and the kind are fixed at create.",
	},
);

export const Schedule = Type.Object(
	{
		id: id("The schedule's ID."),
		owner: OwnerRef,
		kind: ScheduleKind,
		...scheduleFields,
		status: ScheduleStatus,
		nextDueAt: Type.Optional(Type.Integer({ description: "The next due time; absent when ended or paused." })),
		occurrences: Type.Integer({ description: "Occurrences so far; a coalesced one counts once." }),
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "Schedule" },
);

export const SchedulePage = Type.Object(
	{
		items: Type.Array(Schedule),
		nextCursor: Type.Optional(Type.String({ description: "Present when more items follow." })),
	},
	{ title: "SchedulePage" },
);

export const ListSchedulesQuery = Type.Object(
	{
		kind: Type.Optional(ScheduleKind),
		status: Type.Optional(ScheduleStatus),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		cursor: Type.Optional(Type.String({ description: "A previous page's `nextCursor`." })),
	},
	{ title: "ListSchedulesQuery" },
);

export const SchedulePath = Type.Object({ scheduleId: id("The schedule's ID.") });

export const PreviewScheduleQuery = Type.Object(
	{ n: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "How many due times. Default 5." })) },
	{ title: "PreviewScheduleQuery" },
);

export const SchedulePreview = Type.Object(
	{ dueAt: Type.Array(Timestamp, { description: "The next due times, soonest first." }) },
	{ title: "SchedulePreview" },
);

export const OccurrenceStatus = Type.Union(
	[Type.Literal("due"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed")],
	{ title: "OccurrenceStatus" },
);

export const Occurrence = Type.Object(
	{
		id: id("`<scheduleId>@<dueAt>`: unique per schedule and due time."),
		scheduleId: Type.String(),
		dueAt: Timestamp,
		coalesced: Type.Integer({ description: "How many due times this run stands for (more than 1 after missed runs)." }),
		status: OccurrenceStatus,
		attempt: Type.Integer(),
		claimedBy: Type.Optional(Type.String()),
		leaseUntil: Type.Optional(Timestamp),
		finishedAt: Type.Optional(Timestamp),
		result: Type.Optional(
			Type.Unknown({
				description:
					"How the run went: a task's `{ sessionId, submissionId }` (the session it started), a check's `{ exitCode, raised }`, or `{ error }` for a failed run.",
			}),
		),
	},
	{ title: "Occurrence", description: "One run of a schedule." },
);

export const OccurrencePage = Type.Object(
	{
		items: Type.Array(Occurrence),
		nextCursor: Type.Optional(Type.String({ description: "Present when more items follow." })),
	},
	{ title: "OccurrencePage" },
);

export const ErrorCode = Type.Union(
	[
		Type.Literal("invalid"),
		Type.Literal("not_found"),
		Type.Literal("forbidden"),
		Type.Literal("conflict"),
		Type.Literal("expired"),
		Type.Literal("refused"),
		Type.Literal("exhausted"),
		Type.Literal("aborted"),
		Type.Literal("not_supported"),
		Type.Literal("unavailable"),
		Type.Literal("unauthenticated"),
	],
	{ title: "ErrorCode" },
);

export const ErrorBody = Type.Object(
	{
		error: Type.Object({
			code: ErrorCode,
			message: Type.String(),
			details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
	},
	{ title: "ErrorBody", description: "Every error: the HarbourError's code and message." },
);

const Extensions = Type.Record(Type.String(), JsonValue, {
	description: "Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`.",
});

const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }));
const cursor = Type.Optional(Type.String({ description: "A previous page's `nextCursor`." }));
const nextCursor = Type.Optional(Type.String({ description: "Present when more items follow." }));

export const PageQuery = Type.Object({ limit, cursor }, { title: "PageQuery" });

// Skills (#12): Agent Skills packages and their immutable revisions.

const SourceRef = Type.Object(
	{
		sourceId: Type.String({ description: "The host's skill or memory source, such as `sal-skills`." }),
		ref: Type.String({ description: "Its ref: a commit or a version." }),
	},
	{ title: "SourceRef", description: "Where a host's adapter imported something from." },
);

export const SkillFile = Type.Object(
	{
		path: Type.String({ description: "A relative path inside the package, such as `SKILL.md` or `scripts/run.sh`." }),
		content: Type.String(),
	},
	{ title: "SkillFile" },
);

export const SkillPackage = Type.Object(
	{
		id: id("The skill's ID."),
		owner: OwnerRef,
		name: Type.String({ description: "Unique per owner: lowercase letters, digits and dashes." }),
		description: Type.String(),
		latestRevision: Type.Optional(Type.Integer({ description: "The newest published revision." })),
		draftDigest: Type.Optional(Type.String({ description: "Present while a draft is open." })),
		source: Type.Optional(SourceRef),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "SkillPackage" },
);

export const SkillRevision = Type.Object(
	{
		skillId: Type.String(),
		revision: Type.Integer({ minimum: 1, description: "1, 2, 3… per skill. A published revision never changes." }),
		digest: Type.String({ description: "Hex SHA-256 over the sorted paths and contents." }),
		name: Type.String(),
		description: Type.String(),
		files: Type.Array(Type.Object({ path: Type.String(), size: Type.Integer({ description: "Bytes, UTF-8." }) })),
		extensions: Type.Optional(Extensions),
		publishedBy: Actor,
		publishedAt: Timestamp,
		source: Type.Optional(SourceRef),
	},
	{ title: "SkillRevision" },
);

export const SkillListing = Type.Object(
	{
		skillId: Type.String(),
		name: Type.String(),
		description: Type.String(),
		revision: Type.Integer({ description: "The latest published revision." }),
		path: Type.String({ description: "Where a session finds it, such as `/skills/pr-review/SKILL.md`." }),
	},
	{ title: "SkillListing", description: "What a session is shown of a skill: enough to decide whether to read it." },
);

export const SkillListingPage = Type.Object(
	{ items: Type.Array(SkillListing), nextCursor },
	{ title: "SkillListingPage" },
);

export const SkillRevisionPage = Type.Object(
	{ items: Type.Array(SkillRevision), nextCursor },
	{ title: "SkillRevisionPage" },
);

export const ListSkillsQuery = Type.Object(
	{
		projectId: Type.Optional(
			Type.String({ description: "Also list this project's skills. Needs the viewer role on it." }),
		),
		limit,
		cursor,
	},
	{ title: "ListSkillsQuery" },
);

export const SkillPath = Type.Object({ skillId: id("The skill's ID.") });

export const SkillRevisionPath = Type.Object({
	skillId: id("The skill's ID."),
	revision: Type.String({ pattern: "^[1-9][0-9]{0,8}$", description: "The revision number." }),
});

export const SkillFileQuery = Type.Object(
	{ path: Type.String({ minLength: 1, description: "The file's path in the package, such as `SKILL.md`." }) },
	{ title: "SkillFileQuery" },
);

export const SkillFileContent = Type.Object(
	{ path: Type.String(), content: Type.String() },
	{ title: "SkillFileContent", description: "One file of a revision, as UTF-8 text." },
);

export const ImportSkillBody = Type.Object(
	{
		owner: OwnerRef,
		name: Type.String({ minLength: 1 }),
		description: Type.String({ minLength: 1 }),
		files: Type.Array(SkillFile, { description: "Every file of the package, `SKILL.md` among them." }),
		source: SourceRef,
		extensions: Type.Optional(Extensions),
	},
	{ title: "ImportSkillBody" },
);

// Memory (#12): spaces of curated concepts, read by search and recall.

export const MemorySnapshotRef = Type.Object(
	{ sourceId: Type.String(), ref: Type.String(), importedAt: Timestamp },
	{ title: "MemorySnapshotRef", description: "Where a space's snapshot came from, and when it was imported." },
);

export const MemorySpace = Type.Object(
	{
		id: id("The space's ID."),
		owner: OwnerRef,
		name: Type.String(),
		createdAt: Timestamp,
		snapshot: Type.Optional(MemorySnapshotRef),
	},
	{ title: "MemorySpace" },
);

export const MemorySpacePage = Type.Object(
	{ items: Type.Array(MemorySpace), nextCursor },
	{ title: "MemorySpacePage" },
);

export const CreateMemorySpaceBody = Type.Object(
	{ owner: OwnerRef, name: Type.String({ minLength: 1 }) },
	{ title: "CreateMemorySpaceBody" },
);

export const ConceptScope = Type.Union(
	[
		Type.Object({ kind: Type.Literal("global") }),
		Type.Object({ kind: Type.Literal("project"), project: Type.String() }),
		Type.Object({ kind: Type.Literal("job"), job: Type.String() }),
	],
	{ title: "ConceptScope", description: "Where a concept applies. A `job` concept is an exception for one job." },
);

export const ConceptStatus = Type.Union(
	[Type.Literal("active"), Type.Literal("superseded"), Type.Literal("forgotten")],
	{ title: "ConceptStatus" },
);

const SetBy = Type.Union([Type.Literal("owner"), Type.Literal("learned")], {
	description: "`owner`: set by the space's owner. `learned`: from an approved agent proposal.",
});

const conceptFields = {
	id: Type.String({ minLength: 1, description: "A stable path, such as `projects/harbour/vault-binding-codes`." }),
	title: Type.String(),
	description: Type.Optional(Type.String()),
	statement: Type.String({ description: "The fact itself, short." }),
	scope: ConceptScope,
	sources: Type.Array(Type.String(), {
		description: "What backs it: URLs, `owner/repo@commit:path:lines`, ticket IDs.",
	}),
	staleAfter: Type.Optional(Type.Integer({ description: "After this, recall marks it stale (epoch milliseconds)." })),
	overrides: Type.Optional(Type.String({ description: "A job exception's general concept." })),
	extensions: Type.Optional(Extensions),
};

export const Concept = Type.Object(
	{
		spaceId: Type.String(),
		...conceptFields,
		tags: Type.Array(Type.String()),
		setBy: SetBy,
		version: Type.Integer({ description: "Increases with every change." }),
		status: ConceptStatus,
		supersededBy: Type.Optional(Type.String()),
		updatedAt: Timestamp,
	},
	{ title: "Concept" },
);

export const ConceptPage = Type.Object({ items: Type.Array(Concept), nextCursor }, { title: "ConceptPage" });

export const ListConceptsQuery = Type.Object(
	{ status: Type.Optional(ConceptStatus), limit, cursor },
	{ title: "ListConceptsQuery" },
);

export const MemorySpacePath = Type.Object({ spaceId: id("The space's ID.") });

export const ConceptPath = Type.Object({
	spaceId: id("The space's ID."),
	conceptId: id("The concept's ID, its slashes encoded (`projects%2Fharbour%2Fregion`)."),
});

export const SnapshotConcept = Type.Object(
	{
		...conceptFields,
		tags: Type.Optional(Type.Array(Type.String())),
		setBy: SetBy,
		status: ConceptStatus,
		supersededBy: Type.Optional(Type.String()),
		updatedAt: Timestamp,
	},
	{ title: "SnapshotConcept", description: "One concept as a host's source holds it." },
);

export const MemorySnapshot = Type.Object(
	{
		sourceId: Type.String({ minLength: 1 }),
		ref: Type.String({ minLength: 1 }),
		concepts: Type.Array(SnapshotConcept),
	},
	{ title: "MemorySnapshot", description: "A whole space's concepts at one ref of a source." },
);

const spaceIds = Type.Array(Type.String(), { minItems: 1, description: "The spaces to read." });

export const MemorySearchBody = Type.Object(
	{
		spaceIds,
		query: Type.String(),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Default 5." })),
		includeInactive: Type.Optional(
			Type.Boolean({ description: "Also list superseded and forgotten concepts, scoring a quarter." }),
		),
	},
	{ title: "MemorySearchBody" },
);

export const MemorySearchHit = Type.Object(
	{
		concept: Concept,
		score: Type.Number(),
		stale: Type.Boolean(),
		snippet: Type.String({ description: "The first statement line holding a term, cut to 160 characters." }),
	},
	{ title: "MemorySearchHit" },
);

export const MemorySearchResult = Type.Object({ hits: Type.Array(MemorySearchHit) }, { title: "MemorySearchResult" });

export const RecallBody = Type.Object(
	{
		spaceIds,
		query: Type.String({ description: "The task or message text to search by." }),
		scopes: Type.Optional(
			Type.Object({
				projects: Type.Optional(Type.Array(Type.String())),
				jobs: Type.Optional(Type.Array(Type.String())),
			}),
		),
		profile: Type.Optional(
			Type.Array(Type.String(), { description: "Concept IDs recalled whatever the query, within their own limits." }),
		),
		exclude: Type.Optional(Type.Array(Type.String(), { description: "Concept IDs never recalled." })),
		maxConcepts: Type.Optional(Type.Integer({ minimum: 0, description: "Default 5 search matches." })),
		maxBytes: Type.Optional(Type.Integer({ minimum: 0, description: "Default 4096." })),
		maxProfileConcepts: Type.Optional(Type.Integer({ minimum: 0 })),
		maxProfileBytes: Type.Optional(Type.Integer({ minimum: 0, description: "Default 24576." })),
	},
	{ title: "RecallBody" },
);

export const RecallManifestEntry = Type.Object(
	{
		spaceId: Type.String(),
		conceptId: Type.String(),
		version: Type.Integer(),
		reason: Type.Union([Type.Literal("profile"), Type.Literal("search"), Type.Literal("exception")]),
		score: Type.Optional(Type.Number()),
		matched: Type.Optional(Type.Array(Type.String())),
		stale: Type.Boolean(),
		truncated: Type.Boolean(),
		snapshotRef: Type.Optional(Type.String()),
	},
	{ title: "RecallManifestEntry" },
);

export const Recall = Type.Object(
	{
		concepts: Type.Array(Concept),
		manifest: Type.Array(RecallManifestEntry, { description: "What was recalled and why, in the same order." }),
		text: Type.String({ description: "The recall as a prompt shows it." }),
		skipped: Type.Array(Type.Object({ conceptId: Type.String(), reason: Type.String() })),
		profileOmitted: Type.Array(Type.String()),
		truncated: Type.Boolean(),
	},
	{ title: "Recall" },
);

// Browsers (the embed API, docs/design/browser-runtime.md).

export const BrowserSessionPath = Type.Object({
	sessionId: id("The session's ID."),
	browserSessionId: id("The browser session's ID, as the session's browser tool items name it."),
});

export const EmbedBrowserBody = Type.Object(
	{
		mode: Type.Union([Type.Literal("live"), Type.Literal("replay")], {
			description: "`live`: the open browser as it is now, watch-only. `replay`: its recording.",
		}),
		minutes: Type.Optional(
			Type.Integer({ minimum: 5, maximum: 60, description: "How long the link lasts. Default 15." }),
		),
	},
	{ title: "EmbedBrowserBody" },
);

export const BrowserEmbed = Type.Object(
	{
		url: Type.String({
			description:
				"The page to frame. It holds its token after `#`, so the token reaches no server; treat the URL as a secret.",
		}),
		mode: Type.Union([Type.Literal("live"), Type.Literal("replay")]),
		expiresAt: Type.Optional(Timestamp),
		endMessage: Type.Optional(
			Type.String({ description: "What the page posts to its parent once its stream is over." }),
		),
	},
	{ title: "BrowserEmbed" },
);
