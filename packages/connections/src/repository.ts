/**
 * Where the connections service keeps its records: one table of JSON records by kind, so SQLite (D1, a Durable Object,
 * node:sqlite), Postgres and memory behave the same. Every change is conditional on the revision read, so two
 * gateways over one database settle a race (a state used twice, a refresh made twice) in favour of one.
 *
 * No record holds a secret value: tokens, keys and client secrets are in the vault, and records hold their item IDs.
 */
import { type SqlDriver, sqlNumber } from "@kantel/sql";

/**
 * `github_app`: a GitHub App manifest flow in progress (#326), keyed by its state's hash like an attempt. `rules`: a
 * connection's access rules (#332), one record per connection under the connection's ID.
 */
export type RecordKind = "connection" | "attempt" | "client" | "registration" | "use" | "github_app" | "rules";

export interface StoredRecord<T> {
	readonly id: string;
	/** `""` for a record of the deployment's, such as a dynamic registration. */
	readonly organisationId: string;
	/**
	 * A secondary lookup: an attempt's or a GitHub App flow's state hash, a registration's issuer and redirect URI, a
	 * use's connection.
	 */
	readonly key?: string;
	/** A second lookup: a use's session. */
	readonly ref?: string;
	readonly value: T;
	readonly revision: number;
	readonly createdAt: number;
}

export interface ConnectionsRepository {
	get<T>(kind: RecordKind, id: string): Promise<StoredRecord<T> | undefined>;
	findByKey<T>(kind: RecordKind, key: string): Promise<StoredRecord<T> | undefined>;
	/** Newest first. `key`/`ref` filter on those columns. */
	list<T>(
		kind: RecordKind,
		filter: { readonly organisationId: string; readonly key?: string; readonly ref?: string; readonly limit?: number },
	): Promise<StoredRecord<T>[]>;
	/** Inserts; resolves `false` if the ID is taken. */
	insert<T>(kind: RecordKind, record: Omit<StoredRecord<T>, "revision">): Promise<boolean>;
	/** Replaces when the stored revision is still `revision`; resolves whether it did. `key` may change (or clear). */
	update<T>(kind: RecordKind, id: string, revision: number, value: T, key?: string | null): Promise<boolean>;
	remove(kind: RecordKind, id: string): Promise<void>;
}

/** Records in memory, for tests and a deployment with no database. */
export function createMemoryConnectionsRepository(): ConnectionsRepository {
	const tables = new Map<RecordKind, Map<string, StoredRecord<unknown>>>();
	const table = (kind: RecordKind) => {
		let found = tables.get(kind);
		if (found === undefined) {
			found = new Map();
			tables.set(kind, found);
		}
		return found;
	};
	const copy = <T>(record: StoredRecord<unknown>): StoredRecord<T> =>
		({ ...record, value: structuredClone(record.value) }) as StoredRecord<T>;
	return {
		async get(kind, id) {
			const found = table(kind).get(id);
			return found === undefined ? undefined : copy(found);
		},
		async findByKey(kind, key) {
			for (const record of table(kind).values()) if (record.key === key) return copy(record);
			return undefined;
		},
		async list(kind, filter) {
			const out = [...table(kind).values()]
				.filter(
					(record) =>
						record.organisationId === filter.organisationId &&
						(filter.key === undefined || record.key === filter.key) &&
						(filter.ref === undefined || record.ref === filter.ref),
				)
				.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
			return (filter.limit === undefined ? out : out.slice(0, filter.limit)).map((record) => copy(record));
		},
		async insert(kind, record) {
			if (table(kind).has(record.id)) return false;
			table(kind).set(record.id, { ...record, value: structuredClone(record.value), revision: 1 });
			return true;
		},
		async update(kind, id, revision, value, key) {
			const found = table(kind).get(id);
			if (found === undefined || found.revision !== revision) return false;
			const next: StoredRecord<unknown> = {
				...found,
				value: structuredClone(value),
				revision: revision + 1,
			};
			if (key === null) delete (next as { key?: string }).key;
			else if (key !== undefined) (next as { key?: string }).key = key;
			table(kind).set(id, next);
			return true;
		},
		async remove(kind, id) {
			table(kind).delete(id);
		},
	};
}

