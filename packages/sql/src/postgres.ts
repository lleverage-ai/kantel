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

/**
 * Socket errors that mean the database can't be reached, or the connection to it is gone (Node's `error.code`).
 */
const SOCKET_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"EHOSTDOWN",
	"ENETUNREACH",
	"ENETDOWN",
	"ENOTFOUND",
	"EAI_AGAIN",
]);

/**
 * What `pg` and `pg-pool` say when a connection is gone, couldn't be made in time, or a statement got no answer in
 * time (`query_timeout`). They carry no code.
 */
const LOST_MESSAGES =
	/Connection terminated|timeout exceeded when trying to connect|Query read timeout|not queryable|Client was closed|Connection is closed|socket hang up/i;

/** Postgres's SQLSTATEs for a server that is shutting down, starting up or in recovery, or dropped the connection. */
const UNAVAILABLE_STATES = new Set(["57P01", "57P02", "57P03", "53300"]);

/** Postgres's SQLSTATE for a write on a read-only server, such as a primary demoted to a standby after a failover. */
const READ_ONLY_STATE = "25006";

/**
 * How a Postgres call failed, as far as trying again goes:
 *
 *   unavailable  the database couldn't be reached, or the connection broke: a statement sent on it may or may not have
 *                run
 *   readOnly     the server refused the write (it's read-only, as an old primary is after a failover): nothing ran,
 *                and the connection is to the wrong server
 *   other        anything else: a constraint, a syntax error, a timeout the server enforced
 */
export function postgresFailure(error: unknown): "unavailable" | "readOnly" | "other" {
	if (typeof error !== "object" || error === null) return "other";
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (code === READ_ONLY_STATE) return "readOnly";
	if (typeof code === "string") {
		if (SOCKET_CODES.has(code) || UNAVAILABLE_STATES.has(code) || code.startsWith("08")) return "unavailable";
	}
	if (typeof message === "string" && LOST_MESSAGES.test(message)) return "unavailable";
	const cause = (error as { cause?: unknown }).cause;
	return cause === undefined || cause === error ? "other" : postgresFailure(cause);
}

/**
 * The connection broke after `COMMIT` was sent, so the batch may or may not have been applied. It is never sent again
 * by itself: the caller decides, reading what's there first if it matters. `cause` is the connection's error.
 */
export class PostgresCommitUnknownError extends Error {
	override readonly name = "PostgresCommitUnknownError";
	constructor(cause: unknown) {
		super(
			`The connection to Postgres broke while a batch was committing, so it may or may not have been applied (${
				(cause as Error)?.message ?? String(cause)
			})`,
			{ cause },
		);
	}
}

export interface PostgresPoolDriverOptions {
	/**
	 * The pauses before each new attempt at a call that failed before Postgres could have applied it: no connection to be
	 * had, a read-only server, or (a batch) a connection that broke before its `COMMIT` was sent. One entry an attempt;
	 * none (the default) tries once. A statement or `COMMIT` that may have run is never tried again.
	 */
	readonly retryMs?: readonly number[];
	/**
	 * Told when a connection turned out broken or read-only, so the pool's other connections, likely to the same old
	 * server, can be replaced (`postgresRenewingPool`).
	 */
	readonly onConnectionLost?: (error: unknown) => void;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A call's error from before Postgres could have applied anything, so another attempt is safe. */
class NotSent extends Error {
	constructor(override readonly cause: unknown) {
		super("not sent");
	}
}

/** Worth another attempt: nothing was applied, and the cause was the connection or the server, not the call. */
const retryable = (error: unknown) => error instanceof NotSent && postgresFailure(error.cause) !== "other";

/** The call's own error, as the caller should see it. */
async function unwrap<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (error) {
		throw error instanceof NotSent ? error.cause : error;
	}
}

/**
 * A driver over a `pg` pool: each batch takes a connection and runs in `BEGIN` … `COMMIT`. A broken or read-only
 * connection is released to be closed, not reused. With `retryMs`, a call that failed before Postgres could have applied
 * it is tried again on another connection; a batch whose connection broke after `COMMIT` was sent fails with
 * `PostgresCommitUnknownError`.
 */
