// Durable pauses for programs (KANTEL_PROGRAM_WAITS, src/programs/journal.ts): a program waits for input or an
// agent, its run pauses with nothing running, and resumes later, even in another instance of the stack object, with
// every call an earlier activation finished taken from the run's journal instead of made again.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { CodemodeRemoteExchange, CodemodeRemoteRequest } from "@earendil-works/pi-codemode/portable";
import type { CallContext } from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import type { SqlValue } from "@kantel/runtime-cloudflare";
import { createMemoryObjectBucket } from "@kantel/skills/sql";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { createMemoryWorkspaceStore } from "@kantel/workspace/stored";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeServer } from "../src/codemode/serve.ts";
import { CODEMODE_ENTRYPOINT, type CodemodeLoaderLike, workerLoaderCodemode } from "../src/codemode.ts";
import { gatewayConfig } from "../src/config.ts";
import { createProgramsApi } from "../src/programs/http.ts";
import { createProgramsService, type ProgramRunView, type ProgramsService } from "../src/programs/service.ts";
import { createMemoryProgramStore } from "../src/programs/store.ts";
import {
	createMemoryBootstrapStore,
	createStack,
	type SessionObjectStorage,
	type Stack,
	type StackStorage,
} from "../src/stack.ts";

const wasm = loadQuickJSWasm();
const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close().catch(() => undefined);
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

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** A Durable Object's `ctx.storage` over `node:sqlite`, as in test/durable.test.ts. */
function objectStorage(db: DatabaseSync): SessionObjectStorage {
	let alarm: number | null = null;
	let lock: Promise<unknown> = Promise.resolve();
	return {
		sql: {
			exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
				if (TRANSACTION_CONTROL.test(query)) throw new Error(`Durable Object SQL refuses "${query.trim()}"`);
				const statement = db.prepare(query);
				const values = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as SQLInputValue[];
				const rows = statement.columns().length > 0 ? (statement.all(...values) as T[]) : [];
				if (statement.columns().length === 0) statement.run(...values);
				return { toArray: () => rows };
			},
		},
		transaction<T>(work: () => Promise<T>): Promise<T> {
			const next = lock.then(async () => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = await work();
					db.exec("COMMIT");
					return result;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			});
			lock = next.catch(() => undefined);
			return next;
		},
		setAlarm: async (at) => {
			alarm = at;
		},
		getAlarm: async () => alarm,
	};
}

/** Storage that outlives a stack: a second stack over it is the Durable Object after an eviction. */
function durableStorage(): StackStorage {
	return {
		sql: syncSqliteDriver(new DatabaseSync(":memory:")),
		sessions: objectStorage(new DatabaseSync(":memory:")),
		workspaces: createMemoryWorkspaceStore(),
		skillObjects: createMemoryObjectBucket(),
		bootstrap: createMemoryBootstrapStore(),
	};
}

async function start(storage?: StackStorage, waits = true) {
	const { models, script } = createScriptedModel();
	const stack = await createStack({
		config: gatewayConfig({ KANTEL_ADMIN_EMAIL: "tom@kantel.test" }),
		models: () => ({ models }),
		codemode: {
			load: workerLoaderCodemode(fakeLoader(), "export class KantelCodemode {}", new ArrayBuffer(8)),
			bundleId: "b1",
		},
		programs: true,
		...(waits ? { programWaits: true } : {}),
		...(storage === undefined ? {} : { storage }),
	});
	opened.push(stack);
	const admin: CallContext = stack.admin;
	const service = (): ProgramsService => {
		if (stack.programs === undefined) throw new Error("no programs");
		return stack.programs;
	};
	return { stack, admin, script, service };
}

/** Polls the run until it has left `running` (or `waiting`, when `past` says so). */
async function until(
	service: ProgramsService,
	admin: CallContext,
	run: ProgramRunView,
	done: (run: ProgramRunView) => boolean,
): Promise<ProgramRunView> {
	let polled = run;
	for (let tries = 0; tries < 400 && !done(polled); tries += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		polled = await service.getRun(admin, run.programId, run.id);
	}
	return polled;
}

