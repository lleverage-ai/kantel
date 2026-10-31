/**
 * The public API's wire shapes as JSON Schema (TypeBox), each mirroring a type in `@kantel/contracts`. A schema with a
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
	description: 'Host labels, such as `{ ticket: "PROJ-12" }`.',
});

export const Actor = Type.Union(
	[
		Type.Object({ kind: Type.Literal("human"), userId: Type.String() }),
		Type.Object({ kind: Type.Literal("service"), serviceId: Type.String(), keyId: Type.Optional(Type.String()) }),
		Type.Object({ kind: Type.Literal("agent"), agentId: Type.String(), sessionId: Type.String() }),
		Type.Object({ kind: Type.Literal("system"), component: Type.String() }),
	],
	{ title: "Actor", description: "Who acted: a person, a host app's API key, an agent or Kantel itself." },
);

export const SessionVisibility = Type.Union([Type.Literal("private"), Type.Literal("shared")], {
	title: "SessionVisibility",
	description:
		"Who may see the session (#335). `private`: only the person it acts for (and the host app that made it); no project " +
		"or organisation member, an admin included. `shared` (the default): its project's members, or the organisation's. " +
		"A person's private connection is refused in a shared session unless they shared it with the project.",
});

export const SessionRecord = Type.Object(
	{
		id: id("The session's ID."),
		organisationId: Type.String(),
		projectId: Type.Optional(
			Type.String({ description: "The session's project. Absent for a session scoped to the organisation." }),
		),
		agentId: Type.String({ description: "The agent profile the session runs." }),
		userId: Type.Optional(
			Type.String({ description: "The person the session works for: whose own skills and prompt rules it gets." }),
		),
		parentSessionId: Type.Optional(Type.String()),
		workspaceId: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		visibility: Type.Optional(SessionVisibility),
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
		"progress at its next model call, without stopping it (usually right after the tool call in progress), and " +
		"`followUp` runs after the current run ends. A steer or follow-up to a session with no run in progress starts " +
		"one, as a prompt does, so a message sent just as a run ends is never lost.",
});

/** The most attachments one message may carry (`MAX_PROMPT_ATTACHMENTS` in `@kantel/runtime`). */
const MAX_MESSAGE_ATTACHMENTS = 20;

export const PromptAttachment = Type.Object(
	{
		id: id("The upload's ID, as the deployment's upload route answered it. Unique within the message."),
		name: id("The file's name, such as `invoice.pdf`."),
		type: Type.String({ description: "The MIME type, such as `image/png` or `application/pdf`." }),
		size: Type.Number({ minimum: 0, description: "In bytes." }),
		kind: Type.Union([Type.Literal("image"), Type.Literal("file"), Type.Literal("text")], {
			description:
				"`image`: a PNG, JPEG, GIF or WebP the model looks at; `file`: any other file; `text`: a long paste folded " +
				"into a file.",
		}),
	},
	{
		title: "PromptAttachment",
		description:
			"A file for a message, uploaded first: on Cloudflare `POST /v1/attachments?projectId=&name=` with the file's bytes " +
			"as the body answers this reference. The message carries only the reference; the model sees the file's contents.",
	},
);

