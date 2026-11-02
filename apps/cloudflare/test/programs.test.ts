// Saved programs (src/programs): an agent saves a code mode script with `save_program`, and the API runs it with no model,
// each run a session of the version's profile whose only tools are `codemode` and the version's own.
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { CodemodeRemoteExchange, CodemodeRemoteRequest } from "@earendil-works/pi-codemode/portable";
import { createFakeBrowserProvider } from "@kantel/browser/memory";
import type { CallContext } from "@kantel/contracts";
import { createMockAccess } from "@kantel/identity/testing";
import type { CardItem } from "@kantel/protocol";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeServer } from "../src/codemode/serve.ts";
import { CODEMODE_ENTRYPOINT, type CodemodeLoaderLike, workerLoaderCodemode } from "../src/codemode.ts";
import { gatewayConfig } from "../src/config.ts";
import { BROWSER_DECISIONS_PATH, createGateway } from "../src/gateway.ts";
import { createProgramsApi } from "../src/programs/http.ts";
import {
	parseProgramOutcome,
	parseProgramRunPrompt,
	programOutcome,
	programRunPrompt,
	programScript,
} from "../src/programs/runner-model.ts";
import { type ProgramRunView, programProfileId, runWaits } from "../src/programs/service.ts";
import { SAVE_PROGRAM_TOOL } from "../src/programs/tool.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";

const wasm = loadQuickJSWasm();
const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

function fakeLoader(): CodemodeLoaderLike {
	const isolates = new Map<string, ReturnType<typeof createCodemodeServer>>();
	return {
		get(id) {
			return {
				getEntrypoint(name) {
					expect(name).toBe(CODEMODE_ENTRYPOINT);
					return {
						async execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange) {
							let server = isolates.get(id);
							if (server === undefined) {
								server = createCodemodeServer(wasm);
								isolates.set(id, server);
							}
							return server.execute(structuredClone(request), async (messages) =>
								structuredClone(await exchange(structuredClone(messages))),
							);
						},
					};
				},
			};
		},
	};
}

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";

