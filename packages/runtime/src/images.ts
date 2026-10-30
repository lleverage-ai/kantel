/**
 * `generate_image`: the agent makes or edits images with its profile's image model (`AgentProfile.imageModel`), through
 * the model gateway's `images` operation. Decoupled from the chat model: the session can chat with any connector and
 * draw with another.
 *
 * - **When it is offered.** Only when the profile names an image model, the deployment gives the runtime `images`, and
 *   the gateway's config for the session lists that model with `image` in its `output`. Nothing else turns it on.
 * - **What it adds to the prompt.** Its name, description and schema; nothing else (no system text).
 * - **Session files.** Each image is written to the session's files (its workspace, through the call's execution
 *   environment) under `images/`, and reference images for an edit are read from there by path, so the model can edit an
 *   image it made or one a person put in the workspace. A session with no environment still gets its images, unsaved.
 * - **What the model gets back.** The images as image content when the chat model reads images, else their paths only.
 *   The transcript shows them either way: as the result's content, or in its UI details (`details.images`).
 *   Each image shown or sent is held to `MAX_INLINE_IMAGE_CHARS` of base64 (a conversation row holds at most 2 MB):
 *   a larger one goes in scaled down (`./image-preview.ts`), so the model can still check what it made, and the
 *   saved file stays full size. One that can't be scaled down is only saved, and the result says so.
 * - **What the person sees.** The saved images are presented, as `present_files` presents files (`details.
 *   presentedFiles`), each with the model that made it, so the transcript shows them as image cards that open in the
 *   viewer. The transcript carries the model as data; it never reads it from the result's text.
 * - **Replay.** Not replay-safe: each call costs money, so a call cut short by a restart is not run again.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ModelGatewayModel, ModelImage, ModelImagesRequest, ModelImagesResult } from "@harbour/contracts";
import { previewImage } from "./image-preview.ts";

/** The tool's name. */
export const GENERATE_IMAGE_TOOL = "generate_image";
/** Where generated images are saved in the session's files. */
export const GENERATED_IMAGES_DIR = "images";
/** The most base64 one image may hold to go into the conversation; a larger one is only saved. */
export const MAX_INLINE_IMAGE_CHARS = 450_000;
/** The most reference images one edit takes. */
export const MAX_TOOL_REFERENCE_IMAGES = 4;

/** The model gateway's image operation for one session. */
export interface SessionImages {
	/** The models the session may call, as the gateway's config lists them (`output` included). */
	models(signal?: AbortSignal): Promise<readonly ModelGatewayModel[]>;
	/** One `images` call, as the session. */
	generate(request: ModelImagesRequest, signal?: AbortSignal): Promise<ModelImagesResult>;
}

export const generateImageSchema = Type.Object({
	prompt: Type.String({
		description: "What to draw, or for an edit, how to change the reference images.",
		minLength: 1,
	}),
	aspect: Type.Optional(
		Type.Union([Type.Literal("square"), Type.Literal("landscape"), Type.Literal("portrait")], {
			description: "The shape of the image. Default square.",
		}),
	),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "How many images to make. Default 1." })),
	reference_images: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_TOOL_REFERENCE_IMAGES,
			description:
				"Paths of image files in the session's files (PNG, JPEG or WebP) to edit or work from, such as an earlier result.",
		}),
	),
});

const DESCRIPTION = [
	"Generate images from a text prompt, or edit images by passing reference_images.",
	`Images are saved in the session's files under ${GENERATED_IMAGES_DIR}/ and their paths returned.`,
].join("\n");

const EXTENSIONS: { readonly [mimeType: string]: string } = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

const TYPES: { readonly [extension: string]: string } = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

/** A short file-name stem from the prompt: its first words, lower case, letters and digits only. */
export function imageStem(prompt: string): string {
	const words = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter((word) => word !== "")
		.slice(0, 6);
	return words.length === 0 ? "image" : words.join("-").slice(0, 48);
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
	return bytes;
}

/** A saved image, presented to the person as `present_files` presents a file (`PresentedFile` in `@harbour/protocol`). */
export type GeneratedImageFile = {
	readonly workspaceId: string;
	readonly path: string;
	readonly name: string;
	readonly mimeType: string;
	readonly size: number;
	/** The model that made it. */
	readonly model: string;
};

/** The UI details of a call: what the transcript shows, and where each image went. */
export type GenerateImageDetails = {
	readonly images?: readonly { readonly mimeType: string; readonly data: string }[];
	readonly files: readonly string[];
	readonly model: string;
	/** The saved images, for the transcript's cards; only for a session with a workspace. */
	readonly presentedFiles?: readonly GeneratedImageFile[];
};

export interface GenerateImageToolOptions {
	readonly images: SessionImages;
	/** The gateway model ID the profile's image model resolves to: a route, or `<route>:<modelId>`. */
	readonly modelId: string;
	/** For file names: the time each call starts. Default `Date.now`. */
	readonly now?: () => number;
	/** The session's workspace, where its files are: the saved images are presented from it. */
	readonly workspaceId?: string;
}

