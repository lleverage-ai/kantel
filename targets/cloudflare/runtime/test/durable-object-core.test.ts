// The session object's core: a restart mid model call (two cores over one database, as an evicted object and its next
// instance), the alarm armed for a sleeping session and `alarm()` resuming it, and the session API on `fetch`.
import { DatabaseSync } from "node:sqlite";
import type { AgentProfile, Authentication } from "@harbour/contracts";
import { staticTokenAuthenticator } from "@harbour/runtime/http";
import { createScriptedModel } from "@harbour/runtime/testing";
import { ManualClock } from "@harbour/testing/harness";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRuntimeDurableObjectCore } from "../src/index.ts";
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
