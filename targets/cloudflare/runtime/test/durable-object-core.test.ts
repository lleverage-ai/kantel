// The session object's core: a restart mid model call and mid host tool call (two cores over one database, as an
// evicted object and its next instance), the alarm armed for a sleeping session and `alarm()` resuming it, and the
// session API on `fetch`.
import { DatabaseSync } from "node:sqlite";
import type { AgentProfile, Authentication, HostToolCall, HostToolResult, ReplayPolicy } from "@kantel/contracts";
import { createHostToolEndpoint, staticTokenAuthenticator } from "@kantel/runtime/http";
import { createScriptedModel } from "@kantel/runtime/testing";
import { ManualClock } from "@kantel/testing/harness";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionRuntimeDurableObjectCore, sessionsWithPiTables } from "../src/index.ts";
import { coreOn, fakeAlarm } from "./support.ts";

const ORG = "org-object";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [{ name: "role", text: "You help." }],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A core cleaned up after the test; `before` runs first, for a hung call that must fail before its core closes. */
function track(core: SessionRuntimeDurableObjectCore, before?: () => void): SessionRuntimeDurableObjectCore {
	cleanups.unshift(async () => {
		before?.();
		await core.close();
	});
	return core;
}

function database(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	cleanups.push(() => db.close());
	return db;
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("SessionRuntimeDurableObjectCore", () => {
	it("resumes a run cut off mid model call when a second core is built over the same storage", async () => {
		const db = database();
		let fail: (error: Error) => void = () => {};
		const hung = new Promise<never>((_resolve, reject) => {
			fail = reject;
		});
		hung.catch(() => undefined);
		const firstModel = createScriptedModel();
		const first = track(coreOn(db, firstModel.models), () => fail(new Error("the object is gone")));
		const service = await first.ready;
		await service.profiles.put(ctx, profile);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		firstModel.script.reply(() => hung);
		const prompt = await service.runtime.prompt(ctx, session.id, { text: "Hello" });
		await until(() => firstModel.script.requests.length === 1, "the first model call");
		await until(
			async () => (await service.directory.get(ctx, session.id)).status === "running",
			"the session to show running",
		);

		// The object is evicted mid call; its next instance resumes the run while it gets ready.
		const secondModel = createScriptedModel();
		secondModel.script.reply({ text: "Answered after the restart" });
		const second = track(coreOn(db, secondModel.models));
		const resumed = await second.ready;
		await until(() => secondModel.script.requests.length === 1, "the resumed model call");
		expect(await resumed.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({
			status: "answered",
			answer: "Answered after the restart",
		});
		expect(secondModel.script.requests[0]?.messages.at(-1)).toMatchObject({ role: "user", text: "Hello" });
		expect((await resumed.directory.get(ctx, session.id)).status).toBe("idle");
	});

	it("arms the alarm for a retry's backoff, keeps it across a restart, and resumes the session from alarm()", async () => {
		const db = database();
		const clock = new ManualClock();
		const alarm = fakeAlarm();
		const firstModel = createScriptedModel();
		const first = coreOn(db, firstModel.models, alarm, { clock });
		const service = await first.ready;
		await service.profiles.put(ctx, profile);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		// The model fails once; Pi retries after a backoff, which is a stored sleep.
		firstModel.script.reply(() => {
			throw Object.assign(new Error("overloaded"), { status: 529 });
		});
		const prompt = await service.runtime.prompt(ctx, session.id, { text: "Hello" });
		// Admitting the prompt armed the alarm at once, so an eviction mid run is woken; the platform fires it.
		expect(alarm.armed).toBe(clock.now());
		await alarm.fire(first);
		await until(() => alarm.armed !== null && alarm.armed > clock.now(), "the alarm for the backoff");
		const retryAt = alarm.armed!;

		// Evicted while it sleeps: the next instance finds nothing due, and leaves the alarm where it is.
		await first.close();
		const secondModel = createScriptedModel();
		secondModel.script.reply({ text: "Answered on retry" });
		const second = track(coreOn(db, secondModel.models, alarm, { clock }));
		const resumed = await second.ready;
		// This instance's own timer for the wake fires the backoff's length of real time from now.
		const ownTimerAt = Date.now() + (retryAt - clock.now());
		expect(alarm.armed).toBe(retryAt);
		expect(secondModel.script.requests).toHaveLength(0);

		// The backoff falls due and the platform fires the alarm: alarm() resumes the session, well before that timer.
		clock.set(retryAt);
		await alarm.fire(second);
		await until(() => secondModel.script.requests.length === 1, "the retried model call");
		expect(Date.now()).toBeLessThan(ownTimerAt);
		expect(await resumed.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({ answer: "Answered on retry" });
		expect(alarm.later).toEqual([]);
	});

	it("keeps a watchdog alarm while a run is in progress, after its alarm fires and after an alarm-driven restart", async () => {
		const db = database();
		const clock = new ManualClock();
		const alarm = fakeAlarm();
		let fail: (error: Error) => void = () => {};
		const hung = new Promise<never>((_resolve, reject) => {
			fail = reject;
		});
		hung.catch(() => undefined);
		const firstModel = createScriptedModel();
		const first = coreOn(db, firstModel.models, alarm, { clock, watchdogMs: 5_000 });
		const service = await first.ready;
		await service.profiles.put(ctx, profile);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		firstModel.script.reply(() => hung);
		await service.runtime.prompt(ctx, session.id, { text: "Hello" });
		await until(() => firstModel.script.requests.length === 1, "the model call");

		// The admission's alarm fires mid call: the run is still going, so the alarm comes back after the watchdog.
		await alarm.fire(first);
		expect(alarm.armed).toBe(clock.now() + 5_000);

		// Evicted mid call; the watchdog brings the next instance up, which resumes the run and keeps the watchdog.
		fail(new Error("the object is gone"));
		await first.close();
		clock.advance(5_000);
		const secondModel = createScriptedModel();
		let failSecond: (error: Error) => void = () => {};
		const hungAgain = new Promise<never>((_resolve, reject) => {
			failSecond = reject;
		});
		hungAgain.catch(() => undefined);
		secondModel.script.reply(() => hungAgain);
		const second = track(coreOn(db, secondModel.models, alarm, { clock, watchdogMs: 5_000 }), () =>
			failSecond(new Error("the test is over")),
		);
		await alarm.fire(second);
		await until(() => secondModel.script.requests.length === 1, "the resumed model call");
		expect(alarm.armed).toBe(clock.now() + 5_000);
	});

	it("refuses a watchdog interval that isn't a positive number", () => {
		const db = database();
		const { models } = createScriptedModel();
		for (const watchdogMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => coreOn(db, models, fakeAlarm(), { watchdogMs })).toThrow(RangeError);
		}
	});

	it("archives closed sessions' tables from the alarm, a batch at a time, and stops when none is left", async () => {
		const db = database();
		const clock = new ManualClock();
		const { models } = createScriptedModel();
		// Before #216 shipped: closing a session left its tables.
		const before = coreOn(db, models, fakeAlarm(), { clock, archive: async () => false, archiveSweep: false });
		const service = await before.ready;
		await service.profiles.put(ctx, profile);
		const closed: string[] = [];
		for (let index = 0; index < 5; index++) {
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			await service.runtime.close(ctx, session.id);
			closed.push(session.id);
		}
		const open = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await before.close();

		// The next instance archives nothing while it starts; it arms the alarm for the first batch.
		const alarm = fakeAlarm();
		const core = track(coreOn(db, models, alarm, { clock, archiveSweep: { batch: 2, intervalMs: 1_000 } }));
		const after = await core.ready;
		const withTables = async () => (await sessionsWithPiTables(core.database)).length;
		expect(await withTables()).toBe(6);
		expect(alarm.armed).toBe(clock.now() + 1_000);

		clock.advance(1_000);
		await alarm.fire(core);
		expect(await withTables()).toBe(4);
		expect(alarm.armed).toBe(clock.now() + 1_000);
		clock.advance(1_000);
		await alarm.fire(core);
		expect(await withTables()).toBe(2);
		clock.advance(1_000);
		await alarm.fire(core);
		// A short batch: nothing closed is left, and the alarm isn't armed again for the backfill.
		expect(await sessionsWithPiTables(core.database)).toEqual([open.id]);
		expect(alarm.armed).toBeNull();

		for (const id of closed) expect((await after.runtime.snapshot(ctx, id)).status).toBe("done");
		expect((await after.runtime.snapshot(ctx, open.id)).status).toBe("idle");

		// Starting again with only open sessions' tables arms nothing.
		await core.close();
		const quiet = fakeAlarm();
		const again = track(coreOn(db, models, quiet, { clock }));
		await again.ready;
		expect(await sessionsWithPiTables(again.database)).toEqual([open.id]);
		expect(quiet.set).toEqual([]);
	});

	it("refuses an archive backfill batch or interval that isn't positive", () => {
		const db = database();
		const { models } = createScriptedModel();
		for (const batch of [0, -1, 1.5, Number.NaN]) {
			expect(() => coreOn(db, models, fakeAlarm(), { archiveSweep: { batch } })).toThrow(RangeError);
		}
		for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => coreOn(db, models, fakeAlarm(), { archiveSweep: { intervalMs } })).toThrow(RangeError);
		}
	});

	it("never moves an alarm an earlier instance armed to a later wake", async () => {
		const db = database();
		const clock = new ManualClock();
		const alarm = fakeAlarm();
		alarm.arm(clock.now() - 1);
		const model = createScriptedModel();
		const core = track(coreOn(db, model.models, alarm, { clock }));
		const service = await core.ready;
		await service.profiles.put(ctx, profile);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		model.script.reply({ text: "Hi" });
		const prompt = await service.runtime.prompt(ctx, session.id, { text: "Hello" });
		await service.runtime.wait(ctx, session.id, prompt.id);
		expect(alarm.set).toEqual([]);
		expect(alarm.armed).toBe(clock.now() - 1);
	});

	it("serves the session API on fetch, to authenticated callers only", async () => {
		const owner: Authentication = { actor: ctx.actor, organisationId: ORG };
		const model = createScriptedModel();
		const core = track(
			coreOn(database(), model.models, undefined, { authenticator: staticTokenAuthenticator({ owner }) }),
		);
		const service = await core.ready;
		await service.profiles.put(ctx, profile);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		const url = `https://session.internal/v1/sessions/${session.id}`;
		const response = await core.fetch(new Request(url, { headers: { authorization: "Bearer owner" } }));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: session.id, status: "idle" });
		expect((await core.fetch(new Request(url))).status).toBe(401);
	});
});