/** `generate_image` for one session. */
export function createGenerateImageTool(
	options: GenerateImageToolOptions,
): ToolRegistration<typeof generateImageSchema> {
	const now = options.now ?? (() => Date.now());
	return defineTool({
		name: GENERATE_IMAGE_TOOL,
		description: DESCRIPTION,
		parameters: generateImageSchema,
		// Each call costs money: one cut short by a restart is not made again.
		replay: "unsafe",
		async execute(args, api, context) {
			const env = api.env;
			const references: ModelImage[] = [];
			for (const path of args.reference_images ?? []) {
				if (env === undefined) throw new Error("This session has no files to read reference images from");
				const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
				const mimeType = TYPES[extension];
				if (mimeType === undefined) throw new Error(`${path} isn't a PNG, JPEG, WebP or GIF image`);
				const read = await env.readBinaryFile(path, context);
				if (!read.ok) throw new Error(`${path}: ${read.error.message}`);
				references.push({ mimeType, data: toBase64(read.value) });
			}
			const result = await options.images.generate(
				{
					model: options.modelId,
					prompt: args.prompt,
					...(args.aspect === undefined ? {} : { aspect: args.aspect }),
					...(args.count === undefined ? {} : { count: args.count }),
					...(references.length === 0 ? {} : { images: references }),
					// Small enough to show and send: gpt-image's PNGs run to megabytes; models that pick their own ignore it.
					outputFormat: "jpeg",
				},
				context.abortSignal,
			);

			const stem = `${imageStem(args.prompt)}-${now().toString(36)}`;
			const files: string[] = [];
			const presented: GeneratedImageFile[] = [];
			const unsaved: string[] = [];
			for (const [index, image] of result.images.entries()) {
				const name = `${stem}${result.images.length === 1 ? "" : `-${index + 1}`}.${EXTENSIONS[image.mimeType] ?? "png"}`;
				const path = `${GENERATED_IMAGES_DIR}/${name}`;
				if (env === undefined) {
					unsaved.push(name);
					continue;
				}
				const bytes = fromBase64(image.data);
				const written = await env.writeFile(path, bytes, context);
				if (!written.ok) {
					unsaved.push(`${name} (${written.error.message})`);
					continue;
				}
				files.push(path);
				if (options.workspaceId !== undefined) {
					presented.push({
						workspaceId: options.workspaceId,
						path,
						name,
						mimeType: image.mimeType,
						size: bytes.length,
						model: result.modelId,
					});
				}
			}

			// Each image as it can go into the conversation: itself, or scaled down to fit.
			const previews = await Promise.all(result.images.map((image) => previewImage(image, MAX_INLINE_IMAGE_CHARS)));
			const inline = previews.filter((image) => image !== undefined);
			const scaled = previews.filter((image) => image !== undefined && "sourceWidth" in image);
			const agent = await api.agent(context);
			// The chat model the session runs with now: whether it reads images decides what the result carries.
			const chat =
				agent.model === undefined ? undefined : api.models.getModel(agent.model.provider, agent.model.modelId);
			const seesImages = chat?.input.includes("image") === true;

			const lines = [
				`Made ${result.images.length === 1 ? "1 image" : `${result.images.length} images`} with ${result.modelId}.`,
			];
			if (files.length > 0) lines.push("Saved in the session's files:", ...files);
			if (unsaved.length > 0) lines.push("Not saved:", ...unsaved);
			if (presented.length > 0) {
				lines.push(
					presented.length === 1
						? "The person sees it in the conversation already."
						: "The person sees them in the conversation already.",
				);
			}
			if (seesImages && scaled.length > 0) {
				const first = scaled[0];
				const size =
					first !== undefined && "sourceWidth" in first
						? ` (${first.width}x${first.height} of ${first.sourceWidth}x${first.sourceHeight})`
						: "";
				lines.push(
					`${scaled.length === 1 ? "1 is" : `${scaled.length} are`} shown here scaled down${size}; the saved file is full size.`,
				);
			}
			if (inline.length < result.images.length) {
				lines.push(`${result.images.length - inline.length} too large to show here; open the saved file instead.`);
			}
			const revised = result.images.map((image) => image.revisedPrompt).filter((text) => text !== undefined);
			if (revised.length > 0) lines.push(`The model rewrote the prompt as: ${revised[0]}`);
			if (result.text !== undefined && result.text.trim() !== "") lines.push(result.text.trim());

			const shown = inline.map((image) => ({ mimeType: image.mimeType, data: image.data }));
			return {
				output: [
					{ type: "text", text: lines.join("\n") },
					...(seesImages ? shown.map((image) => ({ type: "image" as const, ...image })) : []),
				],
				details: {
					// Shown in the transcript from the content when the model sees them, else from here.
					...(seesImages || shown.length === 0 ? {} : { images: shown }),
					files,
					model: result.modelId,
					...(presented.length === 0 ? {} : { presentedFiles: presented }),
				} satisfies GenerateImageDetails,
			};
		},
	});
}
