/**
 * `SqlDriver`s for Postgres. They take the client's shape, not a package: `pg`'s `Pool` and `PoolClient` and
 * PGlite all fit, so this module has no dependencies.
 */
import { type SqlDriver, type SqlRow, type SqlStatement, type SqlValue, toPostgresPlaceholders } from "./index.ts";

/** What every Postgres client offers: `pg`'s `Pool`, `Client` and `PoolClient`, and PGlite. */
export interface PostgresQueryable {
	query(text: string, params?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

/** A pool that lends a connection for a transaction: `pg`'s `Pool`. */
export interface PostgresPool extends PostgresQueryable {
	connect(): Promise<PostgresQueryable & { release(error?: Error | boolean): void }>;
}

/** A database that runs a callback in a transaction: PGlite. */
export interface PostgresTransactional extends PostgresQueryable {
	transaction<T>(callback: (tx: PostgresQueryable) => Promise<T>): Promise<T>;
}

async function rowsOf<Row extends SqlRow>(
	client: PostgresQueryable,
	text: string,
	params: readonly SqlValue[] = [],
): Promise<Row[]> {
	const result = await client.query(toPostgresPlaceholders(text), [...params]);
	return result.rows as Row[];
}

async function runAll(client: PostgresQueryable, statements: readonly SqlStatement[]): Promise<void> {
	for (const statement of statements) await rowsOf(client, statement.sql, statement.params);
}

/** A driver over a `pg` pool: each batch takes a connection and runs in `BEGIN` … `COMMIT`. */
export function postgresPoolDriver(pool: PostgresPool): SqlDriver {
	return {
		dialect: "postgres",
		query: (text, params) => rowsOf(pool, text, params),
		async batch(statements) {
			if (statements.length === 0) return;
			const client = await pool.connect();
			let failed = false;
			try {
				await client.query("BEGIN");
				await runAll(client, statements);
				await client.query("COMMIT");
			} catch (error) {
				failed = true;
				await client.query("ROLLBACK").catch(() => undefined);
				throw error;
			} finally {
				client.release(failed);
			}
		},
	};
}

/** A driver over a database with `transaction(callback)`, such as PGlite. */
export function postgresTransactionalDriver(database: PostgresTransactional): SqlDriver {
	return {
		dialect: "postgres",
		query: (text, params) => rowsOf(database, text, params),
		async batch(statements) {
			if (statements.length === 0) return;
			await database.transaction((tx) => runAll(tx, statements));
		},
	};
}

/**
 * A driver over a client already inside the caller's transaction: `batch` runs its statements as part of it, so a
 * producer's own writes and its audit outbox rows commit or roll back together.
 */
export function postgresClientDriver(client: PostgresQueryable): SqlDriver {
	return {
		dialect: "postgres",
		query: (text, params) => rowsOf(client, text, params),
		batch: (statements) => runAll(client, statements),
	};
}
