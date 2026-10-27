import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { AgentProfile, SessionRecord } from "@harbour/contracts";
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
});
