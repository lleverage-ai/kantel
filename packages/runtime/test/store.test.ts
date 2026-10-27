import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { AgentProfile, SessionRecord } from "@harbour/contracts";
import type { ServerFrame } from "@harbour/protocol";
import { createSessionRuntime } from "@harbour/runtime/core";
import { createSqlSessionStore, piPrefixFor, sqlPiStorage } from "@harbour/runtime/sql";
import { createMemorySessionStore, type SessionStore } from "@harbour/runtime/store";
import { createScriptedModel } from "@harbour/runtime/testing";
import { describe, expect, it } from "vitest";

const ORG = "org-a";
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

const recordFor = (id: string, createdAt: number, extra: Partial<SessionRecord> = {}): SessionRecord => ({
	id,
	organisationId: ORG,
	projectId: "proj",
	agentId: "worker",
	status: "idle",
	labels: {},
	createdBy: { kind: "service", serviceId: "test" },
	createdAt,
	updatedAt: createdAt,
	...extra,
});

const stores: [string, () => Promise<{ store: SessionStore; close(): Promise<void> }>][] = [
	["memory", async () => ({ store: createMemorySessionStore(), close: async () => {} })],
	[
		"SQL",
		async () => {
			const db = await openNodeSqliteDatabase(":memory:");
			return { store: await createSqlSessionStore(db), close: () => db.close() };
		},
	],
];

describe.each(stores)("session store (%s)", (_name, open) => {
	it("keeps profiles per organisation, by ID", async () => {
		const { store, close } = await open();
		await store.putProfile({ ...profile, id: "b" });
		await store.putProfile({ ...profile, id: "a" });
		await store.putProfile({ ...profile, id: "a", name: "Renamed" });
		await store.putProfile({ ...profile, organisationId: "org-b", id: "c" });
		expect((await store.profiles(ORG)).map((item) => [item.id, item.name])).toEqual([
			["a", "Renamed"],
			["b", "Worker"],
		]);
		expect(await store.profile("org-b", "a")).toBeUndefined();
		await close();
	});

	it("lists sessions newest first with ties broken by sequence, filters, and keeps updates", async () => {
		const { store, close } = await open();
		const first = await store.createSession({
			record: recordFor("s1", 10),
			profile,
			aborts: 0,
			closed: false,
		});
		const second = await store.createSession({
			record: recordFor("s2", 10, { parentSessionId: "s1" }),
			profile,
			aborts: 0,
			closed: false,
		});
		await store.createSession({
			record: recordFor("s3", 5, { projectId: "other" }),
			profile,
			aborts: 0,
			closed: false,
		});
		expect(second.sequence).toBeGreaterThan(first.sequence);
		expect((await store.sessions(ORG)).map((s) => s.record.id)).toEqual(["s2", "s1", "s3"]);
		expect((await store.sessions(ORG, { projectId: "other" })).map((s) => s.record.id)).toEqual(["s3"]);
		expect((await store.sessions(ORG, { parentSessionId: "s1" })).map((s) => s.record.id)).toEqual(["s2"]);
		expect(await store.sessions("org-b")).toEqual([]);
		await store.updateSession("s1", { closed: true, aborts: 2, record: recordFor("s1", 10, { status: "done" }) });
		expect(await store.session("s1")).toMatchObject({ closed: true, aborts: 2, record: { status: "done" } });
		expect((await store.openSessions()).map((s) => s.record.id)).toEqual(["s2", "s3"]);
		await expect(
			store.createSession({ record: recordFor("s1", 1), profile, aborts: 0, closed: false }),
		).rejects.toThrow();
		await close();
	});

	it("keeps the first submission under an ID", async () => {
		const { store, close } = await open();
		await store.putSubmission({ submission: { id: "s1/1", sessionId: "s1", via: "prompt" }, piSubmissionId: 1 });
		await store.putSubmission({ submission: { id: "s1/1", sessionId: "s1", via: "steer" }, piSubmissionId: 9 });
		expect(await store.submission("s1", "s1/1")).toEqual({
			submission: { id: "s1/1", sessionId: "s1", via: "prompt" },
			piSubmissionId: 1,
		});
		expect(await store.submission("s2", "s1/1")).toBeUndefined();
		await close();
	});

	it("replaces a host's registration, removes only the current one, and lists the durable ones", async () => {
		const { store, close } = await open();
		const host = { organisationId: ORG, hostId: "sal", tools: [], registration: "r1" };
		await store.putHost(host);
		await store.putHost({ ...host, registration: "r2", callback: { url: "https://sal.example/tools", secret: "x" } });
		expect(await store.deleteHost(ORG, "sal", "r1")).toBe(false);
		expect((await store.hosts()).map((item) => item.registration)).toEqual(["r2"]);
		expect(await store.deleteHost(ORG, "sal", "r2")).toBe(true);
		expect(await store.host(ORG, "sal")).toBeUndefined();
		await close();
	});
});

