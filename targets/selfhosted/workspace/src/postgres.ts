/**
 * The self-hosted `WorkspaceStore`: Postgres keeps each workspace's head and version table, an S3-compatible bucket
 * (MinIO locally) keeps the immutable objects. Adapted from apps/selfhosted's PostgresWorkspaces, which stays in place
 * for the deployment lane; the tree, paging and access logic is `@harbour/workspace/stored`'s, shared with Cloudflare.
 *
 * The head row carries a `revision`, the compare-and-set token: a commit or remount updates the row only where the
 * revision is still the one it read, in one transaction with the new version's row.
 */
import { HarbourError, type WorkspaceRecord, type WorkspaceVersionInfo } from "@harbour/contracts";
import type { LoadedHead, StoredHead, StoredVersion, WorkspaceStore } from "@harbour/workspace/stored";

/** The part of a SQL client the store uses; `pgDatabase` adapts a `pg.Pool`. */
export interface SqlClient {
	query<R = Record<string, unknown>>(
		text: string,
		values?: readonly unknown[],
	): Promise<{ readonly rows: R[]; readonly rowCount: number }>;
}

export interface SqlDatabase extends SqlClient {
	/** Runs `work` in one transaction, committed when it resolves and rolled back when it throws. */
	transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}

/** The structural part of `pg.Pool` the adapter needs, so this module does not import `pg` itself. */
export interface PgPoolLike {
	query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
	connect(): Promise<{
		query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
		release(error?: Error | boolean): void;
	}>;
}

export function pgDatabase(pool: PgPoolLike): SqlDatabase {
	const wrap =
		(target: Pick<PgPoolLike, "query">): SqlClient["query"] =>
		async <R>(text: string, values: readonly unknown[] = []) => {
			const result = await target.query(text, [...values]);
			return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
		};
	return {
		query: wrap(pool),
		async transaction(work) {
			const client = await pool.connect();
			let failed = false;
			try {
				await client.query("BEGIN");
				const result = await work({ query: wrap(client) });
				await client.query("COMMIT");
				return result;
			} catch (error) {
				failed = true;
				await client.query("ROLLBACK").catch(() => {});
				throw error;
			} finally {
				client.release(failed);
			}
		},
	};
}

/** Immutable objects by key: blobs and trees. `createS3Objects` is the S3/MinIO one. */
export interface ObjectBucket {
	get(key: string): Promise<Uint8Array | undefined>;
	put(key: string, bytes: Uint8Array): Promise<void>;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function quoted(schema: string): string {
	if (!SCHEMA_NAME.test(schema)) throw new HarbourError("invalid", `bad schema name ${schema}`);
	return `"${schema}"`;
}

/** Creates the store's tables in `schema` if they are missing. Idempotent. */
export async function migrateWorkspaceStore(db: SqlClient, schema = "harbour"): Promise<void> {
	const s = quoted(schema);
	await db.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
	await db.query(`CREATE TABLE IF NOT EXISTS ${s}.workspace_heads (
		id               text PRIMARY KEY,
		organisation_id  text NOT NULL,
		record           jsonb NOT NULL,
		-- Object key of the head version's tree; NULL for the empty tree.
		tree_key         text,
		-- The compare-and-set token: every head change adds one.
		revision         bigint NOT NULL
	)`);
	await db.query(`CREATE TABLE IF NOT EXISTS ${s}.workspace_versions (
		workspace_id  text NOT NULL REFERENCES ${s}.workspace_heads (id) ON DELETE CASCADE,
		version       integer NOT NULL,
		info          jsonb NOT NULL,
		tree_key      text,
		PRIMARY KEY (workspace_id, version)
	)`);
	await db.query(
		`CREATE INDEX IF NOT EXISTS workspace_heads_by_organisation ON ${s}.workspace_heads (organisation_id, id)`,
	);
}

export interface PostgresWorkspaceStoreOptions {
	readonly db: SqlDatabase;
	readonly objects: ObjectBucket;
	/** The Postgres schema holding the tables; `harbour` when absent. Run `migrateWorkspaceStore` on it first. */
	readonly schema?: string;
}

type HeadRow = {
	id: string;
	organisation_id: string;
	record: WorkspaceRecord | string;
	tree_key: string | null;
	revision: string | number;
};

/** jsonb comes back parsed from `pg`; some drivers hand back text. */
function json<T>(value: T | string): T {
	return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

export function createPostgresWorkspaceStore(options: PostgresWorkspaceStoreOptions): WorkspaceStore {
	const { db, objects } = options;
	const s = quoted(options.schema ?? "harbour");

	async function insertVersions(client: SqlClient, id: string, versions: readonly StoredVersion[]): Promise<void> {
		for (const version of versions) {
			await client.query(
				`INSERT INTO ${s}.workspace_versions (workspace_id, version, info, tree_key) VALUES ($1, $2, $3::jsonb, $4)`,
				[id, version.info.version, JSON.stringify(version.info), version.tree],
			);
		}
	}

	async function swap(current: LoadedHead, next: StoredHead, version?: StoredVersion): Promise<boolean> {
		if (next.record.id !== current.record.id) throw new HarbourError("invalid", "a head cannot change its ID");
		return db.transaction(async (client) => {
			const updated = await client.query(
				`UPDATE ${s}.workspace_heads SET record = $3::jsonb, tree_key = $4, revision = revision + 1
				 WHERE id = $1 AND revision = $2`,
				[current.record.id, current.token, JSON.stringify(next.record), next.tree],
			);
			if (updated.rowCount !== 1) return false;
			if (version !== undefined) await insertVersions(client, current.record.id, [version]);
			return true;
		});
	}

	return {
		async load(id) {
			const { rows } = await db.query<HeadRow>(
				`SELECT id, organisation_id, record, tree_key, revision FROM ${s}.workspace_heads WHERE id = $1`,
				[id],
			);
			const row = rows[0];
			if (row === undefined) return undefined;
			return {
				organisationId: row.organisation_id,
				record: json(row.record),
				tree: row.tree_key,
				token: String(row.revision),
			};
		},

		async create(head, versions) {
			return db.transaction(async (client) => {
				const inserted = await client.query(
					`INSERT INTO ${s}.workspace_heads (id, organisation_id, record, tree_key, revision)
					 VALUES ($1, $2, $3::jsonb, $4, 1) ON CONFLICT (id) DO NOTHING`,
					[head.record.id, head.organisationId, JSON.stringify(head.record), head.tree],
				);
				if (inserted.rowCount !== 1) return false;
				await insertVersions(client, head.record.id, versions);
				return true;
			});
		},

		advance: (current, next, version) => swap(current, next, version),
		update: (current, next) => swap(current, next),

		async treeAt(current, version) {
			const { rows } = await db.query<{ tree_key: string | null }>(
				`SELECT tree_key FROM ${s}.workspace_versions WHERE workspace_id = $1 AND version = $2`,
				[current.record.id, version],
			);
			return rows[0] === undefined ? undefined : rows[0].tree_key;
		},

		async history(current, below, limit) {
			const { rows } = await db.query<{ info: WorkspaceVersionInfo | string }>(
				`SELECT info FROM ${s}.workspace_versions WHERE workspace_id = $1 AND version < $2
				 ORDER BY version DESC LIMIT $3`,
				[current.record.id, below, limit],
			);
			return rows.map((row) => json(row.info));
		},

		getObject: (key) => objects.get(key),
		putObject: (key, bytes) => objects.put(key, bytes),
	};
}
