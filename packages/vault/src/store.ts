/**
 * Where the vault keeps its records. `createVault` runs every rule over a `VaultStore`; a target supplies the store
 * (memory here, Postgres in `@kantel/vault-selfhosted`, Durable Object SQLite in `@kantel/vault-cloudflare`).
 *
 * The store is deliberately dumb: one table per record kind, each row an ID, the owning organisation, a revision and
 * the record as JSON. The rules live in the engine. What the store guarantees is `commit`: a set of writes applied all
 * or none, each insert only for a new ID and each update only when the row's revision is still the one the engine
 * read (compare-and-set). That is what keeps the race rules across processes: two vault instances over one store
 * settle a proposal once, never spend a grant past `maxUses`, and let a withdrawal and a decision race safely.
 */
import type { OrganisationId } from "@kantel/contracts";

/** The record kinds the vault stores, one table each. */
export type VaultTable = "items" | "ceilings" | "policies" | "proposals" | "decisions" | "grants" | "uses" | "sessions";

export const VAULT_TABLES: readonly VaultTable[] = [
	"items",
	"ceilings",
	"policies",
	"proposals",
	"decisions",
	"grants",
	"uses",
	"sessions",
];

export interface VaultRow {
	readonly id: string;
	/** The organisation the record belongs to; `null` for the platform's own records (platform items). */
	readonly organisationId: OrganisationId | null;
	/** 1 when inserted; every update adds 1. */
	readonly revision: number;
	/** The record as JSON. An item's value is in it only sealed by the vault's cipher, never as plaintext. */
	readonly data: string;
}

export type VaultWrite =
	| {
			readonly kind: "insert";
			readonly table: VaultTable;
			readonly id: string;
			readonly organisationId: OrganisationId | null;
			readonly data: string;
	  }
	| {
			readonly kind: "update";
			readonly table: VaultTable;
			readonly id: string;
			/** The revision the engine read. The update applies only if the row still has it, and stores `revision + 1`. */
			readonly revision: number;
			readonly data: string;
	  };

export interface VaultStore {
	get(table: VaultTable, id: string): Promise<VaultRow | undefined>;
	/** One organisation's rows (`null`: the platform's), in the order they were inserted. */
	list(table: VaultTable, organisationId: OrganisationId | null): Promise<readonly VaultRow[]>;
	/**
	 * Applies every write or none. Resolves `false`, having written nothing, when an insert's ID exists or an update's
	 * row is missing or has moved past the revision it names. Atomic across every vault instance over the store.
	 */
	commit(writes: readonly VaultWrite[]): Promise<boolean>;
}

/** A `VaultStore` in maps, for the in-memory target and tests. Each commit checks and applies without awaiting. */
export function createMemoryVaultStore(): VaultStore {
	const tables = new Map<VaultTable, Map<string, VaultRow>>(VAULT_TABLES.map((table) => [table, new Map()]));
	const rowsOf = (table: VaultTable): Map<string, VaultRow> => {
		const rows = tables.get(table);
		if (rows === undefined) throw new Error(`Unknown vault table ${table}`);
		return rows;
	};

	return {
		async get(table, id) {
			return rowsOf(table).get(id);
		},
		async list(table, organisationId) {
			return [...rowsOf(table).values()].filter((row) => row.organisationId === organisationId);
		},
		async commit(writes) {
			for (const write of writes) {
				const existing = rowsOf(write.table).get(write.id);
				if (write.kind === "insert" ? existing !== undefined : existing?.revision !== write.revision) return false;
			}
			for (const write of writes) {
				const rows = rowsOf(write.table);
				if (write.kind === "insert") {
					rows.set(write.id, { id: write.id, organisationId: write.organisationId, revision: 1, data: write.data });
				} else {
					const existing = rows.get(write.id)!;
					rows.set(write.id, { ...existing, revision: write.revision + 1, data: write.data });
				}
			}
			return true;
		},
	};
}
