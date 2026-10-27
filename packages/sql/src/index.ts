/**
 * The small SQL seam Harbour's durable stores run on, so one implementation serves Postgres (self-hosted) and SQLite
 * (Cloudflare D1, a Durable Object's SQLite storage, or `node:sqlite` in tests). Statements use `?` placeholders; the
 * Postgres adapters number them.
 *
 * There are no interactive transactions, because D1 has none: a change that must be atomic is one `batch`. A producer
 * that writes its own rows and its audit events in one transaction puts both in one batch, or (on Postgres) builds a
 * driver over a client already inside its transaction with `postgresClientDriver`.
 */

export type SqlValue = string | number | null;

export interface SqlStatement {
	readonly sql: string;
	readonly params?: readonly SqlValue[];
}

export type SqlDialect = "postgres" | "sqlite";

export type SqlRow = { readonly [column: string]: unknown };

export interface SqlDriver {
	readonly dialect: SqlDialect;
	/** Runs one statement and resolves its rows (none for a statement that returns none). */
	query<Row extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
	/**
	 * Runs statements in order, atomically: all of them or none. A driver over a connection already inside a
	 * transaction runs them as part of it.
	 */
	batch(statements: readonly SqlStatement[]): Promise<void>;
}

/** A statement, for building batches. */
export function sql(text: string, ...params: SqlValue[]): SqlStatement {
	return { sql: text, params };
}

/** Rewrites `?` placeholders as Postgres's `$1`, `$2`, … Harbour's SQL never has a `?` inside a literal. */
export function toPostgresPlaceholders(text: string): string {
	let index = 0;
	return text.replace(/\?/g, () => {
		index += 1;
		return `$${index}`;
	});
}

/** A finite number from a column a driver may hand back as a string or a bigint (Postgres `BIGINT`). */
export function sqlNumber(value: unknown): number {
	const number = typeof value === "bigint" || typeof value === "string" ? Number(value) : value;
	if (typeof number !== "number" || !Number.isFinite(number))
		throw new Error(`Expected a number, got ${String(value)}`);
	return number;
}

/** A column that may be null, as a string or undefined. */
export function sqlOptionalString(value: unknown): string | undefined {
	return value === null || value === undefined ? undefined : String(value);
}
