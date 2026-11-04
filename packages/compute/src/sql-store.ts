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
 * device sign-in's key secret until it is collected, and environments' protected values and secret files sealed with
 * the deployment's key. Nothing here logs a record. A new collection is a new kind in the same table, so it needs no
 * migration.
 *
 * It is `persistent`: the service seals nothing without the deployment's own secrets key.
 */
import { type SqlDriver, type SqlValue, sqlNumber } from "@kantel/sql";
import {
	type Collection,
	type ComputeStore,
	matches,
	type StoredTemplate,
	type StoredTemplateVersion,
	type TemplateWrites,
	UniqueViolation,
} from "./store.ts";

/** Whether `error` is a unique-constraint violation: Postgres's SQLSTATE 23505, or SQLite's (and D1's) message. */
function isUniqueViolation(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	return (
		code === "23505" ||
		(typeof message === "string" && /UNIQUE constraint failed|duplicate key value violates unique/i.test(message))
	);
}

/** Writes an `update` retries after losing to another writer, before it gives up. */
const UPDATE_ATTEMPTS = 50;
/** The advisory lock a Postgres migration takes, so two gateways starting at once don't race to create the table. */
const MIGRATE_LOCK = "SELECT pg_advisory_xact_lock(7316102020)";
/** A field `list` may filter on in SQL: it is written into the statement, so nothing but a plain name. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const SELECT_DATA = "SELECT data FROM compute_api_records WHERE kind = ? AND id = ?";
const SELECT_VERSIONED = "SELECT data, version FROM compute_api_records WHERE kind = ? AND id = ?";
/**
 * Writes only over the record as it was read, its version and its data both, and answers a row only when it did. The
 * version alone isn't enough: a record deleted and inserted again starts at version 1 again, so a write that read the
 * first could land on the second, computed from what the first held (a bundle's deleted generation, say). With its data
 * too, the record it lands on holds exactly what was read, so the write is the one it would have made reading that.
 */
const UPDATE_VERSIONED =
	"UPDATE compute_api_records SET data = ?, version = version + 1 WHERE kind = ? AND id = ? AND version = ? AND data = ? RETURNING id";
/** Writes only over the record exactly as the caller expected it, and answers a row only when it did. */
const UPDATE_IF_SAME =
	"UPDATE compute_api_records SET data = ?, version = version + 1 WHERE kind = ? AND id = ? AND data = ? RETURNING id";
const DELETE_ONE = "DELETE FROM compute_api_records WHERE kind = ? AND id = ? RETURNING id";
/** Deletes only the record as it was read, its version and its data both (`UPDATE_VERSIONED`), and answers a row only when it did. */
const DELETE_VERSIONED =
	"DELETE FROM compute_api_records WHERE kind = ? AND id = ? AND version = ? AND data = ? RETURNING id";

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
		// One sandbox's egress log, as `list({ sandboxId })` reads it (each batch a host reports trims it), without the
		// rest of the deployment's. On the expression `list` filters by; Postgres's only over egress rows, so no other
		// kind's JSON is cast to `jsonb` on its writes.
		dialect === "postgres"
			? "CREATE INDEX IF NOT EXISTS compute_api_records_egress ON compute_api_records (((data::jsonb ->> 'sandboxId')), seq) WHERE kind = 'egress'"
			: "CREATE INDEX IF NOT EXISTS compute_api_records_by_sandbox ON compute_api_records (kind, json_extract(data, '$.sandboxId'), seq)",
		// One space's E2E chain, as `list({ space })` reads it on every chain read and append, without other spaces'.
		dialect === "postgres"
			? "CREATE INDEX IF NOT EXISTS compute_api_records_e2e_chain ON compute_api_records (((data::jsonb ->> 'space')), seq) WHERE kind = 'e2eChain'"
			: "CREATE INDEX IF NOT EXISTS compute_api_records_by_space ON compute_api_records (kind, json_extract(data, '$.space'), seq)",
		// No two environments of an account share a name (`environmentNameKey`): the write that would make two fails, in
		// the database, whichever gateway makes it and however long after it read.
		dialect === "postgres"
			? "CREATE UNIQUE INDEX IF NOT EXISTS compute_api_records_environment_name ON compute_api_records (((data::jsonb ->> 'accountId')), ((data::jsonb ->> 'name'))) WHERE kind = 'environments'"
			: "CREATE UNIQUE INDEX IF NOT EXISTS compute_api_records_environment_name ON compute_api_records (json_extract(data, '$.accountId'), json_extract(data, '$.name')) WHERE kind = 'environments'",
		// No two templates of an account share a name (`templateNameKey`), in the database as environments' names.
		dialect === "postgres"
			? "CREATE UNIQUE INDEX IF NOT EXISTS compute_api_records_template_name ON compute_api_records (((data::jsonb ->> 'accountId')), ((data::jsonb ->> 'name'))) WHERE kind = 'templates'"
			: "CREATE UNIQUE INDEX IF NOT EXISTS compute_api_records_template_name ON compute_api_records (json_extract(data, '$.accountId'), json_extract(data, '$.name')) WHERE kind = 'templates'",
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

