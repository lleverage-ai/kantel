import type { CallContext, RaisedFinding, Schedule, ScheduleInput, Schedules } from "@kantel/contracts";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import {
	createCheckHandler,
	createReminderHandler,
	createTaskHandler,
	type DueReminder,
	OCCURRENCE_LABEL,
	parseCheckOutput,
	quietHoursEnd,
	SCHEDULE_LABEL,
	scheduledActingUser,
} from "@kantel/schedules/handlers";
import { createMemorySchedules } from "@kantel/schedules/memory";
import { createScheduleRunner, type OccurrenceHandler, type RunnerTimers } from "@kantel/schedules/runner";
import { createSqlSchedules, migrateSchedules } from "@kantel/schedules/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { ManualClock } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-10-28T09:00:00Z");
const human: CallContext = {
	actor: { kind: "human", userId: "user-1" },
	organisationId: "org-1",
	projectId: "proj-1",
};
const operator: CallContext = {
	actor: { kind: "service", serviceId: "supervisor" },
	organisationId: "org-1",
	projectId: "proj-1",
};

/** Timers on the manual clock: `advance` moves the clock and fires what fell due, in order, letting each settle. */
class ManualTimers implements RunnerTimers {
	private next = 1;
	private readonly pending = new Map<number, { at: number; callback: () => void }>();
	constructor(private readonly clock: ManualClock) {}

