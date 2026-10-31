// Sessions on the model gateway on the self-hosted gateway (#232), as Cloudflare's models.test.ts for #17: the
// in-memory components on `modelGatewaySource`, CPA's key kept in the gateway's vault, and a fake CLIProxyAPI.
import { type CallContext, systemContext } from "@harbour/contracts";
import { CODING_TOOLS } from "@harbour/sandbox/coding-tools";
import { createFakeModelUpstream, DEFAULT_FAKE_SCRIPT } from "@harbour/testing/models";
import { afterEach, describe, expect, it } from "vitest";
import {
	ASSISTANT_PROFILE,
	bootstrap,
	createGatewayComponents,
	type GatewayComponents,
} from "../../src/gateway/components.ts";
import { gatewayConfig } from "../../src/gateway/main.ts";
import {
	type CpaConfig,
	cpaConfig,
	cpaItemName,
	cpaOnly,
	DEFAULT_MODEL,
	describeCpaProbe,
	modelGatewaySource,
	probeCpa,
	seedCpaItem,
} from "../../src/gateway/models.ts";

const CPA_KEY = "cpa-client-key-for-tests-0123";
const MODEL = "claude-sonnet-4-5";
const CPA: CpaConfig = { baseUrl: "http://cpa.test:8317/v1", apiKey: CPA_KEY, modelId: MODEL };

const opened: GatewayComponents[] = [];
afterEach(async () => {
	for (const components of opened.splice(0)) await components.close();
});

async function setUp() {
	const upstream = createFakeModelUpstream({ models: [{ id: MODEL, contextWindow: 1_000_000, maxTokens: 64_000 }] });
	const modelGateway = modelGatewaySource(CPA, { upstream: (input, init) => upstream.fetch(input, init) });
	const components = createGatewayComponents({ modelGateway });
	opened.push(components);
	const seeded = await bootstrap(components, { organisation: "Models", project: "models" });
	// As the gateway's start does, once the components and the bootstrap are ready.
	const cpaItem = await modelGateway.seed(components.vault);
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
	const ask = async (agentId: string, text: string) => {
		const session = await runtime.create(operator, { projectId: seeded.projectId, agentId, title: "Models" });
		const prompt = await runtime.prompt(operator, session.id, { text });
		return runtime.wait(operator, session.id, prompt.id);
	};
	return { components, seeded, operator, upstream, ask, cpaItem };
}

