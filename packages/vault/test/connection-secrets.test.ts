import { type CallContext, systemContext } from "@harbour/contracts";
import { createAesGcmCipher, randomCipherKey } from "@harbour/vault/cipher";
import { createVault } from "@harbour/vault/engine";
import { createMemoryVaultStore, VAULT_TABLES } from "@harbour/vault/store";
import { describe, expect, it } from "vitest";

const SYSTEM = systemContext("connections");
const human: CallContext = { actor: { kind: "human", userId: "alice" }, organisationId: "org-a" };
const TOKEN = "connection-token-value-9f3a";

function vault() {
	const store = createMemoryVaultStore();
	return { store, vault: createVault({ store, cipher: createAesGcmCipher({ key: randomCipherKey() }) }) };
}

describe("the vault's connection secrets", () => {
	it("keeps a person's token sealed and opens it only for its hosts in its organisation", async () => {
		const { store, vault: v } = vault();
		const { itemId } = await v.connectionSecret(SYSTEM, {
			op: "put",
			owner: { kind: "user", organisationId: "org-a", userId: "alice" },
			name: "linear-access",
			hosts: ["mcp.linear.app"],
			value: TOKEN,
		});
		for (const table of VAULT_TABLES) {
			for (const row of await store.list(table, "org-a")) expect(row.data).not.toContain(TOKEN);
		}
		const opened = await v.connectionSecret(SYSTEM, {
			op: "open",
			itemId: itemId!,
			host: "mcp.linear.app",
			organisationId: "org-a",
			session: { sessionId: "ses-1", agentId: "agt-1" },
			purpose: "connection conn_1: tools/call",
		});
		expect(opened.value).toBe(TOKEN);
		await expect(
			v.connectionSecret(SYSTEM, {
				op: "open",
				itemId: itemId!,
				host: "evil.example.com",
				organisationId: "org-a",
				purpose: "x",
			}),
		).rejects.toMatchObject({ code: "refused" });
		await expect(
			v.connectionSecret(SYSTEM, {
				op: "open",
				itemId: itemId!,
				host: "mcp.linear.app",
				organisationId: "org-b",
				purpose: "x",
			}),
		).rejects.toMatchObject({ code: "refused" });
		const uses = await v.listUses({ ...SYSTEM, organisationId: "org-a" }, {});
		expect(uses.items.map((use) => use.outcome).sort()).toEqual(["denied", "injected"]);
		// The other organisation's refused attempt is recorded there, naming nothing of org-a's.
		const theirs = await v.listUses({ ...SYSTEM, organisationId: "org-b" }, {});
		expect(theirs.items).toHaveLength(1);
		expect(JSON.stringify(theirs)).not.toContain("linear-access");
		expect(JSON.stringify(uses)).not.toContain(TOKEN);
	});

	it("refuses a session that has ended", async () => {
		const { vault: v } = vault();
		const { itemId } = await v.connectionSecret(SYSTEM, {
			op: "put",
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "key",
			hosts: ["api.example.com"],
			value: TOKEN,
		});
		await v.endSession({ ...SYSTEM, organisationId: "org-a" }, "ses-1", "session_ended");
		await expect(
			v.connectionSecret(SYSTEM, {
				op: "open",
				itemId: itemId!,
				host: "api.example.com",
				organisationId: "org-a",
				session: { sessionId: "ses-1" },
				purpose: "x",
			}),
		).rejects.toMatchObject({ code: "refused" });
	});

	it("replaces and clears a value", async () => {
		const { vault: v } = vault();
		const { itemId } = await v.connectionSecret(SYSTEM, {
			op: "put",
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "key",
			hosts: ["api.example.com"],
			value: TOKEN,
		});
		await v.connectionSecret(SYSTEM, { op: "replace", itemId: itemId!, value: "next-value-1234" });
		const open = () =>
			v.connectionSecret(SYSTEM, {
				op: "open",
				itemId: itemId!,
				host: "api.example.com",
				organisationId: "org-a",
				purpose: "x",
			});
		expect((await open()).value).toBe("next-value-1234");
		await v.connectionSecret(SYSTEM, { op: "clear", itemId: itemId! });
		await expect(open()).rejects.toMatchObject({ code: "refused" });
	});

	it("is a system call only", async () => {
		const { vault: v } = vault();
		await expect(
			v.connectionSecret(human as never, {
				op: "put",
				owner: { kind: "user", organisationId: "org-a", userId: "alice" },
				name: "x",
				hosts: ["api.example.com"],
				value: TOKEN,
			}),
		).rejects.toMatchObject({ code: "forbidden" });
	});
});
