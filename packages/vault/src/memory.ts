import { createAesGcmCipher, randomCipherKey } from "./cipher.ts";
import { createVault, type KantelVault, type VaultOptions } from "./engine.ts";
import { createMemoryVaultStore } from "./store.ts";

export type MemoryVaultOptions = Omit<VaultOptions, "store" | "cipher">;

/**
 * The reference vault: `createVault` over a store in maps, with values sealed under a random key that lives only as
 * long as the vault. Nothing outlives the process.
 */
export function createMemoryVault(options: MemoryVaultOptions = {}): KantelVault {
	return createVault({
		...options,
		store: createMemoryVaultStore(),
		cipher: createAesGcmCipher({ key: randomCipherKey() }),
	});
}
