// A generated image too large for the conversation goes in scaled down (`previewImage`), so the model can still check
// what it made; the saved file stays full size.
import { encode as encodeJpeg } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { decodePng, previewImage } from "../src/image-preview.ts";

// A 1x1 transparent PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Noise: an image that compresses badly, so a modest size runs to a large file. */
function noise(width: number, height: number, channels: 3 | 4): Uint8Array {
	const data = new Uint8Array(width * height * channels);
	for (let at = 0; at < data.length; at += 65_536) crypto.getRandomValues(data.subarray(at, at + 65_536));
	if (channels === 4) for (let at = 3; at < data.length; at += 4) data[at] = 255;
	return data;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + body.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, body.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(body, 8);
	// The CRC is left zero: the decoder doesn't check it.
	return out;
}

/** An 8-bit RGB PNG of the pixels, every row with filter type `filter` (0 none, 1 sub, 2 up). */
async function encodePng(width: number, height: number, rgb: Uint8Array, filter = 0): Promise<Uint8Array> {
	const stride = width * 3;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = filter;
		for (let x = 0; x < stride; x++) {
			const value = rgb[y * stride + x] ?? 0;
			const left = filter === 1 && x >= 3 ? (rgb[y * stride + x - 3] ?? 0) : 0;
			const up = filter === 2 && y > 0 ? (rgb[(y - 1) * stride + x] ?? 0) : 0;
			raw[y * (stride + 1) + 1 + x] = (value - left - up) & 0xff;
		}
	}
	const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
	const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8;
	header[9] = 2;
	const parts = [
		Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", compressed),
		chunk("IEND", new Uint8Array()),
	];
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

describe("previewImage", () => {
	it("passes an image that fits through untouched", async () => {
		const image = { mimeType: "image/png", data: PIXEL };
		expect(await previewImage(image, 1_000)).toBe(image);
	});

	it("scales a large JPEG down to a JPEG that fits, keeping its shape", async () => {
		const width = 1536;
		const height = 1024;
		const jpeg = encodeJpeg({ width, height, data: noise(width, height, 4) }, 95);
		const image = { mimeType: "image/jpeg", data: toBase64(new Uint8Array(jpeg.data)) };
		const max = 450_000;
		expect(image.data.length).toBeGreaterThan(max);
		const preview = await previewImage(image, max);
		expect(preview).toMatchObject({ mimeType: "image/jpeg", sourceWidth: 1536, sourceHeight: 1024 });
		if (preview === undefined || !("width" in preview)) throw new Error("no preview");
		expect(preview.data.length).toBeLessThanOrEqual(max);
		expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(1024);
		expect(preview.width / preview.height).toBeCloseTo(1.5, 1);
	});

	it("scales a large PNG down too", async () => {
		const png = await encodePng(1100, 1100, noise(1100, 1100, 3), 1);
		const image = { mimeType: "image/png", data: toBase64(png) };
		const preview = await previewImage(image, 450_000);
		expect(preview).toMatchObject({ mimeType: "image/jpeg", sourceWidth: 1100, sourceHeight: 1100 });
	});

	it("gives up on what it can't decode, without throwing", async () => {
		expect(await previewImage({ mimeType: "image/webp", data: "x".repeat(2_000) }, 1_000)).toBeUndefined();
		expect(await previewImage({ mimeType: "image/jpeg", data: "x".repeat(2_000) }, 1_000)).toBeUndefined();
	});
});

describe("decodePng", () => {
	it("decodes each filter type to the same pixels", async () => {
		const rgb = noise(5, 4, 3);
		for (const filter of [0, 1, 2]) {
			const decoded = await decodePng(await encodePng(5, 4, rgb, filter));
			expect(decoded?.width).toBe(5);
			const first = decoded === undefined ? [] : [...decoded.data.subarray(0, 4)];
			expect(first).toEqual([rgb[0], rgb[1], rgb[2], 255]);
			const last = decoded === undefined ? [] : [...decoded.data.subarray(-4)];
			expect(last).toEqual([...rgb.subarray(-3), 255]);
		}
	});

	it("decodes a greyscale image with alpha", async () => {
		const decoded = await decodePng(Uint8Array.from(Buffer.from(PIXEL, "base64")));
		expect(decoded).toMatchObject({ width: 1, height: 1 });
		expect(decoded?.data[3]).toBe(0);
	});
});
