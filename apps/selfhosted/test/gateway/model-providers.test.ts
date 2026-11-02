// Model providers (TASK-4602): an organisation connecting its own inference at run time, as the console's onboarding
// does. Each of the four providers is tested against the fake upstream (`@kantel/testing/models`) at its real address
// shape: the connection test reads the provider's model list with the key; a saved connection is an organisation
// connector whose key is in the vault and never in an answer; the default model is the organisation's `default` route,
// which the `assistant` profile names, so a session's call reaches the provider through the model gateway.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CallContext,
	MODEL_PROVIDER_PRESETS,
	type ModelProviderInput,
	systemContext,
	type UsageRecord,
} from "@kantel/contracts";
import type { SqlDriver } from "@kantel/sql";
import { pgliteDatabase } from "@kantel/sql/testing";
import { createFakeModelUpstream } from "@kantel/testing/models";
import { afterEach, describe, expect, it } from "vitest";
import {
	ASSISTANT_PROFILE,
	bootstrap,
	createGatewayComponents,
	type GatewayComponents,
	putAssistantProfile,
} from "../../src/gateway/components.ts";
import { vaultCipherKeyOf } from "../../src/gateway/main.ts";
import {
	createMemoryModelProviderStore,
	createModelProviders,
	createModelProvidersApi,
	createSqlModelProviderStore,
	migrateModelProviders,
	providerBaseUrl,
} from "../../src/gateway/model-providers.ts";
import { modelGatewaySource, NO_PLATFORM_MODELS } from "../../src/gateway/models.ts";

const KEY = "sk-provider-key-for-tests-0123456789";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const opened: GatewayComponents[] = [];
afterEach(async () => {
	for (const components of opened.splice(0)) await components.close();
});

/** Each provider as the console sends it, and where its model list is. */
const PROVIDERS: readonly { readonly input: ModelProviderInput; readonly list: string; readonly model: string }[] = [
	{
		input: { provider: "cliproxyapi", baseUrl: "http://cpa.test:8317/v1", apiKey: KEY },
		list: "http://cpa.test:8317/v1/models",
		model: "claude-sonnet-4-5",
	},
	{
		input: { provider: "litellm", baseUrl: "http://litellm.test:4000/v1", apiKey: KEY },
		list: "http://litellm.test:4000/model/info",
		model: "gpt-5",
	},
	{
		input: { provider: "openrouter", apiKey: KEY },
		list: "https://openrouter.ai/api/v1/models",
		model: "openai/gpt-5",
	},
	{
		input: { provider: "cloudflare-ai-gateway", accountId: ACCOUNT, gatewayId: "kantel", apiKey: KEY },
		list: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/kantel/compat/models`,
		model: "openai/gpt-5",
	},
];

async function setUp() {
	const upstream = createFakeModelUpstream({
		models: [
			{ id: "gpt-5", contextWindow: 400_000, maxTokens: 128_000 },
			{ id: "claude-sonnet-4-5", contextWindow: 1_000_000, maxTokens: 64_000 },
			{ id: "openai/gpt-5", name: "OpenAI: GPT-5", contextWindow: 400_000, maxTokens: 128_000 },
		],
	});
	const source = modelGatewaySource(NO_PLATFORM_MODELS, { upstream: (input, init) => upstream.fetch(input, init) });
	const rows: UsageRecord[] = [];
	const modelGateway = {
		...source,
		build: (deps: Parameters<typeof source.build>[0]) =>
			source.build({ ...deps, usage: { record: async (row: UsageRecord) => void rows.push(row) } }),
	};
	const components = createGatewayComponents({ modelGateway });
	opened.push(components);
	const seeded = await bootstrap(components, { organisation: "Lleverage", project: "workflows" });
	await source.seed(components.vault);
	const providers = components.modelProviders!;
	await providers.restore();
	providers.onDefault(async (organisationId) => {
		if (organisationId === seeded.organisationId) {
			await putAssistantProfile(components, seeded.organisationId, seeded.projectId);
		}
	});
	const system = { ...systemContext("model-providers-test"), organisationId: seeded.organisationId };
	// The bootstrap's key is a project operator's; connecting inference is an organisation admin's, as in the console.
	const key = await components.identity.authenticateApiKey(system, seeded.apiKey);
	const operator: CallContext = { actor: key.actor, organisationId: seeded.organisationId };
	const tom = await components.identity.createUser(system, { name: "Tom", email: "tom@kantel.example.com" });
	await components.identity.grantRole(system, { principal: { kind: "user", userId: tom.id }, role: "admin" });
	const admin: CallContext = { actor: { kind: "human", userId: tom.id }, organisationId: seeded.organisationId };
	let caller = admin;
	const api = createModelProvidersApi({ providers, authenticate: async () => caller });
	const as = (who: "admin" | "operator") => {
		caller = who === "admin" ? admin : { ...operator, projectId: seeded.projectId };
	};
	const call = async (method: string, path: string, body?: unknown) => {
		const response = await api(
			new Request(`http://gateway.test${path}`, {
				method,
				...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
			}),
		);
		const text = await response.text();
		return { status: response.status, text, body: text === "" ? undefined : JSON.parse(text) };
	};
	const ask = async (text: string) => {
		const inProject = { ...operator, projectId: seeded.projectId };
		const { runtime } = components.runtime;
		const session = await runtime.create(inProject, {
			projectId: seeded.projectId,
			agentId: ASSISTANT_PROFILE,
			title: "Provider",
		});
		const prompt = await runtime.prompt(inProject, session.id, { text });
		return { session, result: await runtime.wait(inProject, session.id, prompt.id) };
	};
	return { components, seeded, providers, upstream, call, admin, as, ask, rows };
}

