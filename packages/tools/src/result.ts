/**
 * A `tools/call` result as a `HostToolResult`, the shape every tool's answer takes in the runtime. The model reads
 * `output`, so each content block becomes text: text as it is, an image or audio clip as a line saying what it was
 * (the bytes aren't sent on), and a resource as its URI and any inline text. `structuredContent` rides along as
 * `structured`.
 */
import type { HostToolResult, JsonValue } from "@harbour/contracts";

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MALFORMED: HostToolResult = { output: "The tool server sent a malformed result.", isError: true };

/** A size for people: `512 B`, `12 KB`, `3.4 MB`. */
function sizeOf(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How many bytes base64 `data` decodes to, without decoding it. */
function base64Bytes(data: string): number {
	const trimmed = data.replace(/\s/g, "");
	const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

/** `[image image/png, 12 KB]`, for content whose bytes the model doesn't get. */
function placeholder(kind: string, mimeType: unknown, data: unknown): string {
	const parts = [typeof mimeType === "string" ? `${kind} ${mimeType}` : kind];
	if (typeof data === "string") parts.push(sizeOf(base64Bytes(data)));
	return `[${parts.join(", ")}]`;
}

function blockText(block: unknown): string | undefined {
	if (!isObject(block) || typeof block.type !== "string") return undefined;
	switch (block.type) {
		case "text":
			return typeof block.text === "string" ? block.text : undefined;
		case "image":
		case "audio":
			return placeholder(block.type, block.mimeType, block.data);
		case "resource": {
			const resource = block.resource;
			if (!isObject(resource) || typeof resource.uri !== "string") return undefined;
			if (typeof resource.text === "string") return `${resource.uri}\n${resource.text}`;
			if (typeof resource.blob === "string")
				return `${resource.uri} ${placeholder("blob", resource.mimeType, resource.blob)}`;
			return resource.uri;
		}
		case "resource_link":
			return typeof block.uri === "string" ? block.uri : undefined;
		default:
			return `[${block.type} content]`;
	}
}

/**
 * `result`, a `tools/call` answer's `result`, as a host tool result. Text blocks are joined with blank lines. When
 * there is no content but `structuredContent`, the output is its JSON, so the model still sees the answer. A result
 * that isn't the shape MCP gives is an error result saying so.
 */
export function callResultToHostResult(result: unknown): HostToolResult {
	if (!isObject(result)) return MALFORMED;
	const content = result.content ?? [];
	if (!Array.isArray(content)) return MALFORMED;
	const parts: string[] = [];
	for (const block of content) {
		const text = blockText(block);
		if (text === undefined) return MALFORMED;
		parts.push(text);
	}
	const structured = isObject(result.structuredContent) ? (result.structuredContent as JsonValue) : undefined;
	const output = parts.length === 0 && structured !== undefined ? JSON.stringify(structured) : parts.join("\n\n");
	return {
		output,
		...(result.isError === true ? { isError: true } : {}),
		...(structured === undefined ? {} : { structured }),
	};
}
