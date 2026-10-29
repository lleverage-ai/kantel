// Cold create without the growing schema (#216): a new session's Pi tables are created at the current schema version,
// with no migration replay, and a closed session's tables are archived and dropped, so a database's schema grows with
// its open sessions, not with every session it has held. An archived session reads as before, and after a restart.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { AgentProfile } from "@harbour/contracts";
import { createSessionRuntime } from "@harbour/runtime/core";
import {
	archiveSqlPiStorage,
	borrowDatabase,
	createPiSchema,
	createSqlSessionStore,
	PI_ARCHIVE_TABLE,
	PI_SCHEMA_VERSION,
	piPrefixFor,
	sqlPiStorage,
} from "@harbour/runtime/sql";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-archive";
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
	const dir = mkdtempSync(join(tmpdir(), "harbour-archive-"));
	cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "harbour.db");
}

/** The sessions with Pi tables in the database, from its schema, as the Durable Object target lists them. */
async function sessionsWithTables(db: SqliteDatabase): Promise<string[]> {
	const rows = await db.all<{ name: string }>(
		"SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'pi_*_durable_schema' ORDER BY name",
	);
	return rows.map(({ name }) => name.replace(/^pi_(.{8})(.{4})(.{4})(.{4})(.{12})_durable_schema$/, "$1-$2-$3-$4-$5"));
}

/**
 * One process on the database file, archiving closed sessions as the targets do. Without `archive`, it keeps them; with
 * `migrate` too, a session's tables come from Pi Durable's migrations, as every session's did before #216.
 */
async function processOn(file: string, archive = true, migrate = false) {
	const db = await openNodeSqliteDatabase(file);
	const { models, script } = createScriptedModel();
	const errors: unknown[] = [];
	const service = createSessionRuntime({
		store: await createSqlSessionStore(db),
		storage: (session) =>
			migrate
				? SqliteStorage.open(borrowDatabase(db), { prefix: piPrefixFor(session.id) })
				: sqlPiStorage(db, session.id),
		...(archive
			? { archive: (session) => archiveSqlPiStorage(db, session.id), unarchived: () => sessionsWithTables(db) }
			: {}),
		onArchiveError: (_id, error) => errors.push(error),
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
	return { db, service, script, errors, close };
}

/** The schema's rows (type, name and SQL), without SQLite's own, sorted by name, with whitespace collapsed. */
async function schemaOf(db: SqliteDatabase, like = "%") {
	const rows = await db.all<{ type: string; name: string; sql: string | null }>(
		"SELECT type, name, sql FROM sqlite_schema WHERE name LIKE ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
		like,
	);
	return rows.map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")") }));
}

async function tablesOf(db: SqliteDatabase, sessionId: string) {
	return (await schemaOf(db, `${piPrefixFor(sessionId)}%`)).filter((row) => row.type === "table");
}

describe("a session's Pi schema", () => {
	it("is created at the current version, the same schema Pi Durable's migrations make", async () => {
		expect(PI_SCHEMA_VERSION).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
		const db = await openNodeSqliteDatabase(":memory:");
		cleanups.push(() => db.close());
		const seeded = piPrefixFor(crypto.randomUUID());
		const migrated = piPrefixFor(crypto.randomUUID());
		await createPiSchema(db, seeded);
		await (await SqliteStorage.open(borrowDatabase(db), { prefix: seeded })).close({} as never);
		await (await SqliteStorage.open(borrowDatabase(db), { prefix: migrated })).close({} as never);

		const strip = (prefix: string) => async () =>
			(await schemaOf(db, `${prefix}%`)).map((row) => ({
				type: row.type,
				name: row.name.slice(prefix.length),
				// The rename in the v2 migration leaves the table's name quoted; nothing else differs.
				sql: row.sql?.replaceAll(prefix, "").replaceAll('"', "") ?? null,
			}));
		const fromMigrations = await strip(migrated)();
		expect(fromMigrations.length).toBeGreaterThan(20);
		expect(await strip(seeded)()).toEqual(fromMigrations);
		const version = (prefix: string) =>
			db.get<{ version: number }>(`SELECT version FROM ${prefix}durable_schema WHERE singleton = 1`);
		expect(await version(seeded)).toEqual(await version(migrated));
		const metadata = (prefix: string) => db.all(`SELECT * FROM ${prefix}durable_metadata`);
		expect(await metadata(seeded)).toEqual(await metadata(migrated));
	});

	it("leaves a session that already has its tables as it is", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		cleanups.push(() => db.close());
		const prefix = piPrefixFor(crypto.randomUUID());
		await createPiSchema(db, prefix);
		await db.run(`UPDATE ${prefix}durable_metadata SET next_seq = 7`);
		await createPiSchema(db, prefix);
		expect(await db.get(`SELECT next_seq FROM ${prefix}durable_metadata`)).toEqual({ next_seq: 7 });
	});
});

