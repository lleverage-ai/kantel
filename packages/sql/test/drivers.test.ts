import { sql } from "@kantel/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	describe(`SqlDriver on ${kind.name}`, { timeout: kind.testTimeoutMs }, () => {
		it("runs queries with ? placeholders, and a batch atomically", async () => {
			const { driver, close } = await kind.open();
			try {
				await driver.query("CREATE TABLE items (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
				await driver.batch([
					sql("INSERT INTO items (id, n) VALUES (?, ?)", "a", 1),
					sql("INSERT INTO items (id, n) VALUES (?, ?)", "b", 2),
				]);
				expect(await driver.query("SELECT id, n FROM items WHERE n >= ? ORDER BY id", [1])).toEqual([
					{ id: "a", n: 1 },
					{ id: "b", n: 2 },
				]);
				await expect(
					driver.batch([
						sql("INSERT INTO items (id, n) VALUES (?, ?)", "c", 3),
						sql("INSERT INTO items (id, n) VALUES (?, ?)", "a", 4),
					]),
				).rejects.toThrow();
				expect(await driver.query("SELECT id FROM items ORDER BY id")).toEqual([{ id: "a" }, { id: "b" }]);
				expect(
					await driver.query("INSERT INTO items (id, n) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id", [
						"a",
						9,
					]),
				).toEqual([]);
				expect(await driver.query("DELETE FROM items WHERE n < ? RETURNING id", [2])).toEqual([{ id: "a" }]);
				await driver.batch([]);
			} finally {
				await close();
			}
		});

		it("opens a database of its own each time, empty, even while another is open", async () => {
			const first = await kind.open();
			try {
				await first.driver.query("CREATE TABLE marks (id TEXT PRIMARY KEY)");
				await first.driver.query("INSERT INTO marks (id) VALUES (?)", ["first"]);
				const second = await kind.open();
				try {
					await second.driver.query("CREATE TABLE marks (id TEXT PRIMARY KEY)");
					expect(await second.driver.query("SELECT id FROM marks")).toEqual([]);
					await second.driver.query("INSERT INTO marks (id) VALUES (?)", ["second"]);
				} finally {
					await second.close();
				}
				expect(await first.driver.query("SELECT id FROM marks")).toEqual([{ id: "first" }]);
			} finally {
				await first.close();
			}
		});

		it("throws the database's own error, with its message, when a constraint fails", async () => {
			const { driver, close } = await kind.open();
			try {
				await driver.query("CREATE TABLE items (id TEXT PRIMARY KEY)");
				await driver.query("INSERT INTO items (id) VALUES (?)", ["a"]);
				await expect(driver.query("INSERT INTO items (id) VALUES (?)", ["a"])).rejects.toThrow(
					/UNIQUE constraint failed|duplicate key value/,
				);
				await expect(driver.batch([sql("INSERT INTO items (id) VALUES (?)", "a")])).rejects.toThrow(
					/UNIQUE constraint failed|duplicate key value/,
				);
			} finally {
				await close();
			}
		});
	});
}
