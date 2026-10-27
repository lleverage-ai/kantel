/**
 * The Cloudflare vault: every vault record in a Durable Object's SQLite (`ctx.storage.sql`), and the core a VaultDO
 * class wraps. Portable to Workers: no Node modules and no workers-types, only the minimal `SqlStorageLike` below.
 *
 * A Durable Object runs one request's code at a time, and runs it synchronously between awaits. Each `commit` here
 * checks every write's condition and applies the writes in one synchronous `transactionSync`, so nothing else in the
 * object can run between the check and the write, and a write that does not apply rolls back the ones before it. That, with the engine's conditional commits
 * on record revisions, keeps the race rules: requests that interleave at their awaits still settle a proposal once and
 * never spend a grant past `maxUses`.
 */
import type {
	ConnectorCredential,
	ConnectorCredentialRequest,
	EgressDecision,
	EgressRequest,
	OrganisationId,
	SystemContext,
} from "@harbour/contracts";
import { HarbourError } from "@harbour/contracts";
import { createAesGcmCipher } from "@harbour/vault/cipher";
import { createEgressDecisionApi } from "@harbour/vault/egress-api";
import { createVault, type HarbourVault, type VaultOptions } from "@harbour/vault/engine";
import { VAULT_TABLES, type VaultRow, type VaultStore, type VaultTable, type VaultWrite } from "@harbour/vault/store";

/** A value SQLite hands back or takes as a binding, as a Durable Object's SQL API types it. */
export type SqlValue = ArrayBuffer | string | number | null;

/** The cursor `exec` returns: the shape of a Durable Object's `SqlStorageCursor` that the store uses. */
export interface SqlCursorLike<T> {
	toArray(): T[];
	one(): T;
	readonly rowsWritten: number;
}

/** The shape of a Durable Object's `ctx.storage.sql` that the store uses: synchronous `exec` with `?` bindings. */
export interface SqlStorageLike {
	exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursorLike<T>;
}

export interface SqliteVaultStoreOptions {
	/**
	 * Runs `work` as one transaction, rolled back if it throws: a Durable Object's `ctx.storage.transactionSync`.
	 * Required, because a commit is every write or none: a write that fails part-way must undo the ones before it.
	 */
	readonly transactionSync: <T>(work: () => T) => T;
}

export interface SqliteVaultStore extends VaultStore {
	/** Creates the tables if they are missing. Synchronous and idempotent, so a Durable Object can call it at start. */
	migrate(): void;
}

/** Table names carry a prefix so the vault's tables cannot collide with anything else in the object's database. */
const tableName = (table: VaultTable) => `vault_${table}`;

interface RawRow extends Record<string, SqlValue> {
	id: string;
	organisation_id: string | null;
	revision: number;
	data: string;
}

function toRow(raw: RawRow): VaultRow {
	return { id: raw.id, organisationId: raw.organisation_id, revision: Number(raw.revision), data: raw.data };
}

/** Thrown inside a commit's transaction to roll it back when a write does not apply; the commit then answers `false`. */
class WriteDidNotApply extends Error {}

