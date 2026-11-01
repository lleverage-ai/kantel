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
	[Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")],
	{ title: "ProgramRunStatus" },
);

export const ProgramRun = Type.Object(
	{
		id: Type.String(),
		programId: Type.String(),
		version: Type.Integer(),
		projectId: Type.String(),
		status: ProgramRunStatus,
		waiting: Type.Optional(
			Type.Literal("approval", { description: "A running program waits for a person to allow a tool call." }),
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
