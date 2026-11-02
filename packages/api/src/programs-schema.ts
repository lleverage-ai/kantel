/**
 * The programs API's wire shapes (docs/site/src/content/docs/api/programs.md): saved, versioned code mode programs that run through the API
 * with no model in the loop. Experimental: a deployment serves them only with `KANTEL_PROGRAMS=on`.
 */
import Type from "typebox";
import { Actor, JsonValue, Timestamp } from "./schema.ts";

const JsonSchemaObject = Type.Record(Type.String(), JsonValue, {
	description:
		"A JSON Schema object (draft 2020-12 keywords such as `type`, `properties`, `required`, `items`, `enum`).",
});

const versionFields = {
	code: Type.String({
		minLength: 1,
		maxLength: 200_000,
		description:
			"The program: the body of an async JavaScript function, run by code mode. `input` holds the run's input; " +
			"`await tools.<name>(args)` calls an allowed tool; the value it `return`s is the run's output.",
	}),
	description: Type.Optional(Type.String({ maxLength: 2000 })),
	inputSchema: Type.Optional(JsonSchemaObject),
	outputSchema: Type.Optional(JsonSchemaObject),
	tools: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			maxItems: 200,
			description:
				"The tools the program may call, as an agent profile names them: built-in tools (`read`, `bash`, …), a " +
				"connection's tools and `<server>/<tool>` or `<server>/*` for a tool server. Nothing else is callable. Default none.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 3_600_000,
			description: "The run's deadline, tool calls and approvals included. Default 300000 (5 minutes).",
		}),
	),
	maxOutputTokens: Type.Optional(
		Type.Integer({ minimum: 100, maximum: 100_000, description: "The output's budget. Default 10000." }),
	),
};

export const ProgramVersion = Type.Object(
	{
		programId: Type.String(),
		version: Type.Integer({ minimum: 1 }),
		code: Type.String(),
		description: Type.Optional(Type.String()),
		inputSchema: Type.Optional(JsonSchemaObject),
		outputSchema: Type.Optional(JsonSchemaObject),
		tools: Type.Array(Type.String()),
		timeoutMs: Type.Integer(),
		maxOutputTokens: Type.Integer(),
		createdAt: Timestamp,
		createdBy: Actor,
		sessionId: Type.Optional(Type.String({ description: "The session whose agent saved it, if an agent did." })),
	},
	{ title: "ProgramVersion", description: "One saved version of a program. Versions are immutable." },
);

export const Program = Type.Object(
	{
		id: Type.String(),
		organisationId: Type.String(),
		projectId: Type.String(),
		name: Type.String(),
		description: Type.Optional(Type.String()),
		latestVersion: Type.Optional(
			Type.Integer({ description: "The newest version not deleted; runs use it by default." }),
		),
		versions: Type.Array(Type.Integer(), { description: "The versions not deleted, oldest first." }),
		createdAt: Timestamp,
		updatedAt: Timestamp,
		createdBy: Actor,
	},
	{ title: "Program", description: "A named program in a project, and its versions." },
);

export const ProgramList = Type.Object({ items: Type.Array(Program) }, { title: "ProgramList" });
export const ProgramVersionList = Type.Object({ items: Type.Array(ProgramVersion) }, { title: "ProgramVersionList" });

