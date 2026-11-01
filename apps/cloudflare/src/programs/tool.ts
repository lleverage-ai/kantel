/**
 * `save_program`: how an agent turns a script it has tried with `codemode` into a saved program that runs through the
 * API with no model (`./service.ts`). It saves as the session's agent, in the session's project, so it needs what any
 * agent's change there needs; the version records the session it came from.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CallContext, JsonValue, SessionRecord } from "@kantel/contracts";
import type { ProgramsService } from "./service.ts";

export const SAVE_PROGRAM_TOOL = "save_program";

const schemaObject = Type.Optional(
	Type.Record(Type.String(), Type.Unknown(), {
		description: 'A JSON Schema object, such as {"type":"object","properties":{...},"required":[...]}.',
	}),
);

const saveProgramSchema = Type.Object({
	name: Type.String({
		description: "The program's name, unique in the project. Saving under a name again adds a version.",
	}),
	code: Type.String({
		description:
			"The program, as you would pass it to `codemode`: the body of an async function. It reads its input as `input`, " +
			"calls tools with `await tools.<name>(args)` and `return`s its output, a JSON value. No `// @options` line: the " +
			"version's timeout and output budget apply.",
	}),
	description: Type.Optional(Type.String({ description: "What the program does, for whoever runs it." })),
	input_schema: schemaObject,
	output_schema: schemaObject,
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"The tools the program may call (`read`, `bash`, a connection's tools, `<server>/<tool>`); it can call no " +
				"others. Default none.",
		}),
	),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3_600_000, description: "Default 300000." })),
});

export function sessionSaveProgramTool(
	programs: () => ProgramsService,
	record: SessionRecord,
	apiBase: string,
): ToolRegistration<typeof saveProgramSchema> {
	const ctx: CallContext = {
		actor: { kind: "agent", agentId: record.agentId, sessionId: record.id },
		organisationId: record.organisationId,
		...(record.projectId === undefined ? {} : { projectId: record.projectId }),
	};
	return defineTool({
		name: SAVE_PROGRAM_TOOL,
		description:
			"Save a code mode script as a program: a named, versioned script people and systems run through Kantel's API " +
			"(POST /v1/programs/{id}/runs) with no model, each run a session of its own with only the tools you list. Try " +
			"the script with `codemode` first (set `const input = ...` at its top to stand in for the run's input). Answers " +
			"with the program's ID and version.",
		parameters: saveProgramSchema,
		replay: "unsafe",
		async execute(args) {
			if (record.projectId === undefined) {
				return {
					output: [{ type: "text", text: "Programs belong to a project; this session works in none." }],
					isError: true,
				};
			}
			const { program, version } = await programs().save(ctx, {
				projectId: record.projectId,
				name: args.name,
				code: args.code,
				sessionId: record.id,
				...(args.description === undefined ? {} : { description: args.description }),
				...(args.input_schema === undefined ? {} : { inputSchema: args.input_schema as { [key: string]: JsonValue } }),
				...(args.output_schema === undefined
					? {}
					: { outputSchema: args.output_schema as { [key: string]: JsonValue } }),
				...(args.tools === undefined ? {} : { tools: args.tools }),
				...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
			});
			const text =
				`Saved program ${program.name} (${program.id}) version ${version.version}, with tools: ` +
				`${version.tools.length === 0 ? "none" : version.tools.join(", ")}. Run it with ` +
				`POST ${apiBase}/programs/${program.id}/runs and a body such as {"input": ...}.`;
			return {
				output: [{ type: "text", text }],
				details: { programId: program.id, version: version.version },
			};
		},
	});
}
