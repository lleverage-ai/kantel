/**
 * The check a `POST /messages` context passes before the gateway resolves its route: it must have the shape of pi
 * 1.4.0's `Context`, since pi's wire streams assume it and fail mid-stream on anything else. A context that doesn't is
 * `invalid`, naming the first field at fault.
 */
import { KantelError } from "@kantel/contracts";

type Fields = { readonly [key: string]: unknown };

const isRecord = (value: unknown): value is Fields =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const STOP_REASONS: readonly unknown[] = ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"];
const USAGE_COUNTS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const USAGE_COSTS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function invalid(at: string, expected: string): never {
	throw new KantelError("invalid", `${at} must be ${expected}`);
}

function record(value: unknown, at: string): Fields {
	return isRecord(value) ? value : invalid(at, "an object");
}

function string(fields: Fields, key: string, at: string): void {
	if (typeof fields[key] !== "string") invalid(`${at}.${key}`, "a string");
}

function optional(fields: Fields, key: string, type: "string" | "boolean" | "number", at: string): void {
	if (fields[key] !== undefined && typeof fields[key] !== type) invalid(`${at}.${key}`, `a ${type}`);
}

function number(fields: Fields, key: string, at: string): void {
	if (typeof fields[key] !== "number" || !Number.isFinite(fields[key])) invalid(`${at}.${key}`, "a number");
}

function array(fields: Fields, key: string, at: string): readonly unknown[] {
	const value = fields[key];
	return Array.isArray(value) ? value : invalid(`${at}.${key}`, "an array");
}

/** A content block of one of `types`, as pi's `TextContent`, `ImageContent`, `ThinkingContent` or `ToolCall`. */
function block(value: unknown, types: readonly string[], at: string): void {
	const fields = record(value, at);
	switch (types.includes(fields.type as string) ? fields.type : undefined) {
		case "text":
			string(fields, "text", at);
			optional(fields, "textSignature", "string", at);
			return;
		case "image":
			string(fields, "data", at);
			string(fields, "mimeType", at);
			return;
		case "thinking":
			string(fields, "thinking", at);
			optional(fields, "thinkingSignature", "string", at);
			optional(fields, "redacted", "boolean", at);
			return;
		case "toolCall":
			string(fields, "id", at);
			string(fields, "name", at);
			record(fields.arguments, `${at}.arguments`);
			for (const key of ["thoughtSignature", "namespace", "argumentsError"]) optional(fields, key, "string", at);
			return;
		default:
			invalid(`${at}.type`, types.map((type) => `"${type}"`).join(" or "));
	}
}

/** `content`: an array of blocks of `types`. */
function blocks(fields: Fields, types: readonly string[], at: string): void {
	array(fields, "content", at).forEach((item, index) => {
		block(item, types, `${at}.content[${index}]`);
	});
}

/** `content`: a string, or an array of blocks of `types`. */
function content(fields: Fields, types: readonly string[], at: string): void {
	if (typeof fields.content !== "string") blocks(fields, types, at);
}

function tool(value: unknown, at: string): void {
	const fields = record(value, at);
	string(fields, "name", at);
	string(fields, "description", at);
	record(fields.parameters, `${at}.parameters`);
}

function usage(value: unknown, at: string): void {
	const fields = record(value, at);
	for (const key of USAGE_COUNTS) number(fields, key, at);
	const cost = record(fields.cost, `${at}.cost`);
	for (const key of USAGE_COSTS) number(cost, key, `${at}.cost`);
}

function message(value: unknown, at: string): void {
	const fields = record(value, at);
	optional(fields, "timestamp", "number", at);
	switch (fields.role) {
		case "system": {
			content(fields, ["text"], at);
			if (fields.sections !== undefined) {
				for (const [name, section] of Object.entries(record(fields.sections, `${at}.sections`))) {
					if (section !== null && typeof section !== "string") invalid(`${at}.sections.${name}`, "a string or null");
				}
			}
			if (fields.toolsAdded !== undefined) {
				array(fields, "toolsAdded", at).forEach((added, index) => {
					tool(added, `${at}.toolsAdded[${index}]`);
				});
			}
			if (fields.toolsRemoved !== undefined) {
				array(fields, "toolsRemoved", at).forEach((removed, index) => {
					string(record(removed, `${at}.toolsRemoved[${index}]`), "name", `${at}.toolsRemoved[${index}]`);
				});
			}
			return;
		}
		case "user":
			content(fields, ["text", "image"], at);
			return;
		case "assistant":
			blocks(fields, ["text", "thinking", "toolCall"], at);
			for (const key of ["api", "provider", "model"]) string(fields, key, at);
			number(fields, "timestamp", at);
			usage(fields.usage, `${at}.usage`);
			if (!STOP_REASONS.includes(fields.stopReason)) invalid(`${at}.stopReason`, "one of pi's stop reasons");
			return;
		case "toolResult":
			string(fields, "toolCallId", at);
			string(fields, "toolName", at);
			blocks(fields, ["text", "image"], at);
			if (typeof fields.isError !== "boolean") invalid(`${at}.isError`, "a boolean");
			return;
		default:
			invalid(`${at}.role`, `"system", "user", "assistant" or "toolResult"`);
	}
}

/** Rejects with `invalid` unless `context` has the shape of pi's `Context`: messages, and an optional prompt and tools. */
export function assertPiContext(context: unknown): void {
	const fields = record(context, "context");
	optional(fields, "systemPrompt", "string", "context");
	array(fields, "messages", "context").forEach((item, index) => {
		message(item, `context.messages[${index}]`);
	});
	if (fields.tools !== undefined) {
		array(fields, "tools", "context").forEach((item, index) => {
			tool(item, `context.tools[${index}]`);
		});
	}
}
