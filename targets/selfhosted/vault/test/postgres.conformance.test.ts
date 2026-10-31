import { registerVaultConformance, registerVaultDurableProofs } from "@kantel/testing/vault";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import { createVault } from "@kantel/vault/engine";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { durableSubject } from "./support.ts";
import { freshStore } from "./support-postgres.ts";

// Runs against a real Postgres only when KANTEL_TEST_DATABASE_URL names one; each case gets its own schema
// (`m1_be5_vault_<random>`), dropped afterwards.
const url = process.env.KANTEL_TEST_DATABASE_URL;
const pool = url === undefined || url === "" ? undefined : new pg.Pool({ connectionString: url, max: 8 });
afterAll(async () => {
	await pool?.end();
});
const runner = { describe: describe.skipIf(pool === undefined), expect, it };

registerVaultConformance(
	runner,
	"Postgres vault store (pg)",
	async (deps, use) => {
		const { store, drop } = await freshStore(pool!);
		try {
			await use({
				vault: createVault({
					store,
					cipher: createAesGcmCipher({ key: randomCipherKey() }),
					clock: deps.clock,
					audit: deps.audit,
					access: deps.access,
				}),
			});
		} finally {
			await drop();
		}
	},
	{ projectAccess: true },
);

registerVaultDurableProofs(runner, "Postgres vault store (pg): issue #13 proofs", async (deps, use) => {
	const { store, rawRows, drop } = await freshStore(pool!);
	try {
		await use(durableSubject(deps, store, rawRows));
	} finally {
		await drop();
	}
});
