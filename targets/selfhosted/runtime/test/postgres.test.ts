import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { openPostgresSessionDatabase, translateSqliteToPostgres } from "../src/index.ts";
import { caseSchema } from "./support.ts";

describe("translateSqliteToPostgres", () => {
	it("drops STRICT and json_valid checks and widens INTEGER to BIGINT", () => {
		expect(
			translateSqliteToPostgres(
				"CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, record TEXT NOT NULL CHECK (json_valid(record))) STRICT",
			),
		).toBe("CREATE TABLE t (id BIGINT PRIMARY KEY, n BIGINT NOT NULL, record TEXT NOT NULL)");
		expect(translateSqliteToPostgres("ALTER TABLE harbour_sessions ADD COLUMN wake_at INTEGER")).toBe(
			"ALTER TABLE harbour_sessions ADD COLUMN wake_at BIGINT",
		);
	});

	it("turns INSERT OR IGNORE into ON CONFLICT DO NOTHING, and ? into $n outside quotes", () => {
		expect(translateSqliteToPostgres("INSERT OR IGNORE INTO c (name, value) VALUES ('a?', ?)")).toBe(
			"INSERT INTO c (name, value) VALUES ('a?', $1) ON CONFLICT DO NOTHING",
		);
		expect(translateSqliteToPostgres(`SELECT "x?" FROM t WHERE a = ? AND b = ?`)).toBe(
			`SELECT "x?" FROM t WHERE a = $1 AND b = $2`,
		);
	});

	it("leaves literals, quoted identifiers and comments as they are", () => {
		expect(translateSqliteToPostgres("SELECT 'INTEGER' AS value, \"INTEGER\" FROM t")).toBe(
			"SELECT 'INTEGER' AS value, \"INTEGER\" FROM t",
		);
		expect(translateSqliteToPostgres("SELECT ? /* ? */, ? -- ?\n, 'it''s ?', ?")).toBe(
			"SELECT $1 /* ? */, $2 -- ?\n, 'it''s ?', $3",
		);
	});
});

describe("the Postgres session database (PGlite)", () => {
	const pglite = new PGlite();
	afterAll(() => pglite.close());

	async function fresh() {
		const schema = caseSchema();
		const db = await openPostgresSessionDatabase({ connection: pglite, schema });
		await db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT");
		return {
			db,
			async drop() {
				await db.close();
				await pglite.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			},
		};
	}

	it("reads int8 back as numbers, MIN included", async () => {
		const { db, drop } = await fresh();
		try {
			await db.run("INSERT INTO t (id, n) VALUES (?, ?), (?, ?)", "a", 1_761_555_600_000, "b", 7);
			expect(await db.get("SELECT MIN(n) AS at FROM t WHERE n > ?", 0)).toEqual({ at: 7 });
			expect(await db.all("SELECT id, n FROM t ORDER BY n")).toEqual([
				{ id: "b", n: 7 },
				{ id: "a", n: 1_761_555_600_000 },
			]);
		} finally {
			await drop();
		}
	});

	it("rolls a transaction back when its callback rejects, with the same error", async () => {
		const { db, drop } = await fresh();
		try {
			const failure = new Error("refused");
			await expect(
				db.transaction(async (tx) => {
					await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", "a", 1);
					throw failure;
				}),
			).rejects.toBe(failure);
			expect(await db.all("SELECT id FROM t")).toEqual([]);
		} finally {
			await drop();
		}
	});

	it("holds other statements until a transaction settles, and refuses its handle afterwards", async () => {
		const { db, drop } = await fresh();
		try {
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let handle: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;
			const transaction = db.transaction(async (tx) => {
				handle = tx;
				await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", "a", 1);
				await gate;
				await tx.run("UPDATE t SET n = ? WHERE id = ?", 2, "a");
			});
			const read = db.all<{ n: number }>("SELECT n FROM t");
			release();
			await transaction;
			expect(await read).toEqual([{ n: 2 }]);
			await expect(handle!.run("DELETE FROM t")).rejects.toThrow("no longer active");
		} finally {
			await drop();
		}
	});
});