export const ProgramRunStatus = Type.Union(
	[
		Type.Literal("running"),
		Type.Literal("waiting"),
		Type.Literal("succeeded"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	],
	{
		title: "ProgramRunStatus",
		description:
			"`waiting`: waits on `waitingOn`. Paused on an input or agent step (`KANTEL_PROGRAM_WAITS`), with nothing " +
			"running until a value resumes it, or held on a person's approval of a tool call its script made.",
	},
);

const SchemaObject = Type.Record(Type.String(), JsonValue, {
	description: "The JSON Schema the value must match.",
});

const approvalFields = {
	kind: Type.Literal("approval"),
	sessionId: Type.String({ description: "The run's session, which holds the call." }),
	callId: Type.String({
		description: "The held tool call in the run's session: the script's inner call, `<scriptCallId>/<key>`.",
	}),
	since: Timestamp,
};

export const ProgramRunWait = Type.Union(
	[
		Type.Object(
			{
				kind: Type.Literal("input"),
				id: Type.String({ description: "The wait's ID, which `resume` names as `waitId`." }),
				key: Type.Optional(Type.String()),
				prompt: Type.String(),
				schema: Type.Optional(SchemaObject),
				since: Timestamp,
			},
			{ description: "`waitForInput()`: a person supplies the value (`POST …/resume`)." },
		),
		Type.Object(
			{
				kind: Type.Literal("agent"),
				id: Type.String(),
				key: Type.Optional(Type.String()),
				prompt: Type.String(),
				schema: Type.Optional(SchemaObject),
				agentId: Type.String(),
				sessionId: Type.Optional(Type.String({ description: "The agent's session, once started." })),
				since: Timestamp,
			},
			{ description: "`agent()`: the agent session's answer resumes the run." },
		),
		Type.Object(
			{
				...approvalFields,
				connection: Type.Object({
					requestId: Type.String({ description: "The connection request, as its approval card names it." }),
					what: Type.String(),
					host: Type.String(),
					link: Type.String({ description: "The page where a person decides it." }),
					expiresAt: Timestamp,
				}),
			},
			{ description: "A connection request a rule asked a person about." },
		),
		Type.Object(
			{
				...approvalFields,
				browser: Type.Object({ reason: Type.String(), sites: Type.Array(Type.String()) }),
			},
			{
				description:
					"A `browser_request`: a person allows or declines it from the session, or with `POST /browser/decisions` " +
					"`{ sessionId, callId, allow }`.",
			},
		),
	],
	{
		title: "ProgramRunWait",
		description: "One thing a run waits on, by `kind`; more kinds may come, and a client skips one it doesn't know.",
	},
);

export const ProgramRun = Type.Object(
	{
		id: Type.String(),
		programId: Type.String(),
		version: Type.Integer(),
		projectId: Type.String(),
		status: ProgramRunStatus,
		waiting: Type.Optional(
			Type.Literal("approval", {
				description: "A running program waits for a person to allow a tool call. Also in `waitingOn`.",
			}),
		),
		waitingOn: Type.Optional(
			Type.Array(ProgramRunWait, { description: "While the status is `waiting`: what the run waits on." }),
		),
		activation: Type.Optional(
			Type.Integer({ description: "Which run of the script this is: one more each time a paused run resumes." }),
		),
		input: JsonValue,
		output: Type.Optional(JsonValue),
		logs: Type.Optional(Type.Array(Type.String(), { description: "The program's `console` lines." })),
		error: Type.Optional(Type.String()),
		sessionId: Type.String({
			description: "The run's session: its transcript, tool calls, approvals and audit trail, as for any session.",
		}),
		startedAt: Timestamp,
		endedAt: Type.Optional(Timestamp),
		startedBy: Actor,
	},
	{ title: "ProgramRun", description: "One run of a program version." },
);

export const ProgramRunList = Type.Object({ items: Type.Array(ProgramRun) }, { title: "ProgramRunList" });

export const ListProgramsQuery = Type.Object(
	{ projectId: Type.Optional(Type.String({ description: "Only this project's programs." })) },
	{ title: "ListProgramsQuery" },
);

export const CreateProgramBody = Type.Object(
	{
		projectId: Type.String(),
		name: Type.String({ minLength: 1, maxLength: 120, description: "Unique in the project." }),
		...versionFields,
	},
	{ title: "CreateProgramBody", description: "A new program and its first version." },
);

export const CreateProgramVersionBody = Type.Object(versionFields, {
	title: "CreateProgramVersionBody",
	description: "The program's next version.",
});

export const ProgramPath = Type.Object({ programId: Type.String() });
export const ProgramVersionPath = Type.Object({
	programId: Type.String(),
	version: Type.String({ pattern: "^[0-9]+$" }),
});
export const ProgramRunPath = Type.Object({ programId: Type.String(), runId: Type.String() });

export const ResumeProgramRunBody = Type.Object(
	{
		waitId: Type.Optional(Type.String({ description: "The wait to resolve; optional when the run waits on one." })),
		value: Type.Optional(JsonValue),
		error: Type.Optional(
			Type.String({ maxLength: 4000, description: "Resolve the step with this error instead: its `await` throws." }),
		),
		waitMs: Type.Optional(
			Type.Integer({ minimum: 0, maximum: 30_000, description: "How long to wait for the resumed run. Default 0." }),
		),
	},
	{ title: "ResumeProgramRunBody", description: "The value a waiting `waitForInput()` returns." },
);

export const ProgramRunStep = Type.Object(
	{
		tool: Type.String(),
		kind: Type.Union([Type.Literal("call"), Type.Literal("input"), Type.Literal("agent")]),
		occurrence: Type.Integer({ description: "How many calls of the same tool and arguments came before it." }),
		status: Type.Union([Type.Literal("done"), Type.Literal("waiting"), Type.Literal("resolved")]),
		args: Type.String({ description: "The arguments, cut short." }),
		firstActivation: Type.Integer(),
		lastActivation: Type.Integer(),
		replays: Type.Integer({
			description: "How many later activations took it from the journal instead of running it again.",
		}),
		kept: Type.Boolean({ description: "Whether its result is kept; a call whose result wasn't runs again." }),
		isError: Type.Optional(Type.Boolean()),
		executedAt: Timestamp,
		durationMs: Type.Optional(Type.Integer()),
		waitId: Type.Optional(Type.String()),
	},
	{ title: "ProgramRunStep", description: "One step of a run's journal." },
);

export const ProgramRunStepList = Type.Object({ items: Type.Array(ProgramRunStep) }, { title: "ProgramRunStepList" });

export const RunProgramBody = Type.Object(
	{
		input: Type.Optional(JsonValue),
		version: Type.Optional(Type.Integer({ minimum: 1, description: "Default the latest version." })),
		mode: Type.Optional(
			Type.Union([Type.Literal("sync"), Type.Literal("async")], {
				description:
					"`sync` (default) answers when the run ends, or with 202 and the running run after `waitMs`; `async` " +
					"answers 202 at once. Either way, poll `GET /programs/{programId}/runs/{runId}`.",
			}),
		),
		waitMs: Type.Optional(
			Type.Integer({ minimum: 0, maximum: 60_000, description: "How long a sync call waits. Default 30000." }),
		),
	},
	{ title: "RunProgramBody" },
);
