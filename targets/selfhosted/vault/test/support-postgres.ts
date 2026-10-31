import { PGlite } from "@electric-sql/pglite";
import { registerVaultDurableProofs, type VaultDurableProof, type VaultDurableSubject } from "@kantel/testing/vault";
import { VAULT_TABLES } from "@kantel/vault/store";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresVaultStore, type PostgresVaultDb, type PostgresVaultStore } from "../src/index.ts";
import { durableSubject } from "./support.ts";

/** A fresh schema for one case, as the brief names them: `m1_be5_vault_<random>`. */
export function caseSchema(): string {
	return `m1_be5_vault_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** A migrated store in a fresh schema, every row of it read raw, and a drop for afterwards. */
export async function freshStore(db: PostgresVaultDb): Promise<{
	readonly store: PostgresVaultStore;
	readonly rawRows: VaultDurableSubject["rawRows"];
	drop(): Promise<void>;
}> {
	const schema = caseSchema();
	const store = createPostgresVaultStore({ db, schema });
	await store.migrate();
	return {
		store,
		async rawRows() {
			const rows: { table: string; row: unknown }[] = [];
			for (const table of VAULT_TABLES) {
				const result = await db.query(`SELECT * FROM "${schema}"."${table}" ORDER BY seq`);
				for (const row of result.rows) {
					// int8 columns come back as bigint from PGlite; make them JSON-safe as they are.
					const plain = Object.fromEntries(
						Object.entries(row as Record<string, unknown>).map(([column, value]) => [
							column,
							typeof value === "bigint" ? String(value) : value,
						]),
					);
					rows.push({ table, row: plain });
				}
			}
			return rows;
		},
		async drop() {
			await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		},
	};
}

/**
 * Registers proofs from issue #13 against PGlite, one store (in its own schema) per case, dropped afterwards. Each
 * proof file calls this once with its own database.
 */
export function registerPgliteProofs(title: string, only: readonly VaultDurableProof[]): void {
	const db = new PGlite();
	afterAll(() => db.close());
	registerVaultDurableProofs(
		{ describe, expect, it },
		`Postgres vault store (PGlite): ${title}`,
		async (deps, use) => {
			const { store, rawRows, drop } = await freshStore(db);
			try {
				await use(durableSubject(deps, store, rawRows));
			} finally {
				await drop();
			}
		},
		only,
	);
}
