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
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
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

const migrations = (p: string) => [
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
	await applySqliteMigrations(db, migrations(p), { table: `${p}schema` });

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
					record.projectId,
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
		async nextWake() {
			const row = await db.get<{ at: number | null }>(
				`SELECT MIN(wake_at) AS at FROM ${p}sessions WHERE closed = 0 AND wake_at IS NOT NULL`,
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

/** Pi Durable storage for one session in a shared database, under the session's own table prefix. */
export function sqlPiStorage(db: SqliteDatabase, sessionId: string): Promise<Storage> {
	return SqliteStorage.open(borrowDatabase(db), { prefix: piPrefixFor(sessionId) });
}
