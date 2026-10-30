/**
 * The session store and Pi storage on SQL, through chord's portable `SqliteDatabase` facade: Node's SQLite
 * (`openNodeSqliteDatabase`), a Durable Object's SQLite (`DurableObjectSqliteDatabase`), or Postgres through the
 * self-hosted target's translation. The SQL is the SQLite dialect that translation accepts: no `STRICT` beyond what it
 * strips, `INSERT OR IGNORE`, positional `?`, and upserts in the form both databases share.
 *
 * Records are stored as JSON beside the columns the store filters and orders on.
 */
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";
import { applySqliteMigrations, validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { AgentProfile, SessionRecord, Submission } from "@harbour/contracts";
import type { SessionStore, StoredHost, StoredSession, StoredSessionFilter, StoredSubmission } from "./store.ts";

export interface SqlSessionStoreOptions {
	/** Prefix of every table, such as `harbour_`. Default `harbour_`. */
	readonly prefix?: string;
}

interface SessionRow {
	readonly seq: number;
	readonly closed: number;
	readonly wake_at: number | null;
	readonly aborts: number;
	readonly record: string;
	readonly profile: string;
}

/** The store's migrations for table prefix `p`, in order; `createSqlSessionStore` applies them. Exported for tests. */
export const sqlSessionStoreMigrations = (p: string) => [
	{
		version: 1,
		statements: [
			`CREATE TABLE IF NOT EXISTS ${p}profiles (
				organisation_id TEXT NOT NULL,
				id TEXT NOT NULL,
				body TEXT NOT NULL,
				PRIMARY KEY (organisation_id, id)
			)`,
			`CREATE TABLE IF NOT EXISTS ${p}sessions (
				id TEXT PRIMARY KEY,
				seq INTEGER NOT NULL UNIQUE,
				organisation_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				parent_session_id TEXT,
				created_at INTEGER NOT NULL,
				closed INTEGER NOT NULL,
				aborts INTEGER NOT NULL,
				record TEXT NOT NULL,
				profile TEXT NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS ${p}sessions_by_organisation ON ${p}sessions (organisation_id, created_at, seq)`,
			`CREATE INDEX IF NOT EXISTS ${p}sessions_by_parent ON ${p}sessions (parent_session_id, seq)`,
			`CREATE INDEX IF NOT EXISTS ${p}sessions_open ON ${p}sessions (closed, seq)`,
			`CREATE TABLE IF NOT EXISTS ${p}submissions (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				pi_id INTEGER NOT NULL,
				body TEXT NOT NULL
			)`,
			// One row per counter. Taking the next value is an UPDATE, which holds the row until commit, so two connections
			// (as on Postgres) never take the same one.
			`CREATE TABLE IF NOT EXISTS ${p}counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
			`INSERT OR IGNORE INTO ${p}counters (name, value) VALUES ('session_seq', 0)`,
			`CREATE TABLE IF NOT EXISTS ${p}hosts (
				organisation_id TEXT NOT NULL,
				host_id TEXT NOT NULL,
				registration TEXT NOT NULL,
				durable INTEGER NOT NULL,
				body TEXT NOT NULL,
				PRIMARY KEY (organisation_id, host_id)
			)`,
		],
	},
	{
		version: 2,
		statements: [
			// When the session next needs a process (`SessionStore.setWake`); null when it needs none.
			`ALTER TABLE ${p}sessions ADD COLUMN wake_at INTEGER`,
			`CREATE INDEX IF NOT EXISTS ${p}sessions_by_wake ON ${p}sessions (wake_at)`,
			// Sessions from before wakes may have work cut off: each is due once, and opening it sets its real wake.
			`UPDATE ${p}sessions SET wake_at = 0 WHERE closed = 0`,
		],
	},
];

const SESSION_COLUMNS = "seq, closed, aborts, record, profile, wake_at";

function sessionOf(row: SessionRow): StoredSession {
	return {
		record: JSON.parse(row.record) as SessionRecord,
		profile: JSON.parse(row.profile) as AgentProfile,
		sequence: Number(row.seq),
		aborts: Number(row.aborts),
		closed: Number(row.closed) === 1,
		...(row.wake_at === null || row.wake_at === undefined ? {} : { wakeAt: Number(row.wake_at) }),
	};
}

/**
 * The session store on SQL. Opening it applies its migrations; it does not own the database, so closing the database
 * is the caller's.
 */
export async function createSqlSessionStore(
	db: SqliteDatabase,
	options: SqlSessionStoreOptions = {},
): Promise<SessionStore> {
	const p = options.prefix ?? "harbour_";
	validateSqliteSchemaPrefix(p);
	await applySqliteMigrations(db, sqlSessionStoreMigrations(p), { table: `${p}schema` });

	const readSession = async (tx: SqliteExecutor, sessionId: string) => {
		const row = await tx.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM ${p}sessions WHERE id = ?`, sessionId);
		return row === undefined ? undefined : sessionOf(row);
	};

	return {
		async profile(organisationId, agentId) {
			const row = await db.get<{ body: string }>(
				`SELECT body FROM ${p}profiles WHERE organisation_id = ? AND id = ?`,
				organisationId,
				agentId,
			);
			return row === undefined ? undefined : (JSON.parse(row.body) as AgentProfile);
		},
		async profiles(organisationId) {
			const rows = await db.all<{ body: string }>(
				`SELECT body FROM ${p}profiles WHERE organisation_id = ? ORDER BY id`,
				organisationId,
			);
			return rows.map((row) => JSON.parse(row.body) as AgentProfile);
		},
		async putProfile(profile) {
			await db.run(
				`INSERT INTO ${p}profiles (organisation_id, id, body) VALUES (?, ?, ?)
				 ON CONFLICT (organisation_id, id) DO UPDATE SET body = excluded.body`,
				profile.organisationId,
				profile.id,
				JSON.stringify(profile),
			);
		},
		session: (sessionId) => readSession(db, sessionId),
		async sessions(organisationId, filter?: StoredSessionFilter) {
			const where = ["organisation_id = ?"];
			const params: string[] = [organisationId];
			if (filter?.projectId !== undefined) {
				where.push("project_id = ?");
				params.push(filter.projectId);
			}
			if (filter?.agentId !== undefined) {
				where.push("agent_id = ?");
				params.push(filter.agentId);
			}
			if (filter?.parentSessionId !== undefined) {
				where.push("parent_session_id = ?");
				params.push(filter.parentSessionId);
			}
			const rows = await db.all<SessionRow>(
				`SELECT ${SESSION_COLUMNS} FROM ${p}sessions WHERE ${where.join(" AND ")} ORDER BY created_at DESC, seq DESC`,
				...params,
			);
			return rows.map(sessionOf);
		},
		async createSession(session) {
			const { record } = session;
			return db.transaction(async (tx) => {
				await tx.run(`UPDATE ${p}counters SET value = value + 1 WHERE name = 'session_seq'`);
				const counter = await tx.get<{ value: number }>(`SELECT value FROM ${p}counters WHERE name = 'session_seq'`);
				if (counter === undefined) throw new Error("The session sequence counter is missing");
				const sequence = Number(counter.value);
				await tx.run(
					`INSERT INTO ${p}sessions
					   (id, seq, organisation_id, project_id, agent_id, parent_session_id, created_at, closed, aborts, record, profile)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					record.id,
					sequence,
					record.organisationId,
					// `project_id` is NOT NULL, and SQLite can't relax that without rebuilding the table: an organisation session
					// stores '', which no project ID is (docs/design/org-scope.md). The record, without `projectId`, is the truth.
					record.projectId ?? "",
					record.agentId,
					record.parentSessionId ?? null,
					record.createdAt,
					session.closed ? 1 : 0,
					session.aborts,
					JSON.stringify(record),
					JSON.stringify(session.profile),
				);
				return { ...session, sequence };
			});
		},
		async updateSession(sessionId, change) {
			await db.transaction(async (tx) => {
				const current = await readSession(tx, sessionId);
				if (current === undefined) throw new Error(`Session ${sessionId} is not stored`);
				const next = { ...current, ...change };
				await tx.run(
					`UPDATE ${p}sessions SET closed = ?, aborts = ?, record = ? WHERE id = ?`,
					next.closed ? 1 : 0,
					next.aborts,
					JSON.stringify(next.record),
					sessionId,
				);
			});
		},
		async openSessions() {
			const rows = await db.all<SessionRow>(
				`SELECT ${SESSION_COLUMNS} FROM ${p}sessions WHERE closed = 0 ORDER BY seq`,
			);
			return rows.map(sessionOf);
		},
		async setWake(sessionId, at) {
			await db.run(`UPDATE ${p}sessions SET wake_at = ? WHERE id = ?`, at ?? null, sessionId);
		},
		async wakeable(before) {
			const rows = await db.all<SessionRow>(
				`SELECT ${SESSION_COLUMNS} FROM ${p}sessions
				 WHERE closed = 0 AND wake_at IS NOT NULL AND wake_at <= ? ORDER BY wake_at, seq`,
				before,
			);
			return rows.map(sessionOf);
		},
		async nextWake(after) {
			const row = await db.get<{ at: number | null }>(
				`SELECT MIN(wake_at) AS at FROM ${p}sessions WHERE closed = 0 AND wake_at > ?`,
				after,
			);
			return row?.at === null || row?.at === undefined ? undefined : Number(row.at);
		},
		async submission(sessionId, submissionId) {
			const row = await db.get<{ body: string; pi_id: number }>(
				`SELECT body, pi_id FROM ${p}submissions WHERE id = ? AND session_id = ?`,
				submissionId,
				sessionId,
			);
			if (row === undefined) return undefined;
			return { submission: JSON.parse(row.body) as Submission, piSubmissionId: Number(row.pi_id) };
		},
		async putSubmission(stored: StoredSubmission) {
			await db.run(
				`INSERT OR IGNORE INTO ${p}submissions (id, session_id, pi_id, body) VALUES (?, ?, ?, ?)`,
				stored.submission.id,
				stored.submission.sessionId,
				stored.piSubmissionId,
				JSON.stringify(stored.submission),
			);
		},
		async host(organisationId, hostId) {
			const row = await db.get<{ body: string }>(
				`SELECT body FROM ${p}hosts WHERE organisation_id = ? AND host_id = ?`,
				organisationId,
				hostId,
			);
			return row === undefined ? undefined : (JSON.parse(row.body) as StoredHost);
		},
		async putHost(host) {
			await db.run(
				`INSERT INTO ${p}hosts (organisation_id, host_id, registration, durable, body) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT (organisation_id, host_id) DO UPDATE
				   SET registration = excluded.registration, durable = excluded.durable, body = excluded.body`,
				host.organisationId,
				host.hostId,
				host.registration,
				host.callback === undefined ? 0 : 1,
				JSON.stringify(host),
			);
		},
		async deleteHost(organisationId, hostId, registration) {
			// One statement: a replacement that lands first leaves nothing for a stale registration to remove.
			// In a transaction, where a fenced database (self-hosted Postgres) checks its fence before the write.
			return db.transaction(async (tx) => {
				const removed = await tx.all<{ host_id: string }>(
					`DELETE FROM ${p}hosts WHERE organisation_id = ? AND host_id = ? AND registration = ? RETURNING host_id`,
					organisationId,
					hostId,
					registration,
				);
				return removed.length > 0;
			});
		},
		async hosts() {
			const rows = await db.all<{ body: string }>(
				`SELECT body FROM ${p}hosts WHERE durable = 1 ORDER BY organisation_id, host_id`,
			);
			return rows.map((row) => JSON.parse(row.body) as StoredHost);
		},
	};
}

/** The table prefix of one session's Pi tables: `pi_` and the session's UUID without its dashes. */
export function piPrefixFor(sessionId: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
		throw new Error(`Session ID ${sessionId} is not a UUID`);
	}
	return `pi_${sessionId.replaceAll("-", "").toLowerCase()}_`;
}

/**
 * A view of a database that another owner closes: every call goes to `db`, so it shares `db`'s queue, and closing the
 * view closes nothing. Pi's storage closes the database it is given when its session closes.
 */
export function borrowDatabase(db: SqliteDatabase): SqliteDatabase {
	return {
		exec: (sql) => db.exec(sql),
		run: (sql, ...params) => db.run(sql, ...params),
		get: (sql, ...params) => db.get(sql, ...params),
		all: (sql, ...params) => db.all(sql, ...params),
		transaction: (callback) => db.transaction(callback),
		close: async () => {},
	};
}

/** The Pi Durable schema version `piSchemaStatements` creates: Pi Durable 1.4.0's latest. */
export const PI_SCHEMA_VERSION = 2;

/**
 * Pi Durable's SQLite schema at `PI_SCHEMA_VERSION`, for table prefix `p`, as its migrations leave it: version 1's
 * tables, with version 2's `tasks` (which adds the `sleeping` status) in place of version 1's. The statements and
 * their order are Pi Durable's own (`createSqliteMigrations` in `@earendil-works/pi-durable/storage/sqlite`), so the
 * tables, columns, constraints and indexes are the same; `sql.conformance.test.ts` compares the two schemas.
 *
 * Replaying the migrations instead rebuilds `tasks` and renames it into place, and SQLite rewrites the whole
 * database's schema for a rename. With every session's tables in one database, that made each new session's create
 * slower than the last (#216).
 */
export function piSchemaStatements(p: string): string[] {
	validateSqliteSchemaPrefix(p);
	return [
		`CREATE TABLE ${p}durable_metadata (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			next_id TEXT NOT NULL,
			next_seq INTEGER NOT NULL
		) STRICT`,
		`INSERT INTO ${p}durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1)`,
		`CREATE TABLE ${p}record_ids (
			id INTEGER PRIMARY KEY,
			record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
		) STRICT`,
		`CREATE TABLE ${p}conversations (
			id INTEGER PRIMARY KEY,
			owner_conversation_id INTEGER,
			owner_task_id INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${p}conversations_by_owner_conversation ON ${p}conversations (owner_conversation_id, id)`,
		`CREATE INDEX ${p}conversations_by_owner_task ON ${p}conversations (owner_task_id, id)`,
		`CREATE TABLE ${p}entries (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			head INTEGER,
			commit_seq INTEGER NOT NULL,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${p}entries_by_conversation ON ${p}entries (conversation_id, id DESC)`,
		`CREATE INDEX ${p}entry_heads_by_conversation ON ${p}entries (conversation_id, id DESC) WHERE head IS NOT NULL`,
		`CREATE TABLE ${p}tasks (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
			abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
			background INTEGER NOT NULL CHECK (background IN (0, 1)),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${p}tasks_by_status ON ${p}tasks (status, id)`,
		`CREATE INDEX ${p}tasks_by_conversation ON ${p}tasks (conversation_id, id)`,
		`CREATE INDEX ${p}tasks_by_kind ON ${p}tasks (kind, id)`,
		`CREATE INDEX ${p}tasks_by_abort_requested ON ${p}tasks (abort_requested, id)`,
		`CREATE INDEX ${p}tasks_by_background ON ${p}tasks (background, id)`,
		`CREATE TABLE ${p}submissions (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			request_id TEXT,
			status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${p}submissions_by_request ON ${p}submissions (conversation_id, request_id)`,
		`CREATE INDEX ${p}submissions_by_conversation ON ${p}submissions (conversation_id, id)`,
		`CREATE INDEX ${p}submissions_by_status ON ${p}submissions (status, id)`,
		`CREATE TABLE ${p}documents (
			id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL,
			family INTEGER NOT NULL CHECK (family IN (0, 1)),
			key_value TEXT NOT NULL,
			scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
			owner_id INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			retired_at INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${p}documents_by_address
			ON ${p}documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
		`CREATE INDEX ${p}documents_by_scope ON ${p}documents (scope_kind, owner_id, id)`,
		`CREATE INDEX ${p}documents_by_scope_kind ON ${p}documents (scope_kind, owner_id, kind, id)`,
		`CREATE TABLE ${p}document_revisions (
			document_id INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
			version INTEGER NOT NULL,
			content TEXT NOT NULL CHECK (json_valid(content)),
			PRIMARY KEY (document_id, seq)
		) STRICT`,
		`CREATE INDEX ${p}document_revisions_by_kind ON ${p}document_revisions (document_id, kind, seq DESC)`,
	];
}

/**
 * Creates a new session's Pi tables at `PI_SCHEMA_VERSION` and records that version where Pi Durable's migrations look
 * for it (the `durable_schema` table chord's `applySqliteMigrations` keeps), so `SqliteStorage.open` finds nothing to
 * migrate. A session that already has its tables (version above 0) is left alone, as is every session while Pi
 * Durable's own schema version is another one: its migrations then run as before.
 */
export async function createPiSchema(db: SqliteDatabase, prefix: string): Promise<void> {
	if (CURRENT_SQLITE_SCHEMA_VERSION !== PI_SCHEMA_VERSION) return;
	await db.transaction(async (tx) => {
		if ((await schemaVersionRow(tx, prefix)) === 0) await createPiTables(tx, prefix);
	});
}

/** Makes the session's `durable_schema` table and first row, as chord's `applySqliteMigrations` does; its version. */
async function schemaVersionRow(tx: SqliteExecutor, prefix: string): Promise<number> {
	const table = `${prefix}durable_schema`;
	await tx.exec(`CREATE TABLE IF NOT EXISTS ${table} (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		version INTEGER NOT NULL CHECK (version >= 0)
	) STRICT`);
	await tx.run(`INSERT OR IGNORE INTO ${table} (singleton, version) VALUES (1, 0)`);
	const row = await tx.get<{ version: number }>(`SELECT version FROM ${table} WHERE singleton = 1`);
	return Number(row?.version ?? 0);
}

/** Creates the session's tables at `PI_SCHEMA_VERSION` and records the version, in the caller's transaction. */
async function createPiTables(tx: SqliteExecutor, prefix: string): Promise<void> {
	for (const statement of piSchemaStatements(prefix)) await tx.exec(statement);
	await tx.run(`UPDATE ${prefix}durable_schema SET version = ? WHERE singleton = 1`, PI_SCHEMA_VERSION);
}

/** A session's Pi tables, as `piSchemaStatements` creates them, without `durable_schema`. */
const PI_TABLES = [
	"durable_metadata",
	"record_ids",
	"conversations",
	"entries",
	"tasks",
	"submissions",
	"documents",
	"document_revisions",
] as const;

/**
 * Closed sessions' Pi records, once `archiveSqlPiStorage` has dropped their tables: one row per record, its columns as
 * a JSON object, under the session and the table it came from. One table for every session, so archiving adds rows,
 * not schema.
 */
export const PI_ARCHIVE_TABLE = "harbour_pi_archive";

const archiveTables = new WeakMap<SqliteDatabase, Promise<void>>();

/** Creates `PI_ARCHIVE_TABLE` once per database handle. */
function ensureArchiveTable(db: SqliteDatabase): Promise<void> {
	let made = archiveTables.get(db);
	if (made === undefined) {
		made = db.exec(`CREATE TABLE IF NOT EXISTS ${PI_ARCHIVE_TABLE} (
			session_id TEXT NOT NULL,
			table_name TEXT NOT NULL,
			row_number INTEGER NOT NULL,
			row TEXT NOT NULL,
			PRIMARY KEY (session_id, table_name, row_number)
		) STRICT`);
		archiveTables.set(db, made);
		made.catch(() => archiveTables.delete(db));
	}
	return made;
}

/**
 * Archives a closed session's Pi storage and drops its tables (#216): every record of its `pi_<id>_` tables goes into
 * `PI_ARCHIVE_TABLE`, in one transaction with the drops, so the database's schema grows with the sessions open, not
 * with every session it has held. `sqlPiStorage` restores the tables when the session is opened again (to read its
 * transcript, say). Call it once the session's Harness has closed, as the runtime's `archive` option does.
 *
 * Says whether it archived anything: a session already archived, one with no tables, and one whose tables are at
 * another schema version than `PI_SCHEMA_VERSION` (which `sqlPiStorage` could not restore) are left as they are.
 */
export async function archiveSqlPiStorage(db: SqliteDatabase, sessionId: string): Promise<boolean> {
	const prefix = piPrefixFor(sessionId);
	if (CURRENT_SQLITE_SCHEMA_VERSION !== PI_SCHEMA_VERSION) return false;
	await ensureArchiveTable(db);
	let version: number | undefined;
	try {
		const row = await db.get<{ version: number }>(`SELECT version FROM ${prefix}durable_schema WHERE singleton = 1`);
		version = row === undefined ? undefined : Number(row.version);
	} catch {
		// No tables: never opened, or archived already.
		return false;
	}
	if (version !== PI_SCHEMA_VERSION) return false;
	return db.transaction(async (tx) => {
		for (const table of PI_TABLES) {
			const rows = await tx.all<Record<string, unknown>>(`SELECT * FROM ${prefix}${table}`);
			for (const [index, row] of rows.entries()) {
				await tx.run(
					`INSERT INTO ${PI_ARCHIVE_TABLE} (session_id, table_name, row_number, row) VALUES (?, ?, ?, ?)`,
					sessionId,
					table,
					index,
					JSON.stringify(row),
				);
			}
		}
		// Dropping a table drops its indexes with it.
		for (const table of [...PI_TABLES, "durable_schema"]) await tx.exec(`DROP TABLE ${prefix}${table}`);
		return true;
	});
}

/**
 * Puts an archived session's Pi tables back (`archiveSqlPiStorage`): the tables at `PI_SCHEMA_VERSION` with every
 * archived record, and the archive's rows removed, in one transaction. Says whether the session had an archive.
 */
export async function restoreSqlPiStorage(db: SqliteDatabase, sessionId: string): Promise<boolean> {
	const prefix = piPrefixFor(sessionId);
	await ensureArchiveTable(db);
	const archived = await db.get<{ found: number }>(
		`SELECT 1 AS found FROM ${PI_ARCHIVE_TABLE} WHERE session_id = ? LIMIT 1`,
		sessionId,
	);
	if (archived === undefined) return false;
	return db.transaction(async (tx) => {
		// Another opening restored it meanwhile.
		if ((await schemaVersionRow(tx, prefix)) !== 0) return false;
		await createPiTables(tx, prefix);
		// The archive holds the session's own metadata row in place of a new session's.
		await tx.run(`DELETE FROM ${prefix}durable_metadata`);
		const rows = await tx.all<{ table_name: string; row: string }>(
			`SELECT table_name, row FROM ${PI_ARCHIVE_TABLE} WHERE session_id = ? ORDER BY table_name, row_number`,
			sessionId,
		);
		for (const { table_name: table, row } of rows) {
			if (!(PI_TABLES as readonly string[]).includes(table)) {
				throw new Error(`Session ${sessionId}'s archive names an unknown table ${table}`);
			}
			const record = JSON.parse(row) as Record<string, unknown>;
			const columns = Object.keys(record);
			for (const column of columns) {
				if (!/^[a-z_]+$/.test(column)) throw new Error(`Session ${sessionId}'s archive names a bad column ${column}`);
			}
			await tx.run(
				`INSERT INTO ${prefix}${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
				...(columns.map((column) => record[column]) as (string | number | null)[]),
			);
		}
		await tx.run(`DELETE FROM ${PI_ARCHIVE_TABLE} WHERE session_id = ?`, sessionId);
		return true;
	});
}

/**
 * Pi Durable storage for one session in a shared database, under the session's own table prefix. A new session's
 * tables are created at the current schema version (`createPiSchema`), not by replaying Pi Durable's migrations; an
 * archived session's are restored from the archive (`restoreSqlPiStorage`).
 */
export async function sqlPiStorage(db: SqliteDatabase, sessionId: string): Promise<Storage> {
	const prefix = piPrefixFor(sessionId);
	if (!(await restoreSqlPiStorage(db, sessionId))) await createPiSchema(db, prefix);
	return SqliteStorage.open(borrowDatabase(db), { prefix });
}
