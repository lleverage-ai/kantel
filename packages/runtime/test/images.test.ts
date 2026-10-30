// `generate_image` (`SessionRuntimeOptions.images`): offered only when the profile names an image model the gateway lists
// with image output, saved in the session's files, shown inline, and adding no prompt text of its own.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
	AgentProfile,
	ModelGatewayModel,
	ModelImagesRequest,
	ModelImagesResult,
	SessionRecord,
} from "@harbour/contracts";
import type { ToolItem } from "@harbour/protocol";
import { GENERATE_IMAGE_TOOL, imageStem, type SessionImages } from "@harbour/runtime";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { describe, expect, it } from "vitest";

const ORG = "org-images";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
// A 1x1 transparent PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const profile = (imageModel?: AgentProfile["imageModel"]): AgentProfile => ({
	id: "artist",
	organisationId: ORG,
	name: "Artist",
	model: { route: "default" },
	...(imageModel === undefined ? {} : { imageModel }),
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
});

const gatewayModel = (id: string, output: ModelGatewayModel["output"]): ModelGatewayModel => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"],
	output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
});

/** The gateway's image side for a test: what config lists, and each `images` call it was asked for. */
function fakeImages(listed: readonly ModelGatewayModel[]) {
	const calls: ModelImagesRequest[] = [];
	const images: SessionImages = {
		models: async () => listed,
		async generate(request): Promise<ModelImagesResult> {
			calls.push(request);
			return {
				images: Array.from({ length: request.count ?? 1 }, () => ({ mimeType: "image/png", data: PIXEL })),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					images: request.count ?? 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				route: request.model,
				modelId: "gpt-image-1",
			};
		},
	};
	return { images, calls };
}

/** An environment holding files in memory: only `writeFile` and `readBinaryFile` are used. */
function memoryEnv(files: Map<string, Uint8Array>): (record: SessionRecord) => ExecutionEnv {
	return (record) =>
		({
			id: `env:${record.id}`,
			cwd: "/workspace",
			cleanup: async () => {},
			async writeFile(path: string, content: string | Uint8Array) {
				files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
				return { ok: true, value: undefined };
			},
			async readBinaryFile(path: string) {
				const held = files.get(path);
				return held === undefined
					? { ok: false, error: { code: "not_found", message: `${path} not found` } }
					: { ok: true, value: held };
			},
		}) as unknown as ExecutionEnv;
}

function setUp(listed: readonly ModelGatewayModel[]) {
	const { models, script } = createScriptedModel();
	const { images, calls } = fakeImages(listed);
	const files = new Map<string, Uint8Array>();
	const service = createMemoryRuntime({ models, images: () => images, environment: memoryEnv(files) });
	return { service, script, calls, files };
}

describe("generate_image", () => {
	it("makes images with the profile's image model, saves them in the session's files and shows them inline", async () => {
		const { service, script, calls, files } = setUp([gatewayModel("scripted-1", ["image"])]);
		try {
			await service.profiles.put(ctx, profile({ route: "images" }));
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "artist" });
			script.reply(
				{ toolCalls: [{ name: GENERATE_IMAGE_TOOL, args: { prompt: "A red lighthouse", aspect: "landscape", count: 2 } }] },
				{ text: "Done" },
			);
			const submission = await service.runtime.prompt(ctx, session.id, { text: "Draw one" });
			expect(await service.runtime.wait(ctx, session.id, submission.id)).toMatchObject({ answer: "Done" });
			expect(calls).toEqual([
				expect.objectContaining({ model: "scripted-1", prompt: "A red lighthouse", aspect: "landscape", count: 2 }),
			]);
			const saved = [...files.keys()];
			expect(saved).toHaveLength(2);
			expect(saved[0]).toMatch(/^images\/a-red-lighthouse-[a-z0-9]+-1\.png$/);
			// The faux chat model reads text only: it is told the paths, and the transcript shows the images.
			const result = script.requests[1]?.messages.at(-1)?.text ?? "";
			expect(result).toContain(saved[0]);
			const snapshot = await service.runtime.snapshot(ctx, session.id);
			const tool = snapshot.items.find((item): item is ToolItem => item.kind === "tool");
			expect(tool).toMatchObject({ name: GENERATE_IMAGE_TOOL, status: "done" });
			expect(tool?.images).toEqual([
				{ mimeType: "image/png", data: PIXEL },
				{ mimeType: "image/png", data: PIXEL },
			]);
			// Nothing added to the system prompt.
			expect(script.requests[0]?.system ?? "").not.toMatch(/image/i);
		} finally {
			await service.close();
		}
	});

	it("sends reference images from the session's files for an edit", async () => {
		const { service, script, calls, files } = setUp([gatewayModel("scripted-1", ["image"])]);
		try {
			files.set("images/cat.png", Uint8Array.from(atob(PIXEL), (char) => char.charCodeAt(0)));
			await service.profiles.put(ctx, profile({ route: "images" }));
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "artist" });
			script.reply(
				{
					toolCalls: [
						{ name: GENERATE_IMAGE_TOOL, args: { prompt: "Give it a hat", reference_images: ["images/cat.png"] } },
					],
				},
				{ text: "Done" },
			);
			const submission = await service.runtime.prompt(ctx, session.id, { text: "Edit it" });
			await service.runtime.wait(ctx, session.id, submission.id);
			expect(calls[0]?.images).toEqual([{ mimeType: "image/png", data: PIXEL }]);
		} finally {
			await service.close();
		}
	});

	it("isn't offered without an image model, or when the gateway doesn't list it as one", async () => {
		for (const [listed, imageModel] of [
			[[gatewayModel("scripted-1", ["image"])], undefined],
			[[gatewayModel("scripted-1", ["text"])], { route: "images" }],
		] as const) {
			const { service, script, calls } = setUp(listed);
			try {
				await service.profiles.put(ctx, profile(imageModel));
				const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "artist" });
				script.reply({ toolCalls: [{ name: GENERATE_IMAGE_TOOL, args: { prompt: "x" } }] }, { text: "Done" });
				const submission = await service.runtime.prompt(ctx, session.id, { text: "Draw" });
				await service.runtime.wait(ctx, session.id, submission.id);
				expect(calls).toHaveLength(0);
				const tool = (await service.runtime.snapshot(ctx, session.id)).items.find(
					(item): item is ToolItem => item.kind === "tool",
				);
				expect(tool?.status).toBe("error");
			} finally {
				await service.close();
			}
		}
	});

	it("names files from the prompt's first words", () => {
		expect(imageStem("A red lighthouse, on a rocky shore at dusk!")).toBe("a-red-lighthouse-on-a-rocky");
		expect(imageStem("???")).toBe("image");
	});
});
