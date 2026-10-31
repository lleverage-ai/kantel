#!/usr/bin/env bun
/**
 * Runs the spike scenario against any target that serves the spike HTTP surface: Cloudflare (spikes/cloudflare) and
 * the self-hosted stack.
 *
 *   HARBOUR_SPIKE_TOKEN=... HARBOUR_CANARY=... bun spikes/scenario/run.ts \
 *     --base-url https://harbour-m0-cf1.<subdomain>.workers.dev [--kill-after-exec 2] [--fixture out.json]
 *
 * Exit code 0 when every check passes. Prints one JSON report on stdout, and a short verdict on stderr that names
 * every failed check with its detail, so a run whose stdout is redirected (CI) still says what failed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

type Expect = {
	tier?: "isolate" | "container";
	exitCode?: number;
	stdoutIncludes?: string[];
	canaryAbsent?: boolean;
};
type Step = { label: string; tool: string; args: Record<string, unknown>; expect: Expect };
type ScenarioFile = { name: string; seed: Record<string, string>; steps: Step[]; finalAnswer: string };
type ToolResult = { toolCallId: string; toolName: string; isError: boolean; text: string };
type ExecRecord = {
	command: string;
	tier: string;
	exitCode: number;
	base: string;
	version: string;
	timings: Record<string, number>;
};
type State = {
	submission?: { id: string; status: string; reason?: string };
	toolResults: ToolResult[];
	answer?: string;
	workspace: { id: string; head: string };
	execs: ExecRecord[];
	events: { at: number; type: string; [key: string]: unknown }[];
};

const { values } = parseArgs({
	options: {
		"base-url": { type: "string" },
		scenario: { type: "string", default: new URL("./research-task.json", import.meta.url).pathname },
		"kill-after-exec": { type: "string" },
		fixture: { type: "string" },
		"session-id": { type: "string" },
		"timeout-s": { type: "string", default: "300" },
	},
});
const baseUrl = values["base-url"] ?? process.env.HARBOUR_BASE_URL;
const token = process.env.HARBOUR_SPIKE_TOKEN;
const canary = process.env.HARBOUR_CANARY;
if (baseUrl === undefined || token === undefined) {
	console.error("need --base-url (or HARBOUR_BASE_URL) and HARBOUR_SPIKE_TOKEN");
	process.exit(2);
}

const scenario = JSON.parse(await readFile(values.scenario as string, "utf8")) as ScenarioFile;
const sessionId = values["session-id"] ?? `${scenario.name}-${Date.now().toString(36)}`;
const killAfterExec = values["kill-after-exec"] === undefined ? undefined : Number(values["kill-after-exec"]);
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) =>
	checks.push({ name, ok, ...(ok || detail === undefined ? {} : { detail }) });

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${baseUrl}/sessions/${sessionId}/${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
	return JSON.parse(text) as T;
}

const started = Date.now();
await call("POST", "setup", { scenario });
if (killAfterExec !== undefined) await call("POST", "kill", { afterExec: killAfterExec });
const { submissionId } = await call<{ submissionId: string }>("POST", "prompt", {
	content: "Run the research task in brief.txt.",
	requestId: `${sessionId}-prompt`,
});

let state: State | undefined;
const deadline = Date.now() + Number(values["timeout-s"]) * 1000;
let pollErrors = 0;
while (Date.now() < deadline) {
	try {
		state = await call<State>("GET", `state?submission=${submissionId}`);
		const status = state.submission?.status;
		if (status === "done" || status === "unanswered") break;
	} catch (error) {
		// A killed object answers 500 until it has restarted; keep polling.
		pollErrors += 1;
		if (pollErrors > 30) throw error;
	}
	await new Promise((resolve) => setTimeout(resolve, 1000));
}
const elapsedMs = Date.now() - started;
if (state === undefined) throw new Error("no state");

// ---- checks ------------------------------------------------------------------------------------------------------
check("submission done", state.submission?.status === "done", state.submission);
check("final answer", state.answer === scenario.finalAnswer, state.answer);

const interrupted = state.toolResults.filter((r) => r.isError && /interrupt/i.test(r.text));
const completed = state.toolResults.filter((r) => !(r.isError && /interrupt/i.test(r.text)));
check("one tool result per step", completed.length === scenario.steps.length, {
	completed: completed.length,
	steps: scenario.steps.length,
});

for (const [index, step] of scenario.steps.entries()) {
	const result = completed[index];
	const name = `step ${index + 1} ${step.label}`;
	if (result === undefined) {
		check(name, false, "no result");
		continue;
	}
	const problems: string[] = [];
	if (result.toolName !== step.tool) problems.push(`tool ${result.toolName}`);
	for (const needle of step.expect.stdoutIncludes ?? [])
		if (!result.text.includes(needle)) problems.push(`missing ${JSON.stringify(needle)}`);
	if (step.expect.exitCode === 0 && result.isError) problems.push("error result");
	if (step.expect.tier !== undefined) {
		const command = String(step.args.command);
		const exec = state.execs.filter((e) => e.command === command).at(-1);
		if (exec?.tier !== step.expect.tier) problems.push(`tier ${exec?.tier}`);
	}
	if (step.expect.canaryAbsent && canary !== undefined && result.text.includes(canary))
		problems.push("canary in tool result");
	check(name, problems.length === 0, { problems, text: result.text.slice(0, 400) });
}

const tiers = new Set(state.execs.map((e) => e.tier));
check("both tiers ran", tiers.has("isolate") && tiers.has("container"), [...tiers]);

let fixture: unknown;
try {
	fixture = await call("GET", "fixture");
} catch (error) {
	check("fixture", false, String(error));
}
if (canary !== undefined) {
	const transcript = JSON.stringify({ toolResults: state.toolResults, answer: state.answer, fixture });
	check("canary absent from transcript, fixture and exec log", !transcript.includes(canary));
} else {
	check("canary check skipped (HARBOUR_CANARY not set)", true);
}
const vault =
	(await call<{ decision: string; tier: string; injected?: unknown; redactions?: number }[]>("GET", "vault")) ?? [];
const vaultDetail = vault.map(({ tier, decision, redactions }) => ({ tier, decision, redactions }));
check(
	"vault allowed and injected for both tiers",
	["isolate", "container"].every((t) =>
		vault.some((u) => u.tier === t && u.decision === "allowed" && u.injected !== undefined),
	),
	vaultDetail,
);
check(
	"vault denied for both tiers",
	["isolate", "container"].every((t) => vault.some((u) => u.tier === t && u.decision === "denied")),
	vaultDetail,
);
check(
	"vault redacted echoed canary for both tiers",
	["isolate", "container"].every((t) => vault.some((u) => u.tier === t && (u.redactions ?? 0) > 0)),
	vaultDetail,
);

if (killAfterExec !== undefined) {
	const kill = state.events.find((e) => e.type === "kill");
	const reopen = state.events.filter((e) => e.type === "reopen");
	check("object was killed mid tool call", kill !== undefined, state.events);
	check(
		"object reopened after the kill",
		reopen.some((e) => kill !== undefined && e.at >= kill.at),
		state.events,
	);
	check("killed call came back as interrupted", interrupted.length === 1, interrupted);
}

if (values.fixture !== undefined && fixture !== undefined)
	await writeFile(values.fixture, `${JSON.stringify(fixture, null, 2)}\n`);

const ok = checks.every((c) => c.ok);
console.log(
	JSON.stringify(
		{
			ok,
			sessionId,
			elapsedMs,
			killAfterExec,
			workspace: state.workspace,
			interrupted: interrupted.map((r) => ({ tool: r.toolName, text: r.text.slice(0, 300) })),
			execs: state.execs.map((e) => ({
				tier: e.tier,
				exitCode: e.exitCode,
				base: e.base,
				version: e.version,
				command: e.command.slice(0, 60),
				timings: e.timings,
			})),
			events: state.events,
			checks,
		},
		null,
		2,
	),
);
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.error(`FAIL ${c.name}: ${JSON.stringify(c.detail ?? null).slice(0, 2000)}`);
console.error(
	`${ok ? "PASS" : "FAIL"}: ${checks.length - failed.length}/${checks.length} checks, ${elapsedMs} ms (session ${sessionId}${killAfterExec === undefined ? "" : `, kill after exec ${killAfterExec}`})`,
);
process.exit(ok ? 0 : 1);
