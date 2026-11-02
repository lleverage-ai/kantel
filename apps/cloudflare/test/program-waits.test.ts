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
import type { ProgramRunView, ProgramsService } from "../src/programs/service.ts";
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
		config: gatewayConfig({ KANTEL_ADMIN_EMAIL: "tom@harbour.test" }),
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

describe("program waits", () => {
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
		script.reply({ text: 'Sure.\n```json\n{"verdict":"ship","score":9}\n```' });
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
