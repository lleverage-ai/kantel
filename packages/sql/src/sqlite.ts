/**
 * `SqlDriver`s for SQLite. They take the database's shape, not a package: Cloudflare D1's `D1Database`, and a
 * synchronous database such as `node:sqlite`'s `DatabaseSync`, so this module has no dependencies and runs in Workers.
 */
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from "./index.ts";

/** The part of Cloudflare's `D1Database` the driver uses. */
export interface D1Like {
	prepare(query: string): D1PreparedLike;
	batch(statements: D1PreparedLike[]): Promise<unknown[]>;
}

export interface D1PreparedLike {
	bind(...values: unknown[]): D1PreparedLike;
	all(): Promise<{ readonly results: readonly unknown[] }>;
}

/** A driver over D1. `batch` is D1's own, which runs its statements in one transaction. */
export function d1Driver(database: D1Like): SqlDriver {
	const prepared = (text: string, params: readonly SqlValue[] = []) =>
		params.length === 0 ? database.prepare(text) : database.prepare(text).bind(...params);
	return {
		dialect: "sqlite",
		async query<Row extends SqlRow>(text: string, params?: readonly SqlValue[]): Promise<Row[]> {
			const { results } = await prepared(text, params).all();
			return results as Row[];
		},
		async batch(statements: readonly SqlStatement[]): Promise<void> {
			if (statements.length === 0) return;
			await database.batch(statements.map((statement) => prepared(statement.sql, statement.params)));
		},
	};
}

/** A synchronous SQLite database: `node:sqlite`'s `DatabaseSync`, or Bun's `Database`. */
export interface SyncSqliteLike {
	exec(sql: string): unknown;
	prepare(sql: string): { all(...params: SqlValue[]): unknown[] };
}

/**
 * A driver over a synchronous SQLite database, for tests and single-process deployments. Each call runs to the end
 * before any other starts, so a batch in `BEGIN` … `COMMIT` cannot interleave with another.
 */
export function syncSqliteDriver(database: SyncSqliteLike): SqlDriver {
	return {
		dialect: "sqlite",
		async query<Row extends SqlRow>(text: string, params: readonly SqlValue[] = []): Promise<Row[]> {
			return database.prepare(text).all(...params) as Row[];
		},
		async batch(statements: readonly SqlStatement[]): Promise<void> {
			if (statements.length === 0) return;
			database.exec("BEGIN");
			try {
				for (const statement of statements) database.prepare(statement.sql).all(...(statement.params ?? []));
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	};
}
