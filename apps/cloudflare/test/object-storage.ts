// A Durable Object's `ctx.storage.sql` and `transactionSync` over `node:sqlite`, for the VaultDO's portable half in Node.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqlStorageLike, SqlValue } from "@kantel/vault-cloudflare";

export function objectStorage(db: DatabaseSync): { sql: SqlStorageLike; transactionSync<T>(work: () => T): T } {
	return {
		sql: {
			exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
				const statement = db.prepare(query);
				const values = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as SQLInputValue[];
				const reads = statement.columns().length > 0;
				const rows = reads ? (statement.all(...values) as T[]) : [];
				const rowsWritten = reads ? 0 : Number(statement.run(...values).changes);
				return { toArray: () => rows, one: () => rows[0]!, rowsWritten };
			},
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