export function postgresPoolDriver(pool: PostgresPool, options: PostgresPoolDriverOptions = {}): SqlDriver {
	const retryMs = options.retryMs ?? [];
	const lost = (error: unknown) => {
		if (postgresFailure(error) !== "other") options.onConnectionLost?.(error);
	};
	/** Runs `attempt` until it succeeds, throws something not worth another go, or the pauses run out. */
	const withRetries = async <T>(attempt: () => Promise<T>, again: (error: unknown) => boolean): Promise<T> => {
		for (let tried = 0; ; tried++) {
			try {
				return await attempt();
			} catch (error) {
				const wait = retryMs[tried];
				if (wait === undefined || !again(error)) throw error;
				await pause(wait);
			}
		}
	};
	/** A connection from the pool; failing to get one is marked as nothing having been sent. */
	const connect = async () => {
		try {
			return await pool.connect();
		} catch (error) {
			lost(error);
			throw new NotSent(error);
		}
	};
	return {
		dialect: "postgres",
		query: <Row extends SqlRow>(text: string, params?: readonly SqlValue[]) =>
			unwrap(
				withRetries(async () => {
					const client = await connect();
					try {
						const rows = await rowsOf<Row>(client, text, params);
						client.release();
						return rows;
					} catch (error) {
						const failure = postgresFailure(error);
						client.release(failure !== "other");
						lost(error);
						// A read-only server refused the statement: it didn't run.
						throw failure === "readOnly" ? new NotSent(error) : error;
					}
				}, retryable),
			),
		async batch(statements) {
			if (statements.length === 0) return;
			await unwrap(
				withRetries(async () => {
					const client = await connect();
					let committing = false;
					let failed = false;
					try {
						await client.query("BEGIN");
						await runAll(client, statements);
						committing = true;
						await client.query("COMMIT");
					} catch (error) {
						failed = true;
						const failure = postgresFailure(error);
						lost(error);
						if (failure === "unavailable" && committing) throw new PostgresCommitUnknownError(error);
						// On a connection that still answers, end the transaction; a broken one is closed, which ends it.
						if (failure !== "unavailable") await client.query("ROLLBACK").catch(() => undefined);
						// Before COMMIT, a broken connection or a read-only server leaves nothing applied.
						throw failure === "other" ? error : new NotSent(error);
					} finally {
						client.release(failed);
					}
				}, retryable),
			);
		},
	};
}

/** A pool that can be closed: `pg`'s `Pool`. */
export interface PostgresEndablePool extends PostgresPool {
	end(): Promise<void>;
}

export interface PostgresRenewingPool extends PostgresEndablePool {
	/**
	 * Replaces the pool with a new one, so new calls get new connections, and closes the old one once the connections
	 * it lent are back. At most once per `minIntervalMs`; calls in between do nothing.
	 */
	renew(why: unknown): void;
}

/**
 * A pool over pools: `create` makes one, and `renew` swaps it for another. After a failover a pool's idle connections
 * are all to the old server, broken or read-only, and each would fail one call before it is closed; and a connection
 * whose server vanished without closing it answers nothing until a statement times out. Renewing drops them together
 * the first time one fails.
 */
export function postgresRenewingPool(
	create: () => PostgresEndablePool,
	options: { readonly minIntervalMs?: number; readonly onRenew?: (why: unknown) => void } = {},
): PostgresRenewingPool {
	const minIntervalMs = options.minIntervalMs ?? 1_000;
	let current = create();
	let renewedAt = Number.NEGATIVE_INFINITY;
	let ended = false;
	const retiring = new Set<Promise<void>>();
	return {
		query: (text, params) => current.query(text, params),
		connect: () => current.connect(),
		renew(why) {
			const now = Date.now();
			if (ended || now - renewedAt < minIntervalMs) return;
			renewedAt = now;
			const old = current;
			current = create();
			options.onRenew?.(why);
			const closing = old.end().catch(() => undefined);
			retiring.add(closing);
			void closing.then(() => retiring.delete(closing));
		},
		async end() {
			ended = true;
			await Promise.all([current.end(), ...retiring]);
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
