// The VaultDO's portable half in Node: `createVaultCore` over `node:sqlite` standing in for the object's SQLite, its
// audit events in a SQL audit store standing in for D1, the egress decision API as the Worker routes it, and the
// deploy's vault secrets.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createSqlAuditStore } from "@harbour/audit/sql";
import { type CallContext, isHarbourError } from "@harbour/contracts";
import { syncSqliteDriver } from "@harbour/sql/sqlite";
import { createEgressDecisionClient } from "@harbour/vault/egress-api";
import type { SqlStorageLike, SqlValue } from "@harbour/vault-cloudflare";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { deployConfig, deployValues } from "../scripts/deploy-config.ts";
import { VAULT_SECRETS, vaultSecrets } from "../scripts/vault-secrets.ts";
import { routeRequest, STACK_NAME, VAULT_NAME } from "../src/route.ts";
import {
	COMPONENT_TOKENS,
	componentKeys,
	createVaultCore,
	isVaultPath,
	type VaultVars,
	vaultAuditSink,
} from "../src/vault.ts";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const MODEL_GATEWAY_TOKEN = "model-gateway-token-0123456789";
const human: CallContext = { actor: { kind: "human", userId: "admin-1" }, organisationId: "org-a" };
const BASE = "https://harbour.test";

/** A Durable Object's `ctx.storage.sql` and `transactionSync` over `node:sqlite`. */
function objectStorage(db: DatabaseSync): { sql: SqlStorageLike; transactionSync<T>(work: () => T): T } {
	return {
		sql: {
			exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
				const statement = db.prepare(query);
				const values = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as SQLInputValue[];
				const reads = statement.columns().length > 0;
				const rows = reads ? (statement.all(...values) as T[]) : [];
				const rowsWritten = reads ? 0 : Number(statement.run(...values).changes);
				return { toArray: () => rows, one: () => rows[0]!, rowsWritten };
			},
		},
		transactionSync<T>(work: () => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = work();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

function vaultOver(objectDb: DatabaseSync, auditDb: DatabaseSync, vars: VaultVars) {
	const storage = objectStorage(objectDb);
	return createVaultCore({
		sql: storage.sql,
		transactionSync: storage.transactionSync,
		audit: vaultAuditSink(syncSqliteDriver(auditDb)),
		vars,
	});
}

const configured: VaultVars = { HARBOUR_VAULT_KEY: KEY, HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: MODEL_GATEWAY_TOKEN };

async function withConnectorItem(vault: ReturnType<typeof vaultOver>) {
	return vault.vault.putItem(human, {
		owner: { kind: "organisation", organisationId: "org-a" },
		name: "llm-key",
		hosts: ["llm.example.com"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: "vault-do-test-value",
	});
}

const credentialRequest = (vaultItemId: string) => ({
	connectorId: "org-llm",
	owner: { kind: "organisation", organisationId: "org-a" } as const,
	vaultItemId,
	baseUrl: "http://llm.example.com/v1",
	scope: { organisationId: "org-a", projectId: "proj-a", agentId: "agent-1", sessionId: "session-1" },
});

describe("the VaultDO's core", () => {
	it("keeps the vault across a restart and serves the model gateway's key read over the egress API", async () => {
		const objectDb = new DatabaseSync(":memory:");
		const auditDb = new DatabaseSync(":memory:");
		const item = await withConnectorItem(vaultOver(objectDb, auditDb, configured));

		// The object restarts: a new core over the same SQLite sees the item and opens its value with the same key.
		const restarted = vaultOver(objectDb, auditDb, configured);
		const client = createEgressDecisionClient({
			baseUrl: BASE,
			token: MODEL_GATEWAY_TOKEN,
			fetch: async (input, init) => restarted.fetch(new Request(input, init)),
		});
		expect((await client.readConnectorCredential(credentialRequest(item.id))).value).toBe("vault-do-test-value");

		// No value reaches the object's rows or the audit store.
		const rows = JSON.stringify(objectDb.prepare("SELECT * FROM vault_items").all());
		expect(rows).toContain(item.id);
		expect(rows).not.toContain("vault-do-test-value");
		const audit = createSqlAuditStore({ driver: syncSqliteDriver(auditDb) });
		const events = await audit.query(human, {});
		expect(events.items.map((event) => event.type)).toContain("vault.use.injected");
		expect(JSON.stringify(events)).not.toContain("vault-do-test-value");
	});

	it("refuses a caller without a component's key, and every caller when no component has one", async () => {
		const objectDb = new DatabaseSync(":memory:");
		const auditDb = new DatabaseSync(":memory:");
		const item = await withConnectorItem(vaultOver(objectDb, auditDb, configured));
		const post = (vault: ReturnType<typeof vaultOver>, token?: string) =>
			vault.fetch(
				new Request(`${BASE}/v1/connector-credentials`, {
					method: "POST",
					headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
					body: JSON.stringify(credentialRequest(item.id)),
				}),
			);
		const vault = vaultOver(objectDb, auditDb, configured);
		expect((await post(vault)).status).toBe(403);
		expect((await post(vault, "not-the-model-gateway-token")).status).toBe(403);
		const noComponents = vaultOver(objectDb, auditDb, { HARBOUR_VAULT_KEY: KEY });
		const refused = await post(noComponents, MODEL_GATEWAY_TOKEN);
		expect(refused.status).toBe(403);
		expect(await refused.text()).not.toContain("vault-do-test-value");
	});

	it("will not start without a key, or with one that is not 32 bytes", () => {
		const start = (vars: VaultVars) => () =>
			vaultOver(new DatabaseSync(":memory:"), new DatabaseSync(":memory:"), vars);
		expect(start({ HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: MODEL_GATEWAY_TOKEN })).toThrow(
			expect.objectContaining({ code: "unavailable" }),
		);
		expect(start({ HARBOUR_VAULT_KEY: "  " })).toThrow(expect.objectContaining({ code: "unavailable" }));
		expect(start({ HARBOUR_VAULT_KEY: btoa("too short") })).toThrow(expect.objectContaining({ code: "invalid" }));
		try {
			start({ HARBOUR_VAULT_KEY: KEY, HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN: "short" })();
			expect.unreachable();
		} catch (error) {
			expect(isHarbourError(error) && error.code).toBe("invalid");
		}
	});

	it("names each component by its own secret", () => {
		expect(
			componentKeys({
				HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: " model-token-0123456789 ",
				HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN: "",
			}),
		).toEqual({ "model-gateway": "model-token-0123456789" });
		// The deploy writes exactly the secrets the vault reads.
		expect([...VAULT_SECRETS].sort()).toEqual(["HARBOUR_VAULT_KEY", ...Object.values(COMPONENT_TOKENS)].sort());
	});
});

describe("routing", () => {
	function namespace(name: string, seen: string[]) {
		return {
			idFromName: (objectName: string) => `${name}:${objectName}`,
			get: (id: string) => ({
				fetch: async (request: Request) => {
					seen.push(`${id} ${new URL(request.url).pathname}`);
					return new Response(null, { status: 204 });
				},
			}),
		};
	}

	it("sends the egress decision API to the one vault object and every other /v1 path to the stack", async () => {
		const seen: string[] = [];
		const env = {
			STACK: namespace("stack", seen),
			VAULTS: namespace("vault", seen),
			ASSETS: {
				fetch: async (request: Request) => {
					seen.push(`assets ${new URL(request.url).pathname}`);
					return new Response(null, { status: 204 });
				},
			},
		};
		for (const path of [
			"/v1/egress/decisions",
			"/v1/connector-credentials",
			"/v1/egress",
			"/v1/egress/decisions/x",
			"/v1/sessions",
			"/vault",
			"/",
		]) {
			await routeRequest(new Request(`${BASE}${path}`), env);
		}
		expect(seen).toEqual([
			`vault:${VAULT_NAME} /v1/egress/decisions`,
			`vault:${VAULT_NAME} /v1/connector-credentials`,
			`stack:${STACK_NAME} /v1/egress`,
			`stack:${STACK_NAME} /v1/egress/decisions/x`,
			`stack:${STACK_NAME} /v1/sessions`,
			"assets /vault",
			"assets /",
		]);
		expect(isVaultPath("/v1/egress/decisions")).toBe(true);
		expect(isVaultPath("/v1/egress/decisions/")).toBe(false);
	});
});

describe("the vault's deploy", () => {
	const wranglerJsonc = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
	const { rawConfig } = experimental_readRawConfig({ config: wranglerJsonc });
	const values = deployValues({}, "dry-run");

	it("binds the VaultDO beside the stack, with its own SQLite migration", () => {
		const config = deployConfig(rawConfig, values);
		expect(config.durable_objects).toEqual({
			bindings: [
				{ name: "STACK", class_name: "HarbourStack" },
				{ name: "VAULTS", class_name: "HarbourVault" },
			],
		});
		expect(config.migrations).toEqual([
			{ tag: "v1", new_sqlite_classes: ["HarbourStack"] },
			{ tag: "v2", new_sqlite_classes: ["HarbourVault"] },
		]);
		// The vault's secrets are never vars of the deployed Worker; only the local dev environment has its own.
		for (const name of VAULT_SECRETS) expect(config.vars as Record<string, unknown>).not.toHaveProperty(name);
	});

	it("refuses a vault secret written into wrangler.jsonc as a var", () => {
		const vars = { ...(rawConfig.vars as Record<string, unknown>), HARBOUR_VAULT_KEY: KEY };
		expect(() => deployConfig({ ...rawConfig, vars }, values)).toThrow(/HARBOUR_VAULT_KEY as a var/);
	});

	it("writes only the vault secrets that are set, and refuses a malformed one without printing it", () => {
		expect(vaultSecrets({})).toEqual({});
		expect(vaultSecrets({ HARBOUR_VAULT_KEY: ` ${KEY} `, HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: "" })).toEqual({
			HARBOUR_VAULT_KEY: KEY,
		});
		const urlSafe = KEY.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(vaultSecrets({ HARBOUR_VAULT_KEY: urlSafe })).toEqual({ HARBOUR_VAULT_KEY: urlSafe });
		for (const bad of [btoa("sixteen bytes!!!"), "not base64 at all!", `${KEY}x`]) {
			expect(() => vaultSecrets({ HARBOUR_VAULT_KEY: bad })).toThrow(/HARBOUR_VAULT_KEY must be 32 random bytes/);
			try {
				vaultSecrets({ HARBOUR_VAULT_KEY: bad });
			} catch (error) {
				expect(String(error)).not.toContain(bad);
			}
		}
		expect(() => vaultSecrets({ HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN: "short" })).toThrow(
			/HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN must be at least 16/,
		);
	});
});
