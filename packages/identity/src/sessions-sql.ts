/**
 * Kantel sessions and one-time sign-in links on any `SqlDriver` (Postgres self-hosted; D1 on Cloudflare; SQLite for
 * tests). `migrateIdentity` creates the tables with the rest of identity.
 *
 * - Tokens are stored only as hashes.
 * - Ending a session and redeeming a link are each one guarded `UPDATE … RETURNING`, so two racing calls never both
 *   succeed.
 * - A database email one-time PIN sign-in used still has its `identity_otp_codes` table: nothing reads or writes it
 *   now, and it is left as it is.
 */
import type { SqlDialect, SqlDriver } from "@kantel/sql";
import { sqlNumber, sqlOptionalString } from "@kantel/sql";
import type { SessionRecord, SessionStore } from "./sessions.ts";
import type { SignInLinkRecord, SignInLinkStore } from "./sign-in-links.ts";

/** The session and sign-in link tables; `identitySchema` includes them. Every statement is idempotent. */
export function sessionsSchema(dialect: SqlDialect): readonly string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
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
		`CREATE TABLE IF NOT EXISTS identity_sign_in_links (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			user_id TEXT NOT NULL,
			created_at ${time} NOT NULL,
			expires_at ${time} NOT NULL,
			used_at ${time}
		)`,
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

type LinkRow = { id: unknown; token_hash: unknown; user_id: unknown; created_at: unknown; expires_at: unknown };

const LINK_COLUMNS = "id, token_hash, user_id, created_at, expires_at";

function linkOf(row: LinkRow): SignInLinkRecord {
	return {
		id: String(row.id),
		tokenHash: String(row.token_hash),
		userId: String(row.user_id),
		createdAt: sqlNumber(row.created_at),
		expiresAt: sqlNumber(row.expires_at),
	};
}

/** Session and sign-in link stores on `driver`. They hold no state of their own, so any number of processes share them. */
export function createSqlSessionStores(driver: SqlDriver): {
	readonly sessions: SessionStore;
	readonly links: SignInLinkStore;
} {
	return {
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

		links: {
			async create(link) {
				await driver.query(`INSERT INTO identity_sign_in_links (${LINK_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [
					link.id,
					link.tokenHash,
					link.userId,
					link.createdAt,
					link.expiresAt,
				]);
			},

			async redeem(tokenHash, now) {
				const [row] = await driver.query<LinkRow>(
					`UPDATE identity_sign_in_links SET used_at = ?
					WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
					RETURNING ${LINK_COLUMNS}`,
					[now, tokenHash, now],
				);
				return row === undefined ? undefined : linkOf(row);
			},
		},
	};
}
