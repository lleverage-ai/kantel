// The scripted model both targets run: a deterministic stand-in for a real
// model, so the scenario's result depends only on the platform under test.
//
// Its next step is a pure function of the transcript (how many tool results
// follow the scenario prompt), so a session host that takes over a session
// mid-run produces the same next step the dead owner would have.
//
// The research-style task (plan §15):
//   1. fetch a page through the vault          bash (isolate tier, curl)
//   2. write notes/x.md                        write (host commit)
//   3. read it back in the isolate             bash (isolate tier)
//   4. run one git command in the container    bash (container tier, git)
//   5. read the container's write in the isolate
//   6. hand back

import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SCENARIO_PREFIX, type ScenarioSpec } from "../../../spike/contracts/index.ts";

export interface ScriptedStep {
	tool: "bash" | "write";
	args: Record<string, unknown>;
	/** The step the scenario kills the owner in. Its interrupted result is expected. */
	crash?: boolean;
}

export function scenarioSteps(spec: ScenarioSpec): ScriptedStep[] {
	if (spec.kind === "exec") return spec.steps;
	const steps: ScriptedStep[] = [
		{ tool: "bash", args: { command: `curl -sS -f ${spec.url} -o page.html && wc -c < page.html` } },
		{
			tool: "bash",
			args: { command: "grep -o '<h1>[^<]*</h1>' page.html | sed 's/<[^>]*>//g' > title.txt && cat title.txt" },
		},
		{
			tool: "write",
			args: {
				path: "notes/x.md",
				content: "# Research notes\n\nSource fetched through the vault. The page title is in title.txt.\n",
			},
		},
		{ tool: "bash", args: { command: "cat title.txt >> notes/x.md && cat notes/x.md" } },
	];
	if (spec.crash) {
		// A long container call, so the scenario can kill the owner while it runs.
		steps.push({
			tool: "bash",
			args: { command: "git --version && sleep 20 && echo finished > crash-marker.txt" },
			crash: true,
		});
	}
	steps.push(
		{
			tool: "bash",
			args: {
				command:
					"git init -q -b main . && git add -A && git -c user.name=harbour -c user.email=spike@harbour.invalid commit -q -m 'research notes' && git log --oneline | wc -l > git-commits.txt && git rev-parse HEAD",
			},
		},
		{ tool: "bash", args: { command: "cat git-commits.txt && ls .git/HEAD && cat notes/x.md | wc -l" } },
	);
	return steps;
}

const text = (message: { content: unknown }) =>
	typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? (message.content as { type?: string; text?: string }[])
					.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
					.join("")
			: "";

/**
 * A scenario file in the shared format (the Cloudflare spike's spikes/scenario/research-task.json):
 * seed files, a list of tool calls, and the final answer.
 */
export interface StepsScenario {
	name: string;
	seed?: Record<string, string>;
	steps: { label?: string; tool: string; args: Record<string, unknown> }[];
	finalAnswer: string;
}

const isInterrupted = (message: { role: string; isError?: boolean; content: unknown }) =>
	message.role === "toolResult" && message.isError === true && /interrupt/i.test(text(message));

/**
 * The shared scenario's model, as the Cloudflare spike defines it: the next step is the
 * number of completed tool results since the last user message. An
 * interrupted call does not count, so after a crash the script reissues the
 * call that was cut off (the "may have partially run" path, decided by the
 * script rather than by replay).
 */
export function stepsResponse(scenario: StepsScenario, context: TranscriptContext): AssistantMessage {
	const messages = context.messages;
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "user") {
			lastUser = i;
			break;
		}
	}
	const results = messages.slice(lastUser + 1).filter((m) => m.role === "toolResult");
	const completed = results.filter((m) => !isInterrupted(m)).length;
	const step = scenario.steps[completed];
	if (step === undefined) return fauxAssistantMessage(fauxText(scenario.finalAnswer));
	const retry = results.length - completed;
	return fauxAssistantMessage(
		fauxToolCall(step.tool, step.args as Parameters<typeof fauxToolCall>[1], { id: `step-${completed}-try-${retry}` }),
		{ stopReason: "toolUse" },
	);
}

/** The last user message starts the Kantel scenario (this repo's `ScenarioSpec`). */
export function isSpecPrompt(context: TranscriptContext): boolean {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i]!;
		if (message.role === "user") return text(message).startsWith(SCENARIO_PREFIX);
	}
	return false;
}

/** The faux response factory. Install it many times over: one call consumes one step. */
export function scriptedResponse(context: TranscriptContext): AssistantMessage {
	const messages = context.messages;
	let start = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "user" && text(message).startsWith(SCENARIO_PREFIX)) {
			start = i;
			break;
		}
	}
	if (start === -1) return fauxAssistantMessage("I only run the Kantel scenario.");
	const spec = JSON.parse(text(messages[start]!).slice(SCENARIO_PREFIX.length)) as ScenarioSpec;
	const results = messages.slice(start + 1).filter((m) => m.role === "toolResult");
	const steps = scenarioSteps(spec);
	const last = results.at(-1) as { isError?: boolean; content?: unknown } | undefined;
	// The "may have partially run" path: the crash step comes back interrupted,
	// not replayed (bash is replay-unsafe). The script carries on; a real model
	// would check what the step left behind. Any other failure ends the run.
	const crashStep = steps[results.length - 1]?.crash === true;
	const keepGoing = spec.kind === "exec" && spec.keepGoing === true;
	if (last?.isError && !crashStep && !keepGoing) {
		return fauxAssistantMessage(fauxText(`FAILED at step ${results.length}: ${text(last as never).slice(0, 2000)}`));
	}
	const next = steps[results.length];
	if (next === undefined) {
		const outputs = results.map((r) => text(r as never).trim());
		const errors = results.map((r) => (r as { isError?: boolean }).isError === true);
		return fauxAssistantMessage(fauxText(`DONE ${JSON.stringify({ steps: results.length, outputs, errors })}`));
	}
	return fauxAssistantMessage(
		fauxToolCall(next.tool, next.args as Parameters<typeof fauxToolCall>[1], { id: `step-${start}-${results.length}` }),
		{
			stopReason: "toolUse",
		},
	);
}
