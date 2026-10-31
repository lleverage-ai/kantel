import {
	type ConnectorPreset,
	type JsonValue,
	KantelError,
	type ModelOverride,
	type UsageRecord,
	type UsageWriter,
} from "@kantel/contracts";
import { assertImagesRequest, outputByName, sizeFor, sniffImageType } from "@kantel/models";
import { createMemoryModelConnectors } from "@kantel/models/directory";
import { createModelGateway } from "@kantel/models/gateway";
import { priceVersionOf } from "@kantel/models/usage";
import { actors, contextFor, createDeps } from "@kantel/testing/harness";
import { createFakeModelUpstream, FAKE_IMAGE_PNG, type FakeListedModel } from "@kantel/testing/models";
import { createMemoryVault } from "@kantel/vault/memory";
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
		return error instanceof KantelError ? error.code : String(error);
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
	compat?: { readonly [key: string]: JsonValue };
	/** Where the gateway writes each call's usage record. */
	usage?: UsageWriter;
	/** Wraps the fake upstream's fetch. */
	fetch?: (upstream: typeof fetch) => typeof fetch;
	/** The hosts the key may go to. Default the upstream's. */
	keyHosts?: readonly string[];
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
		hosts: [...(options.keyHosts ?? ["upstream.internal"])],
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
		...(options.compat === undefined ? {} : { compat: options.compat }),
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
		fetch: options.fetch === undefined ? upstream.fetch : options.fetch(upstream.fetch),
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

	it("maps an upstream refusal to its code, redacted, and records the failed call", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
		});
		upstream.nextImages({ error: { status: 400, message: `Your request was rejected (key ${KEY})` } });
		const failure = await gateway.images(scopeFor(), { model: "images", prompt: "x" }).catch((error) => error);
		expect(failure).toBeInstanceOf(KantelError);
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
		for (const request of bad) expect(() => assertImagesRequest(request)).toThrow(KantelError);
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