async function setUp(programs = true, options: { readonly browser?: boolean } = {}) {
	const { models, script } = createScriptedModel();
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const stack = await createStack({
		config: gatewayConfig({
			KANTEL_ADMIN_EMAIL: ADMIN,
			...(options.browser === true ? { KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, KANTEL_ACCESS_AUD: AUD } : {}),
		}),
		...(options.browser === true
			? { accessFetch: mock.fetch, browserProvider: createFakeBrowserProvider().provider }
			: {}),
		models: () => ({ models }),
		codemode: {
			load: workerLoaderCodemode(fakeLoader(), "export class KantelCodemode {}", new ArrayBuffer(8)),
			bundleId: "b1",
		},
		programs,
	});
	opened.push(stack);
	const admin: CallContext = stack.admin;
	const service = () => {
		if (stack.programs === undefined) throw new Error("no programs");
		return stack.programs;
	};
	/** A person's answer to a waiting browser request, through the console's route. */
	const decide = async (body: unknown) => {
		const gateway = createGateway(stack);
		return gateway.fetch(
			new Request(`https://harbour.test${BROWSER_DECISIONS_PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-access-jwt-assertion": await mock.sign({ sub: `sub-${ADMIN}`, email: ADMIN }),
				},
				body: JSON.stringify(body),
			}),
		);
	};
	return { stack, admin, script, service, decide };
}

/** Polls a run until `done` says it has got where the test wants it. */
async function pollRun(
	get: () => Promise<ProgramRunView>,
	done: (run: ProgramRunView) => boolean,
): Promise<ProgramRunView> {
	let run = await get();
	for (let tries = 0; tries < 400 && !done(run); tries += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		run = await get();
	}
	return run;
}

/** The call a run's first approval wait holds. */
const heldCall = (run: ProgramRunView): string => {
	const wait = run.waitingOn?.[0];
	return wait?.kind === "approval" ? wait.callId : "";
};

const ASK_FOR_BROWSER = [
	"try {",
	'  await tools.browser_request({ reason: "Read the docs", sites: ["example.com"] });',
	"  return { allowed: true };",
	"} catch (error) {",
	"  return { allowed: false };",
	"}",
].join("\n");

const SUM = [
	"const total = input.numbers.reduce((sum, n) => sum + n, 0);",
	'await tools.write({ path: "sum.txt", content: String(total) });',
	'const back = await tools.read({ path: "sum.txt" });',
	'console.log("summed", input.numbers.length);',
	"return { total, back: back.trim() };",
].join("\n");

const NUMBERS = {
	type: "object",
	properties: { numbers: { type: "array", items: { type: "number" } } },
	required: ["numbers"],
};

describe("the program runner", () => {
	it("wraps a program with its input and budget, and reads its output and logs back", () => {
		const request = {
			runId: "r1",
			programId: "p1",
			name: "sum",
			version: 2,
			code: "return input.a + 1;",
			input: { a: 1 },
			timeoutMs: 5000,
			maxOutputTokens: 500,
		};
		expect(parseProgramRunPrompt(programRunPrompt(request))).toEqual(request);
		const script = programScript(request);
		expect(script.split("\n")[0]).toBe('// @options: {"timeout_ms":5000,"max_output_tokens":500}');
		expect(script).toContain('const input = {"a":1};');
		const text =
			'Script completed\n<kantel-program-output>{"x":[1,2]}</kantel-program-output>\n<console_output>\none\ntwo\n</console_output>';
		expect(programOutcome(text, false)).toEqual({ ok: true, output: { x: [1, 2] }, logs: ["one", "two"] });
		expect(programOutcome("Script failed: boom", true)).toMatchObject({ ok: false, error: "Script failed: boom" });
		expect(programOutcome("Warning: truncated output <kantel-program-output>{", false)).toMatchObject({ ok: false });
		expect(parseProgramOutcome(undefined)).toMatchObject({ ok: false });
		expect(parseProgramOutcome('{"ok":true,"output":3}')).toEqual({ ok: true, output: 3 });
	});
});

describe("programs", () => {
	it("are off without the option: no service and no save_program", async () => {
		const { stack, admin } = await setUp(false);
		expect(stack.programs).toBeUndefined();
		const profile = await stack.runtime.profiles.get(admin, DEFAULT_AGENT_ID);
		expect(profile.tools).not.toContain(SAVE_PROGRAM_TOOL);
	});

	it("an agent saves a program, and the API runs it with no model, with only the version's tools", async () => {
		const { stack, admin, script, service } = await setUp();
		const profile = await stack.runtime.profiles.get(admin, DEFAULT_AGENT_ID);
		expect(profile.tools).toContain(SAVE_PROGRAM_TOOL);

		// The agent saves the script it wrote.
		const session = await stack.runtime.runtime.create(admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
		});
		script.reply(
			{
				toolCalls: [
					{
						name: SAVE_PROGRAM_TOOL,
						args: { name: "sum", code: SUM, tools: ["read", "write"], input_schema: NUMBERS, description: "Adds up" },
					},
				],
			},
			{ text: "Saved" },
		);
		const prompt = await stack.runtime.runtime.prompt(admin, session.id, { text: "Save a summing program" });
		expect(await stack.runtime.runtime.wait(admin, session.id, prompt.id)).toMatchObject({ status: "answered" });
		const saved = script.requests.at(-1)?.messages.find((message) => message.role === "tool")?.text ?? "";
		expect(saved).toMatch(/Saved program sum \(prog_[0-9a-f]+\) version 1, with tools: read, write/);

		const [program] = await service().list(admin, { projectId: stack.project.id });
		expect(program).toMatchObject({ name: "sum", versions: [1], latestVersion: 1, description: "Adds up" });
		if (program === undefined) throw new Error("not saved");
		const v1 = await service().version(admin, program.id, 1);
		expect(v1).toMatchObject({ tools: ["read", "write"], sessionId: session.id, createdBy: { kind: "agent" } });
		const versionProfile = await stack.runtime.profiles.get(admin, programProfileId(program.id, 1));
		expect(versionProfile).toMatchObject({ tools: ["codemode", "read", "write"], projectId: stack.project.id });

		// A sync run: no model call is made.
		const modelCalls = script.requests.length;
		const run = await service().run(admin, program.id, { input: { numbers: [1, 2, 3.5] } });
		expect(run).toMatchObject({
			status: "succeeded",
			version: 1,
			output: { total: 6.5, back: "6.5" },
			logs: ["summed 3"],
			startedBy: admin.actor,
		});
		expect(script.requests.length).toBe(modelCalls);
		// The run is an ordinary session, as the caller, of the version's profile.
		const runSession = await stack.runtime.directory.get(admin, run.sessionId);
		expect(runSession).toMatchObject({ agentId: programProfileId(program.id, 1), projectId: stack.project.id });
		expect(runSession.labels).toMatchObject({ programId: program.id, programRun: run.id });

		// The input schema is checked before a run starts.
		await expect(service().run(admin, program.id, { input: { numbers: ["x"] } })).rejects.toMatchObject({
			code: "invalid",
		});

		// The run's events are in the audit trail, beside the session's own.
		const events = await stack.audit.query(admin, { type: "programs." });
		expect(events.items.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"programs.program.created",
				"programs.version.created",
				"programs.run.started",
				"programs.run.ended",
			]),
		);
		const sessionEvents = await stack.audit.query(admin, { sessionId: run.sessionId });
		expect(sessionEvents.items.length).toBeGreaterThan(2);
	});

	it("refuses a tool the version doesn't allow, checks the output schema, and runs async", async () => {
		const { stack, admin, service } = await setUp();
		const program = await service().create(admin, {
			projectId: stack.project.id,
			name: "sneaky",
			code: 'return await tools.bash({ command: "echo hi" });',
			tools: ["read"],
		});
		const refused = await service().run(admin, program.id, {});
		expect(refused.status).toBe("failed");
		expect(refused.error).toMatch(/bash/);

		const v2 = await service().addVersion(admin, program.id, {
			code: "return { n: 'not a number' };",
			outputSchema: { type: "object", properties: { n: { type: "number" } } },
		});
		expect(v2.version).toBe(2);
		const mismatch = await service().run(admin, program.id, {});
		expect(mismatch).toMatchObject({ status: "failed", version: 2, output: { n: "not a number" } });
		expect(mismatch.error).toMatch(/output schema/);

		// Async: answered at once, then polled to its end.
		const v3 = await service().addVersion(admin, program.id, { code: "return input * 2;" });
		const started = await service().run(admin, program.id, { input: 21, mode: "async" });
		expect(started).toMatchObject({ status: "running", version: v3.version });
		let polled = started;
		for (let tries = 0; tries < 100 && polled.status === "running"; tries += 1) {
			polled = await service().getRun(admin, program.id, started.id);
		}
		expect(polled).toMatchObject({ status: "succeeded", output: 42 });
		expect((await service().runs(admin, program.id)).map((run) => run.id)).toContain(started.id);

		// Versions: listed, one deleted, its number never reused, and a deleted version can't run.
		await service().removeVersion(admin, program.id, 1);
		expect((await service().versions(admin, program.id)).map((version) => version.version)).toEqual([2, 3]);
		await expect(service().run(admin, program.id, { version: 1 })).rejects.toMatchObject({ code: "not_found" });
		expect((await service().addVersion(admin, program.id, { code: "return 1;" })).version).toBe(4);
		expect(await service().get(admin, program.id)).toMatchObject({ versions: [2, 3, 4], latestVersion: 4 });

		// A program can't be given code mode, subagents or save_program.
		await expect(
			service().addVersion(admin, program.id, { code: "return 1;", tools: ["save_program"] }),
		).rejects.toMatchObject({ code: "invalid" });
		// Names are unique in a project.
		await expect(
			service().create(admin, { projectId: stack.project.id, name: "sneaky", code: "return 1;" }),
		).rejects.toMatchObject({ code: "conflict" });

		await service().remove(admin, program.id);
		await expect(service().get(admin, program.id)).rejects.toMatchObject({ code: "not_found" });
	});

	it("is waiting while its script's browser_request waits on a person, who answers it from the card", async () => {
		const { stack, admin, service, decide } = await setUp(true, { browser: true });
		const program = await service().create(admin, {
			projectId: stack.project.id,
			name: "browse",
			code: ASK_FOR_BROWSER,
			tools: ["browser_request"],
		});
		const started = await service().run(admin, program.id, { mode: "async" });
		const held = await pollRun(
			() => service().getRun(admin, program.id, started.id),
			(run) => run.status !== "running",
		);
		// The run says it waits, and on what: enough to answer it.
		expect(held).toMatchObject({
			status: "waiting",
			waiting: "approval",
			waitingOn: [
				{
					kind: "approval",
					sessionId: held.sessionId,
					browser: { reason: "Read the docs", sites: ["example.com"] },
				},
			],
		});
		const callId = heldCall(held);
		expect(callId).toMatch(/^.+\/c\d+$/);
		expect((await service().runs(admin, program.id)).find((run) => run.id === started.id)?.status).toBe("waiting");

		// Its session waits too, with the card the console draws Allow and Decline from.
		const snapshot = await stack.runtime.runtime.snapshot(admin, held.sessionId);
		expect(snapshot).toMatchObject({ status: "waiting", attention: "waiting" });
		const cards = () =>
			stack.runtime.runtime
				.snapshot(admin, held.sessionId)
				.then((now) => now.items.filter((item): item is CardItem => item.kind === "card"));
		expect(await cards()).toEqual([
			expect.objectContaining({
				card: {
					type: "browser.grant",
					requestId: callId,
					reason: "Read the docs",
					status: "pending",
					callId,
					sites: ["example.com"],
				},
			}),
		]);

		// Allowed through the console's route, the script goes on and the run succeeds.
		const allowed = await decide({ sessionId: held.sessionId, callId, allow: true });
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toEqual({ status: "granted" });
		const ended = await pollRun(
			() => service().getRun(admin, program.id, started.id),
			(run) => run.status !== "running" && run.status !== "waiting",
		);
		expect(ended).toMatchObject({ status: "succeeded", output: { allowed: true } });
		expect(ended.waitingOn).toBeUndefined();
		expect((await cards())[0]?.card).toMatchObject({ type: "browser.grant", status: "granted" });

		// Declined, the script hears so, and the card says it.
		const again = await service().run(admin, program.id, { mode: "async" });
		const waiting = await pollRun(
			() => service().getRun(admin, program.id, again.id),
			(run) => run.status !== "running",
		);
		const declined = await decide({
			sessionId: waiting.sessionId,
			callId: heldCall(waiting),
			allow: false,
		});
		expect(await declined.json()).toEqual({ status: "declined" });
		const after = await pollRun(
			() => service().getRun(admin, program.id, again.id),
			(run) => run.status !== "running" && run.status !== "waiting",
		);
		expect(after).toMatchObject({ status: "succeeded", output: { allowed: false } });
		const settled = (await stack.runtime.runtime.snapshot(admin, after.sessionId)).items.find(
			(item): item is CardItem => item.kind === "card",
		);
		expect(settled?.card).toMatchObject({ type: "browser.grant", status: "denied" });
	});

	it("lists what a run waits on from its session's open approvals, only while their calls run", () => {
		const script = {
			kind: "tool" as const,
			id: "t1",
			at: 1,
			callId: "s1",
			name: "codemode",
			label: "Running a script",
			status: "running" as const,
		};
		const connection = (status: "pending" | "approved", callId: string): CardItem => ({
			kind: "card",
			id: `c:${callId}`,
			at: 2,
			card: {
				type: "connection.approval",
				proposalId: "proposal_1",
				status,
				bindingCode: "K7-42",
				what: "POST api.example.com/v1/issues through Example",
				why: "Open an issue",
				host: "api.example.com",
				methods: ["POST"],
				pathPrefix: "/v1/issues",
				termsSource: "agent-proposed",
				expiresAt: 99,
				link: "https://harbour.test/connections/requests/proposal_1",
				callId,
			},
		});
		expect(runWaits("ses_1", [script, connection("pending", "s1/c1")])).toEqual([
			{
				kind: "approval",
				sessionId: "ses_1",
				callId: "s1/c1",
				since: 2,
				connection: {
					requestId: "proposal_1",
					what: "POST api.example.com/v1/issues through Example",
					host: "api.example.com",
					link: "https://harbour.test/connections/requests/proposal_1",
					expiresAt: 99,
				},
			},
		]);
		// Approved, or left behind by a call that has ended, it is waited on no longer.
		expect(runWaits("ses_1", [script, connection("approved", "s1/c1")])).toEqual([]);
		expect(runWaits("ses_1", [{ ...script, status: "done" }, connection("pending", "s1/c1")])).toEqual([]);
	});

	it("serves the API: create, sync run, async run and poll, and an idempotent retry", async () => {
		const { stack, admin, service } = await setUp();
		const api = createProgramsApi({ programs: service(), authenticate: async () => admin });
		const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
			const response = await api.fetch(
				new Request(`https://kantel.test/v1${path}`, {
					method,
					headers: { "content-type": "application/json", ...headers },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
			if (response === undefined) throw new Error("not a programs route");
			return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
		};
		const created = await call("POST", "/programs", {
			projectId: stack.project.id,
			name: "double",
			code: "return input.n * 2;",
			inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
		});
		expect(created).toMatchObject({ status: 201, body: { name: "double", versions: [1] } });
		const id = (created.body as { id: string }).id;
		expect(await call("POST", `/programs/${id}/runs`, { input: { n: 4 } })).toMatchObject({
			status: 200,
			body: { status: "succeeded", output: 8 },
		});
		expect(await call("POST", `/programs/${id}/runs`, { input: {} })).toMatchObject({
			status: 400,
			body: { error: { code: "invalid" } },
		});
		const async = await call(
			"POST",
			`/programs/${id}/runs`,
			{ input: { n: 5 }, mode: "async" },
			{ "idempotency-key": "k1" },
		);
		expect(async).toMatchObject({ status: 202, body: { status: "running" } });
		const runId = (async.body as { id: string }).id;
		let polled = async;
		for (let tries = 0; tries < 100 && (polled.body as { status: string }).status === "running"; tries += 1) {
			polled = await call("GET", `/programs/${id}/runs/${runId}`);
		}
		expect(polled).toMatchObject({ status: 200, body: { status: "succeeded", output: 10 } });
		// The same key gets the same run.
		const retried = await call(
			"POST",
			`/programs/${id}/runs`,
			{ input: { n: 5 }, mode: "async" },
			{ "idempotency-key": "k1" },
		);
		expect(retried.body).toMatchObject({ id: runId, status: "succeeded" });
		expect(await call("GET", `/programs/${id}/versions/1`)).toMatchObject({ status: 200, body: { version: 1 } });
		expect(await call("DELETE", `/programs/${id}/versions/1`)).toMatchObject({ status: 204 });
		expect(await call("GET", `/programs/${id}`)).toMatchObject({ status: 200, body: { versions: [] } });
		expect(await call("GET", "/programs/nope")).toMatchObject({ status: 404 });
	});
});
