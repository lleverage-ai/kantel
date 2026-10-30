/**
 * A smaller copy of a generated image, for the model to see and the transcript to show, when the image itself is too
 * large to go into the conversation (a row holds at most 2 MB, so one image is held to `MAX_INLINE_IMAGE_CHARS` of
 * base64). The saved file stays full size; only the copy in the conversation is scaled down.
 *
 * Pure JavaScript, so it runs the same in a Worker and in Node: JPEG through `jpeg-js` (decode and encode), PNG through
 * the platform's `DecompressionStream` and a small decoder for the 8-bit, non-interlaced PNGs image models make. Any
 * other image (WebP, GIF, a 16-bit or interlaced PNG) gets no preview, and the call says so as before.
 */
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";

/** An image as base64, as the gateway answers and the conversation holds. */
export type Base64Image = { readonly mimeType: string; readonly data: string };

/** Decoded pixels: 8-bit RGBA, row by row. */
type Pixels = { readonly width: number; readonly height: number; readonly data: Uint8Array };

/** The longest side a preview is made at first, then smaller ones until it fits. */
const PREVIEW_SIDES = [1024, 768, 512] as const;
/** The JPEG quality a preview is encoded at. */
const PREVIEW_QUALITY = 80;
/** The most pixels an image may have to be decoded for a preview (a 4096 by 4096 image). */
const MAX_PREVIEW_SOURCE_PIXELS = 4096 * 4096;

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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decodes an 8-bit, non-interlaced PNG (greyscale, RGB, palette, with or without alpha) to RGBA; else undefined. */
export async function decodePng(bytes: Uint8Array): Promise<Pixels | undefined> {
	if (bytes.length < 33 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let width = 0;
	let height = 0;
	let colourType = -1;
	let palette: Uint8Array | undefined;
	let transparency: Uint8Array | undefined;
	const chunks: Uint8Array[] = [];
	let offset = 8;
	while (offset + 8 <= bytes.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
		const body = bytes.subarray(offset + 8, offset + 8 + length);
		offset += 12 + length;
		if (type === "IHDR") {
			if (body.length < 13) return undefined;
			const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
			width = header.getUint32(0);
			height = header.getUint32(4);
			const depth = body[8];
			colourType = body[9] ?? -1;
			const interlace = body[12];
			if (depth !== 8 || interlace !== 0) return undefined;
		} else if (type === "PLTE") palette = body;
		else if (type === "tRNS") transparency = body;
		else if (type === "IDAT") chunks.push(body);
		else if (type === "IEND") break;
	}
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType as 0 | 2 | 3 | 4 | 6];
	if (channels === undefined || width === 0 || height === 0 || chunks.length === 0) return undefined;
	if (width * height > MAX_PREVIEW_SOURCE_PIXELS) return undefined;
	if (colourType === 3 && palette === undefined) return undefined;
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const compressed = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		compressed.set(chunk, at);
		at += chunk.length;
	}
	const raw = await inflate(compressed);
	const stride = width * channels;
	if (raw.length < (stride + 1) * height) return undefined;
	const rows = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const source = y * (stride + 1) + 1;
		const target = y * stride;
		for (let x = 0; x < stride; x++) {
			const value = raw[source + x] ?? 0;
			const left = x >= channels ? (rows[target + x - channels] ?? 0) : 0;
			const up = y > 0 ? (rows[target - stride + x] ?? 0) : 0;
			const corner = y > 0 && x >= channels ? (rows[target - stride + x - channels] ?? 0) : 0;
			let predicted = 0;
			if (filter === 1) predicted = left;
			else if (filter === 2) predicted = up;
			else if (filter === 3) predicted = (left + up) >> 1;
			else if (filter === 4) {
				const estimate = left + up - corner;
				const toLeft = Math.abs(estimate - left);
				const toUp = Math.abs(estimate - up);
				const toCorner = Math.abs(estimate - corner);
				predicted = toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
			} else if (filter !== 0) return undefined;
			rows[target + x] = (value + predicted) & 0xff;
		}
	}
	const data = new Uint8Array(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) {
		const from = pixel * channels;
		const to = pixel * 4;
		if (colourType === 3) {
			const index = rows[from] ?? 0;
			data[to] = palette?.[index * 3] ?? 0;
			data[to + 1] = palette?.[index * 3 + 1] ?? 0;
			data[to + 2] = palette?.[index * 3 + 2] ?? 0;
			data[to + 3] = transparency?.[index] ?? 255;
		} else if (channels <= 2) {
			const grey = rows[from] ?? 0;
			data[to] = grey;
			data[to + 1] = grey;
			data[to + 2] = grey;
			data[to + 3] = channels === 2 ? (rows[from + 1] ?? 255) : 255;
		} else {
			data[to] = rows[from] ?? 0;
			data[to + 1] = rows[from + 1] ?? 0;
			data[to + 2] = rows[from + 2] ?? 0;
			data[to + 3] = channels === 4 ? (rows[from + 3] ?? 255) : 255;
		}
	}
	return { width, height, data };
}

