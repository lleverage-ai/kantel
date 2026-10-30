// The model gateway on Cloudflare in Node: the stack's sessions on `createGatewayModels`, the VaultDO's core over
// `node:sqlite` holding CPA's key as a platform item, and a fake CLIProxyAPI standing in for the `MODELS` VPC service.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createSqlAuditStore } from "@harbour/audit/sql";
import { isHarbourError, systemContext } from "@harbour/contracts";
import { syncSqliteDriver } from "@harbour/sql/sqlite";
import { createFakeModelUpstream, DEFAULT_FAKE_SCRIPT } from "@harbour/testing/models";
import type { SqlStorageLike, SqlValue } from "@harbour/vault-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VAULT_SECRETS, vaultSecrets } from "../scripts/vault-secrets.ts";
import { objectSqlDriver } from "../src/audit-outbox.ts";
import { CODING_TOOLS } from "../src/coding-tools.ts";

/** The namespace the model gateway sends tool names under on CPA's Messages API (`@harbour/models`, #227). */
const TOOL_NAMESPACE = "mcp__harbour__";

import { gatewayConfig } from "../src/config.ts";
import {
	CPA_CONNECTOR_ID,
	CPA_HOST,
	cpaItemName,
	cpaOnly,
	createGatewayModels,
	DEFAULT_MODEL,
	defaultModel,
	type ModelsVault,
} from "../src/models.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";
import { createVaultCore, type SeededItems, seedCpaItem, vaultAuditSink } from "../src/vault.ts";

const VAULT_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const CPA_KEY = "cpa-client-key-for-tests-0123";
const MODEL = "claude-sonnet-4-5";

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

/** The VaultDO's `ctx.storage.sql` and `transactionSync` over `node:sqlite`. */
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

/** The vault object as the stack's object reaches it over RPC: its core, the items it seeded and its CPA key. */
function vaultObject(options: { objectDb?: DatabaseSync; auditDb: DatabaseSync; cpaKey?: string }) {
	const objectDb = options.objectDb ?? new DatabaseSync(":memory:");
	const storage = objectStorage(objectDb);
	const core = createVaultCore({
		sql: storage.sql,
		transactionSync: storage.transactionSync,
		audit: vaultAuditSink(syncSqliteDriver(options.auditDb)),
		vars: { HARBOUR_VAULT_KEY: VAULT_KEY },
	});
	const names = new Map<string, string>();
	const seeded: SeededItems = {
		get: async (name) => names.get(name),
		put: async (name, itemId) => {
			names.set(name, itemId);
		},
	};
	const vault: ModelsVault = {
		cpaItem: () => seedCpaItem(core, seeded, { HARBOUR_CPA_API_KEY: options.cpaKey ?? CPA_KEY }),
		readConnectorCredential: (ctx, request) => core.readConnectorCredential(ctx, request),
	};
	return { core, vault, objectDb };
}

/** The stack, its sessions on the gateway, the upstream as the VPC service, and its D1 standing in. */
async function gatewayStack(vault: ModelsVault, auditDb: DatabaseSync, modelId: string = MODEL) {
	const upstream = createFakeModelUpstream({ models: [{ id: modelId, contextWindow: 1_000_000, maxTokens: 64_000 }] });
	const stack = await createStack({
		config: gatewayConfig({}),
		storage: { sql: syncSqliteDriver(auditDb) },
		models: ({ audit, clock }) =>
			createGatewayModels({ upstream: (request) => upstream.fetch(request), vault, audit, clock, modelId }),
	});
	opened.push(stack);
	const ask = async (text: string) => {
		const session = await stack.runtime.runtime.create(stack.admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			title: "Models",
		});
		const prompt = await stack.runtime.runtime.prompt(stack.admin, session.id, { text });
		return { session, result: await stack.runtime.runtime.wait(stack.admin, session.id, prompt.id) };
	};
	return { stack, upstream, ask };
}

