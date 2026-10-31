import { registerVaultConformance } from "@kantel/testing/vault";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import { createVault } from "@kantel/vault/engine";
import { describe, expect, it } from "vitest";
import { freshStore } from "./support-sqlite.ts";

registerVaultConformance(
	{ describe, expect, it },
	"Durable Object SQLite vault store (node:sqlite)",
	async (deps, use) => {
		const { store, close } = freshStore();
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
			close();
		}
	},
	{ projectAccess: true },
);