describe("images over chat-modalities (OpenRouter, Vercel)", () => {
	const GEMINI = "google/gemini-2.5-flash-image";
	const chatCall = (upstream: { requests: readonly { kind: string; url: string }[] }) =>
		upstream.requests.find((request) => request.kind === "openai-completions") as
			| { url: string; headers: { readonly [name: string]: string }; body: { readonly [key: string]: unknown } }
			| undefined;

	it("generates on OpenRouter over chat completions, with the key, affinity, the shape and the reported cost", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "openrouter",
			models: [{ id: GEMINI, output: ["image", "text"] }],
			imageModel: GEMINI,
		});
		upstream.nextImages({ text: "Here is your lighthouse.", reportedCost: 0.039, usage: { input: 9, output: 1290 } });
		const scope = scopeFor();
		const result = await gateway.images(scope, { model: "images", prompt: "A lighthouse", aspect: "landscape" });
		expect(result.images).toEqual([{ mimeType: "image/png", data: FAKE_IMAGE_PNG }]);
		expect(result.text).toBe("Here is your lighthouse.");
		expect(result.usage).toMatchObject({
			input: 9,
			output: 1290,
			totalTokens: 1299,
			images: 1,
			cost: { total: 0.039 },
		});
		const call = chatCall(upstream);
		expect(call?.url).toBe("http://upstream.internal/v1/chat/completions");
		expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(call?.headers["x-session-id"]).toBe(scope.sessionId);
		expect(call?.body).toEqual({
			model: GEMINI,
			messages: [{ role: "user", content: "A lighthouse" }],
			modalities: ["image", "text"],
			stream: false,
			image_config: { aspect_ratio: "3:2" },
		});
		const [event] = deps.audit.ofType("model.call");
		expect(event?.data).toMatchObject({ operation: "images", status: "done", costSource: "reported" });
		expect((event?.data?.usage as { images?: number } | undefined)?.images).toBe(1);
		expect(JSON.stringify(event)).not.toContain("lighthouse");
		expect(JSON.stringify(event)).not.toContain(FAKE_IMAGE_PNG.slice(0, 40));
	});

	it("asks an image-only model for images only, and turns an exact size into its ratio", async () => {
		const { gateway, upstream } = await setup({
			preset: "openrouter",
			models: [{ id: "black-forest-labs/flux.2-pro", output: ["image"] }],
			imageModel: "black-forest-labs/flux.2-pro",
		});
		await gateway.images(scopeFor(), {
			model: "images",
			prompt: "A lighthouse",
			size: "1024x1024",
			aspect: "portrait",
		});
		expect(chatCall(upstream)?.body).toMatchObject({ modalities: ["image"], image_config: { aspect_ratio: "1:1" } });
	});

	it("refuses a size OpenRouter has no ratio for, before calling or recording anything", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "openrouter",
			models: [{ id: GEMINI, output: ["image", "text"] }],
			imageModel: GEMINI,
		});
		expect(await code(gateway.images(scopeFor(), { model: "images", prompt: "x", size: "1792x1000" }))).toBe("invalid");
		expect(upstream.calls()).toHaveLength(0);
		expect(deps.audit.ofType("model.call")).toHaveLength(0);
	});

	it("edits: the prompt first, then each reference image as an image_url data URL", async () => {
		const { gateway, upstream } = await setup({
			preset: "openrouter",
			models: [{ id: GEMINI, output: ["image", "text"] }],
			imageModel: GEMINI,
		});
		const result = await gateway.images(scopeFor(), {
			model: "images",
			prompt: "Put them in one basket",
			images: [
				{ mimeType: "image/png", data: FAKE_IMAGE_PNG },
				{ mimeType: "image/jpeg", data: "/9j/4AAQ" },
			],
		});
		expect(result.images).toHaveLength(1);
		expect(chatCall(upstream)?.body.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Put them in one basket" },
					{ type: "image_url", image_url: { url: `data:image/png;base64,${FAKE_IMAGE_PNG}` } },
					{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
				],
			},
		]);
	});

	it("returns every image the model made, fetching https URLs once without the key, whatever count asked", async () => {
		const { gateway, upstream } = await setup({
			preset: "openrouter",
			models: [{ id: GEMINI, output: ["image", "text"] }],
			imageModel: GEMINI,
		});
		upstream.nextImages({ count: 2, asUrl: true });
		const result = await gateway.images(scopeFor(), { model: "images", prompt: "Two lighthouses", count: 3 });
		expect(result.images).toHaveLength(2);
		expect(result.usage.images).toBe(2);
		const call = chatCall(upstream);
		expect(call?.body).not.toHaveProperty("n");
		const downloads = upstream.requests.filter((request) => request.url.includes("/fake-images/"));
		expect(downloads).toHaveLength(2);
		for (const download of downloads) expect(download.headers.authorization).toBeUndefined();
	});

	it("passes the connector's OpenRouter routing as the provider object", async () => {
		const { gateway, upstream } = await setup({
			preset: "openrouter",
			models: [{ id: GEMINI, output: ["image", "text"] }],
			imageModel: GEMINI,
			compat: { openRouterRouting: { only: ["google-ai-studio"] } },
		});
		await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse" });
		expect(chatCall(upstream)?.body.provider).toEqual({ only: ["google-ai-studio"] });
	});

	it("generates on Vercel with modalities only: no image_config, its routing, and its usage.cost", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "vercel-ai-gateway",
			models: [{ id: GEMINI, output: ["text", "image"] }],
			imageModel: GEMINI,
			compat: { vercelGatewayRouting: { only: ["vertex"] } },
		});
		upstream.nextImages({ reportedCost: 0.039 });
		const result = await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse", aspect: "portrait" });
		expect(result.usage.cost.total).toBe(0.039);
		const call = chatCall(upstream);
		expect(call?.url).toBe("http://upstream.internal/v1/chat/completions");
		expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(call?.body).toEqual({
			model: GEMINI,
			messages: [{ role: "user", content: "A lighthouse" }],
			modalities: ["image", "text"],
			stream: false,
			providerOptions: { gateway: { only: ["vertex"] } },
		});
		expect(deps.audit.ofType("model.call")[0]?.data).toMatchObject({ costSource: "reported" });
		expect(await code(gateway.images(scopeFor(), { model: "images", prompt: "x", size: "1024x1024" }))).toBe("invalid");
	});

	it("computes Vercel's cost from tokens when it reports none", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "vercel-ai-gateway",
			models: [{ id: GEMINI, output: ["text", "image"] }],
			imageModel: GEMINI,
			overrides: { [GEMINI]: { rates: { input: 0.3, output: 30, cacheRead: 0, cacheWrite: 0 } } },
		});
		upstream.nextImages({ usage: { input: 10, output: 1290 } });
		const result = await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse" });
		expect(result.usage.cost.total).toBeCloseTo((10 * 0.3 + 1290 * 30) / 1_000_000);
		expect(deps.audit.ofType("model.call")[0]?.data).toMatchObject({ costSource: "computed" });
	});

	it("calls Vercel's image-only models over its Images API, not chat", async () => {
		const { gateway, upstream } = await setup({
			preset: "vercel-ai-gateway",
			models: [
				{ id: "openai/gpt-image-2", output: ["image"] },
				{ id: GEMINI, output: ["text", "image"] },
			],
			imageModel: "openai/gpt-image-2",
		});
		const result = await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse" });
		expect(result.images).toHaveLength(1);
		expect(upstream.requests.find((request) => request.kind === "images")?.url).toBe(
			"http://upstream.internal/v1/images/generations",
		);
		const viewer = contextFor(actors.human("viewer-a"), ORG);
		const [connector] = await gateway.listConnectorModels(viewer, { projectId: PROJECT });
		expect(connector?.models.find((model) => model.id === "openai/gpt-image-2")?.imageApi).toBe("openai-images");
		expect(connector?.models.find((model) => model.id === GEMINI)?.imageApi).toBe("chat-modalities");
	});

	it("maps an upstream refusal to its code, redacted, and records the failed call", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "openrouter",
			models: [{ id: GEMINI, output: ["image", "text"] }],
			imageModel: GEMINI,
		});
		upstream.nextImages({ error: { status: 400, message: `Bad request for key ${KEY}` } });
		const failure = await gateway.images(scopeFor(), { model: "images", prompt: "x" }).catch((error) => error);
		expect(failure).toBeInstanceOf(KantelError);
		expect(failure.code).toBe("invalid");
		expect(failure.message).not.toContain(KEY);
		upstream.nextImages({ error: { status: 429, message: "Rate limit exceeded" } });
		expect(await code(gateway.images(scopeFor(), { model: "images", prompt: "x" }))).toBe("exhausted");
		upstream.nextImages({ bodyError: { code: 502, message: "Provider returned error" } });
		expect(await code(gateway.images(scopeFor(), { model: "images", prompt: "x" }))).toBe("unavailable");
		const events = deps.audit.ofType("model.call");
		expect(events.map((event) => event.data?.status)).toEqual(["error", "error", "error"]);
		expect(JSON.stringify(events)).not.toContain(KEY);
	});

	it("fails an answer without an image, but records the tokens and cost it was billed", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "openrouter",
			models: [{ id: GEMINI, output: ["image", "text"] }],
			imageModel: GEMINI,
		});
		upstream.nextImages({
			count: 0,
			text: `I can't draw that (${KEY}).`,
			usage: { input: 9, output: 14 },
			reportedCost: 0.0001,
		});
		const failure = await gateway.images(scopeFor(), { model: "images", prompt: "x" }).catch((error) => error);
		expect(failure).toBeInstanceOf(KantelError);
		expect(failure.code).toBe("unavailable");
		expect(failure.message).toContain("I can't draw that");
		expect(failure.message).not.toContain(KEY);
		const [event] = deps.audit.ofType("model.call");
		expect(event?.data).toMatchObject({
			status: "error",
			costSource: "reported",
			usage: { input: 9, output: 14, images: 0, cost: { total: 0.0001 } },
		});
	});

	it("makes the console's test image on OpenRouter: one square image, no quality", async () => {
		const { gateway, upstream, deps } = await setup({
			preset: "openrouter",
			models: [{ id: GEMINI, output: ["image", "text"] }],
			imageModel: GEMINI,
		});
		const admin = contextFor(actors.human("admin-a"), ORG);
		const result = await gateway.testImage(admin, { connectorId: "up", modelId: GEMINI, projectId: PROJECT });
		expect(result.images).toHaveLength(1);
		const body = chatCall(upstream)?.body;
		expect(body).toMatchObject({ image_config: { aspect_ratio: "1:1" } });
		expect(body).not.toHaveProperty("quality");
		expect(deps.audit.ofType("model.call")[0]).toMatchObject({ agentId: "console", data: { route: "connector-test" } });
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

/** A usage writer that keeps what it is given. */
function recordsWriter(): UsageWriter & { readonly records: UsageRecord[] } {
	const records: UsageRecord[] = [];
	return {
		records,
		async record(record) {
			records.push(record);
		},
	};
}

describe("image calls' usage records", () => {
	it("writes one per call, beside its model.call, with the image count and OpenAI's tokens at the catalogue's rates", async () => {
		const usage = recordsWriter();
		const { gateway, upstream, deps } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
			usage,
		});
		upstream.nextImages({ usage: { input: 50, output: 4160 } });
		const scope = scopeFor();
		const result = await gateway.images(scope, { model: "images", prompt: "A lighthouse", count: 2 });
		const rates = (await gateway.config(scope)).models.find((model) => model.id === "images")?.cost;
		expect(rates?.output).toBeGreaterThan(0);

		expect(usage.records).toHaveLength(1);
		const [record] = usage.records;
		expect(record).toMatchObject({
			callId: deps.audit.ofType("model.call")[0]?.subject?.id,
			organisationId: ORG,
			projectId: PROJECT,
			sessionId: scope.sessionId,
			agentId: "agent-1",
			route: "images",
			modelId: "gpt-image-1",
			provider: "openai",
			connectorId: "up",
			connectorPreset: "openai",
			api: "openai-images",
			status: "done",
			stopReason: "stop",
			inputTokens: 50,
			outputTokens: 4160,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			images: 2,
			cost: result.usage.cost,
			costSource: "computed",
			priceVersion: priceVersionOf("computed", {
				input: rates?.input ?? 0,
				output: rates?.output ?? 0,
				cacheRead: rates?.cacheRead ?? 0,
				cacheWrite: rates?.cacheWrite ?? 0,
			}),
		});
		expect(record?.cost.total).toBeCloseTo(((rates?.input ?? 0) * 50 + (rates?.output ?? 0) * 4160) / 1_000_000);
		// No prompt, no image and no time to a first token: an image call doesn't stream.
		expect(record?.firstTokenMs).toBeUndefined();
		expect(JSON.stringify(record)).not.toContain("lighthouse");
		expect(JSON.stringify(record)).not.toContain(FAKE_IMAGE_PNG.slice(0, 40));
	});

	it("takes the cost LiteLLM reports", async () => {
		const usage = recordsWriter();
		const { gateway, upstream } = await setup({
			preset: "litellm",
			models: [{ id: "gpt-image-1", output: ["image"] }],
			imageModel: "gpt-image-1",
			usage,
		});
		upstream.nextImages({ usage: { input: 20, output: 1056 }, reportedCost: 0.042 });
		await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse" });
		expect(usage.records).toEqual([
			expect.objectContaining({
				connectorPreset: "litellm",
				provider: "openai",
				api: "openai-images",
				images: 1,
				inputTokens: 20,
				outputTokens: 1056,
				cost: { total: 0.042, input: 0, output: 0.042, cacheRead: 0, cacheWrite: 0 },
				costSource: "reported",
				priceVersion: "reported",
			}),
		]);
	});

	it("writes one for OpenRouter's and Vercel's chat-modalities image calls, with the cost each reports", async () => {
		const presets: readonly ConnectorPreset[] = ["openrouter", "vercel-ai-gateway"];
		for (const preset of presets) {
			const usage = recordsWriter();
			const { gateway, upstream } = await setup({
				preset,
				models: [{ id: "google/gemini-2.5-flash-image", output: ["image", "text"] }],
				imageModel: "google/gemini-2.5-flash-image",
				usage,
			});
			upstream.nextImages({ reportedCost: 0.039, usage: { input: 9, output: 1290 } });
			await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse" });
			expect(usage.records, preset).toHaveLength(1);
			expect(usage.records[0], preset).toMatchObject({
				status: "done",
				images: 1,
				inputTokens: 9,
				outputTokens: 1290,
				cost: { total: 0.039 },
				costSource: "reported",
			});
		}
	});

	it("names the per-image rate a cost made per image used", async () => {
		const usage = recordsWriter();
		const { gateway, upstream } = await setup({
			preset: "openai-compatible",
			models: [{ id: "dall-e-3" }],
			imageModel: "dall-e-3",
			overrides: { "dall-e-3": { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, image: 0.04 } } },
			usage,
		});
		upstream.nextImages({});
		await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse", count: 3 });
		expect(usage.records[0]).toMatchObject({
			images: 3,
			inputTokens: 0,
			outputTokens: 0,
			cost: { total: expect.closeTo(0.12, 9), output: expect.closeTo(0.12, 9) },
			costSource: "computed",
			priceVersion: "image:0.04",
		});
	});

	it("costs nothing on CLIProxyAPI, whose preset reports no cost, and still counts the images", async () => {
		const usage = recordsWriter();
		const { gateway, upstream } = await setup({
			preset: "cliproxyapi",
			models: [{ id: "gpt-5" }],
			imageModel: "gpt-image-1",
			overrides: { "gpt-image-1": { output: ["image"] } },
			usage,
		});
		upstream.nextImages({ usage: { input: 50, output: 4160 }, reportedCost: 0.17 });
		await gateway.images(scopeFor(), { model: "images", prompt: "A lighthouse", count: 2 });
		expect(usage.records[0]).toMatchObject({
			connectorPreset: "cliproxyapi",
			api: "openai-images",
			images: 2,
			inputTokens: 50,
			outputTokens: 4160,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			costSource: "none",
			priceVersion: "none",
		});
	});

	it("records a refused call as an error with the redacted reason and no images, as messages does", async () => {
		const usage = recordsWriter();
		const { gateway, upstream, deps } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
			usage,
		});
		upstream.nextImages({ error: { status: 400, message: `Your request was rejected (key ${KEY})` } });
		expect(await code(gateway.images(scopeFor(), { model: "images", prompt: "x" }))).toBe("invalid");
		expect(usage.records).toHaveLength(1);
		const [record] = usage.records;
		expect(record).toMatchObject({
			callId: deps.audit.ofType("model.call")[0]?.subject?.id,
			status: "error",
			stopReason: "error",
			images: 0,
			inputTokens: 0,
			outputTokens: 0,
			cost: { total: 0 },
			costSource: "computed",
			priceVersion: expect.stringMatching(/^rates:/),
		});
		expect(record?.error).toContain("400: Your request was rejected");
		expect(record?.error).not.toContain(KEY);
	});

	it("records an aborted call as aborted, and one whose key can't be read as an error that cost nothing", async () => {
		const usage = recordsWriter();
		const { gateway } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
			usage,
			// An Images API call that waits until it is cancelled.
			fetch: (upstream) => async (input, init) => {
				if (!String(input instanceof Request ? input.url : input).includes("/images/")) return upstream(input, init);
				const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
				return new Promise<Response>((_, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		});
		const controller = new AbortController();
		const call = gateway.images(scopeFor(), { model: "images", prompt: "x" }, controller.signal);
		setTimeout(() => controller.abort(new Error("The client went away")), 10);
		expect(await code(call)).toBe("aborted");
		expect(usage.records).toEqual([
			expect.objectContaining({ status: "aborted", stopReason: "aborted", images: 0, costSource: "computed" }),
		]);

		const refused = recordsWriter();
		const elsewhere = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
			usage: refused,
			// A static catalogue, so the route resolves without the key, and the key read is the call's own.
			refresh: "static",
			keyHosts: ["somewhere-else.internal"],
		});
		expect(await code(elsewhere.gateway.images(scopeFor(), { model: "images", prompt: "x" }))).toBe("refused");
		expect(elsewhere.upstream.requests.filter((request) => request.kind === "images")).toHaveLength(0);
		expect(refused.records).toEqual([
			expect.objectContaining({ status: "error", images: 0, costSource: "none", priceVersion: "none" }),
		]);
		expect(refused.records[0]?.error).toBeTypeOf("string");
	});

	it("writes one for the console's test image, under the console", async () => {
		const usage = recordsWriter();
		const { gateway } = await setup({
			preset: "openai",
			models: [{ id: "gpt-image-1" }],
			imageModel: "gpt-image-1",
			usage,
		});
		const admin = contextFor(actors.human("admin-a"), ORG);
		await gateway.testImage(admin, { connectorId: "up", modelId: "gpt-image-1", projectId: PROJECT });
		expect(usage.records).toEqual([
			expect.objectContaining({
				agentId: "console",
				projectId: PROJECT,
				route: "connector-test",
				api: "openai-images",
				images: 1,
			}),
		]);
	});
});
