// Platform model connectors from the deployment's config (`KANTEL_MODEL_CONNECTORS`): parsing, CPA staying the
// default with no config change, and sessions on a LiteLLM connector, its upstream faked at an in-cluster address.
import { type CallContext, systemContext, type UsageRecord } from "@kantel/contracts";
import { createFakeModelUpstream, DEFAULT_FAKE_SCRIPT } from "@kantel/testing/models";
import { afterEach, describe, expect, it } from "vitest";
import {
	ASSISTANT_PROFILE,
	bootstrap,
	createGatewayComponents,
	type GatewayComponents,
} from "../../src/gateway/components.ts";
import { gatewayConfig } from "../../src/gateway/main.ts";
import {
	CPA_CONNECTOR_ID,
	type CpaConfig,
	connectorItemName,
	connectorsOnly,
	cpaItemName,
	cpaModels,
	describeConnectorProbe,
	modelConnectorsConfig,
	modelGatewayConfig,
	modelGatewaySource,
	platformModels,
	probeConnector,
} from "../../src/gateway/models.ts";

const CPA_KEY = "cpa-client-key-for-tests-0123";
const MODEL = "claude-sonnet-4-5";
const CPA: CpaConfig = { baseUrl: "http://cpa.test:8317/v1", apiKey: CPA_KEY, modelId: MODEL };

const LITELLM_URL = "http://litellm.litellm.svc.cluster.local/v1";
const LITELLM_KEY = "sk-litellm-platform-key-0123456789";
const LITELLM_CONNECTORS = JSON.stringify({
	connectors: [
		{ id: "lleverage-litellm", preset: "litellm", baseUrl: LITELLM_URL, apiKeyEnv: "KANTEL_LITELLM_API_KEY" },
	],
	routes: [
		{ name: "default", connectorId: "lleverage-litellm", modelId: "gpt-5" },
		{ name: "claude", connectorId: "lleverage-litellm", modelId: "claude-sonnet-4-5", thinking: "high" },
	],
});
const LITELLM_ENV = { KANTEL_MODEL_CONNECTORS: LITELLM_CONNECTORS, KANTEL_LITELLM_API_KEY: LITELLM_KEY };

const opened: GatewayComponents[] = [];
afterEach(async () => {
	for (const components of opened.splice(0)) await components.close();
});

describe("CPA stays the default", () => {
	it("with only the CPA variables, the deployment has the one CPA connector and route it always had", async () => {
		const env = {
			KANTEL_CPA_URL: "http://cpa.test:8317/v1",
			KANTEL_CPA_API_KEY: CPA_KEY,
			KANTEL_DEFAULT_MODEL: MODEL,
		};
		const models = platformModels(env);
		expect(models).toEqual(cpaModels(CPA));
		expect(platformModels({})).toBeUndefined();
		// The connector and route the gateway loads, exactly as before connectors could be configured.
		expect(modelGatewayConfig(models!, { [CPA_CONNECTOR_ID]: "item-1" })).toEqual({
			baseUrl: "http://model-gateway.harbour.internal",
			connectors: [
				{
					id: "sal-cliproxyapi",
					owner: { kind: "platform" },
					preset: "cliproxyapi",
					baseUrl: "http://cpa.test:8317/v1",
					vaultItemId: "item-1",
					catalogue: { refresh: "gateway" },
				},
			],
			routes: [{ name: "default", owner: { kind: "platform" }, connectorId: "sal-cliproxyapi", modelId: MODEL }],
		});
		// The same item name as before, so an existing deployment keeps its item.
		expect(await connectorItemName(models!.connectors[0]!)).toBe(await cpaItemName(CPA_KEY));
	});
});

