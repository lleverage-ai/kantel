// Code mode off the stack (KANTEL_CODEMODE_OFFLOAD=on, TASK-4580): each script runs in an object of the sandbox Worker
// (src/codemode/worker.ts), here a Node worker thread standing in for it (test/codemode-thread.ts), while its tool calls
// still run on the stack, as the session's agent. A script that computes no longer holds the stack: another call
// answers while it does. The same script on the stack's own thread, as the Worker Loader's isolate runs it, holds that
// call until it stops computing.
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type {
	CodemodeRemoteExchange,
	CodemodeRemoteMessage,
	CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode/portable";
import { createFakeBrowserProvider } from "@kantel/browser/memory";
import type { CallContext } from "@kantel/contracts";
import { createMockAccess } from "@kantel/identity/testing";
import type { ProgramRunView } from "@kantel/programs/service";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeServer } from "../src/codemode/serve.ts";
import {
	CODEMODE_TOOL,
	type CodemodeLoaderLike,
	codemodeIsolateId,
	codemodeLoad,
	codemodeOffloaded,
	objectCodemode,
	workerLoaderCodemode,
} from "../src/codemode.ts";
import { gatewayConfig } from "../src/config.ts";
import { BROWSER_DECISIONS_PATH, createGateway } from "../src/gateway.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";
import { type ThreadSandboxes, threadSandboxes } from "./codemode-thread.ts";

const TEAM_DOMAIN = "kantel-test.cloudflareaccess.com";
const AUD = "aud-kantel-test";
const ADMIN = "tom@kantel.test";
const BASE = "https://kantel.test";

const opened: Stack[] = [];
const threads: ThreadSandboxes[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close().catch(() => undefined);
	for (const thread of threads.splice(0)) await thread.close();
});

/** Collatz chain lengths up to `end`: about a second of QuickJS arithmetic, well inside the interrupt budget. */
const collatz = (end: number) =>
	[
		"let best = 0, bestN = 0;",
		`for (let n = 1; n < ${end}; n++) {`,
		"  let x = n, k = 0;",
		"  while (x !== 1) { x = x % 2 === 0 ? x / 2 : 3 * x + 1; k++; }",
		"  if (k > best) { best = k; bestN = n; }",
		"}",
	].join("\n");
const HEAVY = 60_000;
/** Collatz up to 60,000: the longest chain starts at 52,527 and has 339 steps. */
const HEAVY_ANSWER = { best: 339, bestN: 52_527 };

/** The Worker Loader's path in Node: the isolate's server on the test's own thread, as the stack object's thread. */
function inThreadLoader(messages: CodemodeRemoteMessage[], arrived: number[]): CodemodeLoaderLike {
	const server = createCodemodeServer(loadQuickJSWasm());
	return {
		get: () => ({
			getEntrypoint: () => ({
				execute: (request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange) =>
					server.execute(structuredClone(request), async (sent) => {
						messages.push(...sent);
						arrived.push(...sent.map(() => performance.now()));
						return structuredClone(await exchange(structuredClone(sent)));
					}),
			}),
		}),
	};
}

