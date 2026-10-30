import {
	type ConnectorPreset,
	HarbourError,
	type ModelOverride,
	type UsageRecord,
	type UsageWriter,
} from "@harbour/contracts";
import { assertImagesRequest, outputByName, sizeFor, sniffImageType } from "@harbour/models";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import { createModelGateway } from "@harbour/models/gateway";
import { actors, contextFor, createDeps } from "@harbour/testing/harness";
import { createFakeModelUpstream, FAKE_IMAGE_PNG, type FakeListedModel } from "@harbour/testing/models";
import { createMemoryVault } from "@harbour/vault/memory";
import { describe, expect, it } from "vitest";

const ORG = "org-a";
const PROJECT = "proj-a";
const operator = contextFor(actors.system("operator"), ORG);
const KEY = "sk-images-test-5b2c9d1e";

let sessions = 0;
const scopeFor = () => {
	sessions += 1;
	return { organisationId: ORG, projectId: PROJECT, agentId: "agent-1", sessionId: `img-sess-${sessions}` };
};

async function code(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof HarbourError ? error.code : String(error);
	}
}

/** A gateway with one connector of `preset` offering `models`, and routes `chat` and `images`. */
async function setup(options: {
	preset: ConnectorPreset;
	models: readonly FakeListedModel[];
	imageModel: string;
	chatModel?: string;
	refresh?: "gateway" | "static";
	overrides?: { readonly [modelId: string]: ModelOverride };
	usage?: UsageWriter;
}) {
	const deps = createDeps();
	deps.tenancy.bind(actors.human("viewer-a"), ORG, "viewer", PROJECT);
	deps.tenancy.bind(actors.human("admin-a"), ORG, "admin", PROJECT);
	const upstream = createFakeModelUpstream({ models: options.models });
	const vault = createMemoryVault({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const connectors = createMemoryModelConnectors({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const item = await vault.putItem(operator, {
		owner: { kind: "platform" },
		name: "Upstream",
		hosts: ["upstream.internal"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: KEY,
	});
	await connectors.putConnector(operator, {
		id: "up",
		owner: { kind: "platform" },
		preset: options.preset,
		baseUrl: "http://upstream.internal/v1",
		vaultItemId: item.id,
		catalogue: {
			refresh: options.refresh ?? "gateway",
			...(options.refresh === "static" ? { include: options.models.map((model) => model.id) } : {}),
			...(options.overrides === undefined ? {} : { overrides: options.overrides }),
		},
	});
	await connectors.putRoute(operator, {
		name: "images",
		owner: { kind: "platform" },
		connectorId: "up",
		modelId: options.imageModel,
	});
	if (options.chatModel !== undefined) {
		await connectors.putRoute(operator, {
			name: "chat",
			owner: { kind: "platform" },
			connectorId: "up",
			modelId: options.chatModel,
		});
	}
	const gateway = createModelGateway({
		connectors,
		credentials: vault,
		clock: deps.clock,
		audit: deps.audit,
		fetch: upstream.fetch,
		baseUrl: "http://gateway.internal",
		access: deps.access,
		...(options.usage === undefined ? {} : { usage: options.usage }),
	});
	return { deps, upstream, gateway, connectors };
}

describe("image output in the catalogue", () => {
	it("reads image output off a model's name on OpenAI, CLIProxyAPI and the compatible presets", () => {
		expect(outputByName("gpt-image-1")).toEqual(["image"]);
		expect(outputByName("dall-e-3")).toEqual(["image"]);
		expect(outputByName("imagen-4.0-generate-001")).toEqual(["image"]);
		expect(outputByName("gemini-2.5-flash-image")).toEqual(["text", "image"]);
		expect(outputByName("gpt-5-image-mini")).toEqual(["text", "image"]);
		expect(outputByName("gpt-5")).toBeUndefined();
		expect(outputByName("claude-sonnet-4-5")).toBeUndefined();
	});

	it("lists output beside input in config, from OpenRouter's output_modalities", async () => {
		const { gateway } = await setup({
			preset: "openrouter",
			models: [
				{ id: "openai/gpt-5", contextWindow: 400_000, maxTokens: 128_000 },
				{ id: "google/gemini-2.5-flash-image", output: ["image", "text"] },
			],
			imageModel: "google/gemini-2.5-flash-image",
			chatModel: "openai/gpt-5",
		});
		const { models } = await gateway.config(scopeFor());
		expect(models.find((model) => model.id === "chat")?.output).toEqual(["text"]);
		expect(models.find((model) => model.id === "images")?.output).toEqual(["image", "text"]);
	});

	it("reads LiteLLM's image_generation mode and per-image price", async () => {
		const { gateway } = await setup({
			preset: "litellm",
			models: [{ id: "dall-e-3", output: ["image"], imageCost: 0.04 }],
			imageModel: "dall-e-3",
		});
		const { models } = await gateway.config(scopeFor());
		expect(models[0]).toMatchObject({ id: "images", output: ["image"], cost: { image: 0.04 } });
	});

	it("offers an image model the upstream doesn't list when an override says it makes images (CLIProxyAPI)", async () => {
		const { gateway } = await setup({
			preset: "cliproxyapi",
			models: [{ id: "gpt-5" }],
			imageModel: "gpt-image-1",
			overrides: { "gpt-image-1": { output: ["image"] } },
		});
		const { models } = await gateway.config(scopeFor());
		expect(models.find((model) => model.id === "images")?.output).toEqual(["image"]);
	});

	it("lets an override set output, and offers no image output on Anthropic whatever it says", async () => {
		const openai = await setup({
			preset: "openai-compatible",
			models: [{ id: "house-painter" }],
			imageModel: "house-painter",
			overrides: { "house-painter": { output: ["image"] } },
		});
		expect((await openai.gateway.config(scopeFor())).models[0]?.output).toEqual(["image"]);
		const anthropic = await setup({
			preset: "anthropic",
			models: [{ id: "claude-sonnet-4-5" }],
			imageModel: "claude-sonnet-4-5",
			overrides: { "claude-sonnet-4-5": { output: ["text", "image"] } },
		});
		expect((await anthropic.gateway.config(scopeFor())).models[0]?.output).toEqual(["text"]);
	});
});

describe("images", () => {
	it("generates over /images/generations with the key, attribution and the shape's size", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
		});
		upstream.nextImages({ usage: { input: 50, output: 4160 } });
		const scope = scopeFor();
		const result = await gateway.images(scope, {
			model: "images",
			prompt: "A lighthouse",
			aspect: "landscape",
			count: 2,
		});
		expect(result.images).toHaveLength(2);
		expect(result.images[0]).toEqual({ mimeType: "image/png", data: FAKE_IMAGE_PNG });
		expect(result.route).toBe("images");
		const call = upstream.requests.find((request) => request.kind === "images");
		expect(call?.url).toBe("http://upstream.internal/v1/images/generations");
		expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(call?.body).toMatchObject({ model: "gpt-image-1", prompt: "A lighthouse", n: 2, size: "1536x1024" });
		expect((call?.body as { user?: string } | undefined)?.user).toBeTypeOf("string");
		expect(result.usage).toMatchObject({ input: 50, output: 4160, images: 2 });
		const [event] = deps.audit.ofType("model.call");
		expect(event?.data).toMatchObject({ operation: "images", route: "images", status: "done", costSource: "computed" });
		expect(JSON.stringify(event)).not.toContain("lighthouse");
		expect(JSON.stringify(event)).not.toContain(FAKE_IMAGE_PNG.slice(0, 40));
	});

	it("edits over /images/edits as multipart form data when given reference images", async () => {
		const { gateway, upstream } = await setup({
			preset: "cliproxyapi",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
		});
		const result = await gateway.images(scopeFor(), {
			model: "images",
			prompt: "Make it night",
			images: [{ mimeType: "image/png", data: FAKE_IMAGE_PNG }],
		});
		expect(result.images).toHaveLength(1);
		expect(result.usage.cost.total).toBe(0);
		const call = upstream.requests.find((request) => request.kind === "images");
		expect(call?.url).toBe("http://upstream.internal/v1/images/edits");
		expect(call?.body).toMatchObject({ model: "gpt-image-1", prompt: "Make it night", image: { type: "image/png" } });
	});

	it("takes LiteLLM's reported cost and adds its metadata", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "litellm",
			models: [{ id: "dall-e-3", output: ["image"], imageCost: 0.04 }],
			imageModel: "dall-e-3",
		});
		upstream.nextImages({ reportedCost: 0.08, revisedPrompt: "A detailed lighthouse" });
		const result = await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse", aspect: "portrait" });
		expect(result.usage.cost.total).toBe(0.08);
		expect(result.images[0]?.revisedPrompt).toBe("A detailed lighthouse");
		const call = upstream.requests.find((request) => request.kind === "images");
		expect(call?.body).toMatchObject({
			size: "1024x1792",
			response_format: "b64_json",
			metadata: { session_id: expect.any(String) },
		});
		expect(deps.audit.ofType("model.call")[0]?.data).toMatchObject({ costSource: "reported" });
	});

	it("prices per image from the catalogue when the upstream reports nothing", async () => {
		const { gateway, upstream } = await setup({
			preset: "openai-compatible",
			models: [{ id: "dall-e-3" }],
			imageModel: "dall-e-3",
			overrides: { "dall-e-3": { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, image: 0.04 } } },
		});
		upstream.nextImages({ asUrl: true });
		const result = await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse", count: 3 });
		expect(result.images).toHaveLength(3);
		expect(result.usage.cost.total).toBeCloseTo(0.12);
	});

	it("refuses a chat model for images and an image-only model for messages, as invalid", async () => {
		const { gateway, deps } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }, { id: "gpt-5" }],
			imageModel: "gpt-image-1",
			chatModel: "gpt-5",
		});
		expect(await code(gateway.images(scopeFor(), { model: "chat", prompt: "Hi" }))).toBe("invalid");
		expect(
			await code(
				gateway.messages(scopeFor(), {
					model: "images",
					context: { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
				}),
			),
		).toBe("invalid");
		expect(deps.audit.ofType("model.call")).toHaveLength(0);
	});

	it("refuses chat-modalities as not_supported, for now", async () => {
		const { gateway } = await setup({
			preset: "openrouter",
			models: [{ id: "google/gemini-2.5-flash-image", output: ["image", "text"] }],
			imageModel: "google/gemini-2.5-flash-image",
		});
		expect(await code(gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse" }))).toBe("not_supported");
	});

	it("maps an upstream refusal to its code, redacted, and records the failed call", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
		});
		upstream.nextImages({ error: { status: 400, message: `Your request was rejected (key ${KEY})` } });
		const failure = await gateway.images(scopeFor(), { model: "images", prompt: "x" }).catch((error) => error);
		expect(failure).toBeInstanceOf(HarbourError);
		expect(failure.code).toBe("invalid");
		expect(failure.message).not.toContain(KEY);
		upstream.nextImages({ error: { status: 429, message: "Slow down" } });
		expect(await code(gateway.images(scopeFor(), { model: "images", prompt: "x" }))).toBe("exhausted");
		const events = deps.audit.ofType("model.call");
		expect(events.map((event) => event.data?.status)).toEqual(["error", "error"]);
	});

	it("writes a usage record per image call, done or refused, under the image API", async () => {
		const records: UsageRecord[] = [];
		const { gateway, upstream } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
			usage: { record: async (record) => void records.push(record) },
		});
		upstream.nextImages({ usage: { input: 50, output: 4160 } });
		await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse" });
		upstream.nextImages({ error: { status: 400, message: `Rejected (key ${KEY})` } });
		await gateway.images(scopeFor(), { model: "images", prompt: "x" }).catch(() => {});
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			api: "openai-images",
			modelId: "gpt-image-1",
			provider: "openai",
			connectorPreset: "openai",
			status: "done",
			inputTokens: 50,
			outputTokens: 4160,
			costSource: "computed",
		});
		expect(records[1]).toMatchObject({ api: "openai-images", status: "error", inputTokens: 0 });
		expect(records[1]?.error).toContain("400: Rejected");
		expect(records[1]?.error).not.toContain(KEY);
	});

	it("rejects a malformed request as invalid", () => {
		const bad = [
			{ model: "images" },
			{ model: "images", prompt: "x", count: 5 },
			{ model: "images", prompt: "x", aspect: "wide" },
			{ model: "images", prompt: "x", size: "huge" },
			{ model: "images", prompt: "x", images: [{ mimeType: "text/plain", data: "aGk=" }] },
			{ model: "images", prompt: "x", images: [{ mimeType: "image/png", data: "not base64!" }] },
		];
		for (const request of bad) expect(() => assertImagesRequest(request)).toThrow(HarbourError);
		expect(() => assertImagesRequest({ model: "images", prompt: "x", count: 4, aspect: "square" })).not.toThrow();
	});

	it("picks each family's size for a shape", () => {
		expect(sizeFor("gpt-image-1", { aspect: "portrait" })).toBe("1024x1536");
		expect(sizeFor("dall-e-3", { aspect: "landscape" })).toBe("1792x1024");
		expect(sizeFor("dall-e-2", { aspect: "landscape" })).toBe("1024x1024");
		expect(sizeFor("flux-pro", { aspect: "landscape" })).toBeUndefined();
		expect(sizeFor("gpt-image-1", { aspect: "square", size: "auto" })).toBe("auto");
		expect(sniffImageType(FAKE_IMAGE_PNG)).toBe("image/png");
	});
});

