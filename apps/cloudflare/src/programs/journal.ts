/**
 * Durable pauses for programs (experimental, `KANTEL_PROGRAM_WAITS=on`): what a program run's code mode gets on top of
 * the session's.
 *
 * - **Two more tools in the script.** `waitForInput()` and `agent()` (the program's prelude, `./runner-model.ts`) call
 *   `program_input` and `program_agent`, which exist only inside a program's code mode: they are added to the agent the
 *   script sees, and their calls never reach the session's tools. A step that has its value returns it; one that has
 *   none pauses the run (`ProgramsService`): the run's session stops its turn, so nothing runs, holds an isolate or keeps
 *   the stack object awake while a person or an agent takes as long as they take.
 * - **A journal across activations.** Every other tool call the script makes goes through `ProgramSteps.step`, which
 *   keeps its result in the run's journal. A resumed run runs the script again from the top, as a new activation, and
 *   each call an earlier activation finished gets its kept result back instead of running again; the first call that
 *   isn't in the journal runs live. A call is matched by its tool, a digest of its arguments and how many such calls came
 *   before it, so a script that takes the same path makes the same calls. Within one activation code mode's own journal
 *   still resumes a script an eviction cut off (`src/codemode.ts`).
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@kantel/contracts";
import { PROGRAM_AGENT_TOOL, PROGRAM_INPUT_TOOL } from "./runner-model.ts";

/** What a nested call answers, as code mode reads it (Pi Durable's `NestedToolExecutionResult`). */
export type NestedResult = Awaited<ReturnType<ToolExecutionApi["executeTool"]>>;

const schemaObject = Type.Optional(
	Type.Record(Type.String(), Type.Unknown(), {
		description: 'A JSON Schema the value must match, such as {"type":"object","properties":{...}}.',
	}),
);

export const programInputParameters = Type.Object({
	prompt: Type.String({ description: "What the person is asked for." }),
	key: Type.Optional(Type.String({ description: "A name for the step, shown with the wait." })),
	schema: schemaObject,
});

export const programAgentParameters = Type.Object({
	prompt: Type.String({ description: "The agent's whole task: it sees nothing else." }),
	agentId: Type.Optional(Type.String({ description: "The agent profile. Default the project's default agent." })),
	title: Type.Optional(Type.String({ description: "The agent session's title." })),
	key: Type.Optional(Type.String({ description: "A name for the step, shown with the wait." })),
	schema: schemaObject,
});

/** The two tools as the script's agent lists them: declarations only, since their calls never reach the session. */
export const PROGRAM_WAIT_TOOLS = [
	{
		name: PROGRAM_INPUT_TOOL,
		description:
			"Pause the program until a person supplies a value (POST /v1/programs/{id}/runs/{runId}/resume), then resolve " +
			"with it. Call it as `await waitForInput({ prompt, schema? })`.",
		parameters: programInputParameters,
		structuredOutputSchema: Type.Unknown(),
	},
	{
		name: PROGRAM_AGENT_TOOL,
		description:
			"Pause the program while an agent session works on `prompt`, then resolve with its answer (parsed and checked " +
			"when `schema` is given). Call it as `await agent(prompt, { agentId?, schema? })`.",
		parameters: programAgentParameters,
		structuredOutputSchema: Type.Unknown(),
	},
] as const;

export const isWaitTool = (name: string): name is typeof PROGRAM_INPUT_TOOL | typeof PROGRAM_AGENT_TOOL =>
	name === PROGRAM_INPUT_TOOL || name === PROGRAM_AGENT_TOOL;

/** The journal's side of a run's code mode: `ProgramsService.steps`. */
export interface ProgramSteps {
	/** The run's current activation, or undefined when there is no such run (nothing is journalled then). */
	activation(runId: string): Promise<number | undefined>;
	/** One nested call of the script: from the journal, a wait, or `execute` and kept. */
	step(
		input: {
			readonly runId: string;
			readonly activation: number;
			readonly key: string;
			readonly name: string;
			readonly args: { readonly [key: string]: JsonValue };
			readonly signal?: AbortSignal;
		},
		execute: () => Promise<NestedResult>,
	): Promise<NestedResult>;
}

/** Canonical JSON: object keys sorted, so the same arguments in another order are the same call. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** The digest a step's arguments are matched by: SHA-256 of the canonical JSON, in hex. */
export async function fingerprintOf(args: unknown): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(args)));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A program run's code mode tool: the same tool, whose script also sees `program_input` and `program_agent`, and
 * whose every nested call goes through the run's journal.
 */
export function journaledCodemodeTool(tool: ToolRegistration, steps: ProgramSteps, runId: string): ToolRegistration {
	return {
		...tool,
		execute: async (args, api, context) => {
			const activation = await steps.activation(runId);
			if (activation === undefined) return tool.execute(args, api, context);
			let fallbackKey = 0;
			const journaled: ToolExecutionApi = {
				...api,
				agent: async (agentContext) => {
					const agent = await api.agent(agentContext);
					return {
						...agent,
						callable: [...agent.callable, ...(PROGRAM_WAIT_TOOLS as unknown as typeof agent.callable)],
					};
				},
				executeTool: (name, toolArgs, callContext, options) => {
					fallbackKey += 1;
					return steps.step(
						{
							runId,
							activation,
							key: options?.key ?? `n${fallbackKey}`,
							name,
							args: toolArgs as { readonly [key: string]: JsonValue },
							...(callContext.abortSignal === undefined ? {} : { signal: callContext.abortSignal }),
						},
						() => api.executeTool(name, toolArgs, callContext, options),
					);
				},
			};
			return tool.execute(args, journaled as never, context);
		},
	};
}