/** The connections table, for SQLite and Postgres alike. */
export function connectionsSchema(dialect: SqlDriver["dialect"]): string[] {
	const real = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS connection_records (
			kind TEXT NOT NULL,
			id TEXT NOT NULL,
			organisation_id TEXT NOT NULL,
			record_key TEXT,
			record_ref TEXT,
			data TEXT NOT NULL,
			revision INTEGER NOT NULL,
			created_at ${real} NOT NULL,
			PRIMARY KEY (kind, id)
		)`,
		"CREATE INDEX IF NOT EXISTS connection_records_org ON connection_records (kind, organisation_id, created_at)",
		"CREATE INDEX IF NOT EXISTS connection_records_key ON connection_records (kind, record_key)",
		"CREATE INDEX IF NOT EXISTS connection_records_ref ON connection_records (kind, organisation_id, record_ref)",
	];
}

/** Creates the connections table if it is missing. */
export async function migrateConnections(driver: SqlDriver): Promise<void> {
	await driver.batch(connectionsSchema(driver.dialect).map((text) => ({ sql: text })));
}

const COLUMNS = "id, organisation_id, record_key, record_ref, data, revision, created_at";

function recordFrom<T>(row: Record<string, unknown>): StoredRecord<T> {
	const key = row.record_key;
	const ref = row.record_ref;
	return {
		id: String(row.id),
		organisationId: String(row.organisation_id),
		...(typeof key === "string" ? { key } : {}),
		...(typeof ref === "string" ? { ref } : {}),
		value: JSON.parse(String(row.data)) as T,
		revision: sqlNumber(row.revision),
		createdAt: sqlNumber(row.created_at),
	};
}

/** Records in SQL. Run `migrateConnections` first. */
export function createSqlConnectionsRepository(driver: SqlDriver): ConnectionsRepository {
	const changed = async (sql: string, params: (string | number | null)[]): Promise<boolean> => {
		const rows = await driver.query(`${sql} RETURNING id`, params);
		return rows.length > 0;
	};
	return {
		async get(kind, id) {
			const rows = await driver.query(`SELECT ${COLUMNS} FROM connection_records WHERE kind = ? AND id = ?`, [
				kind,
				id,
			]);
			return rows[0] === undefined ? undefined : recordFrom(rows[0]);
		},
		async findByKey(kind, key) {
			const rows = await driver.query(
				`SELECT ${COLUMNS} FROM connection_records WHERE kind = ? AND record_key = ? LIMIT 1`,
				[kind, key],
			);
			return rows[0] === undefined ? undefined : recordFrom(rows[0]);
		},
		async list(kind, filter) {
			const where = ["kind = ?", "organisation_id = ?"];
			const params: (string | number)[] = [kind, filter.organisationId];
			if (filter.key !== undefined) {
				where.push("record_key = ?");
				params.push(filter.key);
			}
			if (filter.ref !== undefined) {
				where.push("record_ref = ?");
				params.push(filter.ref);
			}
			const limit = filter.limit === undefined ? "" : ` LIMIT ${Math.max(1, Math.floor(filter.limit))}`;
			const rows = await driver.query(
				`SELECT ${COLUMNS} FROM connection_records WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC${limit}`,
				params,
			);
			return rows.map((row) => recordFrom(row));
		},
		async insert(kind, record) {
			const sql =
				"INSERT INTO connection_records (kind, id, organisation_id, record_key, record_ref, data, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (kind, id) DO NOTHING";
			return changed(sql, [
				kind,
				record.id,
				record.organisationId,
				record.key ?? null,
				record.ref ?? null,
				JSON.stringify(record.value),
				record.createdAt,
			]);
		},
		async update(kind, id, revision, value, key) {
			const keySql = key === undefined ? "" : ", record_key = ?";
			const params: (string | number | null)[] = [JSON.stringify(value), revision + 1];
			if (key !== undefined) params.push(key);
			params.push(kind, id, revision);
			return changed(
				`UPDATE connection_records SET data = ?, revision = ?${keySql} WHERE kind = ? AND id = ? AND revision = ?`,
				params,
			);
		},
		async remove(kind, id) {
			await driver.query("DELETE FROM connection_records WHERE kind = ? AND id = ?", [kind, id]);
		},
	};
}