async function setUp(options: { readonly offload: boolean; readonly browser?: boolean }) {
	const { models, script } = createScriptedModel();
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	let sandboxes: ThreadSandboxes | undefined;
	const messages: CodemodeRemoteMessage[] = [];
	const arrived: number[] = [];
	let names = 0;
	if (options.offload) {
		sandboxes = threadSandboxes();
		threads.push(sandboxes);
	}
	const load =
		sandboxes === undefined
			? workerLoaderCodemode(inThreadLoader(messages, arrived), "export class KantelCodemode {}", new ArrayBuffer(8))
			: objectCodemode(sandboxes, "weur", () => `script-${++names}`);
	const stack = await createStack({
		config: gatewayConfig({
			KANTEL_ADMIN_EMAIL: ADMIN,
			...(options.browser === true ? { KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, KANTEL_ACCESS_AUD: AUD } : {}),
		}),
		...(options.browser === true
			? { accessFetch: mock.fetch, browserProvider: createFakeBrowserProvider().provider }
			: {}),
		models: () => ({ models }),
		codemode: { load, bundleId: "b1" },
		programs: true,
		programWaits: true,
	});
	opened.push(stack);
	const admin: CallContext = stack.admin;
	const gateway = createGateway(stack);
	const service = await stack.identity.createServiceIdentity(admin, { name: "console" });
	const key = await stack.identity.issueApiKey(admin, {
		serviceId: service.id,
		projectIds: [stack.project.id],
		role: "operator",
	});
	/** `GET /v1/sessions`, as the console lists them, and how long it took to answer. */
	const listSessions = async () => {
		const started = performance.now();
		const response = await gateway.fetch(
			new Request(`${BASE}/v1/sessions?projectId=${stack.project.id}`, {
				headers: { authorization: `Bearer ${key.secret}` },
			}),
		);
		await response.text();
		return { status: response.status, ms: performance.now() - started };
	};
	const programs = () => {
		if (stack.programs === undefined) throw new Error("no programs");
		return stack.programs;
	};
	/** Every message scripts sent back to the stack, wherever they ran, and when each arrived. */
	const sent = (): Sent => ({
		messages: sandboxes?.messages ?? messages,
		arrived: sandboxes?.arrived ?? arrived,
	});
	const decide = async (body: unknown) =>
		gateway.fetch(
			new Request(`${BASE}${BROWSER_DECISIONS_PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-access-jwt-assertion": await mock.sign({ sub: `sub-${ADMIN}`, email: ADMIN }),
				},
				body: JSON.stringify(body),
			}),
		);
	return { stack, admin, script, sandboxes, listSessions, programs, sent, decide };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Sent {
	readonly messages: readonly CodemodeRemoteMessage[];
	readonly arrived: readonly number[];
}

/** Waits (without blocking the thread) until a script has sent a call for `tool`; when the call reached the stack. */
async function untilCalled(sent: () => Sent, tool: string): Promise<number> {
	for (let tries = 0; tries < 500; tries += 1) {
		const { messages, arrived } = sent();
		const index = messages.findIndex((message) => message.type === "call" && message.name === tool);
		if (index >= 0) return arrived[index] ?? 0;
		await tick(5);
	}
	throw new Error(`No script called ${tool}`);
}

/** Polls a run until `done` says it has got where the test wants it. */
async function pollRun(
	get: () => Promise<ProgramRunView>,
	done: (run: ProgramRunView) => boolean,
): Promise<ProgramRunView> {
	let run = await get();
	for (let tries = 0; tries < 1000 && !done(run); tries += 1) {
		await tick(5);
		run = await get();
	}
	return run;
}

/**
 * Runs a session's script that calls `ls`, then computes: lists the sessions once the script has made its call (so it
 * is computing), and reports how long that list took against how long the script went on after its call.
 */
async function heavySessionScript(offload: boolean) {
	const { stack, admin, script, sandboxes, listSessions, sent } = await setUp({ offload });
	const session = await stack.runtime.runtime.create(admin, {
		projectId: stack.project.id,
		agentId: DEFAULT_AGENT_ID,
	});
	const code = [
		'await tools.write({ path: "started.txt", content: "go" });',
		collatz(HEAVY),
		'await tools.write({ path: "best.txt", content: String(best) });',
		"return { best, bestN };",
	].join("\n");
	script.reply({ toolCalls: [{ name: CODEMODE_TOOL, args: { code } }] }, { text: "Computed" });
	const prompt = await stack.runtime.runtime.prompt(admin, session.id, { text: "Compute" });
	let endedAt = 0;
	const ended = stack.runtime.runtime.wait(admin, session.id, prompt.id).then((result) => {
		endedAt = performance.now();
		return result;
	});
	const calledAt = await untilCalled(sent, "write");
	// Long enough for the call's answer to reach the script, which then computes.
	await tick(20);
	const listed = await listSessions();
	const listedAt = performance.now();
	expect(await ended).toMatchObject({ status: "answered", answer: "Computed" });
	const toolResult =
		script.requests
			.at(-1)
			?.messages.filter((message) => message.role === "tool")
			.map((message) => message.text)
			.at(-1) ?? "";
	return { stack, admin, session, sandboxes, listed, listedAt, endedAt, calledAt, toolResult };
}

describe("code mode off the stack", () => {
	it("is off unless KANTEL_CODEMODE_OFFLOAD is on, and needs the sandbox Worker's binding", () => {
		expect(codemodeOffloaded({})).toBe(false);
		expect(codemodeOffloaded({ KANTEL_CODEMODE_OFFLOAD: "off" })).toBe(false);
		expect(codemodeOffloaded({ KANTEL_CODEMODE_OFFLOAD: " on " })).toBe(true);

		const sandboxes = threadSandboxes();
		threads.push(sandboxes);
		const fromLoader = () => (id: string) => ({ id }) as never;
		const warnings: string[] = [];
		const warn = (message: string) => warnings.push(message);
		// Off: the Worker Loader, as before, whether the binding is there or not.
		expect(codemodeLoad({}, { loader: fromLoader, sandboxes, warn })?.("i1")).toEqual({ id: "i1" });
		// On, with the binding: a new sandbox object for each script, named after the session's isolate, beside the stack.
		const load = codemodeLoad(
			{ KANTEL_CODEMODE_OFFLOAD: "on" },
			{ loader: fromLoader, sandboxes, locationHint: "weur" },
		);
		load?.("i1");
		load?.("i1");
		expect(sandboxes.made).toHaveLength(2);
		for (const made of sandboxes.made)
			expect(made).toMatchObject({ name: expect.stringMatching(/^i1:/), locationHint: "weur" });
		expect(sandboxes.made[0]?.name).not.toBe(sandboxes.made[1]?.name);
		// On, without the binding: the loader, with a warning.
		expect(codemodeLoad({ KANTEL_CODEMODE_OFFLOAD: "on" }, { loader: fromLoader, warn })?.("i2")).toEqual({ id: "i2" });
		expect(warnings).toEqual([expect.stringMatching(/no CODEMODE_SANDBOXES binding/)]);
		// Code mode off: neither.
		expect(codemodeLoad({ KANTEL_CODEMODE: "off", KANTEL_CODEMODE_OFFLOAD: "on" }, { sandboxes })).toBeUndefined();
	});

	it("answers GET /v1/sessions while a session's script computes in its sandbox object", async () => {
		const { stack, admin, session, sandboxes, listed, listedAt, endedAt, calledAt, toolResult } =
			await heavySessionScript(true);
		expect(toolResult).toMatch(/^Script completed/);
		expect(toolResult).toContain(`"best":${HEAVY_ANSWER.best}`);
		expect(toolResult).toContain(`"bestN":${HEAVY_ANSWER.bestN}`);
		// The list answered at once, long before the script stopped computing.
		expect(listed.status).toBe(200);
		expect(listedAt).toBeLessThan(endedAt);
		expect(listedAt - calledAt).toBeLessThan((endedAt - calledAt) / 4);

		// One sandbox object for the script, named after the session's isolate, beside the stack.
		const id = codemodeIsolateId({ organisationId: stack.organisation.id, sessionId: session.id, bundleId: "b1" });
		expect(sandboxes?.made).toEqual([{ name: `${id}:script-1`, locationHint: "weur" }]);
		// Its tool calls ran on the stack, as the session's agent.
		const written = await stack.workspaces.read(
			admin,
			(await stack.runtime.directory.get(admin, session.id)).workspaceId ?? "",
			"best.txt",
		);
		expect(new TextDecoder().decode(written.content)).toBe(String(HEAVY_ANSWER.best));
		const commits = await stack.audit.query(admin, { type: "workspace.committed", sessionId: session.id });
		expect(commits.items.at(-1)?.actor).toEqual({ kind: "agent", agentId: DEFAULT_AGENT_ID, sessionId: session.id });
	});

	it("holds GET /v1/sessions until the script stops computing when it runs on the stack's own thread", async () => {
		const { listed, listedAt, endedAt, calledAt, toolResult } = await heavySessionScript(false);
		expect(toolResult).toContain(`"best":${HEAVY_ANSWER.best}`);
		expect(listed.status).toBe(200);
		// The list waited behind the computation (its timer too): most of the script's time after its call.
		expect(listedAt - calledAt).toBeGreaterThan((endedAt - calledAt) / 2);
	});

	it("runs a program off the stack: its async start, the run's polls and the session list answer while it computes", async () => {
		const { stack, admin, programs, listSessions, sent, sandboxes } = await setUp({ offload: true });
		const program = await programs().create(admin, {
			projectId: stack.project.id,
			name: "collatz",
			code: ['await tools.ls({ path: "." });', collatz(HEAVY), "return { best, bestN };"].join("\n"),
			tools: ["ls"],
		});
		const started = performance.now();
		const run = await programs().run(admin, program.id, { mode: "async" });
		expect(run.status).toBe("running");
		await untilCalled(sent, "ls");
		await tick(20);
		const listed = await listSessions();
		const listedAt = performance.now();
		const polled = await programs().getRun(admin, program.id, run.id);
		expect(listed.status).toBe(200);
		expect(polled.status).toBe("running");
		const ended = await pollRun(
			() => programs().getRun(admin, program.id, run.id),
			(now) => now.status !== "running",
		);
		const total = performance.now() - started;
		expect(ended).toMatchObject({ status: "succeeded", output: HEAVY_ANSWER });
		expect(listedAt - started).toBeLessThan(total / 4);
		expect(sandboxes?.made).toHaveLength(1);
	});

	it("keeps approvals, the Allow card and journal replay when scripts run off the stack", async () => {
		const { stack, admin, programs, decide, sandboxes } = await setUp({ offload: true, browser: true });

		// A browser_request the script makes waits on a person: the run says so, with the card's call.
		const browse = await programs().create(admin, {
			projectId: stack.project.id,
			name: "browse",
			code: [
				"try {",
				'  await tools.browser_request({ reason: "Read the docs", sites: ["example.com"] });',
				"  return { allowed: true };",
				"} catch (error) {",
				"  return { allowed: false };",
				"}",
			].join("\n"),
			tools: ["browser_request"],
		});
		const asked = await programs().run(admin, browse.id, { mode: "async" });
		const held = await pollRun(
			() => programs().getRun(admin, browse.id, asked.id),
			(run) => run.status !== "running",
		);
		expect(held).toMatchObject({
			status: "waiting",
			waiting: "approval",
			waitingOn: [
				{ kind: "approval", sessionId: held.sessionId, browser: { reason: "Read the docs", sites: ["example.com"] } },
			],
		});
		const wait = held.waitingOn?.[0];
		const callId = wait?.kind === "approval" ? wait.callId : "";
		const cards = (await stack.runtime.runtime.snapshot(admin, held.sessionId)).items.filter(
			(item) => item.kind === "card",
		);
		expect(cards).toEqual([
			expect.objectContaining({ card: expect.objectContaining({ type: "browser.grant", callId, status: "pending" }) }),
		]);
		const allowed = await decide({ sessionId: held.sessionId, callId, allow: true });
		expect(await allowed.json()).toEqual({ status: "granted" });
		const browsed = await pollRun(
			() => programs().getRun(admin, browse.id, asked.id),
			(run) => run.status !== "running" && run.status !== "waiting",
		);
		expect(browsed).toMatchObject({ status: "succeeded", output: { allowed: true } });

		// waitForInput pauses the run; resumed, a new sandbox object replays the finished calls from the journal.
		const counted = await programs().create(admin, {
			projectId: stack.project.id,
			name: "ship",
			code: [
				"let prior = '';",
				"try { prior = await tools.read({ path: 'runs.txt' }); } catch {}",
				"await tools.write({ path: 'runs.txt', content: prior.trim() + 'x' });",
				"const answer = await waitForInput({ prompt: 'Ship it?', key: 'ship' });",
				"const after = await tools.read({ path: 'runs.txt' });",
				"return { answer, runs: after.trim() };",
			].join("\n"),
			tools: ["read", "write"],
		});
		const objectsBefore = sandboxes?.made.length ?? 0;
		const shipping = await programs().run(admin, counted.id, { mode: "async" });
		const paused = await pollRun(
			() => programs().getRun(admin, counted.id, shipping.id),
			(run) => run.status !== "running",
		);
		expect(paused).toMatchObject({ status: "waiting", activation: 1 });
		const input = paused.waitingOn?.[0];
		if (input?.kind !== "input") throw new Error("not waiting on input");
		const resumed = await programs().resume(admin, counted.id, shipping.id, { waitId: input.id, value: "yes" });
		const shipped = await pollRun(
			() => programs().getRun(admin, counted.id, resumed.id),
			(run) => run.status !== "running",
		);
		// The write before the wait ran once: a re-run would have made it "xx".
		expect(shipped).toMatchObject({ status: "succeeded", activation: 2, output: { answer: "yes", runs: "x" } });
		const steps = await programs().steps(admin, counted.id, shipping.id);
		const before = steps.filter((step) => step.firstActivation === 1 && step.kind === "call");
		for (const step of before) expect(step).toMatchObject({ replays: 1, lastActivation: 2 });
		// Each activation's script ran in its own sandbox object.
		expect((sandboxes?.made.length ?? 0) - objectsBefore).toBe(2);
	});
});
