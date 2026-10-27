/**
 * Chord's portable `SqliteDatabase` facade over Postgres, so the runtime's SQL session store and Pi Durable's
 * `SqliteStorage` run on it unchanged. Every statement is translated from the SQLite dialect they emit
 * (`translateSqliteToPostgres`) and runs on one dedicated connection, whose `search_path` is the deployment's schema.
 * Statements and transactions run one at a time in call order, so a transaction (`BEGIN` … `COMMIT` on that
 * connection) never interleaves with anything else of this database's.
 *
 * Adapted from `apps/selfhosted/src/pi-postgres.ts`, without its session fence, and extended for the store's SQL.
 */
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";

/** A column of a result, as `pg` and PGlite both describe it. */
export interface PostgresField {
	readonly name: string;
	readonly dataTypeID: number;
}

/** What the facade runs SQL on: `pg`'s `Client` and `PoolClient`, and PGlite, all satisfy it. */
export interface PostgresConnection {
	query(
		text: string,
		params?: unknown[],
	): Promise<{ readonly rows: readonly unknown[]; readonly fields?: readonly PostgresField[] }>;
}

/** A pool that lends the facade its dedicated connection: `pg`'s `Pool`. */
export interface PostgresPool {
	connect(): Promise<
		PostgresConnection & {
			release(error?: Error | boolean): void;
			/**
			 * `pg`'s client events. The facade listens for `error` while it holds the client: a connection lost while idle
			 * fails the database instead of being an unhandled error that ends the process.
			 */
			on?(event: "error", listener: (error: Error) => void): unknown;
			off?(event: "error", listener: (error: Error) => void): unknown;
		}
	>;
}

export type PostgresSessionDatabaseOptions = {
	/** The deployment's schema, created if missing. Lower case letters, digits and `_`. */
	readonly schema: string;
} & (
	| {
			/** A pool to check the dedicated connection out of; closing the database releases it. */
			readonly pool: PostgresPool;
	  }
	| {
			/**
			 * The dedicated connection itself (a `pg.Client`, a client already checked out of a pool, or PGlite). The caller
			 * owns it, its `error` events included: closing the database leaves it open. Nothing else may run statements on
			 * it while the database is open.
			 */
			readonly connection: PostgresConnection;
	  }
);

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Postgres's `int8` (`bigint`): what `INTEGER` becomes, and what `MIN`, `MAX` and `COUNT` over it return. */
const INT8 = 20;

/**
 * Translates one statement of the SQLite dialect the runtime's store and Pi Durable emit into Postgres:
 *
 * - `STRICT` tables and `CHECK (json_valid(…))` constraints are dropped (Postgres types are strict, and the records
 *   are only ever written by code that serialised them);
 * - `INTEGER` becomes `BIGINT`, in tables and in `ALTER TABLE … ADD COLUMN`, since epoch milliseconds and Pi's IDs
 *   outgrow `int4`;
 * - `INSERT OR IGNORE INTO …` becomes `INSERT INTO … ON CONFLICT DO NOTHING`;
 * - positional `?` becomes `$1`, `$2`, ….
 *
 * Only SQL itself is rewritten: quoted literals and identifiers and comments pass through unchanged, and a `?` in them
 * is not a parameter.
 *
 * Everything else the store and Pi emit is already valid Postgres: `ON CONFLICT (…) DO UPDATE SET … = excluded.…`,
 * `DELETE … RETURNING`, `MIN(…) AS at`, `CREATE INDEX IF NOT EXISTS`, partial indexes and `ALTER TABLE … RENAME TO`.
 */
export function translateSqliteToPostgres(sql: string): string {
	const segments = splitSql(sql);
	let index = 0;
	let ignore = false;
	const out = segments.map((segment, position) => {
		if (!segment.code) return segment.text;
		let text = segment.text
			.replace(/\)\s*STRICT\b/g, ")")
			.replace(/\s*CHECK \(json_valid\(\w+\)\)/g, "")
			.replace(/\bINTEGER\b/g, "BIGINT");
		if (position === 0 && /^\s*INSERT OR IGNORE INTO/i.test(text)) {
			text = text.replace(/INSERT OR IGNORE INTO/i, "INSERT INTO");
			ignore = true;
		}
		return text.replace(/\?/g, () => {
			index += 1;
			return `$${index}`;
		});
	});
	const result = out.join("");
	return ignore ? `${result} ON CONFLICT DO NOTHING` : result;
}

/** `sql` cut into code and what isn't: quoted literals and identifiers, and line and block comments. */
function splitSql(sql: string): { readonly text: string; readonly code: boolean }[] {
	const segments: { text: string; code: boolean }[] = [];
	let start = 0;
	let at = 0;
	const cut = (end: number, code: boolean) => {
		if (end > start) segments.push({ text: sql.slice(start, end), code });
		start = end;
	};
	while (at < sql.length) {
		const char = sql[at];
		const pair = sql.slice(at, at + 2);
		let end: number | undefined;
		if (char === "'" || char === '"') {
			// A doubled quote inside is an escaped one, so the literal runs on.
			end = at + 1;
			while (end < sql.length) {
				if (sql[end] === char) {
					if (sql[end + 1] === char) end += 2;
					else break;
				} else end += 1;
			}
			end = Math.min(end + 1, sql.length);
		} else if (pair === "--") {
			const newline = sql.indexOf("\n", at);
			end = newline === -1 ? sql.length : newline;
		} else if (pair === "/*") {
			const close = sql.indexOf("*/", at + 2);
			end = close === -1 ? sql.length : close + 2;
		}
		if (end === undefined) {
			at += 1;
			continue;
		}
		cut(at, true);
		cut(end, false);
		at = end;
	}
	cut(sql.length, true);
	return segments;
}

