// Organising sessions (`SessionOrganising`): renaming, pinning, archiving and marking unread change the record and
// nothing else, and are kept across a restart; deleting closes the session, after which nothing finds it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { type AgentProfile, KantelError, type SessionEnd } from "@kantel/contracts";
import type { ServerFrame } from "@kantel/protocol";
import { createSessionRuntime } from "@kantel/runtime/core";
import { archiveSqlPiStorage, createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-organise";
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

function databaseFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "harbour-organise-"));
	cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "harbour.db");
}

/** One process on the database file: its own runtime and scripted model, archiving closed sessions when asked. */
async function processOn(file: string, archive = false) {
	const db = await openNodeSqliteDatabase(file);
	const { models, script } = createScriptedModel();
	const store = await createSqlSessionStore(db);
	const service = createSessionRuntime({
		store,
		storage: (session) => sqlPiStorage(db, session.id),
		...(archive ? { archive: (session) => archiveSqlPiStorage(db, session.id) } : {}),
		models,
	});
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await service.close();
		await db.close();
	};
	cleanups.push(close);
	await service.profiles.put(ctx, profile);
	return { service, script, close };
}

type Process = Awaited<ReturnType<typeof processOn>>;

const created = (process: Process, title = "Plan", parentSessionId?: string) =>
	process.service.runtime.create(ctx, {
		projectId: "proj",
		agentId: "worker",
		title,
		...(parentSessionId === undefined ? {} : { parentSessionId }),
	});

/** Sends `text` and waits for the scripted answer `answer`. */
async function turn(process: Process, sessionId: string, text: string, answer: string) {
	process.script.reply({ text: answer });
	const submission = await process.service.runtime.prompt(ctx, sessionId, { text });
	expect(await process.service.runtime.wait(ctx, sessionId, submission.id)).toMatchObject({ answer });
}

