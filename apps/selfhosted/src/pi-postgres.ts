// Pi Durable storage on Postgres.
//
// Pi Durable's portable SQL storage core (`SqliteStorage` from
// @earendil-works/pi-durable/storage/sqlite) runs over any async
// `SqliteDatabase` facade. This module is that facade for Postgres: one
// dedicated connection per session, the session's own schema on its
// search_path, Pi's SQL translated to Postgres, and a fencing check inside
// every transaction so a host that lost the session lease cannot commit.
//
// Gate: Pi Durable's own storage conformance suite (test/pi-postgres.test.ts).
// Pin @earendil-works/pi-durable exactly: a Pi upgrade can change its SQL, and
// the suite is what tells us whether the translation still holds.

import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import pg from "pg";

// int8 (bigint) and numeric come back as strings by default; Pi's core compares
// them as numbers. IDs and sequences stay well inside the safe integer range.
pg.types.setTypeParser(20, (value) => Number(value));

/** Translate one statement of Pi's SQLite dialect into Postgres. */
export function translateSql(sql: string): string {
	let out = sql
		.replace(/\)\s*STRICT\b/g, ")")
		.replace(/\s*CHECK \(json_valid\(\w+\)\)/g, "")
		.replace(/\bINTEGER PRIMARY KEY\b/g, "BIGINT PRIMARY KEY")
		.replace(/\bINTEGER\b/g, "BIGINT");
	if (/^\s*INSERT OR IGNORE INTO/i.test(out)) {
		out = `${out.replace(/INSERT OR IGNORE INTO/i, "INSERT INTO")} ON CONFLICT DO NOTHING`;
	}
	// Positional `?` to `$n`, outside quoted literals.
	let index = 0;
	let quoted: string | undefined;
	let result = "";
	for (const char of out) {
		if (quoted !== undefined) {
			if (char === quoted) quoted = undefined;
			result += char;
		} else if (char === "'" || char === '"') {
			quoted = char;
			result += char;
		} else if (char === "?") {
			result += `$${++index}`;
		} else {
			result += char;
		}
	}
	return result;
}

/** Called inside every write transaction, before Pi's statements; throws to refuse the commit. */
export type FenceCheck = (client: pg.ClientBase) => Promise<void>;

function toParam(value: SqliteValue): unknown {
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Uint8Array) return Buffer.from(value);
	return value;
}

/** Runs operations one at a time, in call order. */
class SerialQueue {
	#tail: Promise<unknown> = Promise.resolve();
	run<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.#tail.then(operation, operation);
		this.#tail = next.catch(() => undefined);
		return next;
	}
}

class Executor implements SqliteExecutor {
	constructor(
		protected readonly client: pg.ClientBase,
		private readonly guard: () => void,
	) {}

	async exec(sql: string): Promise<void> {
		this.guard();
		await this.client.query(translateSql(sql));
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.guard();
		await this.client.query(translateSql(sql), params.map(toParam));
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		this.guard();
		const result = await this.client.query(translateSql(sql), params.map(toParam));
		return result.rows[0] as T | undefined;
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.guard();
		const result = await this.client.query(translateSql(sql), params.map(toParam));
		return result.rows as T[];
	}
}

export interface PostgresDatabaseOptions {
	connectionString: string;
	/** Schema holding this session's Pi tables. */
	schema: string;
	/** Checked at the start of every transaction and every write outside one. */
	fence?: FenceCheck;
}

export class PostgresSqliteDatabase implements SqliteDatabase {
	readonly #client: pg.Client;
	readonly #queue = new SerialQueue();
	readonly #fence?: FenceCheck;
	#closed = false;

	private constructor(client: pg.Client, fence?: FenceCheck) {
		this.#client = client;
		this.#fence = fence;
	}

	static async open(options: PostgresDatabaseOptions): Promise<PostgresSqliteDatabase> {
		if (!/^[a-z_][a-z0-9_]*$/.test(options.schema)) throw new Error(`invalid schema ${options.schema}`);
		const client = new pg.Client({ connectionString: options.connectionString });
		await client.connect();
		await client.query(`CREATE SCHEMA IF NOT EXISTS ${options.schema}`);
		await client.query(`SET search_path TO ${options.schema}`);
		return new PostgresSqliteDatabase(client, options.fence);
	}

	#guard = () => {
		if (this.#closed) throw new Error("Postgres storage is closed");
	};

	exec(sql: string): Promise<void> {
		return this.#write(sql, []);
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.#write(sql, params);
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#queue.run(() => new Executor(this.#client, this.#guard).get<T>(sql, ...params));
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#queue.run(() => new Executor(this.#client, this.#guard).all<T>(sql, ...params));
	}

	/** A write outside a transaction gets its own, so the fence still applies. */
	#write(sql: string, params: SqliteValue[]): Promise<void> {
		return this.transaction(async (tx) => {
			if (params.length === 0) await tx.exec(sql);
			else await tx.run(sql, ...params);
		});
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#queue.run(async () => {
			this.#guard();
			const scope = { active: true };
			await this.#client.query("BEGIN");
			try {
				await this.#fence?.(this.#client);
				const result = await callback(
					new Executor(this.#client, () => {
						this.#guard();
						if (!scope.active) throw new Error("Postgres transaction handle is no longer active");
					}),
				);
				scope.active = false;
				await this.#client.query("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					await this.#client.query("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "Postgres transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.#queue.run(async () => {
			if (this.#closed) return;
			this.#closed = true;
			await this.#client.end();
		});
	}
}

/** Open Pi Durable storage for one session on Postgres. */
export async function openPostgresStorage(options: PostgresDatabaseOptions): Promise<Storage> {
	const database = await PostgresSqliteDatabase.open(options);
	return SqliteStorage.open(database);
}

/** A stable, valid schema name for a session ID. */
export function piSchemaFor(sessionId: string): string {
	const hash = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex").slice(0, 24);
	return `pi_${hash}`;
}
