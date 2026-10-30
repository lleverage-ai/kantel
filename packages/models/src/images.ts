/**
 * Image generation over the `openai-images` wire API (docs/model-connectors.md, "Image generation"): one request to
 * `POST <API root>/images/generations`, or `/images/edits` as multipart form data when the call sends reference images.
 *
 * - **The request.** `model`, `prompt`, `n`, and a size the model takes for the shape asked (`sizeFor`); `quality` only
 *   for `gpt-image-*`; `response_format: "b64_json"` only for `dall-e-*`, whose default is a URL (`gpt-image-*` always
 *   answers base64 and refuses the field). The preset's `imagePayload` adds attribution to a generation's JSON body.
 * - **The answer.** `data[].b64_json` (or `data[].url`, fetched once without the key), `revised_prompt`, and `usage`
 *   (`gpt-image-*`'s token counts). A reported cost is read from `usage.cost` or LiteLLM's `x-litellm-response-cost`.
 * - **Pricing** (`pricedImages`): the reported cost where the preset reports one, else tokens at the model's rates
 *   when the upstream counted any, else the per-image rate times the images, else 0; a `cost: "none"` preset is $0.
 */
import {
	HarbourError,
	MAX_IMAGES_PER_CALL,
	MAX_REFERENCE_IMAGES,
	type ModelCallRecord,
	type ModelImage,
	type ModelImageAspect,
	type ModelImagesRequest,
	type ModelRates,
	type ModelUsage,
} from "@harbour/contracts";
import type { OfferedModel } from "./catalogue.ts";
import { imagesUrl } from "./presets.ts";

/** The prompt the console's "Test generate" sends when none is given. */
export const TEST_IMAGE_PROMPT = "A small red lighthouse on a rocky shore, flat illustration";
/** The route name a console test is recorded under. */
export const TEST_IMAGE_ROUTE = "connector-test";
/** The agent ID console calls are recorded under. */
export const CONSOLE_AGENT = "console";
/** The most a prompt may hold, in characters (gpt-image's limit is 32,000). */
export const MAX_IMAGE_PROMPT_LENGTH = 32_000;
/** The most one reference image may hold, decoded: OpenAI's edit limit for gpt-image. */
export const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const ASPECTS: readonly ModelImageAspect[] = ["square", "landscape", "portrait"];
const QUALITIES = ["low", "medium", "high", "auto"];
const FORMATS = ["png", "jpeg", "webp"];

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Rejects with `invalid` unless `request` has the shape of a `ModelImagesRequest`. */
export function assertImagesRequest(request: unknown): asserts request is ModelImagesRequest {
	if (!isRecord(request) || typeof request.model !== "string" || request.model === "") {
		throw new HarbourError("invalid", "An images request names a model");
	}
	if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
		throw new HarbourError("invalid", "An images request has a prompt");
	}
	if (request.prompt.length > MAX_IMAGE_PROMPT_LENGTH) {
		throw new HarbourError("invalid", `A prompt holds at most ${MAX_IMAGE_PROMPT_LENGTH} characters`);
	}
	const { count, aspect, size, quality, outputFormat, images } = request;
	if (outputFormat !== undefined && !FORMATS.includes(outputFormat as string)) {
		throw new HarbourError("invalid", `Unknown output format ${String(outputFormat)}`);
	}
	if (
		count !== undefined &&
		(!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_IMAGES_PER_CALL)
	) {
		throw new HarbourError("invalid", `An images request asks for 1 to ${MAX_IMAGES_PER_CALL} images`);
	}
	if (aspect !== undefined && !ASPECTS.includes(aspect as ModelImageAspect)) {
		throw new HarbourError("invalid", `Unknown aspect ${String(aspect)}`);
	}
	if (size !== undefined && (typeof size !== "string" || !/^(auto|\d{2,5}x\d{2,5})$/.test(size))) {
		throw new HarbourError("invalid", "A size is `auto` or `<width>x<height>`");
	}
	if (quality !== undefined && !QUALITIES.includes(quality as string)) {
		throw new HarbourError("invalid", `Unknown quality ${String(quality)}`);
	}
	if (images === undefined) return;
	if (!Array.isArray(images) || images.length > MAX_REFERENCE_IMAGES) {
		throw new HarbourError("invalid", `An images request sends at most ${MAX_REFERENCE_IMAGES} reference images`);
	}
	for (const image of images as unknown[]) {
		if (!isRecord(image) || typeof image.mimeType !== "string" || !IMAGE_MIME_TYPES.includes(image.mimeType)) {
			throw new HarbourError("invalid", "A reference image is a PNG, JPEG, WebP or GIF");
		}
		if (typeof image.data !== "string" || image.data === "" || !BASE64.test(image.data)) {
			throw new HarbourError("invalid", "A reference image is base64");
		}
		if ((image.data.length * 3) / 4 > MAX_REFERENCE_IMAGE_BYTES) {
			throw new HarbourError("invalid", "A reference image holds at most 50 MB");
		}
	}
}