const messageFields = {
	text: Type.String({
		description: "The message's words. May be empty when `attachments` has a file; otherwise it is `invalid`.",
	}),
	attachments: Type.Optional(
		Type.Array(PromptAttachment, {
			maxItems: MAX_MESSAGE_ATTACHMENTS,
			description:
				"Files for this message, in the order they were attached. A deployment that stores no uploads refuses them " +
				"(`invalid`), as it does a file from another project.",
		}),
	),
	model: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"A model ID the session may use, for this run and the session's later runs. Absent keeps the session's model. " +
				"Only a session's first message may choose its model: once the session has started, naming another is a " +
				"`conflict` (naming its own is fine).",
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

export const SessionScope = Type.Union([Type.Literal("project"), Type.Literal("organisation")], {
	title: "SessionScope",
	description:
		"Where a session works: `project` (in `projectId`) or `organisation`, above every project and in none of them.",
});

export const CreateSessionBody = Type.Object(
	{
		projectId: Type.Optional(id("The project the session runs in. Required unless `scope` is `organisation`.")),
		scope: Type.Optional(SessionScope),
		userId: Type.Optional(
			id(
				"The person the session works for. A person may name only themselves; a host app any user. Default the " +
					"person creating it.",
			),
		),
		agentId: id("The agent profile it runs."),
		title: Type.Optional(Type.String()),
		labels: Type.Optional(Labels),
		workspaceId: Type.Optional(Type.String({ description: "An existing workspace to run in." })),
		parentSessionId: Type.Optional(
			Type.String({ description: "Creates a child session owned by this parent; aborting the parent aborts it." }),
		),
		visibility: Type.Optional(SessionVisibility),
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
		scope: Type.Optional(SessionScope),
		agentId: Type.Optional(Type.String()),
		status: Type.Optional(SessionStatus),
		parentSessionId: Type.Optional(Type.String()),
		workspaceId: Type.Optional(
			Type.String({
				description:
					"Sessions running in this workspace: the conversations that share its files, each with its own history.",
			}),
		),
		label: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description:
					"Sessions with every one of these labels, each sent as `label.<key>=<value>`, such as `label.ticket=PROJ-12`.",
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

export const SessionImagePath = Type.Object({
	sessionId: id("The session's ID."),
	imageId: Type.String({
		pattern: "^[0-9a-f]{64}$",
		description: "The SHA-256 of the image's bytes, in lowercase hex.",
	}),
});

export const ModelOption = Type.Object(
	{
		id: Type.String({
			description: "What a message's `model` names: a route such as `default`, or `<route>:<modelId>` for an override.",
		}),
		label: Type.String({ description: "What a person reads, such as `Claude Sonnet 4.5`." }),
		provider: Type.Optional(Type.String({ description: "Who serves the model, for grouping, such as `Anthropic`." })),
		description: Type.Optional(Type.String()),
		capabilities: Type.Optional(
			Type.Object(
				{
					images: Type.Optional(Type.Boolean({ description: "Reads images." })),
					thinking: Type.Optional(Type.Array(ThinkingLevel, { description: "The thinking levels it supports." })),
				},
				{ description: "What the model takes. A field left out is unknown." },
			),
		),
		default: Type.Optional(
			Type.Boolean({ description: "The model the session runs with when no message names one. At most one." }),
		),
		disabledReason: Type.Optional(
			Type.String({ description: "Set when the model is listed but can't be chosen now, with the reason." }),
		),
	},
	{ title: "ModelOption", description: "A model a session may run with, as a model picker shows it." },
);

export const ModelSelection = Type.Object(
	{
		model: Type.String({ description: "A `ModelOption.id`." }),
		thinking: Type.Optional(ThinkingLevel),
	},
	{ title: "ModelSelection", description: "A model and thinking level." },
);

export const SessionModelState = Type.Object(
	{
		models: Type.Array(ModelOption),
		selected: Type.Optional(ModelSelection),
		defaults: Type.Optional(ModelSelection),
		locked: Type.Optional(
			Type.Boolean({
				description:
					"Set once the session has started (it holds a message): its model is `selected`'s for good, and a message " +
					"naming another is a `conflict`. Its thinking level can still change.",
			}),
		),
	},
	{
		title: "SessionModelState",
		description:
			"The models a session's messages may name (`model` and `thinking` on a message), in the order to show them; " +
			"`selected`, what the session's next model call uses (its agent profile's until its first message names another); " +
			"`defaults`, what its agent profile names; and `locked`, set once the session has started. The first message " +
			"fixes the session's model, so everything in its transcript comes from one model; its thinking level can change " +
			"on any later message, though a change may cost the next call the provider's prompt cache.",
	},
);

export const ProfilePath = Type.Object({ agentId: id("The agent profile's ID.") });

export const NewSessionModelsQuery = Type.Object(
	{
		projectId: Type.Optional(id("The project the session would run in. Required unless `scope` is `organisation`.")),
		scope: Type.Optional(SessionScope),
	},
	{ title: "NewSessionModelsQuery" },
);

export const ForkSessionBody = Type.Object(
	{
		itemId: id("The transcript item ID of an assistant answer, as the session's stream gives it."),
		title: Type.Optional(
			Type.String({ description: "The new session's title. Default the source's, with \" (fork)\"." }),
		),
	},
	{
		title: "ForkSessionBody",
		description: "Where to fork: the answer the new session's history ends with.",
	},
);

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
 * Kantel. Its static type is `unknown` rather than the contracts' recursive `JsonValue`, which the router's read-only
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
	{ title: "ErrorBody", description: "Every error: the KantelError's code and message." },
);

const Extensions = Type.Record(Type.String(), JsonValue, {
	description: "Namespaced host data Kantel keeps but doesn't read, such as Lleverage's `lleverage.workflows`.",
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

export const Project = Type.Object(
	{
		id: id("The project's ID."),
		organisationId: Type.String({ description: "The organisation the project is in: always the caller's." }),
		name: Type.String(),
		createdAt: Timestamp,
	},
	{ title: "Project" },
);

// The length is `PROJECT_NAME_MAX_LENGTH` in `@kantel/contracts`; `test/types.test.ts` checks they agree.
export const CreateProjectBody = Type.Object(
	{
		name: Type.String({
			minLength: 1,
			maxLength: 100,
			description: "The project's name, trimmed: not empty, and at most 100 characters.",
		}),
	},
	{ title: "CreateProjectBody", description: "Any other field is refused as `invalid`." },
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
	id: Type.String({ minLength: 1, description: "A stable path, such as `projects/harbour/binding-codes`." }),
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

// Browsers (the embed API, packages/browser/CONTRACT.md).

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

// Sharing (`FileShares`): a file an agent made, shared by invite or by link.

export const ShareAccess = Type.Union([Type.Literal("restricted"), Type.Literal("link")], {
	title: "ShareAccess",
	description: "`restricted`: only those who can see the session's workspace. `link`: anyone with the link.",
});

export const ShareInvite = Type.Object(
	{
		email: Type.String({ description: "As invited. Kantel sends no email." }),
		invitedBy: id("The person who invited them."),
		invitedAt: Timestamp,
	},
	{ title: "ShareInvite" },
);

export const FileShare = Type.Object(
	{
		id: id("The share's ID."),
		organisationId: id("The organisation."),
		workspaceId: id("The workspace the file is in."),
		path: Type.String({ description: "The file's path in the workspace." }),
		title: Type.Optional(Type.String({ description: "What the link's page calls the file." })),
		access: ShareAccess,
		token: Type.String({
			description: "The link's secret: the link is `/shared/<token>` on the deployment's hostname. Treat it as one.",
		}),
		createdBy: id("The person who shared the file, its owner."),
		createdAt: Timestamp,
		updatedAt: Timestamp,
		invites: Type.Array(ShareInvite),
		revokedAt: Type.Optional(Timestamp),
	},
	{ title: "FileShare" },
);

export const FileSharePage = Type.Object({ items: Type.Array(FileShare) }, { title: "FileSharePage" });

export const WorkspaceSharesPath = Type.Object({ workspaceId: id("The workspace's ID.") });

export const ListSharesQuery = Type.Object(
	{ path: Type.Optional(Type.String({ minLength: 1, description: "Only this file's share." })) },
	{ title: "ListSharesQuery" },
);

export const ShareFileBody = Type.Object(
	{
		path: Type.String({ minLength: 1, description: "The file's path in the workspace." }),
		title: Type.Optional(Type.String({ maxLength: 200, description: "What the link's page calls it." })),
		access: Type.Optional(ShareAccess),
	},
	{ title: "ShareFileBody" },
);

export const SharePath = Type.Object({ shareId: id("The share's ID.") });

export const UpdateShareBody = Type.Object(
	{ access: Type.Optional(ShareAccess), title: Type.Optional(Type.String({ maxLength: 200 })) },
	{ title: "UpdateShareBody", description: "The fields to change; one left out stays as it is." },
);

export const ShareInviteBody = Type.Object(
	{ email: Type.String({ minLength: 3, maxLength: 254, description: "Who to invite." }) },
	{ title: "ShareInviteBody" },
);

// Resource sharing: one project's skills, memory spaces, stored secrets, workspaces and a host's
// own kinds, shared with another project, agent, person or session, with access requests, bindings and policies.

const resourceKind = Type.String({
	minLength: 1,
	pattern: "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$",
	description:
		"Kantel's `skills.skill`, `memory.space`, `workspace`, `models.connector` or `vault.item` (a secret in the encrypted store behind connections, under its stored name), or a kind a host registered, such as `workflows.workflow`.",
});
const revision = Type.Optional(
	Type.Integer({ minimum: 1, description: "Pins this revision. Without one, the share follows the latest." }),
);

export const ResourceRef = Type.Object(
	{ kind: resourceKind, id: id("The resource's ID in its component.") },
	{ title: "ResourceRef", description: "A resource: its kind and ID." },
);

export const ResourceSelector = Type.Object(
	{ kind: resourceKind, id: id("The resource's ID in its component."), revision },
	{ title: "ResourceSelector", description: "A resource, optionally at one revision." },
);

export const ShareGrantee = Type.Union(
	[
		Type.Object({ kind: Type.Literal("project"), projectId: Type.String() }),
		Type.Object({ kind: Type.Literal("agent"), agentId: Type.String() }),
		Type.Object({ kind: Type.Literal("user"), userId: Type.String() }),
		Type.Object({ kind: Type.Literal("session"), sessionId: Type.String() }),
	],
	{
		title: "ShareGrantee",
		description:
			"Who a share is for: a project (its sessions, and its people within their role), an agent profile, a person, or one session (what a supervisor passes on).",
	},
);

export const SharePermission = Type.Union(
	[Type.Literal("use"), Type.Literal("propose"), Type.Literal("edit"), Type.Literal("approve")],
	{
		title: "SharePermission",
		description:
			"Weakest first, each including the ones before. Agents hold at most `propose`, or `edit` through a share with `agentWrites` on.",
	},
);

export const ResourceShare = Type.Object(
	{
		id: id("The share's ID."),
		organisationId: id("The organisation."),
		resource: ResourceSelector,
		owner: OwnerRef,
		grantee: ShareGrantee,
		permission: SharePermission,
		agentWrites: Type.Boolean({
			description:
				"Whether agents covered by the share may write through it (`edit`, never `approve`). Off unless the granter turned it on.",
		}),
		grantedBy: Actor,
		grantedAt: Timestamp,
		requestId: Type.Optional(Type.String({ description: "The request this share answers." })),
		expiresAt: Type.Optional(Timestamp),
		parentShareId: Type.Optional(
			Type.String({ description: "The share a supervisor passed this one on from; revoking that revokes this." }),
		),
		note: Type.Optional(Type.String()),
		revokedAt: Type.Optional(Timestamp),
		revokedBy: Type.Optional(Actor),
		revokeReason: Type.Optional(Type.String()),
	},
	{ title: "ResourceShare" },
);

export const ResourceSharePage = Type.Object(
	{ items: Type.Array(ResourceShare), nextCursor },
	{ title: "ResourceSharePage" },
);

export const CreateResourceShareBody = Type.Object(
	{
		resource: ResourceSelector,
		grantee: ShareGrantee,
		permission: SharePermission,
		agentWrites: Type.Optional(
			Type.Boolean({
				description:
					"Let agents write through the share (default false). Only on an `edit` or `approve` share; a share passed on may turn it on only when the one held has it.",
			}),
		),
		expiresAt: Type.Optional(Timestamp),
		parentShareId: Type.Optional(Type.String({ description: "Required of an agent: the share it passes on." })),
		note: Type.Optional(Type.String({ maxLength: 1000 })),
	},
	{ title: "CreateResourceShareBody" },
);

const granteeQuery = {
	granteeKind: Type.Optional(
		Type.Union([Type.Literal("project"), Type.Literal("agent"), Type.Literal("user"), Type.Literal("session")]),
	),
	granteeId: Type.Optional(
		Type.String({ description: "With `granteeKind`: the project's, agent's, person's or session's ID." }),
	),
};
const resourceQuery = {
	resourceKind: Type.Optional(resourceKind),
	resourceId: Type.Optional(Type.String({ description: "With `resourceKind`." })),
};

export const ListResourceSharesQuery = Type.Object(
	{
		...resourceQuery,
		...granteeQuery,
		ownerProjectId: Type.Optional(Type.String({ description: "Shares of resources this project owns." })),
		includeInactive: Type.Optional(Type.Boolean({ description: "Include revoked and expired shares." })),
		limit,
		cursor,
	},
	{ title: "ListResourceSharesQuery" },
);

export const ResourceSharePath = Type.Object({ shareId: id("The share's ID.") });

export const RevokeResourceShareBody = Type.Object(
	{ reason: Type.Optional(Type.String({ maxLength: 1000 })) },
	{ title: "RevokeResourceShareBody" },
);

export const AccessRequestStatus = Type.Union(
	[Type.Literal("pending"), Type.Literal("granted"), Type.Literal("rejected"), Type.Literal("withdrawn")],
	{ title: "AccessRequestStatus" },
);

export const AccessRequestDecision = Type.Object(
	{
		decidedBy: Actor,
		decidedAt: Timestamp,
		note: Type.Optional(Type.String()),
		shareId: Type.Optional(Type.String({ description: "The share a grant created." })),
	},
	{ title: "AccessRequestDecision" },
);

export const AccessRequest = Type.Object(
	{
		id: id("The request's ID."),
		organisationId: id("The organisation."),
		resource: ResourceSelector,
		owner: OwnerRef,
		grantee: ShareGrantee,
		permission: SharePermission,
		reason: Type.String(),
		requestedBy: Actor,
		sessionId: Type.Optional(Type.String({ description: "The session the request came from." })),
		agentId: Type.Optional(Type.String()),
		status: AccessRequestStatus,
		createdAt: Timestamp,
		expiresAt: Type.Optional(Timestamp),
		decision: Type.Optional(AccessRequestDecision),
	},
	{ title: "AccessRequest" },
);

export const AccessRequestPage = Type.Object(
	{ items: Type.Array(AccessRequest), nextCursor },
	{ title: "AccessRequestPage" },
);

export const RequestAccessBody = Type.Object(
	{
		resource: ResourceSelector,
		grantee: Type.Optional(ShareGrantee),
		permission: Type.Optional(SharePermission),
		reason: Type.String({ minLength: 1, maxLength: 2000 }),
		expiresAt: Type.Optional(Timestamp),
		sessionId: Type.Optional(Type.String({ description: "The session the request is for." })),
	},
	{ title: "RequestAccessBody" },
);

export const ListAccessRequestsQuery = Type.Object(
	{
		...resourceQuery,
		...granteeQuery,
		status: Type.Optional(AccessRequestStatus),
		ownerProjectId: Type.Optional(Type.String({ description: "Requests for resources this project owns." })),
		decidable: Type.Optional(Type.Boolean({ description: "Only those the caller may decide: its inbox." })),
		sessionId: Type.Optional(Type.String()),
		limit,
		cursor,
	},
	{ title: "ListAccessRequestsQuery" },
);

export const AccessRequestPath = Type.Object({ requestId: id("The request's ID.") });

export const DecideAccessRequestBody = Type.Object(
	{
		decision: Type.Union([Type.Literal("grant"), Type.Literal("reject")]),
		note: Type.Optional(Type.String({ maxLength: 1000 })),
		permission: Type.Optional(SharePermission),
		agentWrites: Type.Optional(
			Type.Boolean({
				description:
					"Let agents write through the share the grant makes (default false). Only when it grants `edit` or `approve`.",
			}),
		),
		expiresAt: Type.Optional(Timestamp),
		revision,
	},
	{
		title: "DecideAccessRequestBody",
		description:
			"A grant may narrow what was asked (a weaker permission, an earlier expiry, a pinned revision), never widen it.",
	},
);

export const AccessRequestDecided = Type.Object(
	{ request: AccessRequest, share: Type.Optional(ResourceShare) },
	{ title: "AccessRequestDecided" },
);

export const BindingRelation = Type.Union(
	[Type.Literal("maintainer"), Type.Literal("approver"), Type.Literal("member")],
	{ title: "BindingRelation" },
);

export const BindingSubject = Type.Union(
	[
		Type.Object({ kind: Type.Literal("user"), userId: Type.String() }),
		Type.Object({ kind: Type.Literal("service"), serviceId: Type.String() }),
		Type.Object({ kind: Type.Literal("group"), groupId: Type.String() }),
	],
	{ title: "BindingSubject" },
);

export const BindingObject = Type.Union(
	[ResourceRef, Type.Object({ kind: Type.Literal("group"), id: Type.String() })],
	{ title: "BindingObject", description: "A resource, or a group (for `member`)." },
);

export const BindingBody = Type.Object(
	{ object: BindingObject, relation: BindingRelation, subject: BindingSubject },
	{ title: "BindingBody", description: "A relation tuple: `subject` has `relation` on `object`." },
);

export const ResourceBinding = Type.Object(
	{
		organisationId: id("The organisation."),
		object: BindingObject,
		relation: BindingRelation,
		subject: BindingSubject,
		grantedBy: Actor,
		grantedAt: Timestamp,
	},
	{ title: "ResourceBinding" },
);

export const ResourceBindingPage = Type.Object(
	{ items: Type.Array(ResourceBinding), nextCursor },
	{ title: "ResourceBindingPage" },
);

export const ListBindingsQuery = Type.Object(
	{
		objectKind: Type.Optional(Type.String({ description: "A resource kind, or `group`." })),
		objectId: Type.Optional(Type.String({ description: "With `objectKind`." })),
		subjectKind: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("service"), Type.Literal("group")])),
		subjectId: Type.Optional(Type.String({ description: "With `subjectKind`." })),
		relation: Type.Optional(BindingRelation),
		limit,
		cursor,
	},
	{ title: "ListBindingsQuery" },
);

export const ResourcePolicy = Type.Object(
	{ twoPersonRule: Type.Boolean({ description: "Whoever publishes an edit may not be one of its authors." }) },
	{ title: "ResourcePolicy" },
);

export const ResourceQuery = Type.Object(
	{ kind: resourceKind, id: id("The resource's ID.") },
	{ title: "ResourceQuery" },
);

export const SetResourcePolicyBody = Type.Object(
	{ resource: ResourceRef, policy: ResourcePolicy },
	{ title: "SetResourcePolicyBody" },
);

export const RegisterResourceBody = Type.Object(
	{ resource: ResourceRef, owner: OwnerRef, name: Type.Optional(Type.String({ maxLength: 200 })) },
	{ title: "RegisterResourceBody", description: "A host's own resource and its owner. Kantel's kinds are refused." },
);

export const RegisteredResource = Type.Object(
	{
		organisationId: id("The organisation."),
		resource: ResourceRef,
		owner: OwnerRef,
		name: Type.Optional(Type.String()),
		registeredBy: Actor,
		registeredAt: Timestamp,
	},
	{ title: "RegisteredResource" },
);

export const ShareUse = Type.Object(
	{
		organisationId: id("The organisation."),
		sessionId: id("The session."),
		resource: ResourceSelector,
		shareId: id("The share it was used through."),
		usedAt: Timestamp,
	},
	{ title: "ShareUse", description: "A resource a session used through a share: which revision, under which share." },
);

export const ShareUseList = Type.Object({ items: Type.Array(ShareUse) }, { title: "ShareUseList" });

export const ListShareUsesQuery = Type.Object({ sessionId: id("The session.") }, { title: "ListShareUsesQuery" });

// Prompt rules: prompt layers owned by the platform, the organisation, a project
// or a user, layered around a session's profile when it starts.

export const PromptRule = Type.Object(
	{
		id: id("The rule's ID."),
		owner: OwnerRef,
		name: Type.String({ description: "Unique among its owner's rules." }),
		text: Type.String({ description: "The prompt text." }),
		order: Type.Integer({ description: "Its place among its owner's rules, lowest first; ties go by name." }),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "PromptRule" },
);

export const PromptRuleList = Type.Object(
	{ items: Type.Array(PromptRule, { description: "In layer order: platform, organisation, project, user." }) },
	{ title: "PromptRuleList" },
);

export const PutPromptRuleBody = Type.Object(
	{
		owner: OwnerRef,
		name: Type.String({
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$",
			description: "1 to 100 letters, digits, `.`, `_` and `-`. A rule of this name replaces the owner's rule.",
		}),
		text: Type.String({ minLength: 1, maxLength: 32768 }),
		order: Type.Optional(Type.Integer({ minimum: -1000000, maximum: 1000000, description: "Default 0." })),
	},
	{ title: "PutPromptRuleBody" },
);

export const ListPromptRulesQuery = Type.Object(
	{
		owner: Type.Union(
			[Type.Literal("platform"), Type.Literal("organisation"), Type.Literal("project"), Type.Literal("user")],
			{ description: "Whose rules: the platform's, the organisation's, a project's or a user's." },
		),
		projectId: Type.Optional(Type.String({ minLength: 1, description: "The project, for `owner=project`." })),
		userId: Type.Optional(
			Type.String({ minLength: 1, description: "The user, for `owner=user`. Default the calling person." }),
		),
	},
	{ title: "ListPromptRulesQuery" },
);

export const ResolvedPromptRulesQuery = Type.Object(
	{
		projectId: Type.Optional(
			Type.String({ minLength: 1, description: "A project session's project. Absent: an organisation session." }),
		),
		userId: Type.Optional(
			Type.String({ minLength: 1, description: "The session's user. Default the calling person." }),
		),
	},
	{ title: "ResolvedPromptRulesQuery" },
);

export const PromptRulePath = Type.Object({ ruleId: id("The rule's ID.") });
