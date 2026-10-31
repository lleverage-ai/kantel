/**
 * A server's `tools/list` as Kantel keeps it: each tool's name, description and input schema exactly as the server
 * gave them (Kantel adds no prompt text), the annotations it knows, and a hash of the lot so a change is one
 * comparison. Runs on Workers too, so the hash is WebCrypto's.
 */
import {
	type JsonSchema,
	replayOf,
	type Timestamp,
	type ToolServerSnapshot,
	type ToolServerTool,
	type ToolServerToolAnnotations,
} from "@kantel/contracts";

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BOOLEAN_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

function annotationsOf(raw: unknown): ToolServerToolAnnotations | undefined {
	if (!isObject(raw)) return undefined;
	const picked: { -readonly [K in keyof ToolServerToolAnnotations]: ToolServerToolAnnotations[K] } = {};
	if (typeof raw.title === "string") picked.title = raw.title;
	for (const hint of BOOLEAN_HINTS) {
		const value = raw[hint];
		if (typeof value === "boolean") picked[hint] = value;
	}
	return Object.keys(picked).length === 0 ? undefined : picked;
}

/**
 * The tools in a `tools/list` answer's `tools` arrays. An entry with no string name is left out; a missing
 * description is empty, and a missing or malformed input schema is `{ type: "object" }`, which MCP's own default
 * amounts to.
 */
export function toolsFromList(raw: readonly unknown[]): ToolServerTool[] {
	const tools: ToolServerTool[] = [];
	for (const entry of raw) {
		if (!isObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) continue;
		const annotations = annotationsOf(entry.annotations);
		tools.push({
			name: entry.name,
			description: typeof entry.description === "string" ? entry.description : "",
			// It came from JSON.parse, so it is JSON.
			inputSchema: isObject(entry.inputSchema) ? (entry.inputSchema as JsonSchema) : { type: "object" },
			...(annotations === undefined ? {} : { annotations }),
			replay: replayOf(annotations),
		});
	}
	return tools;
}

/** `value` as JSON with every object's keys sorted, at every depth, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!isObject(value)) return value;
	const sorted: { [key: string]: unknown } = {};
	for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
	return sorted;
}

/** `sha256:<hex>` of `text` in UTF-8. */
export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `sha256:${hex}`;
}

/** A snapshot of `tools` taken at `now`, hashed over their canonical JSON in the order the server listed them. */
export async function snapshotOf(tools: readonly ToolServerTool[], now: Timestamp): Promise<ToolServerSnapshot> {
	return { tools, hash: await sha256(canonicalJson(tools)), takenAt: now };
}
