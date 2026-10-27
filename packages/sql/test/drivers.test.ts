import { sql } from "@harbour/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	describe(`SqlDriver on ${kind.name}`, () => {
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
	});
}