/** Scales RGBA pixels down to `width` by `height`, averaging each target pixel's area, onto white where transparent. */
export function scaleDown(source: Pixels, width: number, height: number): Pixels {
	const data = new Uint8Array(width * height * 4);
	const xRatio = source.width / width;
	const yRatio = source.height / height;
	for (let y = 0; y < height; y++) {
		const top = Math.floor(y * yRatio);
		const bottom = Math.max(top + 1, Math.floor((y + 1) * yRatio));
		for (let x = 0; x < width; x++) {
			const left = Math.floor(x * xRatio);
			const right = Math.max(left + 1, Math.floor((x + 1) * xRatio));
			let red = 0;
			let green = 0;
			let blue = 0;
			let count = 0;
			for (let sy = top; sy < bottom && sy < source.height; sy++) {
				for (let sx = left; sx < right && sx < source.width; sx++) {
					const at = (sy * source.width + sx) * 4;
					const alpha = (source.data[at + 3] ?? 255) / 255;
					red += (source.data[at] ?? 0) * alpha + 255 * (1 - alpha);
					green += (source.data[at + 1] ?? 0) * alpha + 255 * (1 - alpha);
					blue += (source.data[at + 2] ?? 0) * alpha + 255 * (1 - alpha);
					count += 1;
				}
			}
			const to = (y * width + x) * 4;
			data[to] = Math.round(red / count);
			data[to + 1] = Math.round(green / count);
			data[to + 2] = Math.round(blue / count);
			data[to + 3] = 255;
		}
	}
	return { width, height, data };
}

async function decodeImage(image: Base64Image): Promise<Pixels | undefined> {
	const bytes = fromBase64(image.data);
	if (image.mimeType === "image/png") return decodePng(bytes);
	if (image.mimeType !== "image/jpeg") return undefined;
	const decoded = decodeJpeg(bytes, {
		useTArray: true,
		formatAsRGBA: true,
		maxResolutionInMP: MAX_PREVIEW_SOURCE_PIXELS / 1_000_000,
		maxMemoryUsageInMB: 256,
	});
	return { width: decoded.width, height: decoded.height, data: decoded.data };
}

/** A preview: the image scaled down, its size, and the size of the image it came from. */
export type ImagePreview = Base64Image & {
	readonly width: number;
	readonly height: number;
	readonly sourceWidth: number;
	readonly sourceHeight: number;
};

/**
 * The image itself when its base64 fits `maxChars`; else a JPEG of it scaled down to fit (its longest side 1024, then
 * 768, then 512 pixels), or undefined when it can't be decoded or no size fits. Never throws.
 */
export async function previewImage(
	image: Base64Image,
	maxChars: number,
): Promise<Base64Image | ImagePreview | undefined> {
	if (image.data.length <= maxChars) return image;
	try {
		const pixels = await decodeImage(image);
		if (pixels === undefined) return undefined;
		for (const side of PREVIEW_SIDES) {
			const scale = Math.min(1, side / Math.max(pixels.width, pixels.height));
			const width = Math.max(1, Math.round(pixels.width * scale));
			const height = Math.max(1, Math.round(pixels.height * scale));
			const scaled = scale === 1 ? pixels : scaleDown(pixels, width, height);
			const encoded = encodeJpeg({ width, height, data: scaled.data }, PREVIEW_QUALITY);
			const data = toBase64(new Uint8Array(encoded.data));
			if (data.length <= maxChars) {
				return {
					mimeType: "image/jpeg",
					data,
					width,
					height,
					sourceWidth: pixels.width,
					sourceHeight: pixels.height,
				};
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}