describe("sessions on the model gateway", () => {
	it("answers from CLIProxyAPI with the vault's key, recording the call and the key's use", async () => {
		const auditDb = new DatabaseSync(":memory:");
		const { vault, objectDb } = vaultObject({ auditDb });
		const { stack, upstream, ask } = await gatewayStack(vault, auditDb);

		const { session, result } = await ask("ping");
		expect(result).toMatchObject({ answer: DEFAULT_FAKE_SCRIPT.text });

		// Every request went to CPA's host, and the model call (Messages, for a Claude model) carried the vault's key.
		const hosts = new Set(upstream.requests.map((request) => new URL(request.url).hostname));
		expect([...hosts]).toEqual([CPA_HOST]);
		const call = upstream.calls().at(-1)!;
		expect(call.kind).toBe("anthropic-messages");
		expect(call.headers["x-api-key"]).toBe(CPA_KEY);
		expect(call.body).toMatchObject({ model: MODEL });
		expect(session.status).toBeDefined();

		// The call and the key's use are in the organisation's audit, in the stack's store; the key is only in CPA's request.
		const events = await createSqlAuditStore({ driver: syncSqliteDriver(auditDb) }).query(stack.admin, {});
		const types = events.items.map((event) => event.type);
		expect(types).toEqual(expect.arrayContaining(["vault.use.injected", "model.call"]));
		expect(JSON.stringify(events)).not.toContain(CPA_KEY);
		const rows = JSON.stringify(objectDb.prepare("SELECT * FROM vault_items").all());
		expect(rows).toContain(await cpaItemName(CPA_KEY));
		expect(rows).not.toContain(CPA_KEY);
	});

	it("sends a bare session's turn with no prompt of Harbour's own", async () => {
		// The deployed default model: "Hi" in a fresh session on the default profile, as the console starts one.
		const auditDb = new DatabaseSync(":memory:");
		const { vault } = vaultObject({ auditDb });
		const { upstream, ask } = await gatewayStack(vault, auditDb, DEFAULT_MODEL);

		await ask("Hi");
		const call = upstream.calls().at(-1)!;
		expect(call.kind).toBe("anthropic-messages");
		// The whole body: the user's message, the model's settings and the session's tools (every session has the coding
		// tools, which describe themselves). No system prompt, and no text Harbour wrote; what the model is told is the
		// user's to configure on their profile.
		const { tools, ...body } = call.body as { tools?: { name: string }[] };
		// Pi's Anthropic client adds a deferred placeholder the model never sees, to keep tool changes in the cached prefix.
		// On CPA's Messages API the gateway sends each tool under `mcp__harbour__` (#227): a name, not text for the model.
		const named = tools?.map((tool) => tool.name).filter((name) => name !== "__pi_deferred_placeholder__");
		expect(named).toEqual(CODING_TOOLS.map((name) => `${TOOL_NAMESPACE}${name}`));
		expect(body).toEqual({
			model: DEFAULT_MODEL,
			messages: [
				{ role: "user", content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } }] },
				{ role: "system", content: [], output_config: { effort: "high" } },
			],
			max_tokens: 64_000,
			stream: true,
			thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
			output_config: { effort: "high" },
		});
		expect(JSON.stringify(body)).not.toMatch(/harbour/i);
		expect(JSON.stringify(tools?.map(({ name: _, ...rest }) => rest))).not.toMatch(/harbour/i);
	});

	it("sends the prompt the user set on the profile, as the system prompt and nothing more", async () => {
		const auditDb = new DatabaseSync(":memory:");
		const { vault } = vaultObject({ auditDb });
		const { stack, upstream, ask } = await gatewayStack(vault, auditDb, DEFAULT_MODEL);
		const profile = await stack.runtime.profiles.get(stack.admin, DEFAULT_AGENT_ID);
		await stack.runtime.profiles.put(stack.admin, {
			...profile,
			promptLayers: [
				{ name: "organisation", text: "You work for Lleverage." },
				{ name: "project", text: "Answer in Dutch." },
			],
		});

		await ask("Hi");
		const { tools: _, ...body } = upstream.calls().at(-1)!.body as { system?: unknown; tools?: unknown };
		expect(body.system).toEqual([
			{ type: "text", text: "You work for Lleverage.\n\nAnswer in Dutch.", cache_control: { type: "ephemeral" } },
		]);
		// Tool names carry the gateway's namespace (#227); the rest is the user's and the model's.
		expect(JSON.stringify(body)).not.toMatch(/harbour/i);
	});

	it("reaches only CPA's host through the VPC service", async () => {
		const seen: string[] = [];
		const only = cpaOnly(async (request) => {
			seen.push(request.url);
			return new Response("ok");
		});
		await expect(only("https://example.com/v1/models")).rejects.toMatchObject({ code: "refused" });
		await expect(only(`http://${CPA_HOST}.example.com/v1/models`)).rejects.toMatchObject({ code: "refused" });
		expect(await (await only(`http://${CPA_HOST}/v1/models`)).text()).toBe("ok");
		expect(seen).toEqual([`http://${CPA_HOST}/v1/models`]);
	});

	it("builds the gateway again after the vault fails, rather than keeping the failure", async () => {
		const auditDb = new DatabaseSync(":memory:");
		const real = vaultObject({ auditDb });
		let fail = true;
		const flaky: ModelsVault = {
			cpaItem: async () => {
				if (fail) throw new Error("the vault is not ready");
				return real.vault.cpaItem();
			},
			readConnectorCredential: real.vault.readConnectorCredential,
		};
		const { ask } = await gatewayStack(flaky, auditDb);
		const first = await ask("one").then(
			() => "answered",
			(error: unknown) => (isHarbourError(error) ? error.code : String(error)),
		);
		expect(first).toBe("unavailable");
		fail = false;
		expect((await ask("two")).result).toMatchObject({ answer: DEFAULT_FAKE_SCRIPT.text });
	});

	it("writes one usage row per call to the object's ledger and ships it to D1, cache split included", async () => {
		const auditDb = new DatabaseSync(":memory:");
		const { vault } = vaultObject({ auditDb });
		const ledgerDb = new DatabaseSync(":memory:");
		const { sql, transactionSync } = objectStorage(ledgerDb);
		const background: Promise<unknown>[] = [];
		const upstream = createFakeModelUpstream({ models: [{ id: MODEL, contextWindow: 1_000_000, maxTokens: 64_000 }] });
		upstream.next({ usage: { input: 25, output: 10, cacheRead: 3_000, cacheWrite: 400 } });
		const stack = await createStack({
			config: gatewayConfig({}),
			storage: {
				sql: syncSqliteDriver(auditDb),
				usageLedger: {
					driver: objectSqlDriver(sql, transactionSync),
					background: (work) => {
						background.push(work);
					},
				},
			},
			models: ({ audit, clock, usage }) =>
				createGatewayModels({
					upstream: (request) => upstream.fetch(request),
					vault,
					audit,
					clock,
					modelId: MODEL,
					...(usage === undefined ? {} : { usage }),
				}),
		});
		opened.push(stack);
		const session = await stack.runtime.runtime.create(stack.admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			title: "Usage",
		});
		const prompt = await stack.runtime.runtime.prompt(stack.admin, session.id, { text: "ping" });
		await stack.runtime.runtime.wait(stack.admin, session.id, prompt.id);
		await vi.waitFor(() => expect(ledgerDb.prepare("SELECT * FROM usage_calls").all()).toHaveLength(1));
		while (background.length > 0) await Promise.allSettled(background.splice(0));

		const shipped = auditDb.prepare("SELECT * FROM usage_calls").all();
		expect(shipped).toEqual([
			expect.objectContaining({
				session_id: session.id,
				organisation_id: stack.organisation.id,
				project_id: stack.project.id,
				agent_id: DEFAULT_AGENT_ID,
				model_id: MODEL,
				provider: "anthropic",
				connector_id: CPA_CONNECTOR_ID,
				connector_preset: "cliproxyapi",
				status: "done",
				input_tokens: 25,
				output_tokens: 10,
				cache_read_tokens: 3_000,
				cache_write_tokens: 400,
				cost_source: "none",
			}),
		]);
		const events = await createSqlAuditStore({ driver: syncSqliteDriver(auditDb) }).query(stack.admin, {
			types: ["model.call"],
		});
		expect(shipped[0]).toMatchObject({ call_id: events.items[0]?.subject?.id });
	});
});

