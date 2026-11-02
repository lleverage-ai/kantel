// The scheduler on the stack (#23): schedules on the stack's SQL (SQLite standing in for D1), run by `@kantel/schedules`'
// runner from the object's alarm, which the sessions share, and served at `/v1/schedules` through the gateway. A task's
// run starts a session with the prompt exactly as written.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { CallContext, JsonValue, Occurrence, ScheduleInput, SessionRecord } from "@kantel/contracts";
import { OCCURRENCE_LABEL, SCHEDULE_LABEL } from "@kantel/schedules/handlers";
import { createMemorySchedules } from "@kantel/schedules/memory";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { createMemoryWorkspaceStore } from "@kantel/workspace/stored";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { createCloudflareScheduler, MAX_SLEEP_MS, MIN_SLEEP_MS, withDefaultProject } from "../src/schedules.ts";
import { createStack, DEFAULT_AGENT_ID, type SessionObjectStorage, type Stack } from "../src/stack.ts";

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 28, 22, 0);

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** A Durable Object's storage as the stack uses it, over `node:sqlite`, with an alarm the test reads and fires. */
function objectStorage(db: DatabaseSync): SessionObjectStorage & { alarm: number | null } {
	let lock: Promise<unknown> = Promise.resolve();
	const storage = {
		alarm: null as number | null,
		sql: {
			exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
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
		setAlarm: async (at: number) => {
			storage.alarm = at;
		},
		getAlarm: async () => storage.alarm,
	};
	return storage as SessionObjectStorage & { alarm: number | null };
}

async function start() {
	let now = START;
	const clock = { now: () => now };
	const object = objectStorage(new DatabaseSync(":memory:"));
	const stack = await createStack({
		config: gatewayConfig({}),
		clock,
		storage: {
			sql: syncSqliteDriver(new DatabaseSync(":memory:")),
			sessions: object,
			workspaces: createMemoryWorkspaceStore(),
		},
	});
	opened.push(stack);
	return {
		stack,
		object,
		at: (ms: number) => {
			now = ms;
		},
	};
}

/** A task's payload as the public API and the console write it. */
const task = (prompt: string): JsonValue => ({ agentId: DEFAULT_AGENT_ID, prompt });

const everyTenMinutes = (stack: Stack, prompt: string): ScheduleInput => ({
	owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
	kind: "task",
	title: "Ask about the weather",
	timezone: "Europe/London",
	repeat: { every: "minutes", interval: 10, from: START + 10 * MINUTE },
	payload: task(prompt),
});

async function projectSessions(stack: Stack, ctx: CallContext): Promise<readonly SessionRecord[]> {
	return (await stack.runtime.directory.list(ctx, { projectId: stack.project.id })).items;
}

describe("the scheduler on the stack", () => {
	it("arms the alarm for a new schedule, starts a session at each due time, and records it on the run", async () => {
		const { stack, object, at } = await start();
		const prompt = "What's the weather in Amsterdam?\n\nAnswer in one line.";
		const schedule = await stack.schedules.create(stack.admin, everyTenMinutes(stack, prompt));
		expect(schedule.nextDueAt).toBe(START + 10 * MINUTE);
		expect(object.alarm).toBe(START + 10 * MINUTE);

		at(START + 10 * MINUTE);
		await stack.alarm();
		const sessions = await projectSessions(stack, stack.admin);
		expect(sessions).toHaveLength(1);
		const [session] = sessions;
		expect(session).toMatchObject({
			title: "Ask about the weather",
			agentId: DEFAULT_AGENT_ID,
			projectId: stack.project.id,
			createdBy: { kind: "system" },
			labels: { [SCHEDULE_LABEL]: schedule.id, [OCCURRENCE_LABEL]: `${schedule.id}@${START + 10 * MINUTE}` },
		});

		// The run history names the session, and the alarm is armed for the next due time.
		const runs = await stack.schedules.listOccurrences(stack.admin, schedule.id);
		expect(runs.items).toHaveLength(1);
		const run = runs.items[0] as Occurrence;
		expect(run).toMatchObject({ status: "succeeded", result: { sessionId: session?.id } });
		expect(object.alarm).toBe(START + 20 * MINUTE);

		// The agent got the prompt exactly as written: the echo model answers it back, with nothing added.
		const submissionId = (run.result as { submissionId: string }).submissionId;
		const result = await stack.runtime.runtime.wait(stack.admin, session!.id, submissionId);
		expect(result).toMatchObject({ status: "answered", answer: `Echo: ${prompt}` });
		const snapshot = await stack.runtime.runtime.snapshot(stack.admin, session!.id);
		expect(snapshot.items[0]).toMatchObject({ kind: "user", text: prompt });

		// Waking again at the same time starts nothing more.
		await stack.alarm();
		expect(await projectSessions(stack, stack.admin)).toHaveLength(1);
	});

	it("coalesces missed runs into one session, and runs nothing while paused or after ending", async () => {
		const { stack, at, object } = await start();
		const schedule = await stack.schedules.create(stack.admin, everyTenMinutes(stack, "ping"));

		// The object slept through an hour: one run, at the latest due time.
		at(START + 65 * MINUTE);
		await stack.alarm();
		const runs = await stack.schedules.listOccurrences(stack.admin, schedule.id);
		expect(runs.items).toMatchObject([{ dueAt: START + 60 * MINUTE, coalesced: 6, status: "succeeded" }]);
		expect(await projectSessions(stack, stack.admin)).toHaveLength(1);

		await stack.schedules.pause(stack.admin, schedule.id);
		at(START + 95 * MINUTE);
		await stack.alarm();
		expect(await projectSessions(stack, stack.admin)).toHaveLength(1);

		// Resuming doesn't backfill, and arms the alarm for the next due time.
		const resumed = await stack.schedules.resume(stack.admin, schedule.id);
		expect(resumed.nextDueAt).toBe(START + 100 * MINUTE);
		expect(object.alarm).toBe(START + 100 * MINUTE);

		await stack.schedules.end(stack.admin, schedule.id);
		at(START + 120 * MINUTE);
		await stack.alarm();
		expect(await projectSessions(stack, stack.admin)).toHaveLength(1);
	});

	it("runs an organisation's task in the default project, with the default agent when it names none", async () => {
		const { stack, at } = await start();
		const schedule = await stack.schedules.create(stack.admin, {
			...everyTenMinutes(stack, "hello"),
			owner: { kind: "organisation", organisationId: stack.organisation.id },
			payload: { prompt: "hello" },
		});
		at(START + 10 * MINUTE);
		await stack.alarm();
		const [run] = (await stack.schedules.listOccurrences(stack.admin, schedule.id)).items;
		expect(run).toMatchObject({ status: "succeeded" });
		const sessions = await projectSessions(stack, stack.admin);
		expect(sessions.map((session) => [session.labels[SCHEDULE_LABEL], session.agentId])).toEqual([
			[schedule.id, DEFAULT_AGENT_ID],
		]);
	});

	it("runs a check's command in the isolate with no model, and raises its findings once", async () => {
		const { stack, at } = await start();
		const findings = JSON.stringify([{ key: "disk:/", severity: "high", summary: "Disk nearly full", value: 97 }]);
		const schedule = await stack.schedules.create(stack.admin, {
			owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
			kind: "check",
			title: "Disk",
			timezone: "UTC",
			repeat: { every: "minutes", interval: 10, from: START + 10 * MINUTE },
			payload: `echo '${findings}'; exit 3`,
		});
		at(START + 10 * MINUTE);
		await stack.alarm();
		at(START + 20 * MINUTE);
		await stack.alarm();
		const runs = (await stack.schedules.listOccurrences(stack.admin, schedule.id)).items;
		expect(runs).toHaveLength(2);
		for (const run of runs) expect(run).toMatchObject({ status: "succeeded", result: { exitCode: 3 } });
		const raised = await stack.audit.query(stack.admin, { type: "schedules.finding.raised" });
		expect(raised.items).toHaveLength(1);
		// Each run's session is closed once the command ends.
		const sessions = await projectSessions(stack, stack.admin);
		expect(sessions.map((session) => [session.title, session.status])).toEqual([
			["Check: Disk", "done"],
			["Check: Disk", "done"],
		]);
	});

	it("fails a run whose payload isn't a task's, saying why, and keeps the schedule running", async () => {
		const { stack, at } = await start();
		const schedule = await stack.schedules.create(stack.admin, {
			...everyTenMinutes(stack, "x"),
			payload: { brief: "no prompt here" },
		});
		at(START + 10 * MINUTE);
		await stack.alarm();
		const runs = await stack.schedules.listOccurrences(stack.admin, schedule.id);
		expect(runs.items).toMatchObject([{ status: "failed" }]);
		expect((await stack.schedules.get(stack.admin, schedule.id)).status).toBe("active");
	});
});

describe("the schedule routes on the gateway", () => {
	it("creates a schedule over /v1/schedules with an API key, arms the alarm, and lists its runs", async () => {
		const { stack, object, at } = await start();
		const gateway = createGateway(stack);
		const service = await stack.identity.createServiceIdentity(stack.admin, { name: "host" });
		const issued = await stack.identity.issueApiKey(stack.admin, {
			serviceId: service.id,
			projectIds: [stack.project.id],
			role: "operator",
		});
		const call = (path: string, init: RequestInit = {}) =>
			gateway.fetch(
				new Request(`https://kantel.test/v1${path}`, {
					...init,
					headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" },
				}),
			);

		expect((await gateway.fetch(new Request("https://kantel.test/v1/schedules"))).status).toBe(401);

		const created = await call("/schedules", {
			method: "POST",
			body: JSON.stringify(everyTenMinutes(stack, "From the API")),
		});
		expect(created.status).toBe(201);
		const schedule = (await created.json()) as { id: string; nextDueAt: number };
		expect(schedule.nextDueAt).toBe(START + 10 * MINUTE);
		expect(object.alarm).toBe(START + 10 * MINUTE);

		at(START + 10 * MINUTE);
		await stack.alarm();
		const runs = (await (await call(`/schedules/${schedule.id}/runs`)).json()) as { items: Occurrence[] };
		expect(runs.items).toMatchObject([{ status: "succeeded", result: { sessionId: expect.any(String) } }]);

		const ended = await call(`/schedules/${schedule.id}`, { method: "DELETE" });
		expect(((await ended.json()) as { status: string }).status).toBe("ended");
		await gateway.close();
	});
});

describe("the Cloudflare scheduler", () => {
	const organisationId = "org-1";
	const ctx: CallContext = { actor: { kind: "human", userId: "u1" }, organisationId };
	const none = async () => {
		throw new Error("no sessions here");
	};

	function host(now: { value: number }) {
		const clock = { now: () => now.value };
		const schedules = createMemorySchedules({ clock });
		const scheduler = createCloudflareScheduler({
			schedules,
			runtime: { create: none, prompt: none, wait: none, close: none },
			directory: { list: none },
			clock,
			organisationId,
			defaultProjectId: "p-default",
			defaultAgentId: "assistant",
		});
		return { schedules, scheduler };
	}

	it("sleeps until the next due time, no longer than the longest sleep, and not at all with nothing active", async () => {
		const now = { value: START };
		const { schedules, scheduler } = host(now);
		expect(await scheduler.nextWakeAt()).toBeUndefined();
		await schedules.create(ctx, {
			owner: { kind: "organisation", organisationId },
			kind: "check",
			title: "Daily",
			timezone: "UTC",
			repeat: { every: "hours", interval: 24, from: START + 24 * 60 * MINUTE },
			payload: "true",
		});
		expect(await scheduler.nextWakeAt()).toBe(START + MAX_SLEEP_MS);
	});

	it("looks again shortly, not at once, while a schedule waits on an occurrence still held", async () => {
		const now = { value: START };
		const { schedules, scheduler } = host(now);
		await schedules.create(ctx, {
			owner: { kind: "organisation", organisationId },
			kind: "task",
			title: "Held",
			timezone: "UTC",
			repeat: { every: "minutes", interval: 5, from: START + MINUTE },
			payload: task("x"),
		});
		now.value = START + MINUTE;
		const other = { actor: { kind: "system", component: "other" } } as const;
		await schedules.tick(other);
		// Another runner holds the occurrence; this one's wake finds nothing to claim.
		await schedules.claim(other, "other", 60 * MINUTE);
		now.value = START + 6 * MINUTE;
		const { runs, nextWakeAt } = await scheduler.wake();
		expect(runs).toEqual([]);
		expect(nextWakeAt).toBe(START + 6 * MINUTE + MIN_SLEEP_MS);
	});

	it("gives an organisation's or a user's task the default project, and never changes its prompt", () => {
		const base = {
			id: "sch",
			kind: "task",
			title: "t",
			timezone: "UTC",
			status: "active",
			occurrences: 0,
			createdBy: ctx.actor,
			createdAt: START,
			updatedAt: START,
		} as const;
		const prompt = "  Two lines,\nas written.  ";
		const org = { ...base, owner: { kind: "organisation", organisationId }, payload: { prompt } } as const;
		expect(withDefaultProject(org, "p-default").payload).toEqual({ prompt, projectId: "p-default" });
		const named = { ...org, payload: { prompt, projectId: "p-1" } };
		expect(withDefaultProject(named, "p-default")).toBe(named);
		const project = { ...org, owner: { kind: "project", organisationId, projectId: "p-2" } } as const;
		expect(withDefaultProject(project, "p-default")).toBe(project);
	});
});