// Counts its own activations in a file: a replayed read and write leave it at "x", a re-run would make it "xx".
const COUNTED = [
	"let prior = '';",
	"try { prior = await tools.read({ path: 'runs.txt' }); } catch {}",
	"await tools.write({ path: 'runs.txt', content: prior.trim() + 'x' });",
	"const pick = Math.random();",
	"const answer = await waitForInput({ prompt: 'Ship it?', key: 'ship', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } });",
	"const after = await tools.read({ path: 'runs.txt' });",
	"return { answer, runs: after.trim(), pick };",
].join("\n");

/**
 * The service over a fake session runtime whose `prompt` starts the script at once, before `prompt` returns, as a
 * Durable Object's session can: what the deployed check (TASK-4484) caught, a resumed script reading the run before
 * its new activation was kept, so its next wait never paused it.
 */
function eagerRuntime() {
	const store = createMemoryProgramStore();
	const seenAtPrompt: (number | undefined)[] = [];
	const turns = new Map<string, { abort: AbortController; done: Promise<unknown> }>();
	let service: ProgramsService | undefined;
	let submissions = 0;
	const script = async (runId: string, signal: AbortSignal) => {
		const codemode = {
			name: "codemode",
			execute: async (_args: unknown, api: { executeTool: (...args: unknown[]) => Promise<unknown> }) => {
				const first = (await api.executeTool(
					"program_input",
					{ prompt: "One?" },
					{ abortSignal: signal },
					{ key: "c1" },
				)) as {
					structuredOutput: unknown;
				};
				const second = (await api.executeTool(
					"program_input",
					{ prompt: "Two?" },
					{ abortSignal: signal },
					{ key: "c2" },
				)) as {
					structuredOutput: unknown;
				};
				return { output: [first.structuredOutput, second.structuredOutput] };
			},
		};
		const tool = service?.codemodeFor(codemode as never, { labels: { programRun: runId } });
		return (tool as unknown as typeof codemode).execute({}, { executeTool: async () => ({}) });
	};
	const runtime = {
		create: async (_ctx: unknown, input: { labels: { programRun: string } }) => ({
			id: `s-${input.labels.programRun}`,
		}),
		prompt: async (_ctx: unknown, sessionId: string) => {
			const runId = sessionId.slice(2);
			seenAtPrompt.push((await store.run(runId))?.activation);
			submissions += 1;
			const id = `sub${submissions}`;
			const abort = new AbortController();
			// The script starts before `prompt` returns.
			const done = script(runId, abort.signal).then(
				(answer) => ({ status: "answered", answer: JSON.stringify({ ok: true, output: answer.output }) }),
				() => ({ status: "aborted" }),
			);
			turns.set(id, { abort, done });
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { id };
		},
		wait: async (_ctx: unknown, sessionId: string, submissionId: string) => ({
			sessionId,
			submissionId,
			...((await turns.get(submissionId)?.done) as object),
		}),
		abort: async () => {
			for (const turn of turns.values()) turn.abort.abort(new Error("aborted"));
		},
		snapshot: async () => ({ attention: "idle" }),
	};
	service = createProgramsService({
		store,
		access: () => ({ require: async () => undefined, allows: async () => true }) as never,
		runtime: () => runtime as never,
		profiles: () => ({ put: async () => undefined }) as never,
		audit: { append: async () => undefined } as never,
		now: () => Date.now(),
		waits: true,
	});
	return { service, seenAtPrompt };
}

