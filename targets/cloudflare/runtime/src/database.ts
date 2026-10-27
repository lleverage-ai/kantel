/**
 * Chord's portable `SqliteDatabase` facade over a Durable Object's SQLite (`ctx.storage.sql`), so the runtime's SQL
 * session store and Pi Durable's `SqliteStorage` run on it unchanged. Portable to Workers: no Node modules and no
 * workers-types, only the minimal shapes below.
 *
 * Transactions. Chord's `transaction(callback)` takes an async callback: the store and Pi await each statement inside
 * it (Pi's `SqliteStorage.commit` reads, checks and writes across a dozen awaits). `ctx.storage.transactionSync` takes
 * only a synchronous closure, and an `await` always yields, so the callback can never finish inside one; and Durable
 * Object SQL refuses `BEGIN`, `COMMIT` and `SAVEPOINT`. So a transaction here runs through the object's async
 * `ctx.storage.transaction(closure)`, which on SQLite-backed objects makes every `sql.exec` the closure runs part of
 * one transaction, committed when the closure resolves and rolled back when it rejects. That is what chord's own
 * `DurableObjectSqliteDatabase` (and Pi Durable's `openDurableObjectSqliteStorage`) do.
 *
 * Nothing else gets in between. `sql.exec` is synchronous, and the callbacks await nothing but these statements (no
 * network, no timers), so each callback runs to its end in microtasks, before the object's input gate lets another
 * event in. Work of this object's already in flight could still run between those microtasks, so every statement and
 * transaction goes through one queue: outside a transaction a statement runs at once, and while one is open, every
 * other call waits for it to settle. Other storage operations (alarms) go through the queue too
 * (`outsideTransactions`), so a rollback never takes them with it.
 */
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";

/** A value SQLite hands back or takes as a binding, as a Durable Object's SQL API types it. */
export type SqlValue = ArrayBuffer | string | number | null;

/** The cursor `exec` returns: the part of a Durable Object's `SqlStorageCursor` the facade uses. */
export interface SqlCursorLike<T> {
	toArray(): T[];
}

/** The part of a Durable Object's `ctx.storage.sql` the facade uses: synchronous `exec` with `?` bindings. */
export interface SqlStorageLike {
	exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursorLike<T>;
}

/**
 * Runs `work` as one transaction over every `sql.exec` it makes, committed when it resolves and rolled back when it
 * rejects: the object's `(work) => ctx.storage.transaction(() => work())`.
 */
export type DurableObjectTransaction = <T>(work: () => Promise<T>) => Promise<T>;

export interface DurableObjectSessionDatabaseOptions {
	/** The object's `ctx.storage.sql`. */
	readonly sql: SqlStorageLike;
	/** The object's async `ctx.storage.transaction`; see `DurableObjectTransaction`. */
	readonly transaction: DurableObjectTransaction;
}

/** Durable Object SQL binds numbers as doubles: a `bigint` outside the safe integer range would lose precision. */
function bindingOf(value: SqliteValue): SqlValue {
	if (value instanceof Uint8Array) return value.slice().buffer;
	if (typeof value !== "bigint") return value;
	if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`Durable Object SQL cannot bind ${value} without losing precision`);
	}
	return Number(value);
}

/** A row as chord's facade returns it: `BLOB` columns as `Uint8Array`. */
function rowOf<T>(row: Record<string, SqlValue>): T {
	for (const [column, value] of Object.entries(row)) {
		if (value instanceof ArrayBuffer) (row as Record<string, unknown>)[column] = new Uint8Array(value);
	}
	return row as T;
}

const ignore = () => {};

/** Runs operations in call order: one runs at once when nothing is queued; a held one makes later ones wait for it. */
class OperationQueue {
	#tail: Promise<unknown> = Promise.resolve();
	#pending = 0;

	run<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.#pending > 0) return this.hold(operation);
		try {
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	hold<T>(operation: () => T | Promise<T>): Promise<T> {
		this.#pending += 1;
		const result = this.#tail.then(operation).finally(() => {
			this.#pending -= 1;
		});
		this.#tail = result.then(ignore, ignore);
		return result;
	}
}

class DurableObjectExecutor implements SqliteExecutor {
	constructor(
		private readonly sql: SqlStorageLike,
		private readonly check: () => void,
	) {}

	async exec(sql: string): Promise<void> {
		this.check();
		this.sql.exec(sql);
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.check();
		this.sql.exec(sql, ...params.map(bindingOf));
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return (await this.all<T>(sql, ...params))[0];
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.check();
		return this.sql
			.exec(sql, ...params.map(bindingOf))
			.toArray()
			.map((row) => rowOf<T>(row));
	}
}

/** The facade over one object's SQLite. Build one per object and share it: its queue is what orders the calls. */
export class DurableObjectSessionDatabase implements SqliteDatabase {
	readonly #sql: SqlStorageLike;
	readonly #transaction: DurableObjectTransaction;
	readonly #queue = new OperationQueue();
	readonly #executor: DurableObjectExecutor;
	#closed = false;

	constructor(options: DurableObjectSessionDatabaseOptions) {
		this.#sql = options.sql;
		this.#transaction = options.transaction;
		this.#executor = new DurableObjectExecutor(this.#sql, this.#checkOpen);
	}

	#checkOpen = () => {
		if (this.#closed) throw new Error("The Durable Object session database is closed");
	};

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
		return this.#queue.hold(() => {
			this.#checkOpen();
			return this.#transaction(async () => {
				const scope = { active: true };
				const handle = new DurableObjectExecutor(this.#sql, () => {
					this.#checkOpen();
					if (!scope.active) throw new Error("The Durable Object transaction handle is no longer active");
				});
				try {
					return await callback(handle);
				} finally {
					scope.active = false;
				}
			});
		});
	}

	/** Runs `work` (another storage operation, such as setting the alarm) when no transaction is open, holding the rest. */
	outsideTransactions<T>(work: () => Promise<T>): Promise<T> {
		return this.#queue.hold(work);
	}

	/** Waits for queued work; later calls fail. The object owns its storage, so nothing else closes. */
	close(): Promise<void> {
		return this.#queue.run(() => {
			this.#closed = true;
		});
	}
}