describe("the console's connector models and test generate", () => {
	it("lists each connector's models with their output and image API, for a viewer", async () => {
		const { gateway } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }, { id: "gpt-5" }],
			imageModel: "gpt-image-1",
		});
		const viewer = contextFor(actors.human("viewer-a"), ORG);
		const [connector] = await gateway.listConnectorModels(viewer, { projectId: PROJECT });
		expect(connector).toMatchObject({
			id: "up",
			preset: "openai",
			routes: [{ name: "images", modelId: "gpt-image-1" }],
		});
		expect(connector?.models.find((model) => model.id === "gpt-image-1")).toMatchObject({
			output: ["image"],
			imageApi: "openai-images",
		});
		expect(connector?.models.find((model) => model.id === "gpt-5")?.output).toEqual(["text"]);
		expect(JSON.stringify(connector)).not.toContain(KEY);
	});

	it("makes one small image for an admin, recorded under the console", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
		});
		const admin = contextFor(actors.human("admin-a"), ORG);
		const result = await gateway.testImage(admin, { connectorId: "up", modelId: "gpt-image-1", projectId: PROJECT });
		expect(result.images).toHaveLength(1);
		const call = upstream.requests.find((request) => request.kind === "images");
		expect(call?.body).toMatchObject({ n: 1, size: "1024x1024", quality: "low" });
		expect(deps.audit.ofType("model.call")[0]).toMatchObject({ agentId: "console", data: { route: "connector-test" } });
		const viewer = contextFor(actors.human("viewer-a"), ORG);
		expect(
			await code(gateway.testImage(viewer, { connectorId: "up", modelId: "gpt-image-1", projectId: PROJECT })),
		).toBe("forbidden");
	});
});
