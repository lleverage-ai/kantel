// Idle sessions put away (`idleMs`, `putAwayIdle`): a process hosting many sessions (the Cloudflare stack object, one
// 128 MB isolate) keeps only those at work in memory. A session put away opens again from storage on its next call,
// with the same transcript, and one at work, watched or sleeping is never put away.
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { AgentProfile, Clock, SessionId } from "@kantel/contracts";
import { createSessionRuntime, type SessionRuntimeOptions } from "@kantel/runtime/core";
import { createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-idle";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};
const IDLE_MS = 60_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function runtimeWith(options: Partial<SessionRuntimeOptions> = {}) {
	const db = await openNodeSqliteDatabase(":memory:");
	const { models, script } = createScriptedModel();
	let time = Date.now();
	const clock: Clock = { now: () => time };
	// Each Harness the runtime opens, by session: a session put away and used again is opened twice.
	const opened = new Map<SessionId, number>();
	const service = createSessionRuntime({
		store: await createSqlSessionStore(db),
		storage: (session) => {
			opened.set(session.id, (opened.get(session.id) ?? 0) + 1);
			return sqlPiStorage(db, session.id);
		},
		models,
		clock,
		idleMs: IDLE_MS,
		...options,
	});
	cleanups.push(async () => {
		await service.close();
		await db.close();
	});
	await service.profiles.put(ctx, profile);
	const advance = (ms: number) => {
		time += ms;
	};
	return { service, script, opened, advance };
}

/** A session that has answered one prompt and has nothing more to do. */
async function answered(runtime: Awaited<ReturnType<typeof runtimeWith>>) {
	const { service, script } = runtime;
	const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
	script.reply({ text: "Forty-two" });
	const prompt = await service.runtime.prompt(ctx, session.id, { text: "The answer?" });
	await service.runtime.wait(ctx, session.id, prompt.id);
	return session;
}

describe("idle sessions", () => {
	it("are put away once idle for idleMs, and open again from storage with the same transcript", async () => {
		const runtime = await runtimeWith();
		const { service, opened, advance, script } = runtime;
		const session = await answered(runtime);
		const before = await service.runtime.snapshot(ctx, session.id);

		advance(IDLE_MS - 1);
		expect(await service.putAwayIdle()).toBe(0);
		advance(1);
		expect(await service.putAwayIdle()).toBe(1);
		expect(opened.get(session.id)).toBe(1);

		const after = await service.runtime.snapshot(ctx, session.id);
		expect(opened.get(session.id)).toBe(2);
		expect(after.items).toEqual(before.items);
		expect(after.status).toBe("idle");
		expect(after.status).toBe(before.status);

		// And it carries on where it was: the model sees the whole conversation.
		script.reply({ text: "Still forty-two" });
		const next = await service.runtime.prompt(ctx, session.id, { text: "Sure?" });
		expect((await service.runtime.wait(ctx, session.id, next.id)).status).toBe("answered");
		expect(script.requests.at(-1)?.messages.map((message) => message.text)).toEqual([
			"The answer?",
			"Forty-two",
			"Sure?",
		]);
	});

	it("are not put away while watched, and are once the last watcher leaves and idleMs passes", async () => {
		const runtime = await runtimeWith();
		const { service, advance } = runtime;
		const session = await answered(runtime);
		const watch = await service.runtime.watch(ctx, session.id, {}, () => undefined);
		advance(IDLE_MS * 2);
		expect(await service.putAwayIdle()).toBe(0);
		await watch.close();
		expect(await service.putAwayIdle()).toBe(0);
		advance(IDLE_MS);
		expect(await service.putAwayIdle()).toBe(1);
	});

	it("are not put away while at work", async () => {
		const runtime = await runtimeWith();
		const { service, script, advance } = runtime;
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started: () => void = () => undefined;
		const calling = new Promise<void>((resolve) => {
			started = resolve;
		});
		script.reply(async () => {
			started();
			await held;
			return { text: "Done at last" };
		});
		const prompt = await service.runtime.prompt(ctx, session.id, { text: "Take your time" });
		await calling;
		advance(IDLE_MS * 2);
		expect(await service.putAwayIdle()).toBe(0);
		release();
		expect((await service.runtime.wait(ctx, session.id, prompt.id)).status).toBe("answered");
		advance(IDLE_MS);
		expect(await service.putAwayIdle()).toBe(1);
	});

	it("are never put away without idleMs", async () => {
		const runtime = await runtimeWith({ idleMs: undefined });
		await answered(runtime);
		runtime.advance(IDLE_MS * 10);
		expect(await runtime.service.putAwayIdle()).toBe(0);
	});

	it("refuses an idleMs a timer can't hold", async () => {
		await expect(runtimeWith({ idleMs: 0 })).rejects.toMatchObject({ code: "invalid" });
		await expect(runtimeWith({ idleMs: 2 ** 31 })).rejects.toMatchObject({ code: "invalid" });
	});
});
