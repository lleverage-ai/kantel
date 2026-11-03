/**
 * The compute plane's records in SQL (Postgres self-hosted, SQLite on D1 or `node:sqlite`), so a gateway keeps them
 * across restarts and several gateways over one database share them. It behaves as the memory store does
 * (`store.ts`): records copied in and out, `list` oldest first by first insertion, and `update` and `insert`
 * atomic.
 *
 * Every collection is rows of one table, `compute_api_records`: its kind (the collection's name), its ID, `seq` (when
 * it was first put, which a replace keeps), `version` (bumped on every write) and the record as JSON. The `SqlDriver`
 * has no interactive transactions (D1 has none), so `update` is optimistic: it reads the record and its version,
 * changes it, and writes it only if the version is still the one it read, else reads again and retries.
 *
 * It keeps exactly what the memory store keeps: secrets as their SHA-256 hex, except a webhook's signing secret and a
 * device sign-in's key secret until it is collected. Nothing here logs a record.
 */
import { type SqlDriver, type SqlValue, sqlNumber } from "@kantel/sql";
import { type Collection, type ComputeStore, matches } from "./store.ts";

/** Writes an `update` retries after losing to another writer, before it gives up. */
const UPDATE_ATTEMPTS = 50;
/** The advisory lock a Postgres migration takes, so two gateways starting at once don't race to create the table. */
const MIGRATE_LOCK = "SELECT pg_advisory_xact_lock(7316102020)";
/** A field `list` may filter on in SQL: it is written into the statement, so nothing but a plain name. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const SELECT_DATA = "SELECT data FROM compute_api_records WHERE kind = ? AND id = ?";
const SELECT_VERSIONED = "SELECT data, version FROM compute_api_records WHERE kind = ? AND id = ?";
/** Writes only over the version that was read, and answers a row only when it did. */
const UPDATE_VERSIONED =
	"UPDATE compute_api_records SET data = ?, version = version + 1 WHERE kind = ? AND id = ? AND version = ? RETURNING id";
const DELETE_ONE = "DELETE FROM compute_api_records WHERE kind = ? AND id = ? RETURNING id";

/** The store's table, sequence and index. Every statement is `IF NOT EXISTS`, so migrating again is harmless. */
export function computeStoreSchema(dialect: SqlDriver["dialect"]): string[] {
	const seq = dialect === "postgres" ? "BIGINT" : "INTEGER";
	return [
		...(dialect === "postgres" ? ["CREATE SEQUENCE IF NOT EXISTS compute_api_records_seq"] : []),
		`CREATE TABLE IF NOT EXISTS compute_api_records (
			kind TEXT NOT NULL,
			id TEXT NOT NULL,
			seq ${seq} NOT NULL,
			version INTEGER NOT NULL,
			data TEXT NOT NULL,
			PRIMARY KEY (kind, id)
		)`,
		"CREATE INDEX IF NOT EXISTS compute_api_records_order ON compute_api_records (kind, seq)",
	];
}

/**
 * Creates the store's table if it is missing, in one batch. On Postgres the batch takes an advisory lock first: two
 * `CREATE ... IF NOT EXISTS` at once can still both try to create, and one fail.
 */
export async function migrateComputeStore(driver: SqlDriver): Promise<void> {
	const statements = computeStoreSchema(driver.dialect).map((text) => ({ sql: text }));
	await driver.batch(driver.dialect === "postgres" ? [{ sql: MIGRATE_LOCK }, ...statements] : statements);
}

const parse = <T>(row: { readonly [column: string]: unknown }): T => JSON.parse(String(row.data)) as T;

/**
 * One kind of record in `compute_api_records`. Postgres numbers `seq` from a sequence; SQLite takes one more than the
 * kind's highest inside the insert, which is safe because SQLite (D1 too) has one writer at a time.
 */