/** Whether `error` is a unique-constraint violation, answered as `UniqueViolation`; else it is thrown as it is. */
function uniqueOf(kind: string, error: unknown): never {
	if (isUniqueViolation(error)) throw new UniqueViolation(kind);
	throw error;
}

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
	/** A write, its refusal by a unique index (an environment's name) answered as `UniqueViolation`. */
	const write = async (sql: string, params: readonly SqlValue[]) => {
		try {
			return await driver.query(sql, params);
		} catch (error) {
			uniqueOf(kind, error);
		}
	};
	return {
		async get(id) {
			const [row] = await driver.query(SELECT_DATA, [kind, id]);
			return row === undefined ? undefined : parse<T>(row);
		},
		async put(record) {
			const data = JSON.stringify(record);
			await write(insert, postgres ? [kind, record.id, data] : [kind, record.id, kind, data]);
		},
		async insert(record) {
			const data = JSON.stringify(record);
			const rows = await write(insertNew, postgres ? [kind, record.id, data] : [kind, record.id, kind, data]);
			return rows.length > 0;
		},
		async update(id, change, expected) {
			// The caller's copy first: one statement, written only if the stored JSON is still exactly that copy's (every
			// write stores `JSON.stringify` of the record, so an unchanged record compares equal).
			if (expected !== undefined && expected.id === id) {
				const next = change(JSON.parse(JSON.stringify(expected)) as T);
				if (next !== undefined) {
					const data = JSON.stringify(next);
					const written = await write(UPDATE_IF_SAME, [data, kind, id, JSON.stringify(expected)]);
					if (written.length > 0) return JSON.parse(data) as T;
				}
			}
			for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
				const [row] = await driver.query(SELECT_VERSIONED, [kind, id]);
				if (row === undefined) return undefined;
				const next = change(parse<T>(row));
				if (next === undefined) return undefined;
				const data = JSON.stringify(next);
				const written = await write(UPDATE_VERSIONED, [data, kind, id, sqlNumber(row.version), String(row.data)]);
				// Answered as a later `get` would read it.
				if (written.length > 0) return JSON.parse(data) as T;
			}
			throw new Error(`The ${kind} record kept changing while it was updated; gave up after ${UPDATE_ATTEMPTS} tries`);
		},
		async delete(id) {
			const rows = await driver.query(DELETE_ONE, [kind, id]);
			return rows.length > 0;
		},
		async deleteIf(id, should) {
			for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
				const [row] = await driver.query(SELECT_VERSIONED, [kind, id]);
				if (row === undefined || !should(parse<T>(row))) return false;
				const deleted = await driver.query(DELETE_VERSIONED, [kind, id, sqlNumber(row.version), String(row.data)]);
				if (deleted.length > 0) return true;
			}
			throw new Error(`The ${kind} record kept changing while it was deleted; gave up after ${UPDATE_ATTEMPTS} tries`);
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

/** The kinds `sqlTemplateWrites` writes, as `createSqlComputeStore` names their collections. */
const TEMPLATES = "templates";
const TEMPLATE_VERSIONS = "templateVersions";

/**
 * `TemplateWrites` in SQL: each a batch (one transaction) of the template's write and its version's insert, which
 * inserts only when the template's row then holds exactly the template written, so a template write that didn't happen
 * (another writer's came first) records no version either. Whether the batch wrote is read back from the version, which
 * is never changed, rather than the template, which another writer may already have changed again: by the version's
 * `writeId`, each attempt's own, never by what the version says, which another writer's may say too (the same spec
 * with another name or description, say).
 */
