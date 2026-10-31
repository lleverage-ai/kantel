import { PGlite } from "@electric-sql/pglite";
import { registerVaultConformance } from "@kantel/testing/vault";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import { createVault } from "@kantel/vault/engine";
import { afterAll, describe, expect, it } from "vitest";
import { freshStore } from "./support-postgres.ts";

const db = new PGlite();
afterAll(() => db.close());

registerVaultConformance(
	{ describe, expect, it },
	"Postgres vault store (PGlite)",
	async (deps, use) => {
		const { store, drop } = await freshStore(db);
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