/** What kind of OpenAI image model `modelId` is, for the sizes and fields it takes. */
function familyOf(modelId: string): "gpt-image" | "dall-e-3" | "dall-e-2" | "other" {
	const id = modelId.toLowerCase();
	if (id.includes("gpt-image")) return "gpt-image";
	if (id.includes("dall-e-3")) return "dall-e-3";
	if (id.includes("dall-e-2")) return "dall-e-2";
	return "other";
}

/**
 * The size sent for a request: its exact `size`, else the shape's size for the model's family (gpt-image's 1024x1024,
 * 1536x1024 and 1024x1536; DALL·E 3's 1792 sides; DALL·E 2 is square only). Undefined, so the upstream picks, when
 * neither is given, or for a model of another family asked for a shape other than square.
 */
export function sizeFor(modelId: string, request: Pick<ModelImagesRequest, "size" | "aspect">): string | undefined {
	if (request.size !== undefined) return request.size;
	const aspect = request.aspect;
	if (aspect === undefined) return undefined;
	switch (familyOf(modelId)) {
		case "gpt-image":
			return aspect === "square" ? "1024x1024" : aspect === "landscape" ? "1536x1024" : "1024x1536";
		case "dall-e-3":
			return aspect === "square" ? "1024x1024" : aspect === "landscape" ? "1792x1024" : "1024x1792";
		case "dall-e-2":
			return "1024x1024";
		case "other":
			return aspect === "square" ? "1024x1024" : undefined;
	}
}

/** The image's type from its first bytes, so a mislabelled upstream can't make the store serve the wrong type. */
export function sniffImageType(data: string): string | undefined {
	const head = atob(data.slice(0, 24).replace(/=+$/, "").slice(0, 16));
	const bytes = [...head].map((char) => char.charCodeAt(0));
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (head.startsWith("GIF8")) return "image/gif";
	if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
	return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let at = 0; at < bytes.length; at += chunk) {
		binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
	}
	return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
	return bytes;
}

/** What one upstream image call answered. */
export type ImagesCall =
	| {
			readonly ok: true;
			readonly status: number;
			readonly images: readonly (ModelImage & { readonly revisedPrompt?: string })[];
			readonly text?: string;
			/** Token counts, when the upstream gave them (`gpt-image-*`). */
			readonly tokens?: { readonly input: number; readonly output: number; readonly total: number };
			/** The cost the upstream reported, in US dollars. */
			readonly reportedCost?: number;
	  }
	| { readonly ok: false; readonly status: number; readonly errorMessage: string };

export interface OpenAIImagesInput {
	readonly fetch: typeof fetch;
	/** The API root, such as `https://api.openai.com/v1`. */
	readonly baseUrl: string;
	readonly modelId: string;
	readonly request: ModelImagesRequest;
	/** The key and attribution headers. */
	readonly headers: { readonly [name: string]: string };
	/** The preset's change to a generation's JSON body. */
	readonly payload?: (body: { readonly [key: string]: unknown }) => { readonly [key: string]: unknown };
	readonly signal?: AbortSignal;
}

const finite = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The upstream's error text: `error.message` from an OpenAI-style body, else the body itself, trimmed. */
async function errorText(response: Response): Promise<string> {
	const body = await response.text().catch(() => "");
	try {
		const parsed: unknown = JSON.parse(body);
		if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
			return parsed.error.message;
		}
	} catch {
		// Not JSON: the text stands.
	}
	return body.slice(0, 500) || response.statusText || "The upstream refused the request";
}

