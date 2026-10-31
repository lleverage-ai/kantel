/**
 * A tool's images by reference (TASK-4223): a transcript names each image a tool returned inline by the SHA-256 of its
 * bytes, `/v1/sessions/<sessionId>/images/<sha256>`, rather than carrying its base64, so a session's snapshot and its
 * stream hold words, not pictures. The image stays where it is, in the session's conversation, which is what the model
 * reads: only the transcript's copy becomes a reference. `getSessionImage` answers a reference from the projection that
 * gave it out (`ConversationProjector.image`), the same bytes for the same name, so a browser keeps it for good.
 *
 * The host gives the hash (`SessionRuntimeOptions.toolImages`): a synchronous SHA-256, as `node:crypto` has on Node and
 * on Workers. Without one, images stay inline as before.
 */
import type { ToolImage, ToolImageType } from "@kantel/protocol";

/** A synchronous SHA-256 of the bytes, as lowercase hex. */
export type ImageHash = (bytes: Uint8Array) => string;

/** What a host gives the runtime to put a session's tool images by reference. */
export interface ToolImageOptions {
	readonly hash: ImageHash;
}

/** An image the session's conversation holds, as the model reads it. */
export interface HeldImage {
	readonly mimeType: ToolImageType;
	/** Base64. */
	readonly data: string;
}

/** An image's name in a reference: the SHA-256 of its bytes, as lowercase hex. */
export const IMAGE_ID = /^[0-9a-f]{64}$/;

/** Where the API serves a session's image (`getSessionImage`). */
export function sessionImageUrl(sessionId: string, imageId: string): string {
	return `/v1/sessions/${encodeURIComponent(sessionId)}/images/${imageId}`;
}

export function base64Bytes(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
	return bytes;
}

/**
 * The pixel size an image's header gives, for PNG, JPEG, GIF and WebP; undefined when the header can't be read. Only
 * the header is looked at (for a JPEG, the markers up to its first frame), never the pixels.
 */
export function imageSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
	const sized = (width: number, height: number) =>
		width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
	// PNG: the signature, then the IHDR chunk's width and height.
	if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
		return sized(view.getUint32(16), view.getUint32(20));
	}
	// GIF: the logical screen's width and height, little-endian.
	if (bytes.length >= 10 && ascii(0, 3) === "GIF") {
		return sized(view.getUint16(6, true), view.getUint16(8, true));
	}
	// WebP: a RIFF container whose first chunk is lossy (VP8), lossless (VP8L) or extended (VP8X).
	if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
		const chunk = ascii(12, 4);
		if (chunk === "VP8 ") return sized(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
		if (chunk === "VP8L") {
			const bits = view.getUint32(21, true);
			return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
		}
		if (chunk === "VP8X") {
			const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
			const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
			return sized(width, height);
		}
		return undefined;
	}
	// JPEG: the markers after the start of image, up to the first start-of-frame, which holds the size.
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let at = 2;
		while (at + 9 <= bytes.length) {
			if (bytes[at] !== 0xff) return undefined;
			const marker = bytes[at + 1]!;
			// Fill bytes, and markers with no length.
			if (marker === 0xff) {
				at += 1;
				continue;
			}
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				at += 2;
				continue;
			}
			const length = view.getUint16(at + 2);
			// SOF0 to SOF15, but not DHT (C4), JPG (C8) or DAC (CC).
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return sized(view.getUint16(at + 7), view.getUint16(at + 5));
			}
			if (length < 2) return undefined;
			at += 2 + length;
		}
		return undefined;
	}
	return undefined;
}

/**
 * A projection's images by reference: each inline image it shows is named by its hash and kept (the conversation's own
 * string, not a copy) so that the name can be answered.
 */
export class ImageReferences {
	readonly #sessionId: string;
	readonly #hash: ImageHash;
	readonly #held = new Map<string, HeldImage>();

	constructor(sessionId: string, options: ToolImageOptions) {
		this.#sessionId = sessionId;
		this.#hash = options.hash;
	}

	/** The image as the transcript shows it: by reference when it is inline; a reference stays as it is. */
	reference(image: ToolImage): ToolImage {
		if (image.data === undefined) return image;
		let bytes: Uint8Array;
		try {
			bytes = base64Bytes(image.data);
		} catch {
			// Not base64 after all: shown as it was.
			return image;
		}
		const id = this.#hash(bytes);
		if (!IMAGE_ID.test(id)) return image;
		if (!this.#held.has(id)) this.#held.set(id, { mimeType: image.mimeType, data: image.data });
		const size = imageSize(bytes);
		return {
			mimeType: image.mimeType,
			url: sessionImageUrl(this.#sessionId, id),
			...(size === undefined ? {} : { width: size.width, height: size.height }),
			size: bytes.byteLength,
		};
	}

	/** The image a reference this projection gave out names, or undefined. */
	get(imageId: string): HeldImage | undefined {
		return this.#held.get(imageId);
	}
}
