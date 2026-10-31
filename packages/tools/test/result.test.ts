import { describe, expect, it } from "vitest";
import { callResultToHostResult } from "../src/result.ts";

/** Base64 for `bytes` zero bytes. */
function base64Of(bytes: number): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

describe("callResultToHostResult", () => {
	it("joins text with blank lines", () => {
		expect(
			callResultToHostResult({
				content: [
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
			}),
		).toEqual({ output: "one\n\ntwo" });
	});

	it("names an image or audio clip's type, MIME type and size instead of sending its bytes", () => {
		const result = callResultToHostResult({
			content: [
				{ type: "image", mimeType: "image/png", data: base64Of(12 * 1024) },
				{ type: "audio", mimeType: "audio/wav", data: base64Of(100) },
			],
		});
		expect(result.output).toBe("[image image/png, 12 KB]\n\n[audio audio/wav, 100 B]");
	});

	it("gives a resource as its URI and inline text, and a link as its URI", () => {
		const result = callResultToHostResult({
			content: [
				{ type: "resource", resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "# Notes" } },
				{ type: "resource", resource: { uri: "file:///logo.png", mimeType: "image/png", blob: base64Of(2048) } },
				{ type: "resource_link", uri: "https://example.com/doc", name: "doc" },
			],
		});
		expect(result.output).toBe(
			"file:///notes.md\n# Notes\n\nfile:///logo.png [blob image/png, 2 KB]\n\nhttps://example.com/doc",
		);
	});

	it("passes structuredContent and isError through", () => {
		expect(
			callResultToHostResult({
				content: [{ type: "text", text: "nope" }],
				structuredContent: { reason: "missing" },
				isError: true,
			}),
		).toEqual({ output: "nope", isError: true, structured: { reason: "missing" } });
	});

	it("gives structured content as the output when there is no other content", () => {
		expect(callResultToHostResult({ content: [], structuredContent: { n: 1 } })).toEqual({
			output: '{"n":1}',
			structured: { n: 1 },
		});
	});

	it.each([
		["no result", undefined],
		["a string", "done"],
		["content that isn't a list", { content: "done" }],
		["a block with no type", { content: [{ text: "x" }] }],
		["a text block with no text", { content: [{ type: "text" }] }],
	])("makes %s an error result", (_name, raw) => {
		expect(callResultToHostResult(raw)).toEqual({ output: "The tool server sent a malformed result.", isError: true });
	});
});
