/**
 * Durable passkeys and passkey challenges on any `SqlDriver`: Postgres self-hosted, D1 on Cloudflare (and SQLite in
 * tests). `migrateIdentity` creates the tables with the rest of identity.
 *
 * - A challenge is used up with one `DELETE … RETURNING`, so of two requests carrying the same assertion only one
 *   finds its challenge.
 * - A credential ID is `UNIQUE`, so one passkey is never registered twice, to the same person or to two.
 * - A use moves the counter with one `UPDATE` guarded by the counter it read, so two racing assertions can't both
 *   pass the counter check.
 * - Only public keys are stored.
 */
import type { SqlDialect, SqlDriver } from "@harbour/sql";
import { sqlNumber, sqlOptionalString } from "@harbour/sql";
import type {
	PasskeyChallengeRecord,
	PasskeyChallengeStore,
	PasskeyCredentialStore,
	StoredPasskey,
} from "./passkey.ts";

/** The passkey tables; `identitySchema` includes them. Every statement is idempotent. */
export function passkeySchema(dialect: SqlDialect): readonly string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		// `public_key` is `{ algorithm, jwk }` as JSON; `transports` a JSON list or NULL.
		`CREATE TABLE IF NOT EXISTS identity_passkeys (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			credential_id TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			rp_id TEXT NOT NULL,
			transports TEXT,
			backed_up INTEGER NOT NULL DEFAULT 0,
			public_key TEXT NOT NULL,
			sign_count ${time} NOT NULL DEFAULT 0,
			created_at ${time} NOT NULL,
			last_used_at ${time}
		)`,
		"CREATE INDEX IF NOT EXISTS identity_passkeys_by_user ON identity_passkeys (user_id, created_at)",
		// `binding` is the approval's `PasskeyBinding` as JSON, NULL for a registration. Expired rows are deleted as new
		// challenges are issued.
		`CREATE TABLE IF NOT EXISTS identity_passkey_challenges (
			challenge TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			purpose TEXT NOT NULL,
			rp_id TEXT NOT NULL,
			origin TEXT NOT NULL,
			binding TEXT,
			created_at ${time} NOT NULL,
			expires_at ${time} NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS identity_passkey_challenges_by_expiry ON identity_passkey_challenges (expires_at)",
	];
}

type PasskeyRow = {
	id: unknown;
	user_id: unknown;
	credential_id: unknown;
	name: unknown;
	rp_id: unknown;
	transports: unknown;
	backed_up: unknown;
	public_key: unknown;
	sign_count: unknown;
	created_at: unknown;
	last_used_at: unknown;
};

const PASSKEY_COLUMNS =
	"id, user_id, credential_id, name, rp_id, transports, backed_up, public_key, sign_count, created_at, last_used_at";

function passkeyOf(row: PasskeyRow): StoredPasskey {
	const transports = sqlOptionalString(row.transports);
	const lastUsedAt = row.last_used_at === null || row.last_used_at === undefined ? undefined : row.last_used_at;
	return {
		id: String(row.id),
		userId: String(row.user_id),
		credentialId: String(row.credential_id),
		name: String(row.name),
		rpId: String(row.rp_id),
		...(transports === undefined ? {} : { transports: JSON.parse(transports) as string[] }),
		backedUp: sqlNumber(row.backed_up) === 1,
		publicKey: JSON.parse(String(row.public_key)) as StoredPasskey["publicKey"],
		signCount: sqlNumber(row.sign_count),
		createdAt: sqlNumber(row.created_at),
		...(lastUsedAt === undefined ? {} : { lastUsedAt: sqlNumber(lastUsedAt) }),
	};
}

type ChallengeRow = {
	challenge: unknown;
	user_id: unknown;
	purpose: unknown;
	rp_id: unknown;
	origin: unknown;
	binding: unknown;
	created_at: unknown;
	expires_at: unknown;
};

function challengeOf(row: ChallengeRow): PasskeyChallengeRecord {
	const binding = sqlOptionalString(row.binding);
	const purpose = String(row.purpose);
	if (purpose !== "registration" && purpose !== "approval") throw new Error(`Unknown challenge purpose ${purpose}`);
	return {
		challenge: String(row.challenge),
		userId: String(row.user_id),
		purpose,
		rpId: String(row.rp_id),
		origin: String(row.origin),
		...(binding === undefined ? {} : { binding: JSON.parse(binding) as PasskeyChallengeRecord["binding"] }),
		createdAt: sqlNumber(row.created_at),
		expiresAt: sqlNumber(row.expires_at),
	};
}

/** Whether `error` is a unique constraint failing, on Postgres or SQLite. */
function isUniqueViolation(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	return code === "23505" || /UNIQUE constraint failed|duplicate key value/i.test(message);
}

/** Passkey and challenge stores on `driver`. They hold no state of their own, so any number of processes may share them. */
export function createSqlPasskeyStores(driver: SqlDriver): {
	readonly credentials: PasskeyCredentialStore;
	readonly challenges: PasskeyChallengeStore;
} {
	return {
		credentials: {
			async add(passkey) {
				try {
					const rows = await driver.query(
						`INSERT INTO identity_passkeys (${PASSKEY_COLUMNS})
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT (credential_id) DO NOTHING
						RETURNING id`,
						[
							passkey.id,
							passkey.userId,
							passkey.credentialId,
							passkey.name,
							passkey.rpId,
							passkey.transports === undefined ? null : JSON.stringify(passkey.transports),
							passkey.backedUp ? 1 : 0,
							JSON.stringify(passkey.publicKey),
							passkey.signCount,
							passkey.createdAt,
							passkey.lastUsedAt ?? null,
						],
					);
					return rows.length > 0;
				} catch (error) {
					if (isUniqueViolation(error)) return false;
					throw error;
				}
			},

			async listByUser(userId) {
				const rows = await driver.query<PasskeyRow>(
					`SELECT ${PASSKEY_COLUMNS} FROM identity_passkeys WHERE user_id = ? ORDER BY created_at, id`,
					[userId],
				);
				return rows.map(passkeyOf);
			},

			async findByCredentialId(credentialId) {
				const [row] = await driver.query<PasskeyRow>(
					`SELECT ${PASSKEY_COLUMNS} FROM identity_passkeys WHERE credential_id = ?`,
					[credentialId],
				);
				return row === undefined ? undefined : passkeyOf(row);
			},

			async recordUse(id, use) {
				const rows = await driver.query(
					"UPDATE identity_passkeys SET sign_count = ?, last_used_at = ? WHERE id = ? AND sign_count = ? RETURNING id",
					[use.to, use.at, id, use.from],
				);
				return rows.length > 0;
			},

			async remove(userId, id) {
				const [row] = await driver.query<PasskeyRow>(
					`DELETE FROM identity_passkeys WHERE id = ? AND user_id = ? RETURNING ${PASSKEY_COLUMNS}`,
					[id, userId],
				);
				return row === undefined ? undefined : passkeyOf(row);
			},
		},

		challenges: {
			async put(record, now) {
				await driver.batch([
					{ sql: "DELETE FROM identity_passkey_challenges WHERE expires_at <= ?", params: [now] },
					{
						sql: `INSERT INTO identity_passkey_challenges
							(challenge, user_id, purpose, rp_id, origin, binding, created_at, expires_at)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						params: [
							record.challenge,
							record.userId,
							record.purpose,
							record.rpId,
							record.origin,
							record.binding === undefined ? null : JSON.stringify(record.binding),
							record.createdAt,
							record.expiresAt,
						],
					},
				]);
			},

			async take(challenge) {
				const [row] = await driver.query<ChallengeRow>(
					`DELETE FROM identity_passkey_challenges WHERE challenge = ?
					RETURNING challenge, user_id, purpose, rp_id, origin, binding, created_at, expires_at`,
					[challenge],
				);
				return row === undefined ? undefined : challengeOf(row);
			},
		},
	};
}