describe("closing a session archives its Pi tables", () => {
	it("drops a closed session's tables, and reads it from the archive as before, also after a restart", async () => {
		const file = databaseFile();
		const first = await processOn(file);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		first.script.reply({ text: "Hello back" });
		const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Hello" });
		await first.service.runtime.wait(ctx, session.id, prompt.id);
		const before = await first.service.runtime.snapshot(ctx, session.id);
		expect((await tablesOf(first.db, session.id)).length).toBe(9);

		await first.service.runtime.close(ctx, session.id);
		expect(first.errors).toEqual([]);
		expect(await tablesOf(first.db, session.id)).toEqual([]);
		const archived = await first.db.get<{ rows: number }>(
			`SELECT COUNT(*) AS rows FROM ${PI_ARCHIVE_TABLE} WHERE session_id = ?`,
			session.id,
		);
		expect(archived?.rows).toBeGreaterThan(0);

		// Read again: the tables come back from the archive with the transcript.
		const after = await first.service.runtime.snapshot(ctx, session.id);
		expect(after.items).toEqual(before.items);
		expect(after.status).toBe("done");
		const history = await first.service.history.history(ctx, session.id);
		// Newest first.
		expect(history.items.map((item) => item.id)).toEqual(before.items.map((item) => item.id).reverse());
		await first.service.runtime.close(ctx, session.id);
		await expect(first.service.runtime.prompt(ctx, session.id, { text: "More" })).rejects.toMatchObject({
			code: "conflict",
		});

		// The runtime's own close puts a closed session it read back into the archive.
		await first.close();
		const second = await processOn(file);
		expect(await tablesOf(second.db, session.id)).toEqual([]);
		expect((await second.service.runtime.snapshot(ctx, session.id)).items).toEqual(before.items);
		expect((await tablesOf(second.db, session.id)).length).toBe(9);
		await second.close();
		const third = await openNodeSqliteDatabase(file);
		cleanups.push(() => third.close());
		expect(await tablesOf(third, session.id)).toEqual([]);
	});

	it("forks from an archived session", async () => {
		const { service, script } = await processOn(databaseFile());
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "Forty-two" });
		const prompt = await service.runtime.prompt(ctx, session.id, { text: "The answer?" });
		await service.runtime.wait(ctx, session.id, prompt.id);
		const answer = (await service.runtime.snapshot(ctx, session.id)).items.find((item) => item.kind === "assistant");
		await service.runtime.close(ctx, session.id);

		const fork = await service.branching.fork(ctx, session.id, { itemId: answer!.id });
		script.reply({ text: "Still forty-two" });
		const next = await service.runtime.prompt(ctx, fork.id, { text: "Sure?" });
		const result = await service.runtime.wait(ctx, fork.id, next.id);
		expect(result.status).toBe("answered");
		expect(script.requests.at(-1)?.messages.map((message) => message.text)).toEqual([
			"The answer?",
			"Forty-two",
			"Sure?",
		]);
	});

	it("keeps the schema to the open sessions however many have closed", async () => {
		const { db, service } = await processOn(":memory:");
		const tables = async () =>
			(
				await db.get<{ count: number }>(
					"SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'pi\\_%' ESCAPE '\\'",
				)
			)?.count;
		const open = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		const baseline = await tables();
		for (let index = 0; index < 20; index++) {
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			await service.runtime.close(ctx, session.id);
		}
		expect(await tables()).toBe(baseline);
		expect((await service.runtime.snapshot(ctx, open.id)).status).toBe("idle");
	});

	it("without `archive`, keeps a closed session's tables", async () => {
		const { db, service } = await processOn(":memory:", false);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await service.runtime.close(ctx, session.id);
		expect((await tablesOf(db, session.id)).length).toBe(9);
	});

	it("sweeps sessions closed before archiving in bounded batches, stops when none is left, and reads them back", async () => {
		const file = databaseFile();
		// Before #216: every session's tables come from the migrations, and a closed session keeps them.
		const before = await processOn(file, false, true);
		const talked = await before.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		before.script.reply({ text: "Hello back" });
		const prompt = await before.service.runtime.prompt(ctx, talked.id, { text: "Hello" });
		await before.service.runtime.wait(ctx, talked.id, prompt.id);
		const transcript = (await before.service.runtime.snapshot(ctx, talked.id)).items;
		await before.service.runtime.close(ctx, talked.id);
		const closed = [talked.id];
		for (let index = 0; index < 5; index++) {
			const session = await before.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			await before.service.runtime.close(ctx, session.id);
			closed.push(session.id);
		}
		const stillOpen = await before.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await before.close();

		const after = await processOn(file);
		expect((await sessionsWithTables(after.db)).sort()).toEqual([...closed, stillOpen.id].sort());
		// A closed session being read is open here: the sweep leaves it to the runtime's own close.
		const reading = closed[1]!;
		await after.service.runtime.snapshot(ctx, reading);

		// Five closed sessions to archive, two at a time: the short batch says nothing is left.
		expect(await after.service.sweepArchive(2)).toBe(2);
		expect(await after.service.sweepArchive(2)).toBe(2);
		expect(await after.service.sweepArchive(2)).toBe(1);
		expect(await after.service.sweepArchive(2)).toBe(0);
		expect(after.errors).toEqual([]);
		expect((await sessionsWithTables(after.db)).sort()).toEqual([reading, stillOpen.id].sort());
		for (const id of closed.filter((id) => id !== reading)) expect(await tablesOf(after.db, id)).toEqual([]);

		// An archived session reads as it did, and goes back to its archive when the runtime closes.
		expect((await after.service.runtime.snapshot(ctx, talked.id)).items).toEqual(transcript);
		expect((await after.service.runtime.snapshot(ctx, stillOpen.id)).status).toBe("idle");
		await after.close();
		const last = await openNodeSqliteDatabase(file);
		cleanups.push(() => last.close());
		expect(await sessionsWithTables(last)).toEqual([stillOpen.id]);
	});

	it("reports a failed archive and leaves the closed session readable", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		const { models } = createScriptedModel();
		const errors: string[] = [];
		const service = createSessionRuntime({
			store: await createSqlSessionStore(db),
			storage: (session) => sqlPiStorage(db, session.id),
			archive: async () => {
				throw new Error("archive down");
			},
			onArchiveError: (_id, error) => errors.push((error as Error).message),
			models,
		});
		cleanups.push(async () => {
			await service.close();
			await db.close();
		});
		await service.profiles.put(ctx, profile);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await service.runtime.close(ctx, session.id);
		expect(errors).toEqual(["archive down"]);
		expect((await service.runtime.snapshot(ctx, session.id)).status).toBe("done");
	});
});
