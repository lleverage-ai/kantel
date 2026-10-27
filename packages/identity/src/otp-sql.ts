/**
 * Durable one-time PIN codes and Harbour sessions on any `SqlDriver` (Postgres self-hosted; SQLite and D1 for tests).
 * `migrateIdentity` creates the tables with the rest of identity.
 *
 * - Every step that must be atomic is one statement or one `batch`: issuing checks the rate limit and inserts in one
 *   batch (on Postgres behind a per-email advisory lock, so two concurrent starts cannot both take the last slot);
 *   an attempt is claimed with one `UPDATE … RETURNING` guarded by `attempts < max`, and a code is consumed with one
 *   guarded by `consumed_at IS NULL`, so concurrent verifies never exceed the limit or use a code twice.
 * - Codes and session tokens are stored only as hashes.
 */
import type { SqlDialect, SqlDriver, SqlStatement } from "@harbour/sql";
import { sql, sqlNumber, sqlOptionalString } from "@harbour/sql";
import type { OtpCodeStore, SessionRecord, SessionStore } from "./otp.ts";

/** The one-time PIN and session tables; `identitySchema` includes them. Every statement is idempotent. */
export function otpSchema(dialect: SqlDialect): readonly string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		// `burned` is 1 once a newer code replaced it. Rows older than the rate window are deleted as codes are issued.
		`CREATE TABLE IF NOT EXISTS identity_otp_codes (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			code_hash TEXT NOT NULL,
			created_at ${time} NOT NULL,
			expires_at ${time} NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			consumed_at ${time},
			burned INTEGER NOT NULL DEFAULT 0
		)`,
		"CREATE INDEX IF NOT EXISTS identity_otp_codes_by_email ON identity_otp_codes (email, created_at)",
		"CREATE INDEX IF NOT EXISTS identity_otp_codes_by_created ON identity_otp_codes (created_at)",
		`CREATE TABLE IF NOT EXISTS identity_sessions (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			user_id TEXT NOT NULL,
			issuer TEXT NOT NULL,
			subject TEXT NOT NULL,
			email TEXT,
			created_at ${time} NOT NULL,
			expires_at ${time} NOT NULL,
			ended_at ${time}
		)`,
		"CREATE INDEX IF NOT EXISTS identity_sessions_by_user ON identity_sessions (user_id)",
	];
}

type SessionRow = {
	id: unknown;
	token_hash: unknown;
	user_id: unknown;
	issuer: unknown;
	subject: unknown;
	email: unknown;
	created_at: unknown;
	expires_at: unknown;
};

const SESSION_COLUMNS = "id, token_hash, user_id, issuer, subject, email, created_at, expires_at";

function sessionOf(row: SessionRow): SessionRecord {
	const email = sqlOptionalString(row.email);
	return {
		id: String(row.id),
		tokenHash: String(row.token_hash),
		userId: String(row.user_id),
		issuer: String(row.issuer),
		subject: String(row.subject),
		...(email === undefined ? {} : { email }),
		createdAt: sqlNumber(row.created_at),
		expiresAt: sqlNumber(row.expires_at),
	};
}

/** Code and session stores on `driver`. They hold no state of their own, so any number of processes may share them. */
export function createSqlOtpStores(driver: SqlDriver): {
	readonly codes: OtpCodeStore;
	readonly sessions: SessionStore;
} {
	return {
		codes: {
			async issue(code, limit) {
				const statements: SqlStatement[] = [];
				if (driver.dialect === "postgres") {
					statements.push(sql("SELECT pg_advisory_xact_lock(73161, hashtext(?))", code.email));
				}
				statements.push(
					sql("DELETE FROM identity_otp_codes WHERE created_at <= ?", limit.since),
					sql(
						`INSERT INTO identity_otp_codes (id, email, code_hash, created_at, expires_at)
						SELECT ?, ?, ?, ?, ?
						WHERE (SELECT COUNT(*) FROM identity_otp_codes WHERE email = ? AND created_at > ?) < ?`,
						code.id,
						code.email,
						code.codeHash,
						code.createdAt,
						code.expiresAt,
						code.email,
						limit.since,
						limit.max,
					),
					// Only once the new code went in does it replace the others.
					sql(
						`UPDATE identity_otp_codes SET burned = 1
						WHERE email = ? AND id <> ? AND burned = 0
						AND EXISTS (SELECT 1 FROM identity_otp_codes WHERE id = ?)`,
						code.email,
						code.id,
						code.id,
					),
				);
				await driver.batch(statements);
				const rows = await driver.query("SELECT 1 AS found FROM identity_otp_codes WHERE id = ?", [code.id]);
				return rows.length > 0;
			},

			async claimAttempt(email, now, maxAttempts) {
				const rows = await driver.query<{ id: unknown; code_hash: unknown }>(
					`UPDATE identity_otp_codes SET attempts = attempts + 1
					WHERE id = (
						SELECT id FROM identity_otp_codes
						WHERE email = ? AND consumed_at IS NULL AND burned = 0 AND expires_at > ?
						ORDER BY created_at DESC, id DESC
						LIMIT 1
					)
					AND attempts < ? AND consumed_at IS NULL AND burned = 0 AND expires_at > ?
					RETURNING id, code_hash`,
					[email, now, maxAttempts, now],
				);
				const [row] = rows;
				return row === undefined ? undefined : { id: String(row.id), codeHash: String(row.code_hash) };
			},

			async consume(id, now) {
				const rows = await driver.query(
					`UPDATE identity_otp_codes SET consumed_at = ?
					WHERE id = ? AND consumed_at IS NULL AND burned = 0 AND expires_at > ?
					RETURNING id`,
					[now, id, now],
				);
				return rows.length > 0;
			},
		},

		sessions: {
			async create(session) {
				await driver.query(
					`INSERT INTO identity_sessions (id, token_hash, user_id, issuer, subject, email, created_at, expires_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						session.id,
						session.tokenHash,
						session.userId,
						session.issuer,
						session.subject,
						session.email ?? null,
						session.createdAt,
						session.expiresAt,
					],
				);
			},

			async find(tokenHash, now) {
				const [row] = await driver.query<SessionRow>(
					`SELECT ${SESSION_COLUMNS} FROM identity_sessions WHERE token_hash = ? AND ended_at IS NULL AND expires_at > ?`,
					[tokenHash, now],
				);
				return row === undefined ? undefined : sessionOf(row);
			},

			async end(tokenHash, now) {
				const [row] = await driver.query<SessionRow>(
					`UPDATE identity_sessions SET ended_at = ?
					WHERE token_hash = ? AND ended_at IS NULL AND expires_at > ?
					RETURNING ${SESSION_COLUMNS}`,
					[now, tokenHash, now],
				);
				return row === undefined ? undefined : sessionOf(row);
			},
		},
	};
}