describe("program waits", () => {
	it("keep a resumed run's activation before its script starts, so its next wait pauses it again", async () => {
		const { service, seenAtPrompt } = eagerRuntime();
		const ctx = { actor: { kind: "human", userId: "u1" }, organisationId: "o1", projectId: "p1" } as CallContext;
		const program = await service.create(ctx, { projectId: "p1", name: "two", code: "(fake)" });
		const run = await service.run(ctx, program.id, { mode: "async" });
		const first = await until(service, ctx, run, (r) => r.status === "waiting");
		expect(first).toMatchObject({ activation: 1, waitingOn: [expect.objectContaining({ prompt: "One?" })] });
		await service.resume(ctx, program.id, run.id, { value: 1 });
		const second = await until(service, ctx, first, (r) => r.status === "waiting" && r.activation === 2);
		expect(second).toMatchObject({ activation: 2, waitingOn: [expect.objectContaining({ prompt: "Two?" })] });
		await service.resume(ctx, program.id, run.id, { value: 2 });
		const ended = await until(service, ctx, second, (r) => r.status === "succeeded" || r.status === "failed");
		expect(ended).toMatchObject({ status: "succeeded", activation: 3, output: [1, 2] });
		// Each activation's script found its own activation already kept.
		expect(seenAtPrompt).toEqual([1, 2, 3]);
		const steps = await service.steps(ctx, program.id, run.id);
		expect(steps.map((step) => [step.args, step.firstActivation, step.lastActivation])).toEqual([
			['{"prompt":"One?"}', 1, 3],
			['{"prompt":"Two?"}', 2, 3],
		]);
	});

	it("pause on waitForInput past the sync budget, and resume with the value without re-running finished calls", async () => {
		const { stack, admin, service } = await start();
		const program = await service().create(admin, {
			projectId: stack.project.id,
			name: "ship",
			code: COUNTED,
			tools: ["read", "write"],
		});
		const run = await service().run(admin, program.id, { input: null });
		// The sync call answers as soon as the run pauses, not after its budget.
		const waiting = await until(service(), admin, run, (r) => r.status !== "running");
		expect(waiting).toMatchObject({ status: "waiting", activation: 1 });
		expect(waiting.waitingOn).toEqual([
			expect.objectContaining({ kind: "input", key: "ship", prompt: "Ship it?", schema: expect.any(Object) }),
		]);
		// Nothing runs while it waits: its session's turn was stopped.
		const snapshot = await stack.runtime.runtime.snapshot(admin, waiting.sessionId);
		expect(snapshot.attention).not.toBe("working");

		// A value that doesn't match the step's schema is refused, and the run keeps waiting.
		const first = waiting.waitingOn?.[0];
		if (first === undefined || first.kind !== "input") throw new Error("not waiting on input");
		const waitId = first.id;
		await expect(service().resume(admin, program.id, run.id, { waitId, value: { ok: "yes" } })).rejects.toMatchObject({
			code: "invalid",
		});

		const resumed = await service().resume(admin, program.id, run.id, { waitId, value: { ok: true }, waitMs: 5000 });
		const ended = await until(service(), admin, resumed, (r) => r.status !== "running");
		expect(ended).toMatchObject({ status: "succeeded", activation: 2, output: { answer: { ok: true }, runs: "x" } });
		expect(ended.waitingOn).toBeUndefined();
		// Twice resolved is refused.
		await expect(service().resume(admin, program.id, run.id, { waitId, value: { ok: false } })).rejects.toMatchObject({
			code: "conflict",
		});

		// The journal: the read and write before the wait ran once, and activation 2 took them from it.
		const steps = await service().steps(admin, program.id, run.id);
		const before = steps.filter((step) => step.firstActivation === 1 && step.kind === "call");
		expect(before.map((step) => step.tool)).toEqual(["read", "write"]);
		for (const step of before) expect(step).toMatchObject({ replays: 1, lastActivation: 2, kept: true });
		// The wait was made once; activation 2 got its value from the journal.
		expect(steps.find((step) => step.kind === "input")).toMatchObject({
			status: "resolved",
			firstActivation: 1,
			replays: 1,
		});
		expect(steps.filter((step) => step.firstActivation === 2).map((step) => step.tool)).toEqual(["read"]);

		const events = (await stack.audit.query(admin, { type: "programs." })).items.map((event) => event.type);
		expect(events).toEqual(
			expect.arrayContaining([
				"programs.wait.created",
				"programs.run.waiting",
				"programs.wait.resolved",
				"programs.run.resumed",
				"programs.step.replayed",
				"programs.run.ended",
			]),
		);
		expect(events.filter((type) => type === "programs.step.replayed")).toHaveLength(2);
	});

	it("resume after the stack object is evicted, through two waits, with no finished call made twice", async () => {
		const storage = durableStorage();
		const first = await start(storage);
		const code = [
			"let prior = '';",
			"try { prior = await tools.read({ path: 'runs.txt' }); } catch {}",
			"await tools.write({ path: 'runs.txt', content: prior.trim() + 'x' });",
			"const a = await waitForInput('First?');",
			"const mid = await tools.read({ path: 'runs.txt' });",
			"await tools.write({ path: 'runs.txt', content: mid.trim() + 'y' });",
			"const b = await waitForInput({ prompt: 'Second?' });",
			"const after = await tools.read({ path: 'runs.txt' });",
			"return { a, b, runs: after.trim() };",
		].join("\n");
		const program = await first.service().create(first.admin, {
			projectId: first.stack.project.id,
			name: "twice",
			code,
			tools: ["read", "write"],
		});
		const run = await first.service().run(first.admin, program.id, { mode: "async" });
		const waiting = await until(first.service(), first.admin, run, (r) => r.status !== "running");
		expect(waiting).toMatchObject({ status: "waiting", waitingOn: [expect.objectContaining({ prompt: "First?" })] });

		// The object is evicted while the run waits; a new one opens over the same storage.
		await first.stack.close();
		const second = await start(storage);
		const kept = await second.service().getRun(second.admin, program.id, run.id);
		expect(kept).toMatchObject({ status: "waiting", waitingOn: [expect.objectContaining({ prompt: "First?" })] });
		await second.service().resume(second.admin, program.id, run.id, { value: "one" });
		const again = await until(
			second.service(),
			second.admin,
			kept,
			(r) => r.status !== "running" && r.activation === 2,
		);
		expect(again).toMatchObject({ status: "waiting", waitingOn: [expect.objectContaining({ prompt: "Second?" })] });

		// Evicted again, between the second wait and its value.
		await second.stack.close();
		const third = await start(storage);
		await third.service().resume(third.admin, program.id, run.id, { value: "two" });
		const ended = await until(
			third.service(),
			third.admin,
			again,
			(r) => r.status !== "running" && r.status !== "waiting",
		);
		expect(ended).toMatchObject({ status: "succeeded", activation: 3, output: { a: "one", b: "two", runs: "xy" } });

		const steps = await third.service().steps(third.admin, program.id, run.id);
		// Each call ran in one activation only: the first read and write twice replayed, the middle ones once.
		const calls = steps.filter((step) => step.kind === "call");
		expect(calls.map((step) => [step.tool, step.firstActivation, step.replays])).toEqual([
			["read", 1, 2],
			["write", 1, 2],
			["read", 2, 1],
			["write", 2, 1],
			["read", 3, 0],
		]);
	});

	it("pause on agent() while an agent session works, and resume with its checked answer", async () => {
		const { stack, admin, script, service } = await start();
		// The agent takes longer than the pause takes to settle, so the run pauses and the answer resumes it.
		script.reply(async () => {
			await new Promise((resolve) => setTimeout(resolve, 600));
			return { text: 'Sure.\n```json\n{"verdict":"ship","score":9}\n```' };
		});
		const program = await service().create(admin, {
			projectId: stack.project.id,
			name: "review",
			code: [
				"await tools.write({ path: 'draft.txt', content: 'hello' });",
				"const review = await agent('Review draft.txt and score it', { key: 'review', schema: { type: 'object', properties: { verdict: { type: 'string' }, score: { type: 'number' } }, required: ['verdict', 'score'] } });",
				"return review;",
			].join("\n"),
			tools: ["agent", "write"],
		});
		const run = await service().run(admin, program.id, { mode: "async" });
		const ended = await until(service(), admin, run, (r) => r.status !== "running" && r.status !== "waiting");
		expect(ended.error).toBeUndefined();
		expect(ended).toMatchObject({ status: "succeeded", activation: 2, output: { verdict: "ship", score: 9 } });

		const steps = await service().steps(admin, program.id, run.id);
		const agentStep = steps.find((step) => step.kind === "agent");
		expect(agentStep).toMatchObject({ status: "resolved", tool: "program_agent" });
		expect(steps.find((step) => step.tool === "write")).toMatchObject({ replays: 1 });
		// The agent's session is its own, as the run's caller, labelled with the run and not a child of its session.
		const sessions = await stack.runtime.directory.list(admin, { projectId: stack.project.id });
		const agentSession = sessions.items.find((session) => session.labels?.programWait !== undefined);
		expect(agentSession).toMatchObject({ labels: { programRun: run.id } });
		expect(agentSession?.parentSessionId).toBeUndefined();

		// A version without `agent` in its tools can't start one.
		const v2 = await service().addVersion(admin, program.id, { code: "return await agent('hi');", tools: [] });
		const refused = await service().run(admin, program.id, { version: v2.version });
		expect(refused.status).toBe("failed");
		expect(refused.error).toMatch(/can't start agents/);

		// An agent that answers before the run has paused hands its value to the waiting call: no pause, one activation.
		script.reply({ text: "quick" });
		const v3 = await service().addVersion(admin, program.id, {
			code: "return await agent('Be quick');",
			tools: ["agent"],
		});
		const quick = await service().run(admin, program.id, { version: v3.version, mode: "async" });
		const quickEnded = await until(service(), admin, quick, (r) => r.status !== "running" && r.status !== "waiting");
		expect(quickEnded).toMatchObject({ status: "succeeded", output: "quick" });
		expect(quickEnded.activation).toBeLessThanOrEqual(2);
	});

	it("an agent step that the object is evicted under is picked up by the next one", async () => {
		const storage = durableStorage();
		const first = await start(storage);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The agent's model call is still going when the object goes.
		first.script.reply(async () => {
			await gate;
			return { text: "too late" };
		});
		const program = await first.service().create(first.admin, {
			projectId: first.stack.project.id,
			name: "slow-agent",
			code: "const n = await agent('Count to three'); return { n };",
			tools: ["agent"],
		});
		const run = await first.service().run(first.admin, program.id, { mode: "async" });
		const waiting = await until(
			first.service(),
			first.admin,
			run,
			(r) => r.status === "waiting" && r.waitingOn?.some((wait) => "sessionId" in wait) === true,
		);
		expect(waiting.waitingOn?.[0]).toMatchObject({ kind: "agent", sessionId: expect.any(String) });
		const closing = first.stack.close();
		release();
		await closing;

		const second = await start(storage);
		second.script.reply({ text: "three" });
		// The new object resumes the agent's session, and its answer resumes the run.
		const ended = await until(
			second.service(),
			second.admin,
			waiting,
			(r) => r.status !== "running" && r.status !== "waiting",
		);
		// Whichever answer the agent's session kept (its turn may finish as the object closes), the new object took it.
		expect(ended).toMatchObject({ status: "succeeded", activation: 2 });
		expect(["three", "too late"]).toContain((ended.output as { n: string }).n);
		const events = await second.stack.audit.query(second.admin, { type: "programs." });
		expect(events.items.map((event) => event.type)).toEqual(
			expect.arrayContaining(["programs.wait.resolved", "programs.run.resumed"]),
		);
	});

	it("cancel a waiting run, which ends it and its agent steps", async () => {
		const { stack, admin, service } = await start();
		const program = await service().create(admin, {
			projectId: stack.project.id,
			name: "cancel-me",
			code: "return await waitForInput('Anything?');",
		});
		const run = await service().run(admin, program.id, { mode: "async" });
		await until(service(), admin, run, (r) => r.status === "waiting");
		const cancelled = await service().cancel(admin, program.id, run.id);
		expect(cancelled).toMatchObject({ status: "cancelled" });
		await expect(service().resume(admin, program.id, run.id, { value: 1 })).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it("delete a program with its runs and steps in SQL, refused with 409 while a run is going", async () => {
		const storage = durableStorage();
		const { stack, admin, service } = await start(storage);
		const api = createProgramsApi({ programs: service(), authenticate: async () => admin });
		const call = async (method: string, path: string, body?: unknown) => {
			const response = await api.fetch(
				new Request(`https://kantel.test/v1${path}`, {
					method,
					headers: { "content-type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
			if (response === undefined) throw new Error("not a programs route");
			return {
				status: response.status,
				body: response.status === 204 ? undefined : ((await response.json()) as Record<string, unknown>),
			};
		};
		const db = storage.sql;
		if (db === undefined) throw new Error("no SQL");
		const count = async (table: "program_runs" | "program_steps" | "program_versions", programId: string) => {
			const query =
				table === "program_steps"
					? "SELECT COUNT(*) AS n FROM program_steps WHERE run_id IN (SELECT id FROM program_runs WHERE program_id = ?)"
					: `SELECT COUNT(*) AS n FROM ${table} WHERE program_id = ?`;
			return Number((await db.query(query, [programId]))[0]?.n);
		};
		const stepsOf = async (runId: string) =>
			Number((await db.query("SELECT COUNT(*) AS n FROM program_steps WHERE run_id = ?", [runId]))[0]?.n);

		// Two programs, each with an ended run that has steps.
		const doomed = await service().create(admin, {
			projectId: stack.project.id,
			name: "doomed",
			code: COUNTED,
			tools: ["read", "write"],
		});
		const kept = await service().create(admin, {
			projectId: stack.project.id,
			name: "kept",
			code: COUNTED,
			tools: ["read", "write"],
		});
		const finish = async (programId: string) => {
			const run = await service().run(admin, programId, { input: null });
			const waiting = await until(service(), admin, run, (r) => r.status !== "running");
			const wait = waiting.waitingOn?.[0];
			if (wait === undefined || wait.kind !== "input") throw new Error("not waiting on input");
			const resumed = await service().resume(admin, programId, run.id, {
				waitId: wait.id,
				value: { ok: true },
				waitMs: 5000,
			});
			return until(service(), admin, resumed, (r) => r.status !== "running");
		};
		const doomedRun = await finish(doomed.id);
		const keptRun = await finish(kept.id);
		expect([doomedRun.status, keptRun.status]).toEqual(["succeeded", "succeeded"]);
		await service().addVersion(admin, doomed.id, { code: "return 1;" });

		// A run still waiting: the delete is refused, names it, and deletes nothing.
		const live = await service().run(admin, doomed.id, { input: null, version: 1, mode: "async" });
		await until(service(), admin, live, (r) => r.status === "waiting");
		const before = {
			runs: await count("program_runs", doomed.id),
			steps: await count("program_steps", doomed.id),
			versions: await count("program_versions", doomed.id),
		};
		expect(before.runs).toBe(2);
		expect(before.steps).toBeGreaterThan(0);
		expect(before.versions).toBe(2);
		const refused = await call("DELETE", `/programs/${doomed.id}`);
		expect(refused).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
		expect(JSON.stringify(refused.body)).toContain(`${live.id} (waiting)`);
		expect({
			runs: await count("program_runs", doomed.id),
			steps: await count("program_steps", doomed.id),
			versions: await count("program_versions", doomed.id),
		}).toEqual(before);
		expect(await call("GET", `/programs/${doomed.id}`)).toMatchObject({ status: 200 });

		// Cancelled, it goes: the program, its versions, its runs and their steps, and nothing of the other program.
		await service().cancel(admin, doomed.id, live.id);
		const keptSteps = await stepsOf(keptRun.id);
		expect(keptSteps).toBeGreaterThan(0);
		expect(await call("DELETE", `/programs/${doomed.id}`)).toMatchObject({ status: 204 });
		expect(await count("program_runs", doomed.id)).toBe(0);
		expect(await stepsOf(doomedRun.id)).toBe(0);
		expect(await stepsOf(live.id)).toBe(0);
		expect(await count("program_versions", doomed.id)).toBe(0);
		expect(await call("GET", `/programs/${doomed.id}`)).toMatchObject({ status: 404 });
		expect(await call("GET", `/programs/${doomed.id}/runs/${doomedRun.id}`)).toMatchObject({ status: 404 });
		expect(await call("DELETE", `/programs/${doomed.id}`)).toMatchObject({ status: 404 });

		expect(await count("program_runs", kept.id)).toBe(1);
		expect(await stepsOf(keptRun.id)).toBe(keptSteps);
		expect(await call("GET", `/programs/${kept.id}/runs/${keptRun.id}`)).toMatchObject({
			status: 200,
			body: { status: "succeeded" },
		});
		// The runs' sessions stay.
		await expect(stack.runtime.directory.get(admin, doomedRun.sessionId)).resolves.toMatchObject({
			id: doomedRun.sessionId,
		});
	});

	it("in memory too, deleting a program takes its runs and their steps, and only its own", async () => {
		const store = createMemoryProgramStore();
		const actor = { kind: "human", userId: "u1" } as const;
		const run = (id: string, programId: string, status: "running" | "waiting" | "succeeded") =>
			store.putRun({
				id,
				organisationId: "o1",
				projectId: "p1",
				programId,
				version: 1,
				status,
				input: null,
				sessionId: `s-${id}`,
				submissionId: "",
				startedAt: 1,
				startedBy: actor,
			});
		const step = (runId: string) =>
			store.putStep({
				runId,
				tool: "read",
				fingerprint: "f",
				occurrence: 1,
				kind: "call",
				status: "done",
				firstActivation: 1,
				activation: 1,
				callKey: "c1",
				argsPreview: "{}",
				executedAt: 1,
				replays: 0,
			});
		await run("r1", "a", "succeeded");
		await run("r2", "a", "waiting");
		await run("r3", "b", "running");
		for (const id of ["r1", "r2", "r3"]) await step(id);
		expect((await store.unendedRuns("a")).map((r) => r.id)).toEqual(["r2"]);
		await store.removeProgram("a");
		expect(await store.runs("a", 10)).toEqual([]);
		expect(await store.steps("r1")).toEqual([]);
		expect(await store.steps("r2")).toEqual([]);
		expect((await store.runs("b", 10)).map((r) => r.id)).toEqual(["r3"]);
		expect(await store.steps("r3")).toHaveLength(1);
	});

	it("serve resume and steps over the API, and keep both off without the switch", async () => {
		const { stack, admin, service } = await start();
		const api = createProgramsApi({ programs: service(), authenticate: async () => admin });
		const call = async (method: string, path: string, body?: unknown) => {
			const response = await api.fetch(
				new Request(`https://kantel.test/v1${path}`, {
					method,
					headers: { "content-type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
			if (response === undefined) throw new Error("not a programs route");
			return { status: response.status, body: (await response.json()) as Record<string, unknown> };
		};
		const created = await call("POST", "/programs", {
			projectId: stack.project.id,
			name: "ask",
			code: "const name = await waitForInput({ prompt: 'Name?' }); return 'hi ' + name;",
		});
		const id = created.body.id as string;
		const started = await call("POST", `/programs/${id}/runs`, { input: null });
		expect(started).toMatchObject({ status: 200, body: { status: "waiting" } });
		const runId = started.body.id as string;
		expect(await call("POST", `/programs/${id}/runs/${runId}/resume`, { value: "Tom", waitMs: 5000 })).toMatchObject({
			status: 200,
			body: { status: "succeeded", output: "hi Tom" },
		});
		const steps = await call("GET", `/programs/${id}/runs/${runId}/steps`);
		expect(steps).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ kind: "input" })] } });

		// Without KANTEL_PROGRAM_WAITS: no resume route, and waitForInput is no function in the script.
		const off = await start(undefined, false);
		const offApi = createProgramsApi({ programs: off.service(), authenticate: async () => off.admin });
		const program = await off.service().create(off.admin, {
			projectId: off.stack.project.id,
			name: "ask",
			code: "return await waitForInput('x');",
		});
		const failed = await off.service().run(off.admin, program.id, {});
		expect(failed).toMatchObject({ status: "failed" });
		expect(failed.error).toMatch(/waitForInput/);
		const response = await offApi.fetch(
			new Request(`https://kantel.test/v1/programs/${program.id}/runs/${failed.id}/resume`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(response?.status).toBe(404);
	});
});