const code = async (operation: Promise<unknown>) => {
	try {
		await operation;
	} catch (error) {
		return error instanceof KantelError ? error.code : String(error);
	}
	return "resolved";
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("update", () => {
	it("renames a session, trimmed, without changing its last activity, and tells its watchers", async () => {
		const process = await processOn(databaseFile());
		const { organising, directory, runtime } = process.service;
		const session = await created(process);
		const before = await directory.get(ctx, session.id);
		const frames: ServerFrame[] = [];
		const watch = await runtime.watch(ctx, session.id, {}, (frame) => frames.push(frame));

		const renamed = await organising.update(ctx, session.id, { title: "  Release plan  " });
		expect(renamed).toEqual({ ...before, title: "Release plan" });
		expect(await directory.get(ctx, session.id)).toEqual(renamed);
		expect((await runtime.snapshot(ctx, session.id)).title).toBe("Release plan");
		expect(
			frames.some(
				(frame) =>
					frame.type === "delta" && frame.delta.ops.some((op) => op.op === "title" && op.title === "Release plan"),
			),
		).toBe(true);
		await watch.close();
	});

	it("refuses a blank or overlong title and an unknown session, and changes nothing for an empty change", async () => {
		const process = await processOn(databaseFile());
		const { organising, directory } = process.service;
		const session = await created(process);
		expect(await code(organising.update(ctx, session.id, { title: "   " }))).toBe("invalid");
		expect(await code(organising.update(ctx, session.id, { title: "x".repeat(201), pinned: true }))).toBe("invalid");
		expect(await code(organising.update(ctx, "no-session", { title: "Elsewhere" }))).toBe("not_found");
		const record = await directory.get(ctx, session.id);
		expect(record).toMatchObject({ title: "Plan" });
		expect(record).not.toHaveProperty("pinnedAt");
		expect(await organising.update(ctx, session.id, {})).toEqual(record);
		expect((await organising.update(ctx, session.id, { title: "y".repeat(200) })).title).toHaveLength(200);
	});

	it("pins, archives and marks a session unread, keeping when each was set, and takes each back", async () => {
		const process = await processOn(databaseFile());
		const { organising, directory } = process.service;
		const session = await created(process);
		const before = await directory.get(ctx, session.id);

		const marked = await organising.update(ctx, session.id, { pinned: true, archived: true, unread: true });
		expect(marked.pinnedAt).toBeTypeOf("number");
		expect(marked.archivedAt).toBeTypeOf("number");
		expect(marked.markedUnreadAt).toBeTypeOf("number");
		expect(marked.updatedAt).toBe(before.updatedAt);
		expect(await directory.get(ctx, session.id)).toEqual(marked);

		// Setting a mark again keeps when it was first set.
		await pause(5);
		const again = await organising.update(ctx, session.id, { pinned: true, archived: true, unread: true });
		expect(again).toEqual(marked);

		// An archived session is still read and used.
		await turn(process, session.id, "Still there?", "Still here");
		expect((await directory.get(ctx, session.id)).archivedAt).toBe(marked.archivedAt);

		const unpinned = await organising.update(ctx, session.id, { pinned: false });
		expect(unpinned).not.toHaveProperty("pinnedAt");
		expect(unpinned.archivedAt).toBe(marked.archivedAt);
		const unarchived = await organising.update(ctx, session.id, { archived: false });
		expect(unarchived).not.toHaveProperty("archivedAt");
		const read = await organising.update(ctx, session.id, { unread: false });
		expect(read).not.toHaveProperty("markedUnreadAt");
		expect(await directory.get(ctx, session.id)).toEqual(read);
	});

	it("keeps a rename and its marks across a restart, and renames a session not open in the process", async () => {
		const file = databaseFile();
		const first = await processOn(file);
		const session = await created(first);
		await first.service.organising.update(ctx, session.id, { title: "Kept", pinned: true });
		// A later write of the open session's record (its status, after a run) keeps them.
		await turn(first, session.id, "Hello", "Hi");
		await first.close();

		const second = await processOn(file);
		const record = await second.service.directory.get(ctx, session.id);
		expect(record.title).toBe("Kept");
		expect(record.pinnedAt).toBeTypeOf("number");

		// Not open in this process yet: its stream starts from the stored record.
		const renamed = await second.service.organising.update(ctx, session.id, { title: "Renamed later" });
		expect(renamed).toEqual({ ...record, title: "Renamed later" });
		expect((await second.service.runtime.snapshot(ctx, session.id)).title).toBe("Renamed later");
		await second.close();

		const third = await processOn(file);
		expect((await third.service.directory.get(ctx, session.id)).title).toBe("Renamed later");
	});
});

describe("visibility", () => {
	const as = (userId: string) => ({ actor: { kind: "human", userId }, organisationId: ORG }) as const;

	it("starts a session private only when it acts for a person, and gives a child its parent's", async () => {
		const process = await processOn(databaseFile());
		const { runtime } = process.service;
		const base = { projectId: "proj", agentId: "worker" } as const;
		expect(await code(runtime.create(ctx, { ...base, visibility: "private" }))).toBe("invalid");
		expect(await code(runtime.create(ctx, { ...base, visibility: "secret" as never }))).toBe("invalid");
		const parent = await runtime.create(ctx, { ...base, userId: "alice", visibility: "private" });
		expect(parent.visibility).toBe("private");
		const child = await runtime.create(ctx, { ...base, parentSessionId: parent.id });
		expect(child.visibility).toBe("private");
		expect(await code(runtime.create(ctx, { ...base, parentSessionId: parent.id, visibility: "shared" }))).toBe(
			"invalid",
		);
		// Absent is shared, and stays absent on the record.
		expect((await runtime.create(ctx, { ...base, userId: "alice" })).visibility).toBeUndefined();
	});

	it("lets only the session's person or the service that made it change who sees it, children included", async () => {
		const process = await processOn(databaseFile());
		const { runtime, organising, directory } = process.service;
		const parent = await runtime.create(ctx, { projectId: "proj", agentId: "worker", userId: "alice" });
		const child = await runtime.create(ctx, { projectId: "proj", agentId: "worker", parentSessionId: parent.id });
		const grandchild = await runtime.create(ctx, {
			projectId: "proj",
			agentId: "worker",
			parentSessionId: child.id,
		});
		expect(await code(organising.update(as("bob"), parent.id, { visibility: "private" }))).toBe("forbidden");
		expect(await code(organising.update(as("alice"), child.id, { visibility: "private" }))).toBe("invalid");
		expect((await organising.update(as("alice"), parent.id, { visibility: "private" })).visibility).toBe("private");
		expect((await directory.get(ctx, child.id)).visibility).toBe("private");
		expect((await directory.get(ctx, grandchild.id)).visibility).toBe("private");
		expect((await organising.update(ctx, parent.id, { visibility: "shared" })).visibility).toBe("shared");
		expect((await directory.get(ctx, grandchild.id)).visibility).toBe("shared");
		// A session with no person behind it can't be private.
		const unattended = await runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		expect(await code(organising.update(ctx, unattended.id, { visibility: "private" }))).toBe("invalid");
	});

	it("keeps the schedule a run no one watches was started for, given only by Kantel or a service, and on its children", async () => {
		const process = await processOn(databaseFile());
		const { runtime, directory } = process.service;
		const base = { projectId: "proj", agentId: "worker" } as const;
		const unattended = { scheduleId: "sch_1", occurrenceId: "sch_1@1" };
		const run = await runtime.create(ctx, { ...base, userId: "alice", visibility: "private", unattended });
		expect(run).toMatchObject({ userId: "alice", visibility: "private", unattended });
		expect((await directory.get(ctx, run.id)).unattended).toEqual(unattended);
		const child = await runtime.create(ctx, { ...base, parentSessionId: run.id });
		expect(child.unattended).toEqual(unattended);
		expect(await code(runtime.create(ctx, { ...base, parentSessionId: run.id, unattended }))).toBe("invalid");
		// A person can't make their own session look like a schedule's, and a schedule is named.
		expect(await code(runtime.create(as("alice"), { ...base, unattended }))).toBe("forbidden");
		expect(await code(runtime.create(ctx, { ...base, unattended: { scheduleId: "" } }))).toBe("invalid");
	});
});

describe("remove", () => {
	it.each([{ archive: false }, { archive: true }])(
		"closes the session, then nothing finds it, across a restart (archive: $archive)",
		async ({ archive }) => {
			const file = databaseFile();
			const first = await processOn(file, archive);
			const { organising, directory, runtime, history, models, branching } = first.service;
			const ends: SessionEnd[] = [];
			first.service.sessionEnd.register("test", async (_ctx, end) => {
				ends.push(end);
			});
			const session = await created(first);
			await turn(first, session.id, "Hello", "Hi");
			const kept = await created(first, "Other");

			await organising.remove(ctx, session.id);
			expect(ends).toContainEqual(expect.objectContaining({ sessionId: session.id, reason: "session_ended" }));

			const missing: (() => Promise<unknown>)[] = [
				() => directory.get(ctx, session.id),
				() => directory.children(ctx, session.id),
				() => runtime.snapshot(ctx, session.id),
				() => runtime.prompt(ctx, session.id, { text: "Again" }),
				() => runtime.abort(ctx, session.id),
				() => runtime.close(ctx, session.id),
				() => runtime.watch(ctx, session.id, {}, () => {}),
				() => history.history(ctx, session.id),
				() => models.modelState(ctx, session.id),
				() => branching.fork(ctx, session.id, { itemId: "a1" }),
				() => organising.update(ctx, session.id, { title: "Back" }),
				() => organising.remove(ctx, session.id),
			];
			for (const operation of missing) expect(await code(operation())).toBe("not_found");
			expect((await directory.list(ctx, { projectId: "proj" })).items.map((record) => record.id)).toEqual([kept.id]);
			await first.close();

			const second = await processOn(file, archive);
			expect(await code(second.service.directory.get(ctx, session.id))).toBe("not_found");
			expect(await code(second.service.runtime.snapshot(ctx, session.id))).toBe("not_found");
			expect(await code(second.service.organising.remove(ctx, session.id))).toBe("not_found");
			expect((await second.service.directory.list(ctx)).items.map((record) => record.id)).toEqual([kept.id]);
		},
	);

	it("takes a deleted child out of its parent's children, and the parent's abort passes it by", async () => {
		const process = await processOn(databaseFile());
		const { organising, directory, runtime } = process.service;
		const parent = await created(process);
		const child = await created(process, "Child", parent.id);
		const sibling = await created(process, "Sibling", parent.id);
		await organising.remove(ctx, child.id);
		expect((await directory.children(ctx, parent.id)).map((record) => record.id)).toEqual([sibling.id]);
		expect(await code(runtime.abort(ctx, parent.id))).toBe("resolved");
	});
});
