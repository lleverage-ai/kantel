// A tool's images by reference (`./tool-images.ts`): the transcript names each inline image by the SHA-256
// of its bytes, the API answers that name, and the model still reads the image itself.
import { createHash } from "node:crypto";
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import type { AgentProfile, Authentication, ModelGatewayModel } from "@kantel/contracts";
import type { ServerFrame, ToolItem } from "@kantel/protocol";
import { GENERATE_IMAGE_TOOL, imageSize, type SessionImages as RuntimeImages } from "@kantel/runtime";
import { createSessionApi, staticTokenAuthenticator } from "@kantel/runtime/http";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { encode as encodeJpeg } from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-tool-images";
const host: Authentication = { actor: { kind: "service", serviceId: "host" }, organisationId: ORG };
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
// A 1x1 transparent PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PIXEL_BYTES = Buffer.from(PIXEL, "base64");
const PIXEL_ID = createHash("sha256").update(PIXEL_BYTES).digest("hex");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const profile: AgentProfile = {
	id: "artist",
	organisationId: ORG,
	name: "Artist",
	model: { route: "default" },
	imageModel: { route: "images" },
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const imageModel: ModelGatewayModel = {
	id: "scripted-1",
	name: "scripted-1",
	reasoning: false,
	input: ["text"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
};

const images: RuntimeImages = {
	models: async () => [imageModel],
	async generate(request) {
		return {
			images: Array.from({ length: request.count ?? 1 }, () => ({ mimeType: "image/png", data: PIXEL })),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				images: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			route: request.model,
			modelId: "gpt-image-1",
		};
	},
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A session that made an image with a chat model that reads images, so the image goes back to the model. `frames` are
 * the live stream's, watched from before the prompt.
 */
async function madeAnImage(options: { readonly byReference?: boolean } = {}) {
	const { models, script, contexts } = createScriptedModel({ input: ["text", "image"] });
	const memory = createMemoryRuntime({
		models,
		images: () => images,
		...(options.byReference === false ? {} : { toolImages: { hash: sha256 } }),
	});
	const api = createSessionApi({
		runtime: memory.runtime,
		directory: memory.directory,
		profiles: memory.profiles,
		hostTools: memory.hostTools,
		history: memory.history,
		images: memory.images,
		authenticator: staticTokenAuthenticator({ host }),
	});
	cleanups.push(async () => {
		await api.close();
		await memory.close();
	});
	await memory.profiles.put(ctx, profile);
	const session = await memory.runtime.create(ctx, { projectId: "proj", agentId: "artist" });
	const frames: ServerFrame[] = [];
	const watching = await memory.runtime.watch(ctx, session.id, {}, (frame) => frames.push(frame));
	cleanups.push(async () => watching.close());
	script.reply({ toolCalls: [{ name: GENERATE_IMAGE_TOOL, args: { prompt: "A dot" } }] }, { text: "Done" });
	const submission = await memory.runtime.prompt(ctx, session.id, { text: "Draw" });
	expect(await memory.runtime.wait(ctx, session.id, submission.id)).toMatchObject({ answer: "Done" });
	const client = createKantelClient({
		baseUrl: "https://kantel.test/v1",
		token: "host",
		fetch: (input, init) => api.fetch(new Request(input, init)),
	});
	return { memory, api, client, session, contexts, frames };
}

const toolOf = (items: readonly { readonly kind: string }[]) =>
	items.find((item): item is ToolItem => item.kind === "tool");

describe("tool images by reference", () => {
	it("names an image by its hash in the snapshot, the stream and history, never as base64", async () => {
		const { memory, session } = await madeAnImage();
		const snapshot = await memory.runtime.snapshot(ctx, session.id);
		expect(toolOf(snapshot.items)?.images).toEqual([
			{
				mimeType: "image/png",
				url: `/v1/sessions/${session.id}/images/${PIXEL_ID}`,
				width: 1,
				height: 1,
				size: PIXEL_BYTES.byteLength,
			},
		]);
		expect(JSON.stringify(snapshot)).not.toContain(PIXEL);
		const page = await memory.history.history(ctx, session.id);
		expect(toolOf(page.items)?.images?.[0]?.url).toBe(`/v1/sessions/${session.id}/images/${PIXEL_ID}`);
	});

	it("names it by reference in the live stream's deltas too", async () => {
		const { frames, session } = await madeAnImage();
		expect(frames.some((frame) => frame.type === "delta")).toBe(true);
		const text = JSON.stringify(frames);
		expect(text).not.toContain(PIXEL);
		expect(text).toContain(`/v1/sessions/${session.id}/images/${PIXEL_ID}`);
	});

	it("still gives the model the image itself", async () => {
		const { contexts } = await madeAnImage();
		// The second request is the one after the tool's result: its image is there as image content, in full.
		const result = contexts[1]?.find((message) => message.role === "toolResult");
		const content = typeof result?.content === "string" ? [] : (result?.content ?? []);
		expect(content).toContainEqual(expect.objectContaining({ type: "image", mimeType: "image/png", data: PIXEL }));
	});

	it("answers the image's bytes through the public API, cacheable for good", async () => {
		const { api, client, session } = await madeAnImage();
		const blob = await client.getSessionImage(session.id, PIXEL_ID);
		expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(PIXEL_BYTES));
		const response = await api.fetch(
			new Request(`https://kantel.test/v1/sessions/${session.id}/images/${PIXEL_ID}`, {
				headers: { authorization: "Bearer host" },
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("refuses an ID that isn't a hash, and one the transcript doesn't name", async () => {
		const { client, memory, session } = await madeAnImage();
		const code = async (promise: Promise<unknown>) =>
			promise.then(
				() => "answered",
				(error: unknown) => (error instanceof KantelApiError ? error.code : String(error)),
			);
		expect(await code(client.getSessionImage(session.id, "not-a-hash"))).toBe("invalid");
		expect(await code(client.getSessionImage(session.id, "0".repeat(64)))).toBe("not_found");
		const other = { actor: { kind: "service", serviceId: "test" }, organisationId: "org-other" } as const;
		await expect(memory.images.image(other, session.id, PIXEL_ID)).rejects.toMatchObject({ code: "not_found" });
	});

	it("keeps images inline when the host gives no hash", async () => {
		const { memory, client, session } = await madeAnImage({ byReference: false });
		const snapshot = await memory.runtime.snapshot(ctx, session.id);
		expect(toolOf(snapshot.items)?.images).toEqual([{ mimeType: "image/png", data: PIXEL }]);
		await expect(client.getSessionImage(session.id, PIXEL_ID)).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("imageSize", () => {
	it("reads a PNG's and a JPEG's size from their headers", () => {
		expect(imageSize(PIXEL_BYTES)).toEqual({ width: 1, height: 1 });
		const jpeg = encodeJpeg({ width: 37, height: 21, data: new Uint8Array(37 * 21 * 4) }, 80).data;
		expect(imageSize(new Uint8Array(jpeg))).toEqual({ width: 37, height: 21 });
	});

	it("reads a GIF's and a WebP's", () => {
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x01, 0xc8, 0x00, 0, 0, 0]);
		expect(imageSize(gif)).toEqual({ width: 300, height: 200 });
		const webp = new Uint8Array(30);
		webp.set(new TextEncoder().encode("RIFF"), 0);
		webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
		// A 640 by 480 canvas, each stored less one, in three little-endian bytes.
		webp.set([0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00], 24);
		expect(imageSize(webp)).toEqual({ width: 640, height: 480 });
	});

	it("gives nothing for bytes that aren't an image it knows", () => {
		expect(imageSize(new TextEncoder().encode("<svg></svg>"))).toBeUndefined();
		expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeUndefined();
	});
});
