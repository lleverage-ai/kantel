// `generate_image` (`SessionRuntimeOptions.images`): offered only when the profile names an image model the gateway lists
// with image output, saved in the session's files, shown inline, and adding no prompt text of its own.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
	AgentProfile,
	ModelGatewayModel,
	ModelImagesRequest,
	ModelImagesResult,
	PromptAttachment,
	SessionRecord,
} from "@kantel/contracts";
import type { ToolItem } from "@kantel/protocol";
import {
	GENERATE_IMAGE_TOOL,
	imageStem,
	MAX_INLINE_IMAGE_CHARS,
	type PromptAttachments,
	type SessionImages,
	uploadName,
} from "@kantel/runtime";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { encode as encodeJpeg } from "jpeg-js";
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

/** A 1536 by 1024 JPEG of noise: too large to go into the conversation as it is. */
function largeJpeg(): string {
	const data = new Uint8Array(1536 * 1024 * 4);
	for (let at = 0; at < data.length; at += 65_536) crypto.getRandomValues(data.subarray(at, at + 65_536));
	return Buffer.from(encodeJpeg({ width: 1536, height: 1024, data }, 95).data).toString("base64");
}

/** The gateway's image side for a test: what config lists, and each `images` call it was asked for. */
function fakeImages(listed: readonly ModelGatewayModel[], made = { mimeType: "image/png", data: PIXEL }) {
	const calls: ModelImagesRequest[] = [];
	const images: SessionImages = {
		models: async () => listed,
		async generate(request): Promise<ModelImagesResult> {
			calls.push(request);
			return {
				images: Array.from({ length: request.count ?? 1 }, () => made),
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

/** An environment holding files in memory: only `writeFile`, `readBinaryFile` and `exists` are used. */
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
			async exists(path: string) {
				return { ok: true, value: files.has(path) };
			},
			async readBinaryFile(path: string) {
				const held = files.get(path);
				return held === undefined
					? { ok: false, error: { code: "not_found", message: `${path} not found` } }
					: { ok: true, value: held };
			},
		}) as unknown as ExecutionEnv;
}

function setUp(listed: readonly ModelGatewayModel[], made?: { mimeType: string; data: string }) {
	const { models, script } = createScriptedModel();
	const { images, calls } = fakeImages(listed, made);
	const files = new Map<string, Uint8Array>();
	const service = createMemoryRuntime({
		models,
		images: () => images,
		environment: memoryEnv(files),
		attachments: photoHost,
	});
	return { service, script, calls, files };
}

const PHOTO_BYTES = Uint8Array.from(atob(PIXEL), (char) => char.charCodeAt(0));
const photo: PromptAttachment = { id: "p1", name: "image.jpg", type: "image/jpeg", size: 3, kind: "image" };

/** A host holding one uploaded photo, `image.jpg`: the model sees it, and the runtime gets its bytes to save. */
const photoHost: PromptAttachments = {
	async read(_ctx, _session, attachments) {
		return {
			blocks: [
				{ type: "text", text: '<file name="image.jpg" type="image/jpeg">' },
				{ type: "image", data: PIXEL, mimeType: "image/jpeg" },
				{ type: "text", text: "</file>" },
			],
			attachments: attachments.map(() => photo),
			files: attachments.map(() => ({ attachment: photo, bytes: PHOTO_BYTES })),
		};
	},
};

describe("generate_image", () => {
	it("makes images with the profile's image model, saves them in the session's files and shows them inline", async () => {
		const { service, script, calls, files } = setUp([gatewayModel("scripted-1", ["image"])]);
		try {
			await service.profiles.put(ctx, profile({ route: "images" }));
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "artist" });
			script.reply(
				{
					toolCalls: [
						{ name: GENERATE_IMAGE_TOOL, args: { prompt: "A red lighthouse", aspect: "landscape", count: 2 } },
					],
				},
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
			files.set(
				"images/cat.png",
				Uint8Array.from(atob(PIXEL), (char) => char.charCodeAt(0)),
			);
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

	it("edits a photo attached to the prompt: it is saved in the session's files and the model is told where", async () => {
		// Before this, the model saw the photo but had no file to pass as a reference, so it couldn't edit it.
		const { service, script, calls, files } = setUp([gatewayModel("scripted-1", ["image"])]);
		try {
			files.set("uploads/image.jpg", new Uint8Array([1, 2, 3]));
			await service.profiles.put(ctx, profile({ route: "images" }));
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "artist" });
			script.reply(
				{
					toolCalls: [
						{
							name: GENERATE_IMAGE_TOOL,
							args: { prompt: "Put a lion in the background", reference_images: ["uploads/image-2.jpg"] },
						},
					],
				},
				{ text: "Done" },
			);
			const submission = await service.runtime.prompt(ctx, session.id, {
				text: "Put a lion in the background of this",
				attachments: [photo],
			});
			await service.runtime.wait(ctx, session.id, submission.id);

			// An earlier upload of the same name is kept: every iPhone photo is `image.jpg`.
			expect(files.get("uploads/image.jpg")).toEqual(new Uint8Array([1, 2, 3]));
			expect(files.get("uploads/image-2.jpg")).toEqual(PHOTO_BYTES);
			const sent = script.requests[0]?.messages.at(-1)?.text ?? "";
			expect(sent).toContain("uploads/image-2.jpg (attached as image.jpg)");
			expect(sent.indexOf("uploads/image-2.jpg")).toBeLessThan(sent.indexOf("Put a lion in the background of this"));
			expect(calls[0]?.images).toEqual([{ mimeType: "image/jpeg", data: PIXEL }]);

			// The transcript shows the words and the file, not where it was saved.
			const user = (await service.runtime.snapshot(ctx, session.id)).items.find((item) => item.kind === "user");
			expect(user).toMatchObject({ kind: "user", text: "Put a lion in the background of this", attachments: [photo] });
		} finally {
			await service.close();
		}
	});

	it("still sends an attached photo when its file can't be saved", async () => {
		const { models, script } = createScriptedModel();
		const refusing = ((record: SessionRecord) =>
			({
				id: `env:${record.id}`,
				cwd: "/workspace",
				cleanup: async () => {},
				async exists() {
					return { ok: true, value: false };
				},
				async writeFile() {
					return { ok: false, error: { code: "permission_denied", message: "read-only" } };
				},
			}) as unknown as ExecutionEnv) satisfies (record: SessionRecord) => ExecutionEnv;
		const service = createMemoryRuntime({ models, environment: refusing, attachments: photoHost });
		try {
			await service.profiles.put(ctx, profile());
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "artist" });
			script.reply({ text: "A pixel." });
			const submission = await service.runtime.prompt(ctx, session.id, { text: "What is it?", attachments: [photo] });
			expect(await service.runtime.wait(ctx, session.id, submission.id)).toMatchObject({ answer: "A pixel." });
			const sent = script.requests[0]?.messages.at(-1)?.text ?? "";
			expect(sent).toContain("What is it?");
			expect(sent).not.toContain("uploads/");
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

	it("presents the saved images, each with the model that made it, in a session with a workspace", async () => {
		const { service, script } = setUp([gatewayModel("scripted-1", ["image"])]);
		try {
			await service.profiles.put(ctx, profile({ route: "images" }));
			const session = await service.runtime.create(ctx, {
				projectId: "proj",
				agentId: "artist",
				workspaceId: "ws-1",
			});
			script.reply(
				{ toolCalls: [{ name: GENERATE_IMAGE_TOOL, args: { prompt: "A red lighthouse", aspect: "portrait" } }] },
				{ text: "Done" },
			);
			const submission = await service.runtime.prompt(ctx, session.id, { text: "Draw one" });
			await service.runtime.wait(ctx, session.id, submission.id);
			const tool = (await service.runtime.snapshot(ctx, session.id)).items.find(
				(item): item is ToolItem => item.kind === "tool",
			);
			expect(tool?.label).toBe("Making an image");
			expect(tool?.files).toEqual([
				expect.objectContaining({
					workspaceId: "ws-1",
					path: expect.stringMatching(/^images\/a-red-lighthouse-[a-z0-9]+\.png$/),
					mimeType: "image/png",
					model: "gpt-image-1",
				}),
			]);
			expect(script.requests[1]?.messages.at(-1)?.text ?? "").toContain("The person sees it in the conversation");
		} finally {
			await service.close();
		}
	});

	it("shows an image too large for the conversation scaled down, and keeps the file full size", async () => {
		const made = { mimeType: "image/jpeg", data: largeJpeg() };
		expect(made.data.length).toBeGreaterThan(MAX_INLINE_IMAGE_CHARS);
		const { service, script, files } = setUp([gatewayModel("scripted-1", ["image"])], made);
		try {
			await service.profiles.put(ctx, profile({ route: "images" }));
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "artist" });
			script.reply({ toolCalls: [{ name: GENERATE_IMAGE_TOOL, args: { prompt: "Noise" } }] }, { text: "Done" });
			const submission = await service.runtime.prompt(ctx, session.id, { text: "Draw" });
			await service.runtime.wait(ctx, session.id, submission.id);
			const saved = [...files.values()][0];
			expect(saved?.length).toBe(Buffer.from(made.data, "base64").length);
			const tool = (await service.runtime.snapshot(ctx, session.id)).items.find(
				(item): item is ToolItem => item.kind === "tool",
			);
			expect(tool?.images).toHaveLength(1);
			expect(tool?.images?.[0]?.mimeType).toBe("image/jpeg");
			expect(tool?.images?.[0]?.data?.length).toBeLessThanOrEqual(MAX_INLINE_IMAGE_CHARS);
			expect(script.requests[1]?.messages.at(-1)?.text ?? "").not.toContain("too large");
		} finally {
			await service.close();
		}
	});

	it("names files from the prompt's first words", () => {
		expect(imageStem("A red lighthouse, on a rocky shore at dusk!")).toBe("a-red-lighthouse-on-a-rocky");
		expect(imageStem("???")).toBe("image");
	});
});

describe("uploadName", () => {
	it("keeps a file name as one path segment", () => {
		expect(uploadName("image.jpg")).toBe("image.jpg");
		expect(uploadName("a/b\\c.png")).toBe("a-b-c.png");
		expect(uploadName("..")).toBe("file");
		expect(uploadName("  ")).toBe("file");
		expect(uploadName("line\nbreak.txt")).toBe("line-break.txt");
	});
});
