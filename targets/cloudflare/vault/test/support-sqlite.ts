import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { registerVaultDurableProofs, type VaultDurableProof, type VaultDurableSubject } from "@harbour/testing/vault";
import { VAULT_TABLES } from "@harbour/vault/store";
import { describe, expect, it } from "vitest";
import { createSqliteVaultStore, type SqliteVaultStore, type SqlStorageLike, type SqlValue } from "../src/index.ts";
import { durableSubject } from "./support.ts";

/**
 * A Durable Object's `ctx.storage.sql` over `node:sqlite`: synchronous `exec` with `?` bindings returning a cursor,
 * and `transactionSync` as `BEGIN IMMEDIATE` … `COMMIT`.
 */
export function sqlStorageOf(db: DatabaseSync): SqlStorageLike & { transactionSync<T>(work: () => T): T } {
	return {
		exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
			const statement = db.prepare(query);
			const values = bindings.map((binding) =>
				binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
			) as SQLInputValue[];
			let rows: T[] = [];
			let rowsWritten = 0;
			if (statement.columns().length > 0) rows = statement.all(...values) as T[];
			else rowsWritten = Number(statement.run(...values).changes);
			return {
				toArray: () => rows,
				one: () => {
					if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
					return rows[0]!;
				},
				rowsWritten,
			};
		},
		transactionSync<T>(work: () => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = work();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

/** A migrated store over a fresh in-memory database, and every row of it read raw. */
export function freshStore(): {
	readonly store: SqliteVaultStore;
	readonly rawRows: VaultDurableSubject["rawRows"];
	close(): void;
} {
	const db = new DatabaseSync(":memory:");
	const sql = sqlStorageOf(db);
	const store = createSqliteVaultStore(sql, { transactionSync: sql.transactionSync });
	store.migrate();
	return {
		store,
		async rawRows() {
			return VAULT_TABLES.flatMap((table) =>
				db
					.prepare(`SELECT rowid, * FROM vault_${table} ORDER BY rowid`)
					.all()
					.map((row) => ({ table, row: { ...row } })),
			);
		},
		close: () => db.close(),
	};
}

/** Registers proofs from issue #13 against node:sqlite, one fresh database per case. */
export function registerSqliteProofs(title: string, only: readonly VaultDurableProof[]): void {
	registerVaultDurableProofs(
		{ describe, expect, it },
		`Durable Object SQLite vault store (node:sqlite): ${title}`,
		async (deps, use) => {
			const { store, rawRows, close } = freshStore();
			try {
				await use(durableSubject(deps, store, rawRows));
			} finally {
				close();
			}
		},
		only,
	);
}
