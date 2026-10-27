import { registerVaultConformance } from "@harbour/testing/vault";
import { createMemoryVault } from "@harbour/vault/memory";
import { describe, expect, it } from "vitest";

registerVaultConformance({ describe, expect, it }, "in-memory vault", async (deps, use) => {
	await use({ vault: createMemoryVault({ clock: deps.clock, audit: deps.audit }) });
});