describe("a fresh gateway with no platform connector", () => {
	it("isn't configured, has no assistant profile yet, and the admin may connect a provider", async () => {
		const { components, seeded, call } = await setUp();
		const state = await call("GET", "/v1/model-providers");
		expect(state.body).toEqual({ configured: false, canManage: true, connections: [] });
		const inProject = { ...systemContext("test"), organisationId: seeded.organisationId, projectId: seeded.projectId };
		await expect(components.runtime.profiles.get(inProject, ASSISTANT_PROFILE)).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(components.runtime.profiles.get(inProject, "echo")).resolves.toMatchObject({ id: "echo" });
	});

	it("lets a project operator see the state but not test or connect", async () => {
		const { call, as } = await setUp();
		as("operator");
		const state = await call("GET", "/v1/model-providers");
		expect(state.body).toEqual({ configured: false, canManage: false, connections: [] });
		const tested = await call("POST", "/v1/model-providers/test", PROVIDERS[2]!.input);
		expect(tested.body.error).toMatchObject({ code: "forbidden" });
		const saved = await call("PUT", "/v1/model-providers/connections/openrouter", PROVIDERS[2]!.input);
		expect(saved.body.error).toMatchObject({ code: "forbidden" });
	});
});

describe("testing a connection", () => {
	for (const { input, list } of PROVIDERS) {
		it(`${MODEL_PROVIDER_PRESETS[input.provider].label} lists its models with the key`, async () => {
			const { upstream, call } = await setUp();
			const tested = await call("POST", "/v1/model-providers/test", input);
			expect(tested.status).toBe(200);
			expect(tested.body.items.map((model: { id: string }) => model.id)).toEqual([
				"claude-sonnet-4-5",
				"gpt-5",
				"openai/gpt-5",
			]);
			const read = upstream.requests.at(-1)!;
			expect(read.url).toBe(list);
			expect(read.headers.authorization).toBe(`Bearer ${KEY}`);
			expect(tested.text).not.toContain(KEY);
		});
	}

	it("says the provider refused the key, without the key", async () => {
		const { call } = await setUp();
		const refusing = createModelProviders({
			store: createMemoryModelProviderStore(),
			// An admin, as far as `test` asks.
			access: () => ({ require: async () => ({ role: "admin" }) }) as never,
			vault: () => undefined,
			gateway: {
				directory: async () => {
					throw new Error("unused");
				},
				modelGateway: async () => {
					throw new Error("unused");
				},
				allowOrigin: () => {},
				fetch: async () => new Response('{"error":"bad key sk-provider"}', { status: 401 }),
			},
		});
		await expect(
			refusing.test({ ...systemContext("t"), organisationId: "org_1" }, { provider: "openrouter", apiKey: KEY }),
		).rejects.toMatchObject({ code: "refused", message: "The provider refused the key (401)" });
		// No key, no saved connection: nothing to test with.
		const none = await call("POST", "/v1/model-providers/test", { provider: "openrouter" });
		expect(none.body.error).toMatchObject({ code: "invalid" });
	});

	it("checks the base URL and the Cloudflare IDs", () => {
		expect(() => providerBaseUrl({ provider: "litellm", baseUrl: "ftp://litellm.test" })).toThrow(/http or https/);
		expect(() => providerBaseUrl({ provider: "litellm", baseUrl: "http://user:pw@litellm.test" })).toThrow(
			/no credentials/,
		);
		expect(() => providerBaseUrl({ provider: "cloudflare-ai-gateway", accountId: "../x" })).toThrow(/account ID/);
		expect(providerBaseUrl({ provider: "cloudflare-ai-gateway", accountId: ACCOUNT })).toEqual({
			baseUrl: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/default/compat`,
			accountId: ACCOUNT,
			gatewayId: "default",
		});
		// OpenRouter's address is fixed, whatever is sent.
		expect(providerBaseUrl({ provider: "openrouter", baseUrl: "http://elsewhere.test" }).baseUrl).toBe(
			"https://openrouter.ai/api/v1",
		);
	});
});

describe("connecting a provider and choosing the default model", () => {
	for (const { input, model } of PROVIDERS) {
		it(`sessions call ${MODEL_PROVIDER_PRESETS[input.provider].label} through the gateway with the vault's key`, async () => {
			const { components, seeded, upstream, call, ask, rows, admin } = await setUp();
			const id = input.provider;
			const saved = await call("PUT", `/v1/model-providers/connections/${id}`, input);
			expect(saved.status).toBe(200);
			// No asymmetric matcher here: Bun's toMatchObject writes `expect.any` over the field it matched, and the vault
			// item ID is read again below.
			expect(saved.body).toMatchObject({ id, provider: input.provider });
			expect(typeof saved.body.vaultItemId).toBe("string");
			expect(saved.text).not.toContain(KEY);
			// The key is in the vault, as an organisation item bound to the provider's host.
			const item = await components.vault!.getItem(admin, saved.body.vaultItemId);
			expect(item).toMatchObject({
				owner: { kind: "organisation", organisationId: seeded.organisationId },
				hosts: [new URL(saved.body.baseUrl).hostname],
			});
			expect(JSON.stringify(item)).not.toContain(KEY);

			const chosen = await call("PUT", "/v1/model-providers/default", { connectionId: id, modelId: model });
			expect(chosen.body).toMatchObject({ connectionId: id, modelId: model });
			const state = await call("GET", "/v1/model-providers");
			expect(state.body).toMatchObject({ configured: true, default: { connectionId: id, modelId: model } });
			expect(state.text).not.toContain(KEY);

			// The saved connection lists its models with the key from the vault.
			const listed = await call("GET", `/v1/model-providers/connections/${id}/models`);
			expect(listed.body.items.length).toBe(3);

			upstream.next({ text: "Hello from the provider." });
			const { session, result } = await ask("ping");
			expect(result).toMatchObject({ answer: "Hello from the provider." });
			const sent = upstream.calls().at(-1)!;
			expect(sent.headers.authorization ?? sent.headers["x-api-key"]).toContain(KEY);
			expect(new URL(sent.url).origin).toBe(new URL(saved.body.baseUrl).origin);
			expect(rows.at(-1)).toMatchObject({
				organisationId: seeded.organisationId,
				sessionId: session.id,
				route: "default",
				modelId: model,
				connectorId: id,
				connectorPreset: MODEL_PROVIDER_PRESETS[input.provider].connectorPreset,
			});
		});
	}

	it("keeps the saved key on an edit to the same host, and asks for it again on another host", async () => {
		const { call } = await setUp();
		const first = await call("PUT", "/v1/model-providers/connections/litellm", PROVIDERS[1]!.input);
		const { apiKey: _key, ...withoutKey } = PROVIDERS[1]!.input;
		const kept = await call("PUT", "/v1/model-providers/connections/litellm", {
			...withoutKey,
			baseUrl: "http://litellm.test:4000/v1/",
		});
		expect(kept.body.vaultItemId).toBe(first.body.vaultItemId);
		const moved = await call("PUT", "/v1/model-providers/connections/litellm", {
			...withoutKey,
			baseUrl: "http://other.test:4000/v1",
		});
		expect(moved.body.error).toMatchObject({ code: "invalid", message: expect.stringMatching(/enter the key again/) });
		// A test of the saved connection uses its key, without sending it.
		const tested = await call("POST", "/v1/model-providers/test", { ...withoutKey, connectionId: "litellm" });
		expect(tested.status).toBe(200);
	});

	it("removing the default's connection leaves the organisation unconfigured", async () => {
		const { call } = await setUp();
		await call("PUT", "/v1/model-providers/connections/openrouter", PROVIDERS[2]!.input);
		await call("PUT", "/v1/model-providers/default", { connectionId: "openrouter", modelId: "openai/gpt-5" });
		const removed = await call("DELETE", "/v1/model-providers/connections/openrouter");
		expect(removed.status).toBe(204);
		const state = await call("GET", "/v1/model-providers");
		expect(state.body).toEqual({ configured: false, canManage: true, connections: [] });
		const missing = await call("PUT", "/v1/model-providers/default", { connectionId: "openrouter", modelId: "x" });
		expect(missing.body.error).toMatchObject({ code: "not_found" });
	});

	it("refuses a bad ID, a model ID with a colon, and a key that's too short", async () => {
		const { call } = await setUp();
		expect((await call("PUT", "/v1/model-providers/connections/Bad_ID", PROVIDERS[2]!.input)).body.error.code).toBe(
			"invalid",
		);
		expect(
			(await call("PUT", "/v1/model-providers/connections/openrouter", { provider: "openrouter", apiKey: "short" }))
				.body.error.code,
		).toBe("invalid");
		await call("PUT", "/v1/model-providers/connections/openrouter", PROVIDERS[2]!.input);
		expect(
			(await call("PUT", "/v1/model-providers/default", { connectionId: "openrouter", modelId: "default:x" })).body
				.error.code,
		).toBe("invalid");
	});
});

describe("the vault's key file", () => {
	it("is written once with a random key, readable by its user only, and read back", () => {
		const dir = mkdtempSync(join(tmpdir(), "kantel-vault-key-"));
		try {
			const file = join(dir, "state", "vault-cipher.key");
			const first = vaultCipherKeyOf({ KANTEL_VAULT_CIPHER_KEY_FILE: file });
			expect(Buffer.from(first, "base64")).toHaveLength(32);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(vaultCipherKeyOf({ KANTEL_VAULT_CIPHER_KEY_FILE: file })).toBe(first);
			// The variable wins; neither, no vault.
			expect(vaultCipherKeyOf({ KANTEL_VAULT_CIPHER_KEY: "given", KANTEL_VAULT_CIPHER_KEY_FILE: file })).toBe("given");
			expect(vaultCipherKeyOf({})).toBe("");
			writeFileSync(file, "short\n");
			expect(() => vaultCipherKeyOf({ KANTEL_VAULT_CIPHER_KEY_FILE: file })).toThrow(/base64 256-bit key/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the SQL store", () => {
	// PGlite stands in for Postgres: Bun runs this file in CI's self-hosted job, and Bun has no node:sqlite.
	it("keeps connections and defaults, and a restart puts them back in the gateway", async () => {
		const database = await pgliteDatabase.open();
		try {
			await keepsConnectionsAndDefaults(database.driver);
		} finally {
			await database.close();
		}
		// PGlite takes a few seconds to start, close to Bun's 5 s default.
	}, 30_000);
});

async function keepsConnectionsAndDefaults(driver: SqlDriver): Promise<void> {
	await migrateModelProviders(driver);
	await migrateModelProviders(driver);
	const store = createSqlModelProviderStore(driver);
	const connection = {
		id: "openrouter",
		provider: "openrouter" as const,
		baseUrl: "https://openrouter.ai/api/v1",
		vaultItemId: "vi_1",
		createdAt: "2026-11-02T00:00:00.000Z",
		updatedAt: "2026-11-02T00:00:00.000Z",
	};
	const connector = {
		id: "openrouter",
		owner: { kind: "organisation" as const, organisationId: "org_1" },
		preset: "openrouter" as const,
		baseUrl: connection.baseUrl,
		vaultItemId: "vi_1",
		catalogue: { refresh: "gateway" as const },
	};
	await store.put({ organisationId: "org_1", connection, connector });
	await store.putDefault("org_1", { connectionId: "openrouter", modelId: "openai/gpt-5" });
	expect(await store.list("org_1")).toEqual([{ organisationId: "org_1", connection, connector }]);
	expect(await store.list("org_2")).toEqual([]);
	expect(await store.defaults()).toEqual([
		{ organisationId: "org_1", value: { connectionId: "openrouter", modelId: "openai/gpt-5" } },
	]);

	const put: unknown[] = [];
	const routes: unknown[] = [];
	const allowed: string[] = [];
	const restarted = createModelProviders({
		store,
		access: () => {
			throw new Error("unused");
		},
		vault: () => undefined,
		gateway: {
			directory: async () =>
				({
					putConnector: async (_ctx: unknown, input: unknown) => void put.push(input),
					putRoute: async (_ctx: unknown, input: unknown) => void routes.push(input),
				}) as never,
			modelGateway: async () => {
				throw new Error("unused");
			},
			allowOrigin: (url) => void allowed.push(url),
		},
	});
	await restarted.restore();
	expect(put).toEqual([connector]);
	expect(routes).toEqual([
		{
			name: "default",
			owner: { kind: "organisation", organisationId: "org_1" },
			connectorId: "openrouter",
			modelId: "openai/gpt-5",
		},
	]);
	expect(allowed).toEqual([connection.baseUrl]);
	expect(await restarted.configured("org_1")).toBe(true);
	expect(await restarted.configured("org_2")).toBe(false);

	await store.remove("org_1", "openrouter");
	await store.removeDefault("org_1");
	expect(await store.list()).toEqual([]);
	expect(await store.getDefault("org_1")).toBeUndefined();
}