function toParam(value: SqliteValue): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

/**
 * `int8` comes back as a string from `pg` and as a `bigint` from PGlite; the store and Pi compare them as numbers.
 * Values past the safe integer range stay `bigint`, which chord's `SqliteValue` allows.
 */
function int8Of(value: unknown): unknown {
	if (typeof value !== "string" && typeof value !== "bigint") return value;
	const big = BigInt(value);
	return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

function rowsOf<T>(result: Awaited<ReturnType<PostgresConnection["query"]>>): T[] {
	const int8Columns = (result.fields ?? []).filter((field) => field.dataTypeID === INT8).map((field) => field.name);
	if (int8Columns.length === 0) return result.rows as T[];
	return result.rows.map((row) => {
		const converted = { ...(row as Record<string, unknown>) };
		for (const column of int8Columns) converted[column] = int8Of(converted[column]);
		return converted as T;
	});
}

/** Runs operations one at a time, in call order, whether or not the one before failed. */
class SerialQueue {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.#tail.then(operation, operation);
		this.#tail = next.catch(() => undefined);
		return next;
	}
}

class PostgresExecutor implements SqliteExecutor {
	constructor(
		private readonly connection: PostgresConnection,
		private readonly check: () => void,
	) {}

	async exec(sql: string): Promise<void> {
		this.check();
		await this.connection.query(translateSqliteToPostgres(sql));
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.check();
		await this.connection.query(translateSqliteToPostgres(sql), params.map(toParam));
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return (await this.all<T>(sql, ...params))[0];
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.check();
		return rowsOf<T>(await this.connection.query(translateSqliteToPostgres(sql), params.map(toParam)));
	}
}

/** The facade. Open it with `openPostgresSessionDatabase`. */
export class PostgresSessionDatabase implements SqliteDatabase {
	readonly #connection: PostgresConnection;
	readonly #release: (error?: Error | boolean) => void;
	readonly #queue = new SerialQueue();
	readonly #executor: PostgresExecutor;
	#closed = false;
	/** The connection was lost: every later statement rejects with this, and closing releases it as broken. */
	#failure: Error | undefined;

	constructor(connection: PostgresConnection, release: (error?: Error | boolean) => void) {
		this.#connection = connection;
		this.#release = release;
		this.#executor = new PostgresExecutor(connection, this.#checkOpen);
	}

	#checkOpen = () => {
		if (this.#closed) throw new Error("The Postgres session database is closed");
		if (this.#failure !== undefined) {
			throw new Error("The Postgres session database lost its connection", { cause: this.#failure });
		}
	};

	/** Marks the connection lost (its client emitted `error`). */
	fail(error: Error): void {
		this.#failure ??= error;
	}

	exec(sql: string): Promise<void> {
		return this.#queue.run(() => this.#executor.exec(sql));
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.#queue.run(() => this.#executor.run(sql, ...params));
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#queue.run(() => this.#executor.get<T>(sql, ...params));
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#queue.run(() => this.#executor.all<T>(sql, ...params));
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#queue.run(async () => {
			this.#checkOpen();
			const scope = { active: true };
			await this.#connection.query("BEGIN");
			try {
				const result = await callback(
					new PostgresExecutor(this.#connection, () => {
						this.#checkOpen();
						if (!scope.active) throw new Error("The Postgres transaction handle is no longer active");
					}),
				);
				scope.active = false;
				await this.#connection.query("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					await this.#connection.query("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "The Postgres transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	/** Waits for queued work, then gives the connection back: released to its pool, or left to its owner. */
	close(): Promise<void> {
		return this.#queue.run(async () => {
			if (this.#closed) return;
			this.#closed = true;
			if (this.#failure !== undefined) {
				this.#release(this.#failure);
				return;
			}
			try {
				await this.#connection.query("RESET search_path");
			} catch (error) {
				this.#release(error instanceof Error ? error : true);
				return;
			}
			this.#release();
		});
	}
}

/**
 * Opens the facade on its dedicated connection: creates the schema if it is missing and puts it on the connection's
 * `search_path`, so the unqualified names the store and Pi use land there.
 */
export async function openPostgresSessionDatabase(
	options: PostgresSessionDatabaseOptions,
): Promise<PostgresSessionDatabase> {
	const { schema } = options;
	if (!SCHEMA_NAME.test(schema)) throw new Error(`"${schema}" is not a valid schema name`);
	let connection: PostgresConnection;
	let release: (error?: Error | boolean) => void;
	// A pool client's `error` before the database exists is kept for it; after, it fails the database.
	let lost: Error | undefined;
	let database: PostgresSessionDatabase | undefined;
	if ("pool" in options) {
		const client = await options.pool.connect();
		const onError = (error: Error) => {
			if (database === undefined) lost ??= error;
			else database.fail(error);
		};
		client.on?.("error", onError);
		connection = client;
		let released = false;
		release = (error) => {
			if (released) return;
			released = true;
			// A healthy client goes back to the pool, which listens again; a broken one keeps this listener while it ends.
			if (error === undefined) client.off?.("error", onError);
			client.release(error);
		};
	} else {
		connection = options.connection;
		release = () => {};
	}
	try {
		await connection.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
		await connection.query(`SET search_path TO "${schema}"`);
		if (lost !== undefined) throw lost;
	} catch (error) {
		release(error instanceof Error ? error : true);
		throw error;
	}
	database = new PostgresSessionDatabase(connection, release);
	return database;
}
