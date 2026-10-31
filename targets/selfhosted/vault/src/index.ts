/**
 * The self-hosted vault's store: every vault record in Postgres, one table per record kind in one schema. Works over
 * a `pg.Pool` in production and PGlite in tests, through the minimal `PostgresVaultDb` both satisfy.
 *
 * Each table holds `id`, the owning `organisation_id` (null for platform items), a `revision` and the record as
 * `jsonb`, plus a `seq` for insertion order. Item values are in the record only as the cipher's sealed envelope.
 * `commit` applies its writes in one transaction, each insert `ON CONFLICT DO NOTHING` and each update conditional on
 * the revision read (`WHERE revision = $n`): under Postgres's row locks a concurrent update to the same row makes the
 * loser's condition fail, so two vault processes over one database settle every race once.
 */
import { KantelError, type OrganisationId } from "@kantel/contracts";
import { VAULT_TABLES, type VaultRow, type VaultStore, type VaultTable, type VaultWrite } from "@kantel/vault/store";

export const DEFAULT_VAULT_SCHEMA = "harbour_vault";

/** What the store runs SQL through: `pg.Pool`, `pg.PoolClient` and PGlite (and its transactions) all satisfy it. */
export interface PostgresQueryable {
	query(text: string, params?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

/**
 * The database. A commit of more than one write needs a transaction on one connection, from either `transaction`
 * (PGlite's) or `connect` (`pg.Pool`'s, which hands out a client to `BEGIN`, `COMMIT` and `release`).
 */
export interface PostgresVaultDb extends PostgresQueryable {
	transaction?<T>(work: (tx: PostgresQueryable) => Promise<T>): Promise<T>;
	connect?(): Promise<PostgresQueryable & { release(): void }>;
}

export interface PostgresVaultStoreOptions {
	readonly db: PostgresVaultDb;
	/** The schema the tables live in. Lower case letters, digits and `_`. Default `harbour_vault`. */
	readonly schema?: string;
}

export interface PostgresVaultStore extends VaultStore {
	/** Creates the schema and its tables if they are missing. Idempotent, and safe to run from several processes. */
	migrate(): Promise<void>;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Thrown inside a transaction to roll it back when a write's condition fails. */
class LostRace extends Error {}

interface RawRow {
	readonly id: string;
	readonly organisation_id: string | null;
	readonly revision: number;
	readonly data: string;
}

function toRow(raw: RawRow): VaultRow {
	return { id: raw.id, organisationId: raw.organisation_id, revision: Number(raw.revision), data: raw.data };
}

/** Runs `work` in one transaction on one connection, rolled back when it throws. */
async function inTransaction<T>(db: PostgresVaultDb, work: (tx: PostgresQueryable) => Promise<T>): Promise<T> {
	if (db.transaction !== undefined) return db.transaction(work);
	if (db.connect === undefined) {
		throw new KantelError("not_supported", "The vault's database needs transaction() or connect() for a transaction");
	}
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		const result = await work(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

export function createPostgresVaultStore(options: PostgresVaultStoreOptions): PostgresVaultStore {
	const { db } = options;
	const schema = options.schema ?? DEFAULT_VAULT_SCHEMA;
	if (!SCHEMA_NAME.test(schema)) throw new KantelError("invalid", `"${schema}" is not a valid schema name`);
	if (db.transaction === undefined && db.connect === undefined) {
		throw new KantelError("invalid", "The vault's database needs transaction() (PGlite) or connect() (pg.Pool)");
	}
	const table = (name: VaultTable) => `"${schema}"."${name}"`;

	async function apply(on: PostgresQueryable, write: VaultWrite): Promise<boolean> {
		const result =
			write.kind === "insert"
				? await on.query(
						`INSERT INTO ${table(write.table)} (id, organisation_id, revision, data) VALUES ($1, $2, 1, $3::jsonb)
						 ON CONFLICT (id) DO NOTHING RETURNING id`,
						[write.id, write.organisationId, write.data],
					)
				: await on.query(
						`UPDATE ${table(write.table)} SET revision = revision + 1, data = $3::jsonb
						 WHERE id = $1 AND revision = $2 RETURNING id`,
						[write.id, write.revision, write.data],
					);
		return result.rows.length === 1;
	}

	return {
		async migrate() {
			await inTransaction(db, async (tx) => {
				// Serialises concurrent migrations: CREATE ... IF NOT EXISTS alone can race on the catalogue.
				await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`harbour-vault-migrate:${schema}`]);
				await tx.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
				for (const name of VAULT_TABLES) {
					await tx.query(
						`CREATE TABLE IF NOT EXISTS ${table(name)} (
							seq bigint GENERATED ALWAYS AS IDENTITY,
							id text PRIMARY KEY,
							organisation_id text,
							revision integer NOT NULL,
							data jsonb NOT NULL
						)`,
					);
					await tx.query(
						`CREATE INDEX IF NOT EXISTS "${name}_by_organisation" ON ${table(name)} (organisation_id, seq)`,
					);
				}
			});
		},

		async get(name, id) {
			const { rows } = await db.query(
				`SELECT id, organisation_id, revision, data::text AS data FROM ${table(name)} WHERE id = $1`,
				[id],
			);
			const raw = rows[0] as RawRow | undefined;
			return raw === undefined ? undefined : toRow(raw);
		},

		async list(name, organisationId: OrganisationId | null) {
			const { rows } = await db.query(
				`SELECT id, organisation_id, revision, data::text AS data FROM ${table(name)}
				 WHERE ${organisationId === null ? "organisation_id IS NULL" : "organisation_id = $1"} ORDER BY seq`,
				organisationId === null ? [] : [organisationId],
			);
			return (rows as RawRow[]).map(toRow);
		},

		async commit(writes) {
			if (writes.length === 0) return true;
			// One statement is atomic on its own; more need a transaction, rolled back when any condition fails.
			if (writes.length === 1) return apply(db, writes[0]!);
			try {
				return await inTransaction(db, async (tx) => {
					for (const write of writes) if (!(await apply(tx, write))) throw new LostRace();
					return true;
				});
			} catch (error) {
				if (error instanceof LostRace) return false;
				throw error;
			}
		},
	};
}
