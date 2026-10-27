import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DurableObjectSessionDatabase } from "../src/index.ts";
import { durableObjectStorageOf } from "./support-sqlite.ts";

describe("DurableObjectSessionDatabase", () => {
	let db: DatabaseSync;
	afterEach(() => db.close());

	async function fresh() {
		db = new DatabaseSync(":memory:");
		const database = new DurableObjectSessionDatabase(durableObjectStorageOf(db));
		await database.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT");
		return database;
	}

	it("rolls a transaction back when its callback rejects, with the same error, without BEGIN in its SQL", async () => {
		const database = await fresh();
		const failure = new Error("refused");
		await expect(
			database.transaction(async (tx) => {
				await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", "a", 1);
				expect(await tx.get("SELECT n FROM t WHERE id = ?", "a")).toEqual({ n: 1 });
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(await database.all("SELECT id FROM t")).toEqual([]);
	});

	it("holds every other call until a transaction settles, and refuses its handle afterwards", async () => {
		const database = await fresh();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let handle: Parameters<Parameters<typeof database.transaction>[0]>[0] | undefined;
		const transaction = database.transaction(async (tx) => {
			handle = tx;
			await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", "a", 1);
			await gate;
			await tx.run("UPDATE t SET n = ? WHERE id = ?", 2, "a");
		});
		const read = database.all<{ n: number }>("SELECT n FROM t");
		const alarm: string[] = [];
		const outside = database.outsideTransactions(async () => {
			alarm.push("armed");
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(alarm).toEqual([]);
		release();
		await transaction;
		await outside;
		expect(alarm).toEqual(["armed"]);
		expect(await read).toEqual([{ n: 2 }]);
		await expect(handle!.run("DELETE FROM t")).rejects.toThrow("no longer active");
	});
});