describe("session runtime on SQL", () => {
	it("gives a session's Pi tables a prefix from its UUID, and refuses an ID that is not one", () => {
		expect(piPrefixFor("0F8FAD5B-D9CB-469F-A165-70867728950E")).toBe("pi_0f8fad5bd9cb469fa16570867728950e_");
		expect(() => piPrefixFor("x; DROP TABLE")).toThrow();
	});

	it("finds sessions, profiles and transcripts again in a runtime opened later on the same database", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
		const open = async () => {
			const { models, script } = createScriptedModel();
			const service = createSessionRuntime({
				store: await createSqlSessionStore(db),
				storage: (session) => sqlPiStorage(db, session.id),
				models,
			});
			return { service, script };
		};

		const first = await open();
		await first.service.profiles.put(ctx, profile);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker", title: "Kept" });
		first.script.reply({ text: "First answer" });
		const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Hello" });
		await first.service.runtime.wait(ctx, session.id, prompt.id);
		await first.service.close();

		const second = await open();
		expect(await second.service.profiles.get(ctx, "worker")).toEqual(profile);
		expect(await second.service.directory.get(ctx, session.id)).toMatchObject({ title: "Kept", status: "idle" });
		expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({ answer: "First answer" });
		const items = (await second.service.runtime.snapshot(ctx, session.id)).items;
		expect(items.map((item) => item.kind)).toEqual(["user", "assistant"]);
		second.script.reply({ text: "Second answer" });
		const next = await second.service.runtime.prompt(ctx, session.id, { text: "Again" });
		expect(await second.service.runtime.wait(ctx, session.id, next.id)).toMatchObject({ answer: "Second answer" });
		await second.service.runtime.close(ctx, session.id);
		await second.service.close();

		const third = await open();
		expect((await third.service.directory.get(ctx, session.id)).status).toBe("done");
		await expect(third.service.runtime.prompt(ctx, session.id, { text: "More" })).rejects.toMatchObject({
			code: "conflict",
		});
		await third.service.close();
		await db.close();
	});

	it("answers a cursor from before a restart with a snapshot, not a resume that misses what happened since", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		const first = await openOn(db);
		await first.service.profiles.put(ctx, profile);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		const frames: ServerFrame[] = [];
		const watching = await first.service.runtime.watch(ctx, session.id, {}, (frame) => frames.push(frame));
		const seen = frames.find((frame) => frame.type === "hello");
		await watching.close();
		first.script.reply({ text: "Answered while away" });
		const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Hello" });
		await first.service.runtime.wait(ctx, session.id, prompt.id);
		await first.service.close();

		const second = await openOn(db);
		const after: ServerFrame[] = [];
		if (seen?.type !== "hello") throw new Error("no hello");
		const again = await second.service.runtime.watch(ctx, session.id, { after: seen.cursor }, (frame) =>
			after.push(frame),
		);
		expect(after[0]).toMatchObject({ type: "hello", resumed: false });
		const snapshot = after.find((frame) => frame.type === "snapshot");
		expect(snapshot?.type === "snapshot" && snapshot.snapshot.items.map((item) => item.kind)).toEqual([
			"user",
			"assistant",
		]);
		await again.close();
		await second.service.close();
		await db.close();
	});

	it("retries a close whose store write failed, and the session stays closed after a restart", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		let failClose = true;
		const first = await openOn(db, (store) => ({
			...store,
			async updateSession(sessionId, change) {
				if (change.closed === true && failClose) {
					failClose = false;
					throw new Error("store down");
				}
				return store.updateSession(sessionId, change);
			},
		}));
		await first.service.profiles.put(ctx, profile);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await expect(first.service.runtime.close(ctx, session.id)).rejects.toThrow("store down");
		await expect(first.service.runtime.prompt(ctx, session.id, { text: "More" })).rejects.toMatchObject({
			code: "conflict",
		});
		await first.service.runtime.close(ctx, session.id);
		await first.service.close();

		const second = await openOn(db);
		expect((await second.service.directory.get(ctx, session.id)).status).toBe("done");
		await expect(second.service.runtime.prompt(ctx, session.id, { text: "More" })).rejects.toMatchObject({
			code: "conflict",
		});
		await second.service.close();
		await db.close();
	});

	it("carries on writing a session's record after one write fails", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		let failNext = false;
		const first = await openOn(db, (store) => ({
			...store,
			async updateSession(sessionId, change) {
				if (change.record !== undefined && failNext) {
					failNext = false;
					throw new Error("store blip");
				}
				return store.updateSession(sessionId, change);
			},
		}));
		await first.service.profiles.put(ctx, profile);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		failNext = true;
		first.script.reply({ text: "One" });
		const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Hello" }).catch(() => undefined);
		if (prompt !== undefined) await first.service.runtime.wait(ctx, session.id, prompt.id).catch(() => undefined);
		first.script.reply({ text: "Two" });
		const next = await first.service.runtime.prompt(ctx, session.id, { text: "Again" });
		expect(await first.service.runtime.wait(ctx, session.id, next.id)).toMatchObject({ answer: "Two" });
		await first.service.runtime.snapshot(ctx, session.id);
		await first.service.close();

		const second = await openOn(db);
		expect((await second.service.directory.get(ctx, session.id)).status).toBe("idle");
		const items = (await second.service.runtime.snapshot(ctx, session.id)).items;
		expect(items.filter((item) => item.kind === "assistant")).toHaveLength(2);
		await second.service.close();
		await db.close();
	});

	it("installs host tools registered while a session was still opening", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		const hosted = { ...profile, hostId: "sal", tools: ["lookup"] };
		const first = await openOn(db);
		await first.service.profiles.put(ctx, hosted);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await first.service.close();

		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: () => void = () => {};
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const second = await openOn(db, undefined, gate, entered);
		const opening = second.service.runtime.snapshot(ctx, session.id);
		// The session is now opening, held at its storage.
		await reached;
		const calls: string[] = [];
		await second.service.hostTools.register(
			ctx,
			"sal",
			[{ name: "lookup", description: "Looks up", inputSchema: { type: "object" }, replay: "safe" }],
			async (call) => {
				calls.push(call.tool);
				return { output: "found" };
			},
		);
		release();
		await opening;
		second.script.reply({ toolCalls: [{ name: "lookup", args: {} }] }, { text: "Done" });
		const prompt = await second.service.runtime.prompt(ctx, session.id, { text: "Look it up" });
		expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({ answer: "Done" });
		expect(calls).toEqual(["lookup"]);
		await second.service.close();
		await db.close();
	});
});

