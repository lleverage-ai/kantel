// The organisation's ceiling for connection rules (#332) over the VaultDO's RPC: the one the vault's grants keep to.

import { DatabaseSync } from "node:sqlite";
import { vaultCeiling } from "@kantel/connections/rules";
import type { CallContext } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { answerCeilingCall, ceilingVaultOver, createVaultCore } from "../src/vault.ts";
import { objectStorage } from "./object-storage.ts";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe("the connections ceiling over RPC", () => {
	it("reads none, sets it as the person, and reads it back as the vault keeps it", async () => {
		const storage = objectStorage(new DatabaseSync(":memory:"));
		const core = createVaultCore({ ...storage, vars: { KANTEL_VAULT_KEY: KEY } });
		const calls: string[] = [];
		const store = vaultCeiling(() =>
			ceilingVaultOver(async (method, ctx, args) => {
				calls.push(method);
				return structuredClone(
					await answerCeilingCall(() => core.vault, method, structuredClone(ctx), structuredClone(args)),
				);
			}),
		);
		const admin: CallContext = { actor: { kind: "human", userId: "u-1" }, organisationId: "org-a" };
		expect(await store.get("org-a")).toBeUndefined();
		const routes = [{ host: "api.github.com", methods: ["GET" as const], pathPrefix: "/repos" }];
		expect(await store.set(admin, routes)).toEqual(routes);
		expect(await store.get("org-a")).toEqual(routes);
		expect(await store.get("org-b")).toBeUndefined();
		// The vault's grants see the same ceiling.
		expect((await core.vault.getCeiling(admin)).routes).toEqual(routes);
		expect(calls).toEqual(["getCeiling", "setCeiling", "getCeiling", "getCeiling"]);
	});

	it("takes only the ceiling's calls, and carries a refusal's code across", async () => {
		const storage = objectStorage(new DatabaseSync(":memory:"));
		const core = createVaultCore({ ...storage, vars: { KANTEL_VAULT_KEY: KEY } });
		const human: CallContext = { actor: { kind: "human", userId: "u-1" }, organisationId: "org-a" };
		expect(await answerCeilingCall(() => core.vault, "putItem", human, [{}])).toMatchObject({
			ok: false,
			code: "not_supported",
		});
		const bad = await answerCeilingCall(() => core.vault, "setCeiling", human, [[{ host: "", methods: [] }]]);
		expect(bad).toMatchObject({ ok: false, code: "invalid" });
	});
});