describe("the connectors config", () => {
	it("reads connectors of any preset with their keys from the variables they name", () => {
		expect(modelConnectorsConfig({})).toBeUndefined();
		expect(modelConnectorsConfig(LITELLM_ENV)).toEqual({
			connectors: [
				{
					id: "lleverage-litellm",
					preset: "litellm",
					baseUrl: LITELLM_URL,
					apiKey: LITELLM_KEY,
					keyVariable: "KANTEL_LITELLM_API_KEY",
					itemPrefix: "lleverage-litellm",
					catalogue: { refresh: "gateway" },
				},
			],
			routes: [
				{ name: "default", connectorId: "lleverage-litellm", modelId: "gpt-5" },
				{ name: "claude", connectorId: "lleverage-litellm", modelId: "claude-sonnet-4-5", thinking: "high" },
			],
			routesFrom: "config",
		});
	});

	it("reads the same JSON from a file, such as a mounted ConfigMap", () => {
		const read: string[] = [];
		const models = modelConnectorsConfig(
			{ KANTEL_MODEL_CONNECTORS_FILE: "/etc/kantel/connectors.json", KANTEL_LITELLM_API_KEY: LITELLM_KEY },
			(path) => {
				read.push(path);
				return LITELLM_CONNECTORS;
			},
		);
		expect(read).toEqual(["/etc/kantel/connectors.json"]);
		expect(models?.connectors.map((connector) => connector.id)).toEqual(["lleverage-litellm"]);
		expect(() =>
			modelConnectorsConfig({ ...LITELLM_ENV, KANTEL_MODEL_CONNECTORS_FILE: "/etc/kantel/connectors.json" }),
		).toThrow(/not both/);
		expect(() =>
			modelConnectorsConfig({ KANTEL_MODEL_CONNECTORS_FILE: "/nope.json" }, () => {
				throw new Error("ENOENT");
			}),
		).toThrow(/Could not read.*ENOENT/);
	});

	it("without routes, serves KANTEL_DEFAULT_MODEL on the first connector as default; keeps catalogue and compat", () => {
		const config = {
			connectors: [
				{
					id: "platform-openrouter",
					preset: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
					apiKeyEnv: "OPENROUTER_KEY",
					catalogue: { include: ["anthropic/claude-sonnet-4.5"] },
					compat: { openRouterRouting: { only: ["anthropic"] } },
				},
			],
		};
		const models = modelConnectorsConfig({
			KANTEL_MODEL_CONNECTORS: JSON.stringify(config),
			OPENROUTER_KEY: "sk-or-0123456789abcdef",
			KANTEL_DEFAULT_MODEL: "anthropic/claude-sonnet-4.5",
		});
		expect(models?.routes).toEqual([
			{ name: "default", connectorId: "platform-openrouter", modelId: "anthropic/claude-sonnet-4.5" },
		]);
		expect(models?.routesFrom).toBe("default-model");
		expect(models?.connectors[0]).toMatchObject({
			catalogue: { refresh: "gateway", include: ["anthropic/claude-sonnet-4.5"] },
			compat: { openRouterRouting: { only: ["anthropic"] } },
		});
	});

	it("refuses a missing or short key, naming the variable and never the value", () => {
		expect(() => modelConnectorsConfig({ KANTEL_MODEL_CONNECTORS: LITELLM_CONNECTORS })).toThrow(
			"KANTEL_LITELLM_API_KEY, connector lleverage-litellm's key, is not set",
		);
		expect(() => modelConnectorsConfig({ ...LITELLM_ENV, KANTEL_LITELLM_API_KEY: "  " })).toThrow(/is not set/);
		expect(() => modelConnectorsConfig({ ...LITELLM_ENV, KANTEL_LITELLM_API_KEY: "sk-short" })).toThrow(
			/KANTEL_LITELLM_API_KEY must be at least 16 characters/,
		);
		const noVariable = JSON.stringify({ connectors: [{ id: "a", preset: "litellm", baseUrl: LITELLM_URL }] });
		expect(() => modelConnectorsConfig({ KANTEL_MODEL_CONNECTORS: noVariable })).toThrow(/apiKeyEnv/);
	});

	it("refuses an unknown preset, listing the presets", () => {
		const config = JSON.stringify({
			connectors: [{ id: "x", preset: "bedrock", baseUrl: LITELLM_URL, apiKeyEnv: "KANTEL_LITELLM_API_KEY" }],
		});
		expect(() => modelConnectorsConfig({ ...LITELLM_ENV, KANTEL_MODEL_CONNECTORS: config })).toThrow(
			/connector x has an unknown preset "bedrock": use one of litellm, .*anthropic-compatible/,
		);
	});

	it("refuses bad JSON, bad IDs and URLs, duplicates, stray routes and routes without default", () => {
		const env = (value: unknown) => ({
			KANTEL_LITELLM_API_KEY: LITELLM_KEY,
			KANTEL_MODEL_CONNECTORS: typeof value === "string" ? value : JSON.stringify(value),
		});
		const connector = { id: "a", preset: "litellm", baseUrl: LITELLM_URL, apiKeyEnv: "KANTEL_LITELLM_API_KEY" };
		const route = { name: "default", connectorId: "a", modelId: "gpt-5" };
		const withRoutes = (...routes: unknown[]) => env({ connectors: [connector], routes });
		expect(() => modelConnectorsConfig(env("{nope"))).toThrow(/must be JSON/);
		expect(() => modelConnectorsConfig(env({ connectors: [] }))).toThrow(/non-empty "connectors"/);
		expect(() => modelConnectorsConfig(env({ connectors: [{ ...connector, id: "Has Spaces" }] }))).toThrow(/"id"/);
		expect(() => modelConnectorsConfig(env({ connectors: [{ ...connector, baseUrl: "ftp://x/v1" }] }))).toThrow(/http/);
		expect(() => modelConnectorsConfig(env({ connectors: [connector, connector] }))).toThrow(/listed twice/);
		expect(() => modelConnectorsConfig(withRoutes({ ...route, connectorId: "b" }))).toThrow(/isn't listed/);
		expect(() => modelConnectorsConfig(withRoutes({ ...route, name: "deep" }))).toThrow(/route named default/);
		expect(() => modelConnectorsConfig(withRoutes(route, { ...route, name: "echo" }))).toThrow(/echo model's/);
		expect(() => modelConnectorsConfig(withRoutes(route, route))).toThrow(/listed twice/);
		expect(() => modelConnectorsConfig(withRoutes({ ...route, modelId: "a:b" }))).toThrow(/one model ID/);
		expect(() => modelConnectorsConfig(withRoutes({ ...route, thinking: "lots" }))).toThrow(/thinking/);
	});

	it("doesn't mix with CPA's variables, and a gateway on Postgres needs a vault for its keys", () => {
		expect(() =>
			platformModels({ ...LITELLM_ENV, KANTEL_CPA_URL: "http://cpa.test:8317/v1", KANTEL_CPA_API_KEY: CPA_KEY }),
		).toThrow(/not both/);
		const env = {
			...LITELLM_ENV,
			KANTEL_DATABASE_URL: "postgres://harbour@127.0.0.1/harbour",
			S3_ENDPOINT: "http://127.0.0.1:9000",
			S3_BUCKET: "harbour",
			S3_ACCESS_KEY: "minio",
			S3_SECRET_KEY: "minio-secret",
		};
		expect(() => gatewayConfig(env)).toThrow(
			"KANTEL_LITELLM_API_KEY is kept in the vault: set KANTEL_VAULT_CIPHER_KEY",
		);
		const vaultKey = btoa(String.fromCharCode(...new Uint8Array(32)));
		expect(gatewayConfig({ ...env, KANTEL_VAULT_CIPHER_KEY: vaultKey }).models?.connectors).toMatchObject([
			{ id: "lleverage-litellm", preset: "litellm" },
		]);
	});
});

async function setUpLitellm() {
	const models = platformModels(LITELLM_ENV)!;
	const upstream = createFakeModelUpstream({
		models: [
			{ id: "gpt-5", contextWindow: 400_000, maxTokens: 128_000 },
			{ id: "claude-sonnet-4-5", contextWindow: 1_000_000, maxTokens: 64_000 },
		],
	});
	const source = modelGatewaySource(models, { upstream: (input, init) => upstream.fetch(input, init) });
	// The usage rows the gateway writes, as the Postgres ledger would take them.
	const rows: UsageRecord[] = [];
	const modelGateway = {
		...source,
		build: (deps: Parameters<typeof source.build>[0]) =>
			source.build({
				...deps,
				usage: {
					record: async (row: UsageRecord) => {
						rows.push(row);
					},
				},
			}),
	};
	const components = createGatewayComponents({ modelGateway });
	opened.push(components);
	const seeded = await bootstrap(components, { organisation: "Lleverage", project: "workflows" });
	const items = await source.seed(components.vault);
	const key = await components.identity.authenticateApiKey(
		{ ...systemContext("models-test"), organisationId: seeded.organisationId },
		seeded.apiKey,
	);
	const operator: CallContext = {
		actor: key.actor,
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	const { runtime } = components.runtime;
	const ask = async (text: string, model?: string) => {
		const session = await runtime.create(operator, {
			projectId: seeded.projectId,
			agentId: ASSISTANT_PROFILE,
			title: "LiteLLM",
		});
		const prompt = await runtime.prompt(operator, session.id, { text, ...(model === undefined ? {} : { model }) });
		return { session, result: await runtime.wait(operator, session.id, prompt.id) };
	};
	return { models, components, seeded, operator, upstream, ask, items, rows };
}

describe("sessions on a LiteLLM platform connector", () => {
	it("calls the in-cluster LiteLLM with the one platform key, tagged by organisation and project", async () => {
		const { components, seeded, operator, upstream, ask, items, rows } = await setUpLitellm();
		expect(items["lleverage-litellm"]?.name).toMatch(/^lleverage-litellm-[0-9a-f]{12}$/);

		upstream.next({
			text: "Hello from LiteLLM.",
			usage: { input: 200, output: 30, cacheRead: 50 },
			reportedCost: 0.0042,
		});
		const { session, result } = await ask("ping");
		expect(result).toMatchObject({ answer: "Hello from LiteLLM." });

		// Everything went to LiteLLM's in-cluster address; the call (Chat Completions, for gpt-5) carried the key.
		const origins = new Set(upstream.requests.map((request) => new URL(request.url).origin));
		expect([...origins]).toEqual(["http://litellm.litellm.svc.cluster.local"]);
		const call = upstream.calls().at(-1)!;
		expect(call.kind).toBe("openai-completions");
		expect(call.headers.authorization).toBe(`Bearer ${LITELLM_KEY}`);

		// The organisation and project reach LiteLLM as tags and as metadata, under agent-service's keys.
		expect(call.headers["x-litellm-tags"]!.split(",")).toEqual(
			expect.arrayContaining([`organisation:${seeded.organisationId}`, `project:${seeded.projectId}`]),
		);
		expect(JSON.parse(call.headers["x-litellm-spend-logs-metadata"]!)).toMatchObject({
			organisation_id: seeded.organisationId,
			project_id: seeded.projectId,
			session_id: session.id,
		});
		expect(call.body).toMatchObject({
			model: "gpt-5",
			metadata: {
				organisation_id: seeded.organisationId,
				project_id: seeded.projectId,
				session_id: session.id,
				tags: expect.arrayContaining([`organisation:${seeded.organisationId}`, `project:${seeded.projectId}`]),
			},
		});

		// The usage row and the `model.call` event name the connector, with LiteLLM's reported cost.
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			organisationId: seeded.organisationId,
			projectId: seeded.projectId,
			sessionId: session.id,
			route: "default",
			modelId: "gpt-5",
			connectorId: "lleverage-litellm",
			connectorPreset: "litellm",
			api: "openai-completions",
			status: "done",
			outputTokens: 30,
			cacheReadTokens: 50,
			costSource: "reported",
			cost: { total: 0.0042 },
		});
		const events = await components.audit.query(operator, {});
		const modelCall = events.items.find((event) => event.type === "model.call");
		expect(JSON.stringify(modelCall)).toContain("lleverage-litellm");
		expect(events.items.map((event) => event.type)).toContain("connections.egress.injected");
		expect(JSON.stringify(events)).not.toContain(LITELLM_KEY);
	});

	it("tags a Claude model's Messages call by organisation and project too", async () => {
		const { seeded, upstream, ask, rows } = await setUpLitellm();
		const { result } = await ask("ping", "claude");
		expect(result).toMatchObject({ answer: DEFAULT_FAKE_SCRIPT.text });
		const call = upstream.calls().at(-1)!;
		expect(call.kind).toBe("anthropic-messages");
		expect(call.headers["x-api-key"]).toBe(LITELLM_KEY);
		expect(call.headers["x-litellm-tags"]).toContain(`project:${seeded.projectId}`);
		expect(JSON.parse(call.headers["x-litellm-spend-logs-metadata"]!)).toMatchObject({
			organisation_id: seeded.organisationId,
			project_id: seeded.projectId,
		});
		expect(rows.at(-1)).toMatchObject({ route: "claude", connectorId: "lleverage-litellm", api: "anthropic-messages" });
	});

	it("reaches only the configured connectors' origins", () => {
		const only = connectorsOnly(platformModels(LITELLM_ENV)!, async () => new Response("ok"));
		return Promise.all([
			expect(only("http://cpa.test:8317/v1/models")).rejects.toMatchObject({ code: "refused" }),
			only(`${LITELLM_URL}/models`).then(async (response) => expect(await response.text()).toBe("ok")),
		]);
	});

	it("the start's check asks LiteLLM's model list with the key and names a missing route's model", async () => {
		const models = platformModels(LITELLM_ENV)!;
		const connector = models.connectors[0]!;
		const seen: Request[] = [];
		const listing = (...ids: string[]) => Response.json({ object: "list", data: ids.map((id) => ({ id })) });
		const ok = await probeConnector(models, connector, async (input, init) => {
			seen.push(new Request(input, init));
			return listing("gpt-5", "claude-sonnet-4-5");
		});
		expect(ok).toEqual({ result: "ok", models: 2 });
		expect(seen[0]!.url).toBe(`${LITELLM_URL}/models`);
		expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${LITELLM_KEY}`);
		const missing = await probeConnector(models, connector, async () => listing("gpt-5"));
		expect(missing).toEqual({ result: "model_missing", models: 1, missing: ["claude-sonnet-4-5"] });
		expect(describeConnectorProbe(models, connector, missing)).toMatch(
			/lleverage-litellm \(litellm\) lists 1 models but not claude-sonnet-4-5, so sessions on route claude fail/,
		);
		const refused = describeConnectorProbe(models, connector, { result: "key_refused", status: 401 });
		expect(refused).toMatch(/refused KANTEL_LITELLM_API_KEY \(HTTP 401\), so sessions on routes default, claude/);
		expect(refused).not.toContain(LITELLM_KEY);
	});
});