describe("CPA's vault item", () => {
	it("is made once per key, and a rotated key makes a new one", async () => {
		const auditDb = new DatabaseSync(":memory:");
		const objectDb = new DatabaseSync(":memory:");
		const first = vaultObject({ objectDb, auditDb });
		const id = await first.vault.cpaItem();
		expect(await first.vault.cpaItem()).toBe(id);
		// A platform item: stored outside every organisation, so no organisation's admin can list or read it.
		const rows = objectDb.prepare("SELECT organisation_id FROM vault_items").all();
		expect(rows).toEqual([{ organisation_id: null }]);
		await expect(
			first.core.vault.getItem({ actor: { kind: "human", userId: "admin-1" }, organisationId: "org-a" }, id),
		).rejects.toMatchObject({ code: "not_found" });

		const rotated = vaultObject({ objectDb, auditDb, cpaKey: "a-rotated-cpa-client-key-4567" });
		const next = await rotated.vault.cpaItem();
		expect(next).not.toBe(id);
		const credential = await rotated.core.readConnectorCredential(systemContext("model-gateway"), {
			connectorId: CPA_CONNECTOR_ID,
			owner: { kind: "platform" },
			vaultItemId: next,
			baseUrl: `http://${CPA_HOST}/v1`,
			scope: { organisationId: "org-a", projectId: "proj-a", agentId: "agent-1", sessionId: "session-1" },
		});
		expect(credential.value).toBe("a-rotated-cpa-client-key-4567");
	});

	it("refuses without a key, and names items by a digest that is stable and not the key", async () => {
		const { core } = vaultObject({ auditDb: new DatabaseSync(":memory:") });
		const none = { get: async () => undefined, put: async () => undefined };
		await expect(seedCpaItem(core, none, {})).rejects.toMatchObject({ code: "unavailable" });
		await expect(seedCpaItem(core, none, { HARBOUR_CPA_API_KEY: "  " })).rejects.toMatchObject({
			code: "unavailable",
		});
		// A short key would slip past the gateway's redaction, so it is refused rather than seeded.
		await expect(seedCpaItem(core, none, { HARBOUR_CPA_API_KEY: "abc" })).rejects.toMatchObject({
			code: "unavailable",
		});
		const name = await cpaItemName(CPA_KEY);
		expect(name).toMatch(/^cliproxyapi-[0-9a-f]{12}$/);
		expect(await cpaItemName(CPA_KEY)).toBe(name);
		expect(name).not.toContain(CPA_KEY);
	});
});

describe("the models configuration", () => {
	it("reads the default model, refusing one that is not a model ID", () => {
		expect(defaultModel({})).toBe(DEFAULT_MODEL);
		expect(defaultModel({ HARBOUR_DEFAULT_MODEL: " gpt-5 " })).toBe("gpt-5");
		expect(() => defaultModel({ HARBOUR_DEFAULT_MODEL: "default:gpt-5" })).toThrow();
		expect(() => defaultModel({ HARBOUR_DEFAULT_MODEL: "two models" })).toThrow();
	});

	it("deploys CPA's key as a Worker secret, refusing a short one or one with spaces", () => {
		expect(VAULT_SECRETS).toContain("HARBOUR_CPA_API_KEY");
		expect(vaultSecrets({ HARBOUR_CPA_API_KEY: CPA_KEY })).toEqual({ HARBOUR_CPA_API_KEY: CPA_KEY });
		expect(() => vaultSecrets({ HARBOUR_CPA_API_KEY: "short" })).toThrow(/HARBOUR_CPA_API_KEY/);
		expect(() => vaultSecrets({ HARBOUR_CPA_API_KEY: "has a space in a long key" })).toThrow(/HARBOUR_CPA_API_KEY/);
	});
});