describe("SessionRuntimeDurableObjectCore, evicted mid host tool call", () => {
	const owner: Authentication = { actor: ctx.actor, organisationId: ORG };
	const SECRET = "a-callback-secret-of-at-least-32-characters";
	const lookup = (replay: ReplayPolicy) => ({
		name: "lookup",
		description: "Looks up",
		inputSchema: { type: "object" },
		replay,
	});
	const withTool: AgentProfile = { ...profile, tools: ["lookup"], hostId: "atlas" };

	/** The host's side of the callback, checking Kantel's signature, as each instance of the object reaches it. */
	const hostAt =
		(handler: (call: HostToolCall) => Promise<HostToolResult>): typeof fetch =>
		async (input, init) =>
			createHostToolEndpoint(handler, { secret: SECRET })(new Request(input, init));

	const coreWith = (db: DatabaseSync, models: ReturnType<typeof createScriptedModel>["models"], host: typeof fetch) =>
		coreOn(db, models, undefined, {
			authenticator: staticTokenAuthenticator({ owner }),
			api: { fetch: host },
		});

	/**
	 * The first instance: a host registers over the session API, a prompt runs, and the instance is evicted while its
	 * call to the host is out. That call fails only at cleanup, once the next instance has closed.
	 */
	async function evictedMidToolCall(db: DatabaseSync, replay: ReplayPolicy) {
		const reached: string[] = [];
		let fail: (error: Error) => void = () => {};
		const hung = new Promise<never>((_resolve, reject) => {
			fail = reject;
		});
		hung.catch(() => undefined);
		const model = createScriptedModel();
		const first = track(
			coreWith(
				db,
				model.models,
				hostAt(async (call) => {
					reached.push(`first:${call.callId}`);
					return hung;
				}),
			),
			() => fail(new Error("the object is gone")),
		);
		const service = await first.ready;
		await service.profiles.put(ctx, withTool);
		const registered = await first.fetch(
			new Request("https://session.internal/v1/hosts/atlas", {
				method: "PUT",
				headers: { authorization: "Bearer owner", "content-type": "application/json" },
				body: JSON.stringify({
					tools: [lookup(replay)],
					callback: { url: "https://atlas.test/hosts/atlas", secret: SECRET },
				}),
			}),
		);
		expect(registered.status).toBe(200);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		model.script.reply({ toolCalls: [{ name: "lookup", args: { key: "plan" } }] });
		const prompt = await service.runtime.prompt(ctx, session.id, { text: "Find the plan" });
		await until(() => reached.length === 1, "the first host call");
		return { session, prompt, reached };
	}

	it("reruns a replay-safe host tool with the same call ID in the next instance, which nobody re-registered", async () => {
		const db = database();
		const { session, prompt, reached } = await evictedMidToolCall(db, "safe");

		const model = createScriptedModel();
		model.script.reply({ text: "Found it" });
		const second = track(
			coreWith(
				db,
				model.models,
				hostAt(async (call) => {
					reached.push(`second:${call.callId}`);
					return { output: "the plan" };
				}),
			),
		);
		const resumed = await second.ready;
		expect(await resumed.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({
			status: "answered",
			answer: "Found it",
		});
		const [firstCall, secondCall] = reached.map((entry) => entry.split(":")[1]);
		expect(reached.map((entry) => entry.split(":")[0])).toEqual(["first", "second"]);
		expect(secondCall).toBe(firstCall);
		expect(model.script.requests[0]?.messages.at(-1)).toMatchObject({ role: "tool", text: "the plan" });
		expect((await resumed.directory.get(ctx, session.id)).status).toBe("idle");
	});

	it("does not rerun a host tool that is not replay-safe; the model hears it was interrupted", async () => {
		const db = database();
		const { session, prompt, reached } = await evictedMidToolCall(db, "unsafe");

		const model = createScriptedModel();
		model.script.reply({ text: "It was interrupted; I will not retry" });
		const second = track(
			coreWith(
				db,
				model.models,
				hostAt(async (call) => {
					reached.push(`second:${call.callId}`);
					return { output: "charged again" };
				}),
			),
		);
		const resumed = await second.ready;
		expect(await resumed.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({ status: "answered" });
		expect(reached).toHaveLength(1);
		const toolResult = model.script.requests[0]?.messages.find((message) => message.role === "tool");
		expect(toolResult?.text).toMatch(/interrupt/i);
	});
});
