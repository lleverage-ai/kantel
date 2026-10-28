import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { DurableObjectTransaction, SqlStorageLike, SqlValue } from "../src/index.ts";

/** Statements Durable Object SQL refuses: transactions go through `ctx.storage.transaction` instead. */
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** One transaction at a time per database, as one Durable Object's storage allows. */
const transactionLocks = new WeakMap<DatabaseSync, Promise<unknown>>();

/**
 * A Durable Object's `ctx.storage.sql` and async `ctx.storage.transaction` over `node:sqlite`: synchronous `exec` with
 * `?` bindings returning a cursor, refusing transaction control as Durable Object SQL does; and `transaction` as
 * `BEGIN IMMEDIATE` … `COMMIT` around the closure, rolled back when it rejects. Doubles over the same `DatabaseSync`
 * (two instances of one object) take turns at transactions.
 */
export function durableObjectStorageOf(db: DatabaseSync): {
	readonly sql: SqlStorageLike;
	readonly transaction: DurableObjectTransaction;
} {
	return {
		sql: {
			exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
				if (TRANSACTION_CONTROL.test(query)) throw new Error(`Durable Object SQL refuses "${query.trim()}"`);
				const statement = db.prepare(query);
				const values = bindings.map((binding) =>
					binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
				) as SQLInputValue[];
				let rows: T[] = [];
				if (statement.columns().length > 0) rows = statement.all(...values) as T[];
				else statement.run(...values);
				return { toArray: () => rows };
			},
		},
		transaction<T>(work: () => Promise<T>): Promise<T> {
			const previous = transactionLocks.get(db) ?? Promise.resolve();
			const next = previous.then(async () => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = await work();
					db.exec("COMMIT");
					return result;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			});
			transactionLocks.set(
				db,
				next.catch(() => undefined),
			);
			return next;
		},
	};
}
