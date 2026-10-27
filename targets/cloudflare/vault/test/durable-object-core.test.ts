import { DatabaseSync } from "node:sqlite";
import { type CallContext, systemContext } from "@harbour/contracts";
import { createEgressDecisionClient, createSharedKeyAuthenticator } from "@harbour/vault/egress-api";
import { describe, expect, it } from "vitest";
import { VaultDurableObjectCore } from "../src/index.ts";
import { sqlStorageOf } from "./support-sqlite.ts";

const human: CallContext = { actor: { kind: "human", userId: "admin-1" }, organisationId: "org-a" };
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const GATEWAY_KEY = "egress-gateway-key-0123456789";

function core(db: DatabaseSync, withAuthenticator = true) {
	const sql = sqlStorageOf(db);
	return new VaultDurableObjectCore({
		sql,
		transactionSync: sql.transactionSync,
		cipherKey: KEY,
		...(withAuthenticator
			? { authenticate: createSharedKeyAuthenticator({ keys: { "egress-gateway": GATEWAY_KEY } }) }
			: {}),
	});
}

describe("VaultDurableObjectCore", () => {
	it("keeps the vault across objects built over the same storage, and serves the egress API", async () => {
		const db = new DatabaseSync(":memory:");
		const first = core(db);
		const item = await first.vault.putItem(human, {
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "llm-key",
			hosts: ["llm.example.com"],
			injection: { header: "Authorization", template: "Bearer {key}" },
			value: "core-test-value",
		});
		await first.vault.putPolicy(human, {
			itemId: item.id,
			selector: { organisationId: "org-a" },
			route: { host: "llm.example.com", methods: ["GET"], pathPrefix: "/" },
		});

		// The object restarts: a new core over the same storage, migrating again, sees everything.
		const restarted = core(db);
		const request = { organisationId: "org-a", method: "GET", url: "https://llm.example.com/models" } as const;
		expect(await restarted.decideEgress(systemContext("egress-gateway"), request)).toMatchObject({ allow: true });
		const credential = await restarted.readConnectorCredential(systemContext("model-gateway"), {
			connectorId: "org-llm",
			owner: { kind: "organisation", organisationId: "org-a" },
			vaultItemId: item.id,
			baseUrl: "http://llm.example.com/v1",
			scope: { organisationId: "org-a", projectId: "proj-a", agentId: "agent-1", sessionId: "session-1" },
		});
		expect(credential.value).toBe("core-test-value");
		const client = createEgressDecisionClient({
			baseUrl: "https://vault.internal",
			token: GATEWAY_KEY,
			fetch: async (input, init) => restarted.fetch(new Request(input, init)),
		});
		expect(await client.decideEgress(request)).toMatchObject({
			allow: true,
			inject: { value: "Bearer core-test-value" },
		});
		expect((await restarted.vault.listUses(human)).items).toHaveLength(3);
	});

	it("refuses every API request when no authenticator is configured", async () => {
		const response = await core(new DatabaseSync(":memory:"), false).fetch(
			new Request("https://vault.internal/v1/egress/decisions", { method: "POST", body: "{}" }),
		);
		expect(response.status).toBe(403);
	});
});
