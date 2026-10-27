import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteVaultStore } from "../src/index.ts";
import { sqlStorageOf } from "./support-sqlite.ts";

function fresh() {
	const db = new DatabaseSync(":memory:");
	const sql = sqlStorageOf(db);
	const store = createSqliteVaultStore(sql, { transactionSync: sql.transactionSync });
	store.migrate();
	return { store, sql };
}

const insert = (id: string, data = "{}") =>
	({ kind: "insert", table: "items", id, organisationId: "org-a", data }) as const;
const update = (id: string, revision: number, data: string) =>
	({ kind: "update", table: "items", id, revision, data }) as const;

describe("createSqliteVaultStore commits every write or none", () => {
	it("refuses two writes to one row in a commit, writing nothing", async () => {
		const { store } = fresh();
		expect(await store.commit([insert("item-1"), insert("item-2"), insert("item-1")])).toBe(false);
		expect(await store.list("items", "org-a")).toEqual([]);

		expect(await store.commit([insert("item-1")])).toBe(true);
		expect(await store.commit([update("item-1", 1, '{"a":1}'), update("item-1", 1, '{"a":2}')])).toBe(false);
		expect(await store.get("items", "item-1")).toMatchObject({ revision: 1, data: "{}" });
	});

	it("rolls back the writes before one that fails part-way", async () => {
		const { store, sql } = fresh();
		expect(await store.commit([insert("item-1")])).toBe(true);
		// A write the precheck passes but SQLite rejects: the second insert's row appears between the check and the
		// write, through a trigger the first insert fires.
		sql.exec(
			"CREATE TRIGGER sneak AFTER INSERT ON vault_items WHEN NEW.id = 'item-2' BEGIN INSERT INTO vault_items (id, organisation_id, revision, data) VALUES ('item-3', 'org-a', 1, '{}'); END",
		);
		await expect(
			store.commit([update("item-1", 1, '{"changed":true}'), insert("item-2"), insert("item-3")]),
		).rejects.toThrow();
		expect(await store.get("items", "item-1")).toMatchObject({ revision: 1, data: "{}" });
		expect(await store.get("items", "item-2")).toBeUndefined();
	});

	it("answers false and rolls back when an update's row has moved on by the time it is written", async () => {
		const { store, sql } = fresh();
		expect(await store.commit([insert("item-1"), insert("item-2")])).toBe(true);
		// The first update bumps item-2's revision through a trigger, so the second update no longer matches.
		sql.exec(
			"CREATE TRIGGER bump AFTER UPDATE ON vault_items WHEN NEW.id = 'item-1' BEGIN UPDATE vault_items SET revision = revision + 1 WHERE id = 'item-2'; END",
		);
		expect(await store.commit([update("item-1", 1, '{"a":1}'), update("item-2", 1, '{"b":1}')])).toBe(false);
		expect(await store.get("items", "item-1")).toMatchObject({ revision: 1, data: "{}" });
		expect(await store.get("items", "item-2")).toMatchObject({ revision: 1, data: "{}" });
	});
});