describe("session runtime opening", () => {
	it("holds a prompt that arrives while a session's host tools are still installing until they are in", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		const hosted = { ...profile, hostId: "sal", tools: ["lookup"] };
		const calls: string[] = [];
		const first = await openOn(db);
		await first.service.profiles.put(ctx, hosted);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await first.service.close();

		let hold = false;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: () => void = () => {};
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const second = await openOn(db, (store) => ({
			...store,
			async host(organisationId, hostId) {
				if (hold) {
					entered();
					await gate;
				}
				return store.host(organisationId, hostId);
			},
		}));
		await second.service.hostTools.register(
			ctx,
			"sal",
			[{ name: "lookup", description: "Looks up", inputSchema: { type: "object" }, replay: "safe" }],
			async (call) => {
				calls.push(call.tool);
				return { output: "found" };
			},
		);
		hold = true;
		const opening = second.service.runtime.snapshot(ctx, session.id);
		await reached;
		hold = false;
		second.script.reply({ toolCalls: [{ name: "lookup", args: {} }] }, { text: "Done" });
		const prompting = second.service.runtime.prompt(ctx, session.id, { text: "Look it up" });
		// Long enough for the prompt to reach the model if nothing held it.
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await opening;
		const prompt = await prompting;
		expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({ answer: "Done" });
		expect(calls).toEqual(["lookup"]);
		await second.service.close();
		await db.close();
	});
});

const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;

/**
 * A runtime on `db`, its store optionally wrapped, its Pi storage optionally held until `gate` resolves (`entered` is
 * called when a session reaches it).
 */
async function openOn(
	db: SqliteDatabase,
	wrap?: (store: SessionStore) => SessionStore,
	gate?: Promise<void>,
	entered?: () => void,
) {
	const { models, script } = createScriptedModel();
	const store = await createSqlSessionStore(db);
	const service = createSessionRuntime({
		store: wrap === undefined ? store : wrap(store),
		storage: async (session) => {
			entered?.();
			await gate;
			return sqlPiStorage(db, session.id);
		},
		models,
	});
	return { service, script };
}