function sqlTemplateWrites(driver: SqlDriver): TemplateWrites {
	const postgres = driver.dialect === "postgres";
	const seq = postgres
		? "nextval('compute_api_records_seq')"
		: "(SELECT COALESCE(MAX(seq), 0) + 1 FROM compute_api_records WHERE kind = ?)";
	const seqParams = (kind: string): SqlValue[] => (postgres ? [] : [kind]);
	const insertTemplate = `INSERT INTO compute_api_records (kind, id, seq, version, data)
		VALUES (?, ?, ${seq}, 1, ?) ON CONFLICT (kind, id) DO NOTHING`;
	const insertVersion = `INSERT INTO compute_api_records (kind, id, seq, version, data)
		SELECT ?, ?, ${seq}, 1, ?
		WHERE EXISTS (SELECT 1 FROM compute_api_records WHERE kind = ? AND id = ? AND data = ?)
		ON CONFLICT (kind, id) DO NOTHING`;
	const versionStatement = (version: StoredTemplateVersion, templateData: string, writeId: string) => ({
		sql: insertVersion,
		params: [
			TEMPLATE_VERSIONS,
			version.id,
			...seqParams(TEMPLATE_VERSIONS),
			JSON.stringify({ ...version, writeId } satisfies StoredTemplateVersion),
			TEMPLATES,
			version.templateId,
			templateData,
		],
	});
	const batch = async (statements: Parameters<SqlDriver["batch"]>[0]) => {
		try {
			await driver.batch(statements);
		} catch (error) {
			uniqueOf(TEMPLATES, error);
		}
	};
	/** Whether the version `id` is recorded by the write `writeId`. */
	const recordedBy = async (id: string, writeId: string): Promise<boolean> => {
		const [row] = await driver.query(SELECT_DATA, [TEMPLATE_VERSIONS, id]);
		return row !== undefined && parse<StoredTemplateVersion>(row).writeId === writeId;
	};
	return {
		async insert(template, version) {
			const data = JSON.stringify(template);
			const writeId = crypto.randomUUID();
			await batch([
				{ sql: insertTemplate, params: [TEMPLATES, template.id, ...seqParams(TEMPLATES), data] },
				versionStatement(version, data, writeId),
			]);
			return recordedBy(version.id, writeId);
		},
		async update(id, change) {
			for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
				const [row] = await driver.query(SELECT_VERSIONED, [TEMPLATES, id]);
				if (row === undefined) return undefined;
				const next = change(parse<StoredTemplate>(row));
				if (next === undefined) return undefined;
				const data = JSON.stringify(next.template);
				const params = [data, TEMPLATES, id, sqlNumber(row.version), String(row.data)];
				if (next.version === undefined) {
					try {
						if ((await driver.query(UPDATE_VERSIONED, params)).length > 0) return JSON.parse(data) as StoredTemplate;
					} catch (error) {
						uniqueOf(TEMPLATES, error);
					}
					continue;
				}
				const writeId = crypto.randomUUID();
				await batch([{ sql: UPDATE_VERSIONED, params }, versionStatement(next.version, data, writeId)]);
				if (await recordedBy(next.version.id, writeId)) return JSON.parse(data) as StoredTemplate;
			}
			throw new Error(`The template ${id} kept changing while it was updated; gave up after ${UPDATE_ATTEMPTS} tries`);
		},
	};
}

/** A `ComputeStore` in SQL. Run `migrateComputeStore` first. */
export function createSqlComputeStore(driver: SqlDriver): ComputeStore {
	return {
		persistent: true,
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
		environments: sqlCollection(driver, "environments"),
		egress: sqlCollection(driver, "egress"),
		e2eChain: sqlCollection(driver, "e2eChain"),
		bundles: sqlCollection(driver, "bundles"),
		bucketSources: sqlCollection(driver, "bucketSources"),
		fileUrls: sqlCollection(driver, "fileUrls"),
		settings: sqlCollection(driver, "settings"),
		usageMarks: sqlCollection(driver, "usageMarks"),
		templates: sqlCollection(driver, TEMPLATES),
		templateVersions: sqlCollection(driver, TEMPLATE_VERSIONS),
		templateWrites: sqlTemplateWrites(driver),
		templateSnapshots: sqlCollection(driver, "templateSnapshots"),
		templateBases: sqlCollection(driver, "templateBases"),
	};
}
