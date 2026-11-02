/**
 * The program runner: the "model" of a program run's session, which is no model at all. It reads the run's prompt
 * (`programRunPrompt`), calls `codemode` with the program, and answers with what the program returned as JSON
 * (`ProgramOutcome`). Everything between is the session's own: code mode's durable journal and replay, the program's
 * tool calls through the session's rules, approvals and audit, its transcript, and stopping it. No tokens are spent and
 * no model gateway is called.
 */
import type { Message } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import {
	createFauxCore,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { KantelError, type ModelChoice, type SessionRecord } from "@kantel/contracts";
import type { ResolvedModel } from "@kantel/runtime";
import type { StackModels } from "../models.ts";

/** The provider and model a program profile's model route resolves to. */
export const PROGRAM_PROVIDER = "kantel-program";
export const PROGRAM_MODEL_ID = "runner";
/** The model route program profiles name (`ModelChoice.route`). */
export const PROGRAM_MODEL_ROUTE = "kantel-program";

const RUN_OPEN = "<kantel-program-run>";
const RUN_CLOSE = "</kantel-program-run>";
const OUTPUT_OPEN = "<kantel-program-output>";
const OUTPUT_CLOSE = "</kantel-program-output>";

/** What the runner is told to run: the run's prompt carries it as JSON. */
export interface ProgramRunRequest {
	readonly runId: string;
	readonly programId: string;
	readonly name: string;
	readonly version: number;
	readonly code: string;
	readonly input: unknown;
	readonly timeoutMs: number;
	readonly maxOutputTokens: number;
	/** With `KANTEL_PROGRAM_WAITS`: which run of the script this is, 1 at first, one more after each pause. */
	readonly activation?: number;
	/** With `KANTEL_PROGRAM_WAITS`: the script gets `waitForInput()` and `agent()`. */
	readonly waits?: boolean;
}

/** The tools behind `waitForInput()` and `agent()`, which only a program's code mode calls (`./journal.ts`). */
export const PROGRAM_INPUT_TOOL = "program_input";
export const PROGRAM_AGENT_TOOL = "program_agent";

/**
 * What a program with waits gets before its own code: `waitForInput()` and `agent()`, and a `Math.random` seeded by the
 * run, so each activation of the script draws the same numbers and makes the same calls.
 */
function waitsPrelude(runId: string): string[] {
	let seed = 2166136261;
	for (const char of runId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
	return [
		`const waitForInput = (request = {}) => tools.${PROGRAM_INPUT_TOOL}(typeof request === "string" ? { prompt: request } : request);`,
		`const agent = (prompt, options = {}) => tools.${PROGRAM_AGENT_TOOL}({ ...options, prompt });`,
		`Math.random = (() => { let s = ${seed}; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`,
	];
}

/** What the runner answers: the session's final answer, as JSON. */
export interface ProgramOutcome {
	readonly ok: boolean;
	readonly output?: unknown;
	readonly logs?: readonly string[];
	readonly error?: string;
}

/** The run's prompt: a line a person reading the transcript understands, and the request. */
export function programRunPrompt(request: ProgramRunRequest): string {
	const what =
		(request.activation ?? 1) > 1
			? `Resume program ${request.name} v${request.version} (run ${request.runId}, activation ${request.activation}): finished calls come from its journal`
			: `Run program ${request.name} v${request.version} (run ${request.runId})`;
	return `${what}, with no model.\n${RUN_OPEN}\n${JSON.stringify(request)}\n${RUN_CLOSE}`;
}

export function parseProgramRunPrompt(text: string): ProgramRunRequest | undefined {
	const start = text.indexOf(RUN_OPEN);
	const end = text.lastIndexOf(RUN_CLOSE);
	if (start < 0 || end < start) return undefined;
	try {
		const parsed = JSON.parse(text.slice(start + RUN_OPEN.length, end)) as ProgramRunRequest;
		return typeof parsed.code === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The script code mode runs: the options line with the run's budget, `input`, then the program as the body of an async
 * function, whose value comes back between markers so the runner can find it among the program's other output.
 */
export function programScript(request: ProgramRunRequest): string {
	const options = JSON.stringify({ timeout_ms: request.timeoutMs, max_output_tokens: request.maxOutputTokens });
	return [
		`// @options: ${options}`,
		`const input = ${JSON.stringify(request.input ?? null)};`,
		...(request.waits === true ? waitsPrelude(request.runId) : []),
		"const __kantelProgram = async () => {",
		request.code,
		"};",
		"const __kantelOutput = await __kantelProgram();",
		`return ${JSON.stringify(OUTPUT_OPEN)} + JSON.stringify(__kantelOutput === undefined ? null : __kantelOutput) + ${JSON.stringify(OUTPUT_CLOSE)};`,
	].join("\n");
}

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((block: { type?: string }) => block.type === "text")
					.map((block: { text?: string }) => block.text ?? "")
					.join("\n")
			: "";

/** The program's `console` lines, from code mode's `<console_output>` block. */
function logsOf(text: string): string[] {
	const found = /<console_output>\n([\s\S]*?)\n<\/console_output>/.exec(text);
	return found?.[1] === undefined ? [] : found[1].split("\n");
}

/** What the program's code mode result says: its output, or why it has none. */
export function programOutcome(resultText: string, isError: boolean): ProgramOutcome {
	const logs = logsOf(resultText);
	const withLogs = logs.length > 0 ? { logs } : {};
	if (isError) return { ok: false, error: resultText.trim() || "The program failed", ...withLogs };
	const start = resultText.indexOf(OUTPUT_OPEN);
	const end = resultText.lastIndexOf(OUTPUT_CLOSE);
	if (start < 0 || end < start) {
		return {
			ok: false,
			error: "The program's output was cut off: it is larger than the version's maxOutputTokens",
			...withLogs,
		};
	}
	try {
		return { ok: true, output: JSON.parse(resultText.slice(start + OUTPUT_OPEN.length, end)), ...withLogs };
	} catch {
		return { ok: false, error: "The program's output is not JSON", ...withLogs };
	}
}

export function parseProgramOutcome(answer: string | undefined): ProgramOutcome {
	if (answer === undefined) return { ok: false, error: "The run ended without an answer" };
	try {
		const parsed = JSON.parse(answer) as ProgramOutcome;
		if (typeof parsed === "object" && parsed !== null && typeof parsed.ok === "boolean") return parsed;
	} catch {
		// Below.
	}
	return { ok: false, error: `The run answered something other than a program outcome: ${answer.slice(0, 200)}` };
}

/** The runner's next step, from the conversation since the last user message. */
export function programRunnerStep(messages: readonly Message[]) {
	let start = messages.length - 1;
	while (start >= 0 && messages[start]?.role !== "user") start -= 1;
	const prompt = start < 0 ? "" : textOf((messages[start] as { content: unknown }).content);
	const request = parseProgramRunPrompt(prompt);
	if (request === undefined) {
		const refused: ProgramOutcome = { ok: false, error: "This session runs programs only; it has no model to talk to" };
		return fauxAssistantMessage(fauxText(JSON.stringify(refused)));
	}
	const answered = messages.slice(start + 1).find((message) => message.role === "toolResult");
	if (answered === undefined) {
		return fauxAssistantMessage([fauxToolCall("codemode", { code: programScript(request) })], {
			stopReason: "toolUse",
		});
	}
	const outcome = programOutcome(textOf(answered.content), answered.isError === true);
	return fauxAssistantMessage(fauxText(JSON.stringify(outcome)));
}

/** The runner's provider, on a `Models` of its own or added to another. */
export function programRunnerProvider() {
	const core = createFauxCore({ provider: PROGRAM_PROVIDER, models: [{ id: PROGRAM_MODEL_ID }] });
	const factory: FauxResponseFactory = (context) => programRunnerStep(context.messages);
	return createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Program runner", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: {
			stream: (model, context, options) => {
				core.appendResponses([factory]);
				return core.stream(model, context, options);
			},
			streamSimple: (model, context, options) => {
				core.appendResponses([factory]);
				return core.streamSimple(model, context, options);
			},
		},
	});
}

export function createProgramRunnerModels(): MutableModels {
	const models = createModels();
	models.setProvider(programRunnerProvider());
	return models;
}

/** The prefix of a program version's profile ID (`programProfileId` in ./service.ts). */
export const PROGRAM_PROFILE_PREFIX = "program-";

/**
 * `given` with the program runner: a program's session (its profile is a program version's) gets only the runner, and
 * its model route resolves to it; every other session is untouched.
 */
export function withProgramRunner(given: StackModels): StackModels {
	const runner = createProgramRunnerModels();
	const base = given.models;
	const fallback = (choice: ModelChoice): ResolvedModel => {
		if (given.resolveModel !== undefined) return given.resolveModel(choice);
		if (typeof base === "function") throw new KantelError("invalid", "Per-session models need resolveModel");
		const provider = base.getProviders()[0];
		const model = provider === undefined ? undefined : base.getModels(provider.id)[0];
		if (provider === undefined || model === undefined) throw new KantelError("unavailable", "No model is configured");
		return { provider: provider.id, modelId: model.id };
	};
	return {
		...given,
		models: (session: SessionRecord) =>
			session.agentId.startsWith(PROGRAM_PROFILE_PREFIX) ? runner : typeof base === "function" ? base(session) : base,
		resolveModel: (choice) =>
			choice.route === PROGRAM_MODEL_ROUTE
				? { provider: PROGRAM_PROVIDER, modelId: PROGRAM_MODEL_ID }
				: fallback(choice),
	};
}