describe("sessions on the model gateway on the self-hosted gateway", () => {
	it("answers from CLIProxyAPI with the vault's key, recording the call and the key's use", async () => {
		const { components, operator, upstream, ask } = await setUp();

		const result = await ask(ASSISTANT_PROFILE, "ping");
		expect(result).toMatchObject({ answer: DEFAULT_FAKE_SCRIPT.text });

		// Every request went to CPA, and the model call (Messages, for a Claude model) carried the vault's key.
		const origins = new Set(upstream.requests.map((request) => new URL(request.url).origin));
		expect([...origins]).toEqual(["http://cpa.test:8317"]);
		const call = upstream.calls().at(-1)!;
		expect(call.kind).toBe("anthropic-messages");
		expect(call.headers["x-api-key"]).toBe(CPA_KEY);
		expect(call.body).toMatchObject({ model: MODEL });

		// The call and the key's use are in the organisation's audit; the key is only in CPA's request.
		const events = await components.audit.query(operator, {});
		expect(events.items.map((event) => event.type)).toEqual(
			expect.arrayContaining(["connections.egress.injected", "model.call"]),
		);
		expect(JSON.stringify(events)).not.toContain(CPA_KEY);
	});

	it("keeps CPA's item while the key is the same, and makes a new one for a new key", async () => {
		const { components, cpaItem } = await setUp();
		expect(cpaItem.name).toBe(await cpaItemName(CPA_KEY));
		expect(await seedCpaItem(components.vault!, CPA, cpaItem)).toEqual(cpaItem);
		const rotated = await seedCpaItem(components.vault!, { ...CPA, apiKey: "cpa-client-key-rotated-4567" }, cpaItem);
		expect(rotated.name).toBe(await cpaItemName("cpa-client-key-rotated-4567"));
		expect(rotated.id).not.toBe(cpaItem.id);
	});

	it("a session waits for the start to seed CPA's item", async () => {
		const upstream = createFakeModelUpstream({ models: [{ id: MODEL }] });
		const modelGateway = modelGatewaySource(CPA, { upstream: (input, init) => upstream.fetch(input, init) });
		const components = createGatewayComponents({ modelGateway });
		opened.push(components);
		const seeded = await bootstrap(components, { organisation: "Late", project: "late" });
		const key = await components.identity.authenticateApiKey(
			{ ...systemContext("models-test"), organisationId: seeded.organisationId },
			seeded.apiKey,
		);
		const operator = { actor: key.actor, organisationId: seeded.organisationId, projectId: seeded.projectId };
		const { runtime } = components.runtime;
		// Opening the session loads its models from the gateway, so it waits too; nothing reaches CPA meanwhile.
		const answered = (async () => {
			const session = await runtime.create(operator, { projectId: seeded.projectId, agentId: ASSISTANT_PROFILE });
			const prompt = await runtime.prompt(operator, session.id, { text: "ping" });
			return runtime.wait(operator, session.id, prompt.id);
		})();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(upstream.calls()).toHaveLength(0);
		await modelGateway.seed(components.vault);
		expect(await answered).toMatchObject({ answer: DEFAULT_FAKE_SCRIPT.text });
	});

	it("refuses to seed without a vault", async () => {
		await expect(modelGatewaySource(CPA).seed(undefined)).rejects.toThrow(/HARBOUR_VAULT_CIPHER_KEY/);
	});

	it("the bootstrap's assistant profile is on the default route with the coding tools; echo stays on echo", async () => {
		const { components, operator, upstream, ask } = await setUp();
		const assistant = await components.runtime.profiles.get(operator, ASSISTANT_PROFILE);
		expect(assistant.model).toEqual({ route: "default" });
		expect(assistant.tools).toEqual([...CODING_TOOLS]);
		expect(components.bindings.runtime).toBe("memory (model gateway)");

		const before = upstream.calls().length;
		expect(await ask("echo", "hello")).toMatchObject({ answer: "Echo: hello" });
		expect(upstream.calls().length).toBe(before);
	});

	it("keeps a prompt the user set on the assistant profile across a bootstrap", async () => {
		const { components, seeded, operator } = await setUp();
		const profile = await components.runtime.profiles.get(operator, ASSISTANT_PROFILE);
		await components.runtime.profiles.put(operator, {
			...profile,
			promptLayers: [{ name: "project", text: "Be brief." }],
		});
		await bootstrap(components, { organisation: "Models", project: "models" }, seeded);
		const after = await components.runtime.profiles.get(operator, ASSISTANT_PROFILE);
		expect(after.promptLayers).toEqual([{ name: "project", text: "Be brief." }]);
	});

	it("on the echo model, the bootstrap makes no assistant profile", async () => {
		const components = createGatewayComponents();
		opened.push(components);
		await bootstrap(components, { organisation: "Echo", project: "echo" });
		expect(components.assistantRoute).toBeUndefined();
		expect(components.bindings.runtime).toBe("memory (echo model)");
	});
});