/** Makes one `openai-images` call. Never retries. */
export async function openaiImages(input: OpenAIImagesInput): Promise<ImagesCall> {
	const { request, modelId } = input;
	const family = familyOf(modelId);
	const edit = (request.images?.length ?? 0) > 0;
	const size = sizeFor(modelId, request);
	const fields: { [key: string]: string | number } = {
		model: modelId,
		prompt: request.prompt,
		n: request.count ?? 1,
		...(size === undefined ? {} : { size }),
		...(family === "gpt-image" && request.quality !== undefined ? { quality: request.quality } : {}),
		...(family === "gpt-image" && request.outputFormat !== undefined ? { output_format: request.outputFormat } : {}),
		...(family === "dall-e-2" || family === "dall-e-3" ? { response_format: "b64_json" } : {}),
	};
	let body: string | FormData;
	const headers: { [name: string]: string } = { ...input.headers };
	if (edit) {
		const form = new FormData();
		for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
		const images = request.images ?? [];
		images.forEach((image, index) => {
			const extension = image.mimeType.split("/")[1] ?? "png";
			form.append(
				images.length > 1 ? "image[]" : "image",
				new Blob([base64ToBytes(image.data)], { type: image.mimeType }),
				`image-${index + 1}.${extension}`,
			);
		});
		body = form;
	} else {
		body = JSON.stringify(input.payload === undefined ? fields : input.payload(fields));
		headers["content-type"] = "application/json";
	}
	const response = await input.fetch(imagesUrl(input.baseUrl, edit), {
		method: "POST",
		headers,
		body,
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
	if (!response.ok) return { ok: false, status: response.status, errorMessage: await errorText(response) };
	const parsed: unknown = await response.json().catch(() => undefined);
	if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
		return { ok: false, status: 502, errorMessage: "The upstream answered without images" };
	}
	const images: (ModelImage & { revisedPrompt?: string })[] = [];
	for (const entry of parsed.data as unknown[]) {
		if (!isRecord(entry)) continue;
		let data: string | undefined;
		let declared: string | undefined;
		if (typeof entry.b64_json === "string" && entry.b64_json !== "") data = entry.b64_json;
		else if (typeof entry.url === "string" && /^https:\/\//.test(entry.url)) {
			const fetched = await input.fetch(entry.url, input.signal === undefined ? {} : { signal: input.signal });
			if (!fetched.ok) continue;
			declared = fetched.headers.get("content-type")?.split(";")[0]?.trim();
			data = bytesToBase64(new Uint8Array(await fetched.arrayBuffer()));
		}
		if (data === undefined) continue;
		const outputFormat = typeof parsed.output_format === "string" ? `image/${parsed.output_format}` : undefined;
		const mimeType = sniffImageType(data) ?? declared ?? outputFormat ?? "image/png";
		if (!IMAGE_MIME_TYPES.includes(mimeType)) continue;
		images.push({
			mimeType,
			data,
			...(typeof entry.revised_prompt === "string" && entry.revised_prompt !== ""
				? { revisedPrompt: entry.revised_prompt }
				: {}),
		});
	}
	if (images.length === 0) return { ok: false, status: 502, errorMessage: "The upstream answered without images" };
	const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
	const input_ = finite(usage?.input_tokens) ?? finite(usage?.prompt_tokens);
	const output = finite(usage?.output_tokens) ?? finite(usage?.completion_tokens);
	const tokens =
		input_ === undefined && output === undefined
			? undefined
			: {
					input: input_ ?? 0,
					output: output ?? 0,
					total: finite(usage?.total_tokens) ?? (input_ ?? 0) + (output ?? 0),
				};
	const header = response.headers.get("x-litellm-response-cost");
	const reportedCost = finite(usage?.cost) ?? (header === null ? undefined : finite(Number.parseFloat(header)));
	return {
		ok: true,
		status: response.status,
		images,
		...(tokens === undefined ? {} : { tokens }),
		...(reportedCost === undefined ? {} : { reportedCost }),
	};
}

/** The per-image rate a model's rates carry, if any. */
export function imageRate(rates: ModelRates | { readonly image?: number }): number | undefined {
	const rate = (rates as { readonly image?: unknown }).image;
	return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? rate : undefined;
}

/** The usage and cost of a successful image call, by the preset's cost source (see the module comment). */
export function pricedImages(
	cost: "reported" | "computed" | "none",
	target: OfferedModel,
	call: Extract<ImagesCall, { ok: true }>,
): { readonly usage: ModelUsage; readonly costSource: ModelCallRecord["costSource"] } {
	const tokens = call.tokens ?? { input: 0, output: 0, total: 0 };
	const counts = {
		input: tokens.input,
		output: tokens.output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens.total,
		images: call.images.length,
	};
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	if (cost === "none") return { usage: { ...counts, cost: zero }, costSource: "none" };
	if (cost === "reported" && call.reportedCost !== undefined) {
		return {
			usage: { ...counts, cost: { ...zero, output: call.reportedCost, total: call.reportedCost } },
			costSource: "reported",
		};
	}
	const rates = target.model.cost;
	if (call.tokens !== undefined && (rates.input > 0 || rates.output > 0)) {
		const input = (tokens.input * rates.input) / 1_000_000;
		const output = (tokens.output * rates.output) / 1_000_000;
		return {
			usage: { ...counts, cost: { ...zero, input, output, total: input + output } },
			costSource: "computed",
		};
	}
	const perImage = imageRate(rates);
	const output = perImage === undefined ? 0 : perImage * call.images.length;
	return { usage: { ...counts, cost: { ...zero, output, total: output } }, costSource: "computed" };
}