export function createSqliteVaultStore(sql: SqlStorageLike, options: SqliteVaultStoreOptions): SqliteVaultStore {
	const { transactionSync } = options;

	const holds = (write: VaultWrite): boolean => {
		const found = sql
			.exec<{ revision: number }>(`SELECT revision FROM ${tableName(write.table)} WHERE id = ?`, write.id)
			.toArray()[0];
		return write.kind === "insert"
			? found === undefined
			: found !== undefined && Number(found.revision) === write.revision;
	};

	return {
		migrate() {
			for (const table of VAULT_TABLES) {
				// The implicit rowid gives insertion order: rows are never deleted, so it only grows.
				sql.exec(
					`CREATE TABLE IF NOT EXISTS ${tableName(table)} (
						id TEXT PRIMARY KEY,
						organisation_id TEXT,
						revision INTEGER NOT NULL,
						data TEXT NOT NULL
					)`,
				);
				sql.exec(
					`CREATE INDEX IF NOT EXISTS ${tableName(table)}_by_organisation ON ${tableName(table)} (organisation_id)`,
				);
			}
		},

		async get(table, id) {
			const raw = sql
				.exec<RawRow>(`SELECT id, organisation_id, revision, data FROM ${tableName(table)} WHERE id = ?`, id)
				.toArray()[0];
			return raw === undefined ? undefined : toRow(raw);
		},

		async list(table, organisationId: OrganisationId | null) {
			return sql
				.exec<RawRow>(
					`SELECT id, organisation_id, revision, data FROM ${tableName(table)} WHERE organisation_id IS ? ORDER BY rowid`,
					organisationId,
				)
				.toArray()
				.map(toRow);
		},

		async commit(writes) {
			// Two writes to one row cannot both hold against the state read before either: refused before writing.
			const targets = new Set(writes.map((write) => `${write.table}\u0000${write.id}`));
			if (targets.size !== writes.length) return false;
			// Checked and applied in one synchronous transaction: nothing else in the object runs in between, and a write
			// that does not apply (or throws) rolls back every write before it.
			try {
				return transactionSync(() => {
					if (!writes.every(holds)) return false;
					for (const write of writes) {
						const cursor =
							write.kind === "insert"
								? sql.exec(
										`INSERT INTO ${tableName(write.table)} (id, organisation_id, revision, data) VALUES (?, ?, 1, ?)`,
										write.id,
										write.organisationId,
										write.data,
									)
								: sql.exec(
										`UPDATE ${tableName(write.table)} SET revision = revision + 1, data = ? WHERE id = ? AND revision = ?`,
										write.data,
										write.id,
										write.revision,
									);
						// Zero means the write's row did not match. Durable Objects may count index rows in `rowsWritten`, so a
						// write that applied can report more than one.
						if (cursor.rowsWritten < 1) throw new WriteDidNotApply();
					}
					return true;
				});
			} catch (error) {
				if (error instanceof WriteDidNotApply) return false;
				throw error;
			}
		},
	};
}

export interface VaultDurableObjectCoreOptions extends Omit<VaultOptions, "store" | "cipher"> {
	/** The object's `ctx.storage.sql`. */
	readonly sql: SqlStorageLike;
	/** The object's `ctx.storage.transactionSync`, bound to its storage. Required: see `SqliteVaultStoreOptions`. */
	readonly transactionSync: <T>(work: () => T) => T;
	/** The 256-bit key item values are sealed with: 32 bytes, or base64 (from a Worker secret). */
	readonly cipherKey: Uint8Array | string;
	/** Names the key in every sealed value; see `createAesGcmCipher`. */
	readonly cipherKeyId?: string;
	/**
	 * Who is calling the egress API: the egress gateway or the model gateway, as `system` (such as
	 * `createSharedKeyAuthenticator`). Without it the API refuses every request with `forbidden`.
	 */
	readonly authenticate?: (request: Request) => Promise<SystemContext>;
}

/**
 * Everything a VaultDO needs, so the Durable Object class (owned by the deployment) is a thin wrapper: construct this
 * in the constructor with `ctx.storage.sql`, and forward `fetch` and the RPC methods. Building it migrates the tables.
 */
export class VaultDurableObjectCore {
	readonly vault: HarbourVault;
	readonly store: SqliteVaultStore;
	readonly #handler: (request: Request) => Promise<Response>;

	constructor(options: VaultDurableObjectCoreOptions) {
		const { sql, transactionSync, cipherKey, cipherKeyId, authenticate, ...vaultOptions } = options;
		this.store = createSqliteVaultStore(sql, { transactionSync });
		this.store.migrate();
		this.vault = createVault({
			...vaultOptions,
			store: this.store,
			cipher: createAesGcmCipher({ key: cipherKey, ...(cipherKeyId === undefined ? {} : { keyId: cipherKeyId }) }),
		});
		this.#handler = createEgressDecisionApi({
			vault: this.vault,
			authenticate:
				authenticate ??
				(async () => {
					throw new HarbourError("forbidden", "This vault's egress API has no authenticator configured");
				}),
		});
	}

	/** The egress proxy's decision, as an RPC call from a Worker that already holds the gateway's system context. */
	decideEgress(ctx: SystemContext, request: EgressRequest): Promise<EgressDecision> {
		return this.vault.decideEgress(ctx, request);
	}

	/** The model gateway's key read, as an RPC call. */
	readConnectorCredential(ctx: SystemContext, request: ConnectorCredentialRequest): Promise<ConnectorCredential> {
		return this.vault.readConnectorCredential(ctx, request);
	}

	/** The egress decision API (`@harbour/vault/egress-api`), for the object's `fetch`. */
	fetch(request: Request): Promise<Response> {
		return this.#handler(request);
	}
}
