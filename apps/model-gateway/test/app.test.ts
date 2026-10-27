import { HarbourError, type ModelStreamEvent, systemContext } from "@harbour/contracts";
import { createHmacSessionTokens } from "@harbour/models/tokens";
import { actors, contextFor, createDeps } from "@harbour/testing/harness";
import { createFakeModelUpstream } from "@harbour/testing/models";
import { createMemoryVault } from "@harbour/vault/memory";
import { describe, expect, it } from "vitest";
import { createModelGatewayApp, type ModelGatewayConfig, parseModelGatewayConfig } from "../src/app.ts";
import worker, { type ModelGatewayWorkerEnv } from "../src/worker.ts";
import { TOKEN_KEY, withNodeStack } from "./support.ts";

const ORG = "org-a";
const OPERATOR = contextFor(actors.system("operator"), ORG);
const KEY = "sk-cpa-app-test-5a0c9e1f";
const scope = { organisationId: ORG, projectId: "proj-a", agentId: "agent-1", sessionId: "sess-app-1" };

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
	const out: ModelStreamEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

const config = (vaultItemId: string): ModelGatewayConfig => ({
	baseUrl: "http://model-gateway.internal:8080",
	basePath: "/models",
	connectors: [
		{
			id: "cpa",
			owner: { kind: "platform" },
			preset: "cliproxyapi",
			baseUrl: "http://cpa.internal:8317/v1",
			vaultItemId,
			catalogue: { refresh: "static", include: ["claude-sonnet-4-5", "gpt-5"] },
		},
	],
	routes: [{ name: "default", owner: { kind: "platform" }, connectorId: "cpa", modelId: "claude-sonnet-4-5" }],
});

describe("createModelGatewayApp", () => {
	it("reads the connector's key from the vault's egress decision API over HTTP", async () => {
		const deps = createDeps();
		await withNodeStack(deps, createFakeModelUpstream(), async ({ app, credentials, upstream, connectors }) => {
			const item = await credentials.putItem(OPERATOR, {
				owner: { kind: "platform" },
				name: "CPA",
				hosts: ["cpa.internal"],
				injection: { header: "Authorization", template: "Bearer {key}" },
				value: KEY,
			});
			for (const connector of config(item.id).connectors) await connectors.putConnector(OPERATOR, connector);
			for (const route of config(item.id).routes) await connectors.putRoute(OPERATOR, route);
			const request = {
				model: "default",
				context: { messages: [{ role: "user" as const, content: "Hi", timestamp: 1 }] },
			};

			const events = await collect(await app.gateway.messages(scope, request));
			expect(events.at(-1)).toMatchObject({ type: "done" });
			expect(upstream.calls().at(-1)?.headers["x-api-key"]).toBe(KEY);
			await collect(await app.gateway.messages(scope, request));
			// Read once and cached: one use recorded for two calls.
			const uses = await credentials.listUses(OPERATOR, {});
			expect(uses.items).toHaveLength(1);
			console.log(JSON.stringify(deps.audit.ofType("vault.use.injected")[0]));
			expect(uses.items[0]).toMatchObject({ outcome: "injected", host: "cpa.internal" });
			expect(deps.audit.ofType("vault.use.injected")[0]).toMatchObject({
				sessionId: scope.sessionId,
				data: { connectorId: "cpa" },
			});
		});
	});

	it("loads its connectors and routes from config and answers health checks", async () => {
		const deps = createDeps();
		const vault = createMemoryVault({ clock: deps.clock, audit: deps.audit });
		const item = await vault.putItem(OPERATOR, {
			owner: { kind: "platform" },
			name: "CPA",
			hosts: ["cpa.internal"],
			injection: { header: "Authorization", template: "Bearer {key}" },
			value: KEY,
		});
		const app = await createModelGatewayApp({
			config: config(item.id),
			tokenKey: TOKEN_KEY,
			credentials: vault,
			audit: deps.audit,
			clock: deps.clock,
		});
		const health = await app.handler(new Request("http://g/healthz"));
		expect(health.status).toBe(200);
		const token = (await app.tokens.mint(systemContext("session-runtime"), scope)).token;
		const response = await app.handler(
			new Request("http://g/models/v1/config", { headers: { authorization: `Bearer ${token}` } }),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { baseUrl: string; models: { id: string }[] };
		expect(body.baseUrl).toBe("http://model-gateway.internal:8080");
		expect(body.models.map((model) => model.id)).toEqual(["default", "default:gpt-5"]);
		expect(deps.audit.ofType("models.connector.put")[0]?.actor).toEqual({
			kind: "system",
			component: "model-gateway.config",
		});
	});

	it("refuses a config of the wrong shape, or one the directory rejects", async () => {
		const invalid = (value: unknown) => {
			try {
				parseModelGatewayConfig(value);
				return undefined;
			} catch (error) {
				return error instanceof HarbourError ? error.code : String(error);
			}
		};
		expect(invalid(undefined)).toBe("invalid");
		expect(invalid({ baseUrl: "http://g", connectors: [] })).toBe("invalid");
		expect(invalid({ baseUrl: "not a url", connectors: [], routes: [] })).toBe("invalid");
		expect(invalid({ baseUrl: "ftp://g", connectors: [], routes: [] })).toBe("invalid");
		expect(invalid({ baseUrl: "http://g", connectors: [3], routes: [] })).toBe("invalid");
		expect(invalid({ baseUrl: "http://g", connectors: [], routes: [], policies: [] })).toBeUndefined();
		const deps = createDeps();
		const build = createModelGatewayApp({
			config: { ...config("item"), routes: [{ ...config("item").routes[0]!, connectorId: "missing" }] },
			tokenKey: TOKEN_KEY,
			credentials: createMemoryVault(),
			audit: deps.audit,
		});
		await expect(build).rejects.toMatchObject({ code: "refused" });
	});
});

describe("the Worker entry", () => {
	const env = (overrides: Partial<ModelGatewayWorkerEnv> = {}): ModelGatewayWorkerEnv => ({
		HARBOUR_MODEL_GATEWAY_CONFIG: JSON.stringify(config("item-cpa")),
		HARBOUR_MODEL_TOKEN_KEY: TOKEN_KEY,
		HARBOUR_VAULT_URL: "http://vault.internal",
		HARBOUR_VAULT_TOKEN: "vault-shared-key-0123456789",
		...overrides,
	});

	it("is unavailable until its config parses, then serves the model API", async () => {
		const failing = await worker.fetch(new Request("http://g/healthz"), env({ HARBOUR_MODEL_GATEWAY_CONFIG: "{" }));
		expect(failing.status).toBe(503);
		// The Worker reads the system clock, so the session runtime's tokens do too.
		const tokens = createHmacSessionTokens({ key: TOKEN_KEY });
		const token = (await tokens.mint(systemContext("session-runtime"), scope)).token;
		const response = await worker.fetch(
			new Request("http://g/models/v1/config", { headers: { authorization: `Bearer ${token}` } }),
			env(),
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { models: unknown[] }).models).toHaveLength(2);
	});
});