export function sqlCollection<T extends { readonly id: string }>(driver: SqlDriver, kind: string): Collection<T> {
	const postgres = driver.dialect === "postgres";
	const insert = postgres
		? `INSERT INTO compute_api_records (kind, id, seq, version, data)
			VALUES (?, ?, nextval('compute_api_records_seq'), 1, ?)
			ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data, version = compute_api_records.version + 1`
		: `INSERT INTO compute_api_records (kind, id, seq, version, data)
			VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM compute_api_records WHERE kind = ?), 1, ?)
			ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data, version = compute_api_records.version + 1`;
	// The same insert, but a row already there is left alone and no row comes back: one statement, so of two writers at
	// once exactly one gets its row back.
	const insertNew = postgres
		? `INSERT INTO compute_api_records (kind, id, seq, version, data)
			VALUES (?, ?, nextval('compute_api_records_seq'), 1, ?)
			ON CONFLICT (kind, id) DO NOTHING RETURNING id`
		: `INSERT INTO compute_api_records (kind, id, seq, version, data)
			VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM compute_api_records WHERE kind = ?), 1, ?)
			ON CONFLICT (kind, id) DO NOTHING RETURNING id`;
	const field = (name: string) => {
		if (!FIELD_NAME.test(name)) throw new Error(`A compute record has no field ${JSON.stringify(name)} to list by`);
		return postgres ? `(data::jsonb ->> '${name}')` : `json_extract(data, '$.${name}')`;
	};
	const select = (clauses: readonly string[], params: readonly SqlValue[]) =>
		driver.query(`SELECT data FROM compute_api_records WHERE ${clauses.join(" AND ")} ORDER BY seq`, params);
	return {
		async get(id) {
			const [row] = await driver.query(SELECT_DATA, [kind, id]);
			return row === undefined ? undefined : parse<T>(row);
		},
		async put(record) {
			const data = JSON.stringify(record);
			await driver.query(insert, postgres ? [kind, record.id, data] : [kind, record.id, kind, data]);
		},
		async insert(record) {
			const data = JSON.stringify(record);
			const rows = await driver.query(insertNew, postgres ? [kind, record.id, data] : [kind, record.id, kind, data]);
			return rows.length > 0;
		},
		async update(id, change) {
			for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
				const [row] = await driver.query(SELECT_VERSIONED, [kind, id]);
				if (row === undefined) return undefined;
				const next = change(parse<T>(row));
				if (next === undefined) return undefined;
				const data = JSON.stringify(next);
				const written = await driver.query(UPDATE_VERSIONED, [data, kind, id, sqlNumber(row.version)]);
				// Answered as a later `get` would read it.
				if (written.length > 0) return JSON.parse(data) as T;
			}
			throw new Error(`The ${kind} record kept changing while it was updated; gave up after ${UPDATE_ATTEMPTS} tries`);
		},
		async delete(id) {
			const rows = await driver.query(DELETE_ONE, [kind, id]);
			return rows.length > 0;
		},
		async list(where) {
			// String fields narrow the rows in SQL; the rest (booleans, numbers) only in the check below, which every row
			// passes through so the answer is the memory store's.
			const clauses = ["kind = ?"];
			const params: SqlValue[] = [kind];
			for (const [name, value] of Object.entries(where ?? {})) {
				if (value === undefined) continue;
				const column = field(name);
				if (typeof value !== "string") continue;
				clauses.push(`${column} = ?`);
				params.push(value);
			}
			// Postgres's `jsonb` refuses some JSON that JavaScript writes (a `\u0000` escape, as a command's binary output may
			// hold, or a lone surrogate), and one such row fails the whole query: then the kind is read whole and checked
			// below alone.
			const rows =
				clauses.length === 1
					? await select(clauses, params)
					: await select(clauses, params).catch(() => select(clauses.slice(0, 1), params.slice(0, 1)));
			return rows.map((row) => parse<T>(row)).filter((record) => matches(record, where));
		},
	};
}

/** A `ComputeStore` in SQL. Run `migrateComputeStore` first. */
export function createSqlComputeStore(driver: SqlDriver): ComputeStore {
	return {
		users: sqlCollection(driver, "users"),
		accounts: sqlCollection(driver, "accounts"),
		members: sqlCollection(driver, "members"),
		invites: sqlCollection(driver, "invites"),
		sandboxes: sqlCollection(driver, "sandboxes"),
		commands: sqlCollection(driver, "commands"),
		snapshots: sqlCollection(driver, "snapshots"),
		apiKeys: sqlCollection(driver, "apiKeys"),
		webhooks: sqlCollection(driver, "webhooks"),
		deliveries: sqlCollection(driver, "deliveries"),
		telemetry: sqlCollection(driver, "telemetry"),
		proxies: sqlCollection(driver, "proxies"),
		hosts: sqlCollection(driver, "hosts"),
		joinTokens: sqlCollection(driver, "joinTokens"),
		events: sqlCollection(driver, "events"),
		idempotency: sqlCollection(driver, "idempotency"),
		deviceLogins: sqlCollection(driver, "deviceLogins"),
	};
}