describe("CPA's configuration", () => {
	it("is off with neither variable, and both go together", () => {
		expect(cpaConfig({})).toBeUndefined();
		expect(() => cpaConfig({ HARBOUR_CPA_URL: "http://127.0.0.1:8317/v1" })).toThrow(/go together/);
		expect(() => cpaConfig({ HARBOUR_CPA_API_KEY: CPA_KEY })).toThrow(/go together/);
	});

	it("takes an http(s) URL, a key of 16 characters or more and one model ID", () => {
		expect(cpaConfig({ HARBOUR_CPA_URL: "http://127.0.0.1:8317/v1/", HARBOUR_CPA_API_KEY: CPA_KEY })).toEqual({
			baseUrl: "http://127.0.0.1:8317/v1",
			apiKey: CPA_KEY,
			modelId: DEFAULT_MODEL,
		});
		const base = { HARBOUR_CPA_URL: "http://127.0.0.1:8317/v1", HARBOUR_CPA_API_KEY: CPA_KEY };
		expect(() => cpaConfig({ ...base, HARBOUR_CPA_URL: "ftp://cpa/v1" })).toThrow(/http/);
		expect(() => cpaConfig({ ...base, HARBOUR_CPA_API_KEY: "short" })).toThrow(/16 characters/);
		expect(() => cpaConfig({ ...base, HARBOUR_DEFAULT_MODEL: "a:b" })).toThrow(/one model ID/);
		expect(cpaConfig({ ...base, HARBOUR_DEFAULT_MODEL: "gpt-5" })?.modelId).toBe("gpt-5");
	});

	it("a gateway on Postgres refuses CPA without a vault", () => {
		const env = {
			HARBOUR_DATABASE_URL: "postgres://harbour@127.0.0.1/harbour",
			S3_ENDPOINT: "http://127.0.0.1:9000",
			S3_BUCKET: "harbour",
			S3_ACCESS_KEY: "minio",
			S3_SECRET_KEY: "minio-secret",
			HARBOUR_CPA_URL: "http://127.0.0.1:8317/v1",
			HARBOUR_CPA_API_KEY: CPA_KEY,
		};
		expect(() => gatewayConfig(env)).toThrow(/HARBOUR_VAULT_CIPHER_KEY/);
		const vaultKey = btoa(String.fromCharCode(...new Uint8Array(32)));
		expect(gatewayConfig({ ...env, HARBOUR_VAULT_CIPHER_KEY: vaultKey }).cpa).toMatchObject({ apiKey: CPA_KEY });
	});

	it("reaches only CPA's origin", async () => {
		const seen: string[] = [];
		const only = cpaOnly(CPA, async (input) => {
			seen.push(new Request(input).url);
			return new Response("ok");
		});
		await expect(only("http://cpa.test:9999/v1/models")).rejects.toMatchObject({ code: "refused" });
		await expect(only("https://example.com/v1/models")).rejects.toMatchObject({ code: "refused" });
		expect(await (await only("http://cpa.test:8317/v1/models")).text()).toBe("ok");
		expect(seen).toEqual(["http://cpa.test:8317/v1/models"]);
	});
});

describe("the start's check of CPA", () => {
	const listing = (...ids: string[]) => Response.json({ object: "list", data: ids.map((id) => ({ id })) });

	it("asks CPA's model list with the key and finds the default route's model", async () => {
		const seen: Request[] = [];
		const probe = await probeCpa(CPA, async (input, init) => {
			seen.push(new Request(input, init));
			return listing("gpt-5", MODEL);
		});
		expect(probe).toEqual({ result: "ok", models: 2 });
		expect(seen.map((request) => request.url)).toEqual(["http://cpa.test:8317/v1/models"]);
		expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${CPA_KEY}`);
		expect(describeCpaProbe(CPA, probe)).toBe(`[gateway] CLIProxyAPI accepted the key and lists ${MODEL} (2 models)`);
	});

	it("says when CPA refuses the key, as it did next to Sal, without the key", async () => {
		const probe = await probeCpa(CPA, async () => new Response('{"error":"Invalid API key"}', { status: 401 }));
		expect(probe).toEqual({ result: "key_refused", status: 401 });
		const line = describeCpaProbe(CPA, probe);
		expect(line).toMatch(/refused HARBOUR_CPA_API_KEY \(HTTP 401\).*no_model.*api-keys/);
		expect(line).not.toContain(CPA_KEY);
	});

	it("says when CPA doesn't list the default route's model", async () => {
		const probe = await probeCpa(CPA, async () => listing("gpt-5"));
		expect(probe).toEqual({ result: "model_missing", models: 1 });
		expect(describeCpaProbe(CPA, probe)).toMatch(/not claude-sonnet-4-5.*HARBOUR_DEFAULT_MODEL/);
	});

	it("never throws, and keeps the key out of a failure", async () => {
		const down = await probeCpa(CPA, async () => {
			throw new Error(`connect ECONNREFUSED with ${CPA_KEY}`);
		});
		expect(down).toMatchObject({ result: "failed" });
		expect(describeCpaProbe(CPA, down)).not.toContain(CPA_KEY);
		expect(await probeCpa(CPA, async () => new Response("busy", { status: 503 }))).toEqual({
			result: "failed",
			detail: "HTTP 503",
		});
	});
});