	setTimeout(callback: () => void, ms: number): unknown {
		const id = this.next++;
		this.pending.set(id, { at: this.clock.now() + ms, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.pending.delete(handle as number);
	}

	async advance(ms: number): Promise<void> {
		const until = this.clock.now() + ms;
		for (;;) {
			await settle();
			const due = [...this.pending.entries()]
				.filter(([, timer]) => timer.at <= until)
				.sort(([, a], [, b]) => a.at - b.at)[0];
			if (due === undefined) break;
			const [id, timer] = due;
			this.pending.delete(id);
			if (timer.at > this.clock.now()) this.clock.advance(timer.at - this.clock.now());
			timer.callback();
		}
		if (until > this.clock.now()) this.clock.advance(until - this.clock.now());
		await settle();
	}
}

/** Lets pending promise chains run (store calls, handler steps). */
async function settle(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function hourly(clock: ManualClock, input: Partial<ScheduleInput> = {}): ScheduleInput {
	return {
		owner: { kind: "project", organisationId: "org-1", projectId: "proj-1" },
		kind: "task",
		title: "Hourly",
		timezone: "Europe/London",
		repeat: { every: "hours", interval: 1, from: clock.now() + HOUR },
		payload: null,
		...input,
	};
}

async function memoryRuntime() {
	const { models, script } = createScriptedModel();
	const memory = createMemoryRuntime({ models });
	await memory.profiles.put(operator, {
		id: "agent-1",
		organisationId: "org-1",
		name: "Worker",
		model: { route: "default" },
		promptLayers: [],
		tools: [],
		skills: [],
		sandbox: { tiers: ["isolate"] },
		memoryScopes: [],
	});
	return { memory, script };
}

describe("the scheduler loop", () => {
	it("starts a task's session through the public session API and finishes the occurrence when its run ends", async () => {
		const clock = new ManualClock(START);
		const schedules = createMemorySchedules({ clock });
		const { memory, script } = await memoryRuntime();
		try {
			const schedule = await schedules.create(
				human,
				hourly(clock, { title: "Daily digest", payload: { agentId: "agent-1", prompt: "Write the digest" } }),
			);
			script.reply({ text: "Digest written" });
			const runner = createScheduleRunner({
				schedules,
				runnerId: "host-a",
				clock,
				timers: new ManualTimers(clock),
				handlers: { task: createTaskHandler({ runtime: memory.runtime, directory: memory.directory }) },
			});
			clock.advance(HOUR);
			const [record] = await runner.runOnce();
			expect(record).toMatchObject({ scheduleId: schedule.id, kind: "task", status: "succeeded", attempt: 1 });

			const sessions = (await memory.directory.list(operator, { labels: { [SCHEDULE_LABEL]: schedule.id } })).items;
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({ title: "Daily digest", agentId: "agent-1", projectId: "proj-1" });
			expect(sessions[0]?.labels?.[OCCURRENCE_LABEL]).toBe(record?.occurrenceId);
			expect(script.requests.at(-1)?.messages.at(-1)).toMatchObject({ role: "user", text: "Write the digest" });
			const [occurrence] = (await schedules.listOccurrences(human, schedule.id)).items;
			expect(occurrence).toMatchObject({ status: "succeeded", result: { run: "answered" } });
		} finally {
			await memory.close();
		}
	});

	it("runs a person's task acting for them, private to them, only in a one-person deployment (#335)", async () => {
		for (const actForCreator of [true, false]) {
			const clock = new ManualClock(START);
			const schedules = createMemorySchedules({ clock });
			const { memory, script } = await memoryRuntime();
			try {
				const mine = await schedules.create(human, hourly(clock, { payload: { agentId: "agent-1", prompt: "Mine" } }));
				const services = await schedules.create(
					operator,
					hourly(clock, { payload: { agentId: "agent-1", prompt: "Theirs" } }),
				);
				script.reply({ text: "Done" });
				script.reply({ text: "Done" });
				const runner = createScheduleRunner({
					schedules,
					runnerId: "host-a",
					clock,
					timers: new ManualTimers(clock),
					handlers: {
						task: createTaskHandler({ runtime: memory.runtime, directory: memory.directory, actForCreator }),
					},
				});
				clock.advance(HOUR);
				const records = await runner.runOnce();
				expect(records.map((record) => record.status)).toEqual(["succeeded", "succeeded"]);
				const sessionOf = async (scheduleId: string) =>
					(await memory.directory.list(operator, { labels: { [SCHEDULE_LABEL]: scheduleId } })).items[0];
				const ran = await sessionOf(mine.id);
				// Every run says which schedule and occurrence started it, with no one watching.
				expect(ran?.unattended).toEqual({ scheduleId: mine.id, occurrenceId: ran?.labels[OCCURRENCE_LABEL] });
				if (actForCreator) expect(ran).toMatchObject({ userId: "user-1", visibility: "private" });
				else expect(ran?.userId).toBeUndefined();
				// A schedule a service made acts for no one either way.
				const theirs = await sessionOf(services.id);
				expect(theirs?.unattended?.scheduleId).toBe(services.id);
				expect(theirs?.userId).toBeUndefined();
				expect(theirs?.visibility).toBeUndefined();
			} finally {
				await memory.close();
			}
		}
	});

	it("says a run acts for the person who made the schedule only when asked to, and never for anyone else", () => {
		const by = (createdBy: Schedule["createdBy"]) => ({ createdBy });
		expect(scheduledActingUser(by({ kind: "human", userId: "user-1" }), true)).toBe("user-1");
		expect(scheduledActingUser(by({ kind: "human", userId: "user-1" }), false)).toBeUndefined();
		expect(scheduledActingUser(by({ kind: "agent", agentId: "a", sessionId: "s" }), true)).toBeUndefined();
		expect(scheduledActingUser(by({ kind: "service", serviceId: "host" }), true)).toBeUndefined();
		expect(scheduledActingUser(by({ kind: "system", component: "schedules" }), true)).toBeUndefined();
	});

	it("sends a task's prompt exactly as written, to the host's default agent when the payload names none", async () => {
		const clock = new ManualClock(START);
		const schedules = createMemorySchedules({ clock });
		const { memory, script } = await memoryRuntime();
		try {
			const prompt = "  Label the new issues.\n";
			const schedule = await schedules.create(human, hourly(clock, { payload: { prompt } }));
			script.reply({ text: "Labelled" });
			const runner = createScheduleRunner({
				schedules,
				runnerId: "host-a",
				clock,
				timers: new ManualTimers(clock),
				handlers: {
					task: createTaskHandler({
						runtime: memory.runtime,
						directory: memory.directory,
						defaultAgentId: "agent-1",
					}),
				},
			});
			clock.advance(HOUR);
			const [record] = await runner.runOnce();
			expect(record?.status).toBe("succeeded");
			const sessions = (await memory.directory.list(operator, { labels: { [SCHEDULE_LABEL]: schedule.id } })).items;
			expect(sessions[0]).toMatchObject({ agentId: "agent-1" });
			expect(script.requests.at(-1)?.messages.at(-1)).toMatchObject({ role: "user", text: prompt });
		} finally {
			await memory.close();
		}
	});

	it("a task run retried after its first runner died starts no second session or prompt", async () => {
		const clock = new ManualClock(START);
		const schedules = createMemorySchedules({ clock });
		const { memory, script } = await memoryRuntime();
		try {
			const schedule = await schedules.create(
				human,
				hourly(clock, { payload: { agentId: "agent-1", prompt: "Run the report" } }),
			);
			script.reply({ text: "Done" }, { text: "Should not be asked" });
			const handler = createTaskHandler({ runtime: memory.runtime, directory: memory.directory });
			clock.advance(HOUR);
			await schedules.tick({ actor: { kind: "system", component: "test" } });
			// The first runner claims, starts the session and dies before finishing the occurrence.
			const dead = await schedules.claim({ actor: { kind: "system", component: "test" } }, "dead", MINUTE);
			await handler({
				occurrence: dead!,
				schedule: dead!.schedule,
				organisationId: "org-1",
				signal: new AbortController().signal,
				holdLease: async () => {},
			});
			clock.advance(2 * MINUTE);

			const runner = createScheduleRunner({
				schedules,
				runnerId: "host-b",
				clock,
				timers: new ManualTimers(clock),
				handlers: { task: handler },
			});
			const [record] = await runner.runOnce();
			expect(record).toMatchObject({ status: "succeeded", attempt: 2, occurrenceId: dead!.id });
			const sessions = (await memory.directory.list(operator, { labels: { [SCHEDULE_LABEL]: schedule.id } })).items;
			expect(sessions).toHaveLength(1);
			expect(script.requests).toHaveLength(1);
		} finally {
			await memory.close();
		}
	});

	it("two attempts racing past a stalled create prompt one session: the one whose lease was taken closes its own", async () => {
		const clock = new ManualClock(START);
		const schedules = createMemorySchedules({ clock });
		const { memory, script } = await memoryRuntime();
		try {
			const schedule = await schedules.create(
				human,
				hourly(clock, { payload: { agentId: "agent-1", prompt: "Run the report" } }),
			);
			script.reply({ text: "Done" }, { text: "Should not be asked" });
			const gate = deferred();
			let creates = 0;
			const runtime = {
				create: async (...args: Parameters<typeof memory.runtime.create>) => {
					creates += 1;
					// The first attempt's create is slow to become visible; the second's is not.
					if (creates === 1) await gate.promise;
					return memory.runtime.create(...args);
				},
				prompt: memory.runtime.prompt.bind(memory.runtime),
				wait: memory.runtime.wait.bind(memory.runtime),
				close: memory.runtime.close.bind(memory.runtime),
			};
			const handler = createTaskHandler({ runtime, directory: memory.directory });
			const errors: unknown[] = [];
			const a = createScheduleRunner({
				schedules,
				runnerId: "a",
				clock,
				timers: new ManualTimers(clock),
				leaseMs: MINUTE,
				handlers: { task: handler },
				onError: (error) => errors.push(error),
			});
			const b = createScheduleRunner({
				schedules,
				runnerId: "b",
				clock,
				timers: new ManualTimers(clock),
				leaseMs: MINUTE,
				handlers: { task: handler },
			});
			clock.advance(HOUR);
			const passA = a.runOnce();
			await settle();
			// Runner a stalls past its lease inside create; runner b takes the occurrence over and runs it.
			clock.advance(2 * MINUTE);
			expect(await b.runOnce()).toMatchObject([{ status: "succeeded", attempt: 2 }]);
			gate.resolve();
			expect(await passA).toMatchObject([{ status: "lost", attempt: 1 }]);

			expect(script.requests).toHaveLength(1);
			const sessions = (await memory.directory.list(operator, { labels: { [SCHEDULE_LABEL]: schedule.id } })).items;
			expect(sessions).toHaveLength(2);
			const [occurrence] = (await schedules.listOccurrences(human, schedule.id)).items;
			const prompted = (occurrence!.result as { sessionId: string }).sessionId;
			const orphan = sessions.find((session) => session.id !== prompted);
			expect(orphan?.status).not.toBe("running");
			expect(orphan?.status).not.toBe("idle");
			expect(errors).toHaveLength(1);
		} finally {
			await memory.close();
		}
	});

	it("a runner stopped while a claim is in flight starts nothing, and leaves the claim to lapse", async () => {
		const clock = new ManualClock(START);
		const schedules = createMemorySchedules({ clock });
		await schedules.create(human, hourly(clock));
		const gate = deferred();
		const slowClaims: Schedules = Object.create(schedules);
		Object.assign(slowClaims, {
			claim: async (...args: Parameters<Schedules["claim"]>) => {
				const claimed = await schedules.claim(...args);
				await gate.promise;
				return claimed;
			},
		});
		const ran: string[] = [];
		const runner = createScheduleRunner({
			schedules: slowClaims,
			runnerId: "a",
			clock,
			timers: new ManualTimers(clock),
			handlers: {
				task: async (run) => {
					ran.push(run.occurrence.id);
					return { status: "succeeded" };
				},
			},
		});
		clock.advance(HOUR);
		const pass = runner.runOnce();
		await settle();
		const stopped = runner.stop();
		gate.resolve();
		await stopped;
		expect(await pass).toMatchObject([{ status: "interrupted", attempt: 1 }]);
		expect(ran).toEqual([]);
	});

	it("fails a task occurrence whose payload names no agent on a host with no default agent, and carries on", async () => {
		const clock = new ManualClock(START);
		const schedules = createMemorySchedules({ clock });
		const { memory } = await memoryRuntime();
		try {
			await schedules.create(human, hourly(clock, { payload: { prompt: "no agent" } }));
			const runner = createScheduleRunner({
				schedules,
				runnerId: "host-a",
				clock,
				timers: new ManualTimers(clock),
				handlers: { task: createTaskHandler({ runtime: memory.runtime, directory: memory.directory }) },
			});
			clock.advance(HOUR);
			const [record] = await runner.runOnce();
			expect(record?.status).toBe("failed");
		} finally {
			await memory.close();
		}
	});

	it("fails a task occurrence whose payload has a message but no prompt, and starts no session", async () => {
		const clock = new ManualClock(START);
		const schedules = createMemorySchedules({ clock });
		const { memory } = await memoryRuntime();
		try {
			const schedule = await schedules.create(
				human,
				hourly(clock, { payload: { agentId: "agent-1", message: "Write the digest" } }),
			);
			const runner = createScheduleRunner({
				schedules,
				runnerId: "host-a",
				clock,
				timers: new ManualTimers(clock),
				handlers: { task: createTaskHandler({ runtime: memory.runtime, directory: memory.directory }) },
			});
			clock.advance(HOUR);
			const [record] = await runner.runOnce();
			expect(record?.status).toBe("failed");
			const [occurrence] = (await schedules.listOccurrences(human, schedule.id)).items;
			expect(JSON.stringify(occurrence?.result)).toContain("needs a prompt");
			const sessions = (await memory.directory.list(operator, { labels: { [SCHEDULE_LABEL]: schedule.id } })).items;
			expect(sessions).toEqual([]);
		} finally {
			await memory.close();
		}
	});

	it("fails an occurrence of a kind it has no handler for", async () => {
		const clock = new ManualClock(START);
		const schedules = createMemorySchedules({ clock });
		const created = await schedules.create(human, hourly(clock, { kind: "program", payload: "prog-1" }));
		const runner = createScheduleRunner({
			schedules,
			runnerId: "a",
			clock,
			timers: new ManualTimers(clock),
			handlers: {},
		});
		clock.advance(HOUR);
		expect(await runner.runOnce()).toMatchObject([{ status: "failed" }]);
		const [occurrence] = (await schedules.listOccurrences(human, created.id)).items;
		expect(occurrence?.result).toEqual({ error: "This runner has no handler for program" });
	});

	it("renews a long run's lease, so no other runner takes it", async () => {
		const clock = new ManualClock(START);
		const timers = new ManualTimers(clock);
		const schedules = createMemorySchedules({ clock });
		await schedules.create(human, hourly(clock));
		const gate = deferred();
		const runs: string[] = [];
		const slow: OccurrenceHandler = async (run) => {
			runs.push(`a:${run.occurrence.id}`);
			await gate.promise;
			return { status: "succeeded" };
		};
		const other: OccurrenceHandler = async (run) => {
			runs.push(`b:${run.occurrence.id}`);
			return { status: "succeeded" };
		};
		const a = createScheduleRunner({
			schedules,
			runnerId: "a",
			clock,
			timers,
			leaseMs: MINUTE,
			handlers: { task: slow },
		});
		const b = createScheduleRunner({
			schedules,
			runnerId: "b",
			clock,
			timers,
			leaseMs: MINUTE,
			handlers: { task: other },
		});
		clock.advance(HOUR);
		const pass = a.runOnce();
		await timers.advance(5 * MINUTE);
		expect(await b.runOnce()).toEqual([]);
		gate.resolve();
		await timers.advance(0);
		expect(await pass).toMatchObject([{ status: "succeeded" }]);
		expect(runs).toHaveLength(1);
	});

	it("drops the result of a run whose lease another runner took, so the run is finished once", async () => {
		const clock = new ManualClock(START);
		const timers = new ManualTimers(clock);
		const schedules = createMemorySchedules({ clock });
		await schedules.create(human, hourly(clock));
		const signals: AbortSignal[] = [];
		const stuck: OccurrenceHandler = (run) => {
			signals.push(run.signal);
			return new Promise((resolve) =>
				run.signal.addEventListener("abort", () => resolve({ status: "succeeded" }), { once: true }),
			);
		};
		const errors: unknown[] = [];
		const a = createScheduleRunner({
			schedules,
			runnerId: "a",
			clock,
			timers,
			leaseMs: MINUTE,
			handlers: { task: stuck },
			onError: (error) => errors.push(error),
		});
		const b = createScheduleRunner({
			schedules,
			runnerId: "b",
			clock,
			timers: new ManualTimers(clock),
			leaseMs: MINUTE,
			handlers: { task: async () => ({ status: "succeeded", result: "b" }) },
		});
		clock.advance(HOUR);
		const pass = a.runOnce();
		await settle();
		// The process stalls past its lease (no renewal fires) and runner b takes the occurrence over.
		clock.advance(2 * MINUTE);
		expect(await b.runOnce()).toMatchObject([{ status: "succeeded", attempt: 2 }]);
		await timers.advance(MINUTE);
		expect(signals[0]?.aborted).toBe(true);
		expect(await pass).toMatchObject([{ status: "lost" }]);
		expect(errors).toHaveLength(1);
		const [occurrence] = (await schedules.listOccurrences(human, (await schedules.list(human)).items[0]!.id)).items;
		expect(occurrence).toMatchObject({ status: "succeeded", claimedBy: "b", result: "b" });
	});

	it("aborts a run past its time limit and fails the attempt once the handler returns", async () => {
		const clock = new ManualClock(START);
		const timers = new ManualTimers(clock);
		const schedules = createMemorySchedules({ clock });
		await schedules.create(human, hourly(clock));
		const runner = createScheduleRunner({
			schedules,
			runnerId: "a",
			clock,
			timers,
			timeoutMs: { task: 5 * MINUTE },
			handlers: {
				task: (run) =>
					new Promise((resolve) =>
						run.signal.addEventListener("abort", () => resolve({ status: "succeeded" }), { once: true }),
					),
			},
		});
		clock.advance(HOUR);
		const pass = runner.runOnce();
		await timers.advance(5 * MINUTE);
		const [record] = await pass;
		expect(record).toMatchObject({ status: "failed", durationMs: 5 * MINUTE });
		const [occurrence] = (await schedules.listOccurrences(human, record!.scheduleId)).items;
		expect(occurrence?.result).toEqual({ error: "The task run passed its time limit" });
	});

	it("keeps the lease while a timed-out handler winds down, so the next attempt never overlaps it", async () => {
		const clock = new ManualClock(START);
		const timers = new ManualTimers(clock);
		const schedules = createMemorySchedules({ clock });
		await schedules.create(human, hourly(clock));
		const wound = deferred();
		const runner = createScheduleRunner({
			schedules,
			runnerId: "a",
			clock,
			timers,
			leaseMs: MINUTE,
			timeoutMs: { task: 2 * MINUTE },
			handlers: {
				task: async (run) => {
					await new Promise((resolve) => run.signal.addEventListener("abort", resolve, { once: true }));
					await wound.promise;
					return { status: "succeeded" };
				},
			},
		});
		const other = createScheduleRunner({
			schedules,
			runnerId: "b",
			clock,
			timers: new ManualTimers(clock),
			handlers: { task: async () => ({ status: "succeeded" }) },
		});
		clock.advance(HOUR);
		const pass = runner.runOnce();
		await timers.advance(10 * MINUTE);
		expect(await other.runOnce(), "still held while it winds down").toEqual([]);
		wound.resolve();
		expect(await pass).toMatchObject([{ status: "failed" }]);
	});

	it("a stopped runner leaves its run to lapse, and a restarted one runs it again as the same occurrence", async () => {
		const clock = new ManualClock(START);
		const timers = new ManualTimers(clock);
		const schedules = createMemorySchedules({ clock });
		await schedules.create(human, hourly(clock));
		const seen: string[] = [];
		const waitForAbort: OccurrenceHandler = (run) => {
			seen.push(run.occurrence.id);
			return new Promise((resolve) =>
				run.signal.addEventListener("abort", () => resolve({ status: "failed" }), { once: true }),
			);
		};
		const first = createScheduleRunner({
			schedules,
			runnerId: "a",
			clock,
			timers,
			leaseMs: MINUTE,
			handlers: { task: waitForAbort },
		});
		clock.advance(HOUR);
		const pass = first.runOnce();
		await settle();
		await first.stop();
		expect(await pass).toMatchObject([{ status: "interrupted" }]);
		const [left] = (await schedules.listOccurrences(human, (await schedules.list(human)).items[0]!.id)).items;
		expect(left?.status).toBe("running");

		const restarted = createScheduleRunner({
			schedules,
			runnerId: "a2",
			clock,
			timers,
			leaseMs: MINUTE,
			handlers: {
				task: async (run) => {
					seen.push(run.occurrence.id);
					return { status: "succeeded" };
				},
			},
		});
		expect(await restarted.runOnce()).toEqual([]);
		clock.advance(MINUTE);
		expect(await restarted.runOnce()).toMatchObject([{ status: "succeeded", attempt: 2 }]);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]);
	});

	it("a check raises a new finding once, raises check-failed after failed runs, and hands what it raised to the host", async () => {
		const clock = new ManualClock(START);
		const schedules = createMemorySchedules({ clock });
		const check = await schedules.create(
			human,
			hourly(clock, { kind: "check", payload: ["/checks/disk.sh"], check: { failuresBeforeRaise: 2 } }),
		);
		const outputs = [
			{
				exitCode: 3,
				stdout: JSON.stringify({ findings: [{ key: "disk:/", severity: "high", summary: "Disk 91%", value: 91 }] }),
			},
			{ exitCode: 3, stdout: JSON.stringify([{ key: "disk:/", severity: "high", summary: "Disk 92%", value: 92 }]) },
			{ exitCode: 1, stdout: "" },
			{ exitCode: 3, stdout: "not json" },
			{ exitCode: 0, stdout: "ignored" },
		];
		const commands: unknown[] = [];
		const raised: RaisedFinding[][] = [];
		const runner = createScheduleRunner({
			schedules,
			runnerId: "a",
			clock,
			timers: new ManualTimers(clock),
			handlers: {
				check: createCheckHandler({
					execute: async (input) => {
						commands.push(input.command);
						return outputs.shift()!;
					},
				}),
			},
			onRaised: async (findings) => {
				raised.push([...findings]);
			},
		});
		const statuses: string[] = [];
		for (let run = 0; run < 5; run += 1) {
			clock.advance(HOUR);
			const [record] = await runner.runOnce();
			statuses.push(record!.status);
		}
		expect(commands).toEqual(Array.from({ length: 5 }, () => ["/checks/disk.sh"]));
		expect(statuses).toEqual(["succeeded", "succeeded", "failed", "failed", "succeeded"]);
		expect(raised).toEqual([
			[expect.objectContaining({ key: "disk:/", severity: "high", reason: "new", value: 91 })],
			[expect.objectContaining({ key: `check-failed:${check.id}`, severity: "low", reason: "failures" })],
		]);
	});

	it("hands a reminder to the host, held until quiet hours end unless it is urgent", async () => {
		const clock = new ManualClock(Date.parse("2026-10-28T21:00:00Z"));
		const schedules = createMemorySchedules({ clock });
		await schedules.create(human, hourly(clock, { kind: "reminder", payload: "Stretch" }));
		await schedules.create(
			human,
			hourly(clock, { kind: "reminder", title: "Urgent", payload: { message: "Server down", urgent: true } }),
		);
		const delivered: DueReminder[] = [];
		const runner = createScheduleRunner({
			schedules,
			runnerId: "a",
			clock,
			timers: new ManualTimers(clock),
			handlers: {
				reminder: createReminderHandler({
					deliver: async (reminder) => {
						delivered.push(reminder);
					},
					quietHours: () => ({ start: "22:00", end: "08:00", timezone: "Europe/London" }),
				}),
			},
		});
		clock.advance(HOUR);
		expect(await runner.runOnce()).toMatchObject([{ status: "succeeded" }, { status: "succeeded" }]);
		const byMessage = Object.fromEntries(delivered.map((reminder) => [reminder.message, reminder]));
		expect(byMessage.Stretch).toMatchObject({ urgent: false, holdUntil: Date.parse("2026-10-29T08:00:00Z") });
		expect(byMessage["Server down"]).toMatchObject({ urgent: true });
		expect(byMessage["Server down"]?.holdUntil).toBeUndefined();
		expect(new Set(delivered.map((reminder) => reminder.key)).size).toBe(2);
	});
});

describe("quiet hours", () => {
	const quiet = { start: "22:00", end: "08:00", timezone: "Europe/London" };
	it("end later that morning, the next morning, or not at all outside them", () => {
		expect(quietHoursEnd(Date.parse("2026-10-28T23:30:00Z"), quiet)).toBe(Date.parse("2026-10-29T08:00:00Z"));
		expect(quietHoursEnd(Date.parse("2026-10-29T03:00:00Z"), quiet)).toBe(Date.parse("2026-10-29T08:00:00Z"));
		expect(quietHoursEnd(Date.parse("2026-10-29T12:00:00Z"), quiet)).toBeUndefined();
		expect(
			quietHoursEnd(Date.parse("2026-07-01T13:00:00Z"), { start: "13:00", end: "14:00", timezone: "Europe/London" }),
		).toBeUndefined();
		expect(
			quietHoursEnd(Date.parse("2026-07-01T12:30:00Z"), { start: "13:00", end: "14:00", timezone: "Europe/London" }),
		).toBe(Date.parse("2026-07-01T13:00:00Z"));
	});
});

describe("a check's output", () => {
	it("is read by the check contract: 0 healthy, 3 findings as JSON, anything else a failed run", () => {
		expect(parseCheckOutput({ exitCode: 0, stdout: "anything" })).toEqual({ exitCode: 0 });
		expect(parseCheckOutput({ exitCode: 2, stdout: "" })).toEqual({ exitCode: 2 });
		expect(parseCheckOutput({ exitCode: 0, stdout: "", timedOut: true })).toEqual({ exitCode: -1 });
		expect(parseCheckOutput({ exitCode: 3, stdout: "{" })).toEqual({ exitCode: -1 });
		expect(parseCheckOutput({ exitCode: 3, stdout: '{"nope":1}' })).toEqual({ exitCode: -1 });
		expect(parseCheckOutput({ exitCode: 3, stdout: '[{"severity":"high"}]' })).toEqual({ exitCode: -1 });
		expect(
			parseCheckOutput({
				exitCode: 3,
				stdout: JSON.stringify({
					items: [
						{ key: "a", hint: "medium", title: "A is late", evidence: { count: 4 }, change: "escalated" },
						{ key: "b", status: "unchanged" },
					],
				}),
			}),
		).toEqual({
			exitCode: 3,
			findings: [
				{ key: "a", severity: "medium", summary: "A is late", value: 4, status: "escalated" },
				{ key: "b", severity: "low", summary: "b", status: "unchanged" },
			],
		});
	});
});

for (const kind of testDatabaseKinds()) {
	describe(`the scheduler loop on SQL (${kind.name})`, { timeout: kind.testTimeoutMs }, () => {
		it("three runners on three hosts run every occurrence exactly once", async () => {
			const database = await kind.open();
			try {
				await migrateSchedules(database.driver);
				const clock = new ManualClock(START);
				const hosts: Schedules[] = [0, 1, 2].map(() => createSqlSchedules({ driver: database.driver, clock }));
				for (let index = 0; index < 4; index += 1) {
					await hosts[0]!.create(human, hourly(clock, { title: `Job ${index}` }));
				}
				const runs: string[] = [];
				const runners = hosts.map((schedules, index) =>
					createScheduleRunner({
						schedules,
						runnerId: `host-${index}`,
						clock,
						timers: new ManualTimers(clock),
						concurrency: 2,
						handlers: {
							task: async (run) => {
								runs.push(run.occurrence.id);
								return { status: "succeeded" };
							},
						},
					}),
				);
				for (let round = 0; round < 2; round += 1) {
					clock.advance(HOUR);
					const records = (await Promise.all(runners.map((runner) => runner.runOnce()))).flat();
					expect(records.filter((record) => record.status === "succeeded")).toHaveLength(4);
				}
				expect(runs).toHaveLength(8);
				expect(new Set(runs).size).toBe(8);
			} finally {
				await database.close();
			}
			// D1 in Miniflare takes about 15 ms a statement.
		}, 60_000);
	});
}
