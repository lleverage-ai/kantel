/**
 * Conformance suites for the model gateway (packages/contracts/src/models.ts, docs/model-connectors.md "Testing"), and
 * the deterministic fake upstream they run against in CI.
 *
 * - `createFakeModelUpstream()` is a fetch handler that answers like LiteLLM, OpenRouter, Anthropic, OpenAI and CPA do:
 *   SSE streams in each wire API's real format (`/chat/completions`, `/messages`, `/responses`), so pi-ai's own parsers
 *   consume them, plus the catalogue endpoints (`/models`, LiteLLM's `/model/info`). Each call follows a script (text,
 *   thinking, a tool call, usage, reported cost, an HTTP error, a slow stream) and is recorded with its headers and body.
 *   It also answers OpenAI's Images API (`/images/generations`, and `/images/edits` as multipart form data) and a
 *   non-streaming chat completion asking for `modalities: ["image", ...]` (OpenRouter's and Vercel's image wire, the
 *   images in `choices[0].message.images` as data URLs) with `FAKE_IMAGE_PNG`, following `nextImages` scripts.
 * - `registerModelGatewayConformance` drives a gateway over its HTTP API with pi-ai's own `pi-messages` client, as the
 *   session runtime does.
 * - `registerModelConnectorConformance` runs per preset and wire API through the gateway: the key in the right header,
 *   attribution and session affinity, every supported thinking level reaching the upstream payload, and the catalogue.
 *   It runs in CI against the fake upstream for every preset, and against a live upstream (CPA) when one is configured.
 *
 * Every provider wires `deps.clock` and `deps.audit` into the gateway, its connector directory, its session tokens and
 * the vault its credentials come from.
 */
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { stream as piMessages } from "@earendil-works/pi-ai/api/pi-messages";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	type CallContext,
	type ConnectorPreset,
	KANTEL_MODEL_PROVIDER,
	type JsonValue,
	MODEL_GATEWAY_PATHS,
	type ModelCallScope,
	type ModelConnector,
	type ModelConnectors,
	type ModelGatewayConfig,
	type ModelGatewayModel,
	type ModelWireApi,
	type Vault,
} from "@kantel/contracts";
import {
	actors,
	CANARY_SECRET,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceRunner,
	containsCanary,
	contextFor,
	createDeps,
	createExpectAssertions,
	eventually,
	registerCases,
} from "./harness.ts";

// ----------------------------------------------------------------------------------------------------------------
// Recording and the fake upstream
// ----------------------------------------------------------------------------------------------------------------

/** What an upstream saw of one request. `aborted` and `completed` change while its response streams. */
export interface UpstreamRequest {
	readonly method: string;
	readonly url: string;
	/** Which endpoint it hit: a wire API, the catalogue, or something else. */
	readonly kind: ModelWireApi | "images" | "catalogue" | "other";
	/** Lower-case header names. */
	readonly headers: { readonly [name: string]: string };
	/** The parsed JSON body, if any. */
	readonly body: unknown;
	/** The caller aborted the request before its response finished. */
	readonly aborted: boolean;
	/** The response body was written to the end. */
	readonly completed: boolean;
}

interface MutableUpstreamRequest extends UpstreamRequest {
	aborted: boolean;
	completed: boolean;
}

/** Anything that records what reached an upstream: the fake, or `createRecordingFetch` around a live one. */
export interface RecordingUpstream {
	readonly fetch: typeof fetch;
	readonly requests: readonly UpstreamRequest[];
}

function kindOf(method: string, url: URL): UpstreamRequest["kind"] {
	const path = url.pathname.replace(/\/+$/, "");
	if (method === "POST" && path.endsWith("/chat/completions")) return "openai-completions";
	if (method === "POST" && path.endsWith("/messages")) return "anthropic-messages";
	if (method === "POST" && path.endsWith("/responses")) return "openai-responses";
	if (method === "POST" && (path.endsWith("/images/generations") || path.endsWith("/images/edits"))) return "images";
	if (method === "GET" && (path.endsWith("/models") || path.endsWith("/model/info"))) return "catalogue";
	return "other";
}

async function describeRequest(
	input: Parameters<typeof fetch>[0],
	init?: RequestInit,
): Promise<MutableUpstreamRequest> {
	const request = input instanceof Request ? input : undefined;
	const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
	const url = new URL(request?.url ?? String(input));
	const headers: { [name: string]: string } = {};
	new Headers(init?.headers ?? request?.headers).forEach((value, name) => {
		headers[name.toLowerCase()] = value;
	});
	let text: string | undefined;
	if (init?.body instanceof FormData) {
		// A multipart body (an image edit): its fields, and each file as its type and size, never its bytes.
		const fields: { [name: string]: JsonValue } = {};
		for (const [name, value] of init.body.entries()) {
			const entry: JsonValue =
				typeof value === "string" ? value : { file: value.name, type: value.type, size: value.size };
			const held = fields[name];
			fields[name] = held === undefined ? entry : Array.isArray(held) ? [...held, entry] : [held, entry];
		}
		return {
			method,
			url: url.toString(),
			kind: kindOf(method, url),
			headers,
			body: fields,
			aborted: false,
			completed: false,
		};
	}
	if (typeof init?.body === "string") text = init.body;
	else if (init?.body instanceof Uint8Array) text = new TextDecoder().decode(init.body);
	else if (request !== undefined && init?.body === undefined && method !== "GET") text = await request.clone().text();
	let body: unknown;
	try {
		body = text === undefined || text === "" ? undefined : JSON.parse(text);
	} catch {
		body = text;
	}
	return { method, url: url.toString(), kind: kindOf(method, url), headers, body, aborted: false, completed: false };
}

/** Wraps a real fetch so a suite can see what reached a live upstream. Response bodies pass through untouched. */
export function createRecordingFetch(inner: typeof fetch = fetch): RecordingUpstream {
	const requests: MutableUpstreamRequest[] = [];
	return {
		requests,
		fetch: async (input, init) => {
			const recorded = await describeRequest(input, init);
			requests.push(recorded);
			const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
			signal?.addEventListener(
				"abort",
				() => {
					if (!recorded.completed) recorded.aborted = true;
				},
				{ once: true },
			);
			const response = await inner(input, init);
			recorded.completed = true;
			return response;
		},
	};
}

export interface FakeToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: { readonly [key: string]: JsonValue };
	/** The arguments' JSON as the upstream streams it, delta by delta, instead of `arguments` split evenly. */
	readonly argumentDeltas?: readonly string[];
	/** The tool's namespace, which only `openai-responses` carries. */
	readonly namespace?: string;
}

/** The deltas a tool call's argument JSON streams in. */
function argumentDeltas(toolCall: FakeToolCall, chunks: number): readonly string[] {
	return toolCall.argumentDeltas ?? split(JSON.stringify(toolCall.arguments), chunks);
}

/** What the fake upstream answers one model call with. */
export interface FakeUpstreamScript {
	/** Streamed as thinking first; omitted when empty. Default "Let me think about that." */
	readonly thinking?: string;
	/** Streamed as text; omitted when empty. Default "Hello from the fake upstream." */
	readonly text?: string;
	/** A tool call after the text; the stop reason is then tool use. */
	readonly toolCall?: FakeToolCall;
	/**
	 * Token counts. Default 120 in, 40 out, 8 of them reasoning. `input` excludes cached input, as pi counts it.
	 * `cacheWrite` goes on the wire only where the API has a field for it (Anthropic's `cache_creation_input_tokens`,
	 * Chat Completions' `prompt_tokens_details.cache_write_tokens`).
	 */
	readonly usage?: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
		readonly reasoning?: number;
	};
	/**
	 * Fails the stream with the API's error event after its first event (Anthropic's `message_start`, which carries the
	 * input usage), as an overloaded upstream does mid-response. Anthropic only.
	 */
	readonly failAfterStart?: string;
	/** A cost the upstream reports in US dollars (`usage.cost`), as LiteLLM and OpenRouter do. */
	readonly reportedCost?: number;
	/** How many deltas each block is split into. Default 3. */
	readonly chunks?: number;
	/** Real-time delay before each SSE event after the first, in ms: a slow stream. Default 0. */
	readonly delayMs?: number;
	/** An HTTP error instead of a stream, in the API's own error body. */
	readonly error?: { readonly status: number; readonly message: string };
	/** The response's ID, as each API carries it. Default `chatcmpl-fake`, `msg_fake` or `resp_fake`. */
	readonly responseId?: string;
}

/** An Anthropic-style context overflow, which pi's `isContextOverflow` recognises on every API. */
export const FAKE_CONTEXT_OVERFLOW = {
	status: 400,
	message: "prompt is too long: 213462 tokens > 200000 maximum",
} as const;

/** One model in the fake upstream's catalogue. */
export interface FakeListedModel {
	readonly id: string;
	/** A display name the listing carries. */
	readonly name?: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	/**
	 * What it gives back, listed as OpenRouter does (`architecture.output_modalities`) on `/models` and as LiteLLM does
	 * (`supported_output_modalities`, and `mode: "image_generation"` when image-only) on `/model/info`.
	 */
	readonly output?: readonly ("text" | "image")[];
	/** A price per generated image, as LiteLLM's `output_cost_per_image`. */
	readonly imageCost?: number;
}

/** A 64 by 64 PNG (a sun over a field): every image the fake upstream makes. */
export const FAKE_IMAGE_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAABiUlEQVR42u3U3SvDURwG8Ocv+V0rpZRSopQ6pZRSSmihhRYz21pooYUWEhJaiJmZ9/d35v3lb3LlV7tR1L7n5qynTn2uzsXT8704D4qav6ihuPWTGko8H9RQ2vZODWUdb9RQ7n2lhorOF2qo6n6mhmrfEzXU9DwWyne28i/dECh/1rx/q/8mj0Jt4MGwvO1zhGmoC94bJjxAmIb68J1JwvY5kkA0RG5N0jpAEojGgRuTtA6QBKJp6NokrQMkgWiJXpmkdYAkEJ7hS5O0DpAEon30wiStAySB8MbODRO2F6aha+zMMOEBwjT4Jk7Ny9teHoXe+Emh/FtdNwSByWNqCE0fUUNk5pAaBmcPqCE6v08NIwt71BBb3KWG8eUdaognMtQwtbJNDTNraWqYW9+ihoVkihqWUpvUkEgnqWE1s0ENTkg5YeX4ldOnnIBy+pUTVESPoG7vPoK6vfsI6vbuI6jbu4+gbu8+grq9+2hn1M6onVE7o3ZG7YzaGbUzamfUzqidUTujtF/5ByS2PygU+A6kAAAAAElFTkSuQmCC";

/**
 * What the fake upstream answers one image call with: an Images API call, or a chat completion asking for image
 * output (`modalities`).
 */
export interface FakeImagesScript {
	/** Images to answer with. Default: as many as the request's `n` on the Images API, one on chat completions. */
	readonly count?: number;
	/**
	 * Token counts in `usage`, as gpt-image reports them (`input_tokens`) or chat completions do (`prompt_tokens`).
	 * Default none on the Images API; 12 in and 1290 out on chat completions.
	 */
	readonly usage?: { readonly input: number; readonly output: number };
	/** A cost the upstream reports in US dollars (`usage.cost`). */
	readonly reportedCost?: number;
	/** A `revised_prompt` on each image (Images API). */
	readonly revisedPrompt?: string;
	/** Answer with `url`s to fetch instead of `b64_json`, or of data URLs on chat completions. */
	readonly asUrl?: boolean;
	/** The text beside the images on chat completions (`message.content`). Default none. */
	readonly text?: string;
	/** On chat completions, a 200 whose body carries this error instead of a choice, as OpenRouter can answer. */
	readonly bodyError?: { readonly code: number; readonly message: string };
	/** An HTTP error instead of images, in OpenAI's error body. */
	readonly error?: { readonly status: number; readonly message: string };
}

export interface FakeModelUpstream extends RecordingUpstream {
	/** Answers the next model call with `script`; later calls take later scripts, then the default. */
	next(script: FakeUpstreamScript): void;
	/**
	 * Answers the next image call (Images API, or a chat completion asking for images) with `script`; later calls take
	 * later scripts, then one image per `n` (one on chat completions).
	 */
	nextImages(script: FakeImagesScript): void;
	/** Replaces what the catalogue endpoints list. */
	setModels(models: readonly FakeListedModel[]): void;
	/**
	 * Leaves catalogue reads unanswered until `release` is called: each waits, and is recorded as aborted if its caller
	 * gives up first.
	 */
	holdCatalogue(): { release(): void };
	/** The model calls (not catalogue reads) so far. */
	calls(): readonly UpstreamRequest[];
}

export const DEFAULT_FAKE_SCRIPT = {
	thinking: "Let me think about that.",
	text: "Hello from the fake upstream.",
	usage: { input: 120, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 8 },
	chunks: 3,
} as const satisfies FakeUpstreamScript;

function split(text: string, chunks: number): readonly string[] {
	if (text.length === 0) return [];
	const size = Math.max(1, Math.ceil(text.length / Math.max(1, chunks)));
	const parts: string[] = [];
	for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
	return parts;
}

const sse = (data: unknown, event?: string) =>
	`${event === undefined ? "" : `event: ${event}\n`}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

function modelOf(body: unknown): string {
	const model = (body as { model?: unknown } | undefined)?.model;
	return typeof model === "string" ? model : "fake-model";
}

function completionsEvents(script: FakeUpstreamScript, model: string): readonly string[] {
	const chunks = script.chunks ?? DEFAULT_FAKE_SCRIPT.chunks;
	const usage = script.usage ?? DEFAULT_FAKE_SCRIPT.usage;
	const base = {
		id: script.responseId ?? "chatcmpl-fake",
		object: "chat.completion.chunk",
		created: 1_790_000_000,
		model,
	};
	const delta = (inner: object, finish: string | null = null) =>
		sse({ ...base, choices: [{ index: 0, delta: inner, finish_reason: finish }] });
	const events = [delta({ role: "assistant", content: "" })];
	for (const part of split(script.thinking ?? DEFAULT_FAKE_SCRIPT.thinking, chunks)) {
		events.push(delta({ reasoning_content: part }));
	}
	for (const part of split(script.text ?? DEFAULT_FAKE_SCRIPT.text, chunks)) events.push(delta({ content: part }));
	if (script.toolCall !== undefined) {
		const { id, name } = script.toolCall;
		events.push(delta({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }));
		for (const part of argumentDeltas(script.toolCall, chunks)) {
			events.push(delta({ tool_calls: [{ index: 0, function: { arguments: part } }] }));
		}
	}
	events.push(delta({}, script.toolCall === undefined ? "stop" : "tool_calls"));
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	events.push(
		sse({
			...base,
			choices: [],
			usage: {
				prompt_tokens: usage.input + cacheRead + cacheWrite,
				completion_tokens: usage.output,
				total_tokens: usage.input + cacheRead + cacheWrite + usage.output,
				prompt_tokens_details: {
					cached_tokens: cacheRead,
					...(cacheWrite === 0 ? {} : { cache_write_tokens: cacheWrite }),
				},
				completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
				...(script.reportedCost === undefined ? {} : { cost: script.reportedCost }),
			},
		}),
	);
	events.push(sse("[DONE]"));
	return events;
}

function anthropicEvents(script: FakeUpstreamScript, model: string): readonly string[] {
	const chunks = script.chunks ?? DEFAULT_FAKE_SCRIPT.chunks;
	const usage = script.usage ?? DEFAULT_FAKE_SCRIPT.usage;
	const events = [
		sse(
			{
				type: "message_start",
				message: {
					id: script.responseId ?? "msg_fake",
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: usage.input,
						output_tokens: 1,
						cache_read_input_tokens: usage.cacheRead ?? 0,
						cache_creation_input_tokens: usage.cacheWrite ?? 0,
					},
				},
			},
			"message_start",
		),
	];
	if (script.failAfterStart !== undefined) {
		events.push(sse({ type: "error", error: { type: "overloaded_error", message: script.failAfterStart } }, "error"));
		return events;
	}
	let index = 0;
	const block = (start: object, deltas: readonly object[]) => {
		events.push(sse({ type: "content_block_start", index, content_block: start }, "content_block_start"));
		for (const delta of deltas) events.push(sse({ type: "content_block_delta", index, delta }, "content_block_delta"));
		events.push(sse({ type: "content_block_stop", index }, "content_block_stop"));
		index += 1;
	};
	const thinking = split(script.thinking ?? DEFAULT_FAKE_SCRIPT.thinking, chunks);
	if (thinking.length > 0) {
		block({ type: "thinking", thinking: "", signature: "" }, [
			...thinking.map((part) => ({ type: "thinking_delta", thinking: part })),
			{ type: "signature_delta", signature: "fake-thinking-signature" },
		]);
	}
	const text = split(script.text ?? DEFAULT_FAKE_SCRIPT.text, chunks);
	if (text.length > 0) {
		block(
			{ type: "text", text: "" },
			text.map((part) => ({ type: "text_delta", text: part })),
		);
	}
	if (script.toolCall !== undefined) {
		block(
			{ type: "tool_use", id: script.toolCall.id, name: script.toolCall.name, input: {} },
			argumentDeltas(script.toolCall, chunks).map((part) => ({
				type: "input_json_delta",
				partial_json: part,
			})),
		);
	}
	events.push(
		sse(
			{
				type: "message_delta",
				delta: { stop_reason: script.toolCall === undefined ? "end_turn" : "tool_use", stop_sequence: null },
				usage: {
					output_tokens: usage.output,
					...(script.reportedCost === undefined ? {} : { cost: script.reportedCost }),
				},
			},
			"message_delta",
		),
		sse({ type: "message_stop" }, "message_stop"),
	);
	return events;
}

function responsesEvents(script: FakeUpstreamScript, model: string): readonly string[] {
	const chunks = script.chunks ?? DEFAULT_FAKE_SCRIPT.chunks;
	const usage = script.usage ?? DEFAULT_FAKE_SCRIPT.usage;
	let sequence = 0;
	const event = (type: string, fields: object) => sse({ type, sequence_number: sequence++, ...fields }, type);
	const response = { id: script.responseId ?? "resp_fake", object: "response", created_at: 1_790_000_000, model };
	const events = [event("response.created", { response: { ...response, status: "in_progress", output: [] } })];
	const output: object[] = [];
	let outputIndex = 0;
	const thinkingText = script.thinking ?? DEFAULT_FAKE_SCRIPT.thinking;
	if (thinkingText.length > 0) {
		const id = "rs_fake";
		events.push(
			event("response.output_item.added", { output_index: outputIndex, item: { type: "reasoning", id, summary: [] } }),
		);
		for (const part of split(thinkingText, chunks)) {
			events.push(
				event("response.reasoning_summary_text.delta", {
					output_index: outputIndex,
					item_id: id,
					summary_index: 0,
					delta: part,
				}),
			);
		}
		const item = { type: "reasoning", id, summary: [{ type: "summary_text", text: thinkingText }] };
		events.push(event("response.output_item.done", { output_index: outputIndex, item }));
		output.push(item);
		outputIndex += 1;
	}
	const text = script.text ?? DEFAULT_FAKE_SCRIPT.text;
	if (text.length > 0) {
		const id = "msg_fake";
		events.push(
			event("response.output_item.added", {
				output_index: outputIndex,
				item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
			}),
		);
		for (const part of split(text, chunks)) {
			events.push(
				event("response.output_text.delta", { output_index: outputIndex, item_id: id, content_index: 0, delta: part }),
			);
		}
		const item = {
			type: "message",
			id,
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		};
		events.push(event("response.output_item.done", { output_index: outputIndex, item }));
		output.push(item);
		outputIndex += 1;
	}
	if (script.toolCall !== undefined) {
		const id = "fc_fake";
		const parts = argumentDeltas(script.toolCall, chunks);
		const args = parts.join("");
		const base = {
			type: "function_call",
			id,
			call_id: script.toolCall.id,
			name: script.toolCall.name,
			...(script.toolCall.namespace === undefined ? {} : { namespace: script.toolCall.namespace }),
		};
		events.push(event("response.output_item.added", { output_index: outputIndex, item: { ...base, arguments: "" } }));
		for (const part of parts) {
			events.push(
				event("response.function_call_arguments.delta", { output_index: outputIndex, item_id: id, delta: part }),
			);
		}
		events.push(
			event("response.function_call_arguments.done", { output_index: outputIndex, item_id: id, arguments: args }),
		);
		const item = { ...base, arguments: args, status: "completed" };
		events.push(event("response.output_item.done", { output_index: outputIndex, item }));
		output.push(item);
	}
	const cacheRead = usage.cacheRead ?? 0;
	events.push(
		event("response.completed", {
			response: {
				...response,
				status: "completed",
				output,
				usage: {
					input_tokens: usage.input + cacheRead,
					output_tokens: usage.output,
					total_tokens: usage.input + cacheRead + usage.output,
					input_tokens_details: { cached_tokens: cacheRead },
					output_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
					...(script.reportedCost === undefined ? {} : { cost: script.reportedCost }),
				},
			},
		}),
	);
	return events;
}

const ERROR_TYPES: { readonly [status: number]: string } = {
	400: "invalid_request_error",
	401: "authentication_error",
	403: "permission_error",
	404: "not_found_error",
	429: "rate_limit_error",
	500: "api_error",
	529: "overloaded_error",
};

function errorResponse(api: ModelWireApi, error: NonNullable<FakeUpstreamScript["error"]>): Response {
	const type = ERROR_TYPES[error.status] ?? "api_error";
	const body =
		api === "anthropic-messages"
			? { type: "error", error: { type, message: error.message } }
			: { error: { message: error.message, type, code: null } };
	return new Response(JSON.stringify(body), { status: error.status, headers: { "content-type": "application/json" } });
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Resolves with `promise`, or rejects with `signal`'s reason as soon as it aborts. */
function abortableWait(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const onAbort = () => reject(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

/** An Images API answer to `script`, for a request whose body (JSON or form fields) asked for `n` images. */
function imagesResponse(script: FakeImagesScript, body: unknown): Response {
	if (script.error !== undefined) {
		return new Response(
			JSON.stringify({ error: { message: script.error.message, type: "invalid_request_error", code: null } }),
			{ status: script.error.status, headers: { "content-type": "application/json" } },
		);
	}
	const fields = typeof body === "object" && body !== null ? (body as { readonly [key: string]: unknown }) : {};
	const asked = Number(fields.n ?? 1);
	const count = script.count ?? (Number.isInteger(asked) && asked > 0 ? asked : 1);
	const data = Array.from({ length: count }, (_, index) => ({
		...(script.asUrl === true
			? { url: `https://fake-upstream.test/fake-images/${index}.png` }
			: { b64_json: FAKE_IMAGE_PNG }),
		...(script.revisedPrompt === undefined ? {} : { revised_prompt: script.revisedPrompt }),
	}));
	const usage =
		script.usage === undefined && script.reportedCost === undefined
			? undefined
			: {
					...(script.usage === undefined
						? {}
						: {
								input_tokens: script.usage.input,
								output_tokens: script.usage.output,
								total_tokens: script.usage.input + script.usage.output,
							}),
					...(script.reportedCost === undefined ? {} : { cost: script.reportedCost }),
				};
	return new Response(JSON.stringify({ created: 1_790_000_000, data, ...(usage === undefined ? {} : { usage }) }), {
		headers: { "content-type": "application/json" },
	});
}

/** Whether a chat completions body asks for image output: OpenRouter's and Vercel's image wire, never streamed. */
function asksForImages(body: unknown): boolean {
	const fields = typeof body === "object" && body !== null ? (body as { readonly [key: string]: unknown }) : {};
	return Array.isArray(fields.modalities) && fields.modalities.includes("image") && fields.stream !== true;
}

/** A chat completion with images in `choices[0].message.images`, answering `script`. */
function chatImagesResponse(script: FakeImagesScript, body: unknown): Response {
	if (script.error !== undefined) return errorResponse("openai-completions", script.error);
	const usage = script.usage ?? { input: 12, output: 1290 };
	const usageBody = {
		prompt_tokens: usage.input,
		completion_tokens: usage.output,
		total_tokens: usage.input + usage.output,
		...(script.reportedCost === undefined ? {} : { cost: script.reportedCost }),
	};
	if (script.bodyError !== undefined) {
		return new Response(JSON.stringify({ error: script.bodyError, usage: usageBody }), {
			headers: { "content-type": "application/json" },
		});
	}
	const images = Array.from({ length: script.count ?? 1 }, (_, index) => ({
		type: "image_url",
		image_url: {
			url:
				script.asUrl === true
					? `https://fake-upstream.test/fake-images/${index}.png`
					: `data:image/png;base64,${FAKE_IMAGE_PNG}`,
		},
	}));
	return new Response(
		JSON.stringify({
			id: "gen-fake",
			object: "chat.completion",
			created: 1_790_000_000,
			model: modelOf(body),
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: script.text ?? "",
						...(images.length === 0 ? {} : { images }),
					},
					finish_reason: "stop",
				},
			],
			usage: usageBody,
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

const FAKE_MODELS: readonly FakeListedModel[] = [{ id: "claude-sonnet-4-5" }, { id: "gpt-5" }];

/**
 * A deterministic upstream speaking all three wire APIs and the catalogue endpoints, for any host. Model calls follow
 * the queued scripts (`next`), then `DEFAULT_FAKE_SCRIPT`; every request is recorded.
 */
export function createFakeModelUpstream(
	options: { readonly models?: readonly FakeListedModel[]; readonly script?: FakeUpstreamScript } = {},
): FakeModelUpstream {
	const requests: MutableUpstreamRequest[] = [];
	const queued: FakeUpstreamScript[] = [];
	const queuedImages: FakeImagesScript[] = [];
	let models = options.models ?? FAKE_MODELS;
	let catalogueHeld: Promise<void> | undefined;
	const encoder = new TextEncoder();

	function catalogue(url: URL): Response {
		const data = url.pathname.endsWith("/model/info")
			? models.map((model) => ({
					model_name: model.id,
					...(model.name === undefined ? {} : { name: model.name }),
					litellm_params: { model: `fake/${model.id}` },
					model_info: {
						...(model.contextWindow === undefined ? {} : { max_input_tokens: model.contextWindow }),
						...(model.maxTokens === undefined ? {} : { max_output_tokens: model.maxTokens }),
						...(model.output === undefined ? {} : { supported_output_modalities: model.output }),
						...(model.output?.length === 1 && model.output[0] === "image" ? { mode: "image_generation" } : {}),
						...(model.imageCost === undefined ? {} : { output_cost_per_image: model.imageCost }),
					},
				}))
			: models.map((model) => ({
					id: model.id,
					...(model.name === undefined ? {} : { name: model.name }),
					object: "model",
					created: 1_790_000_000,
					owned_by: "fake",
					...(model.contextWindow === undefined ? {} : { context_length: model.contextWindow }),
					...(model.maxTokens === undefined ? {} : { max_tokens: model.maxTokens }),
					...(model.output === undefined ? {} : { architecture: { output_modalities: model.output } }),
				}));
		return new Response(JSON.stringify({ object: "list", data }), {
			headers: { "content-type": "application/json" },
		});
	}

	const upstream: FakeModelUpstream = {
		requests,
		next(script) {
			queued.push(script);
		},
		nextImages(script) {
			queuedImages.push(script);
		},
		setModels(next) {
			models = next;
		},
		holdCatalogue() {
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			catalogueHeld = held;
			return {
				release() {
					if (catalogueHeld === held) catalogueHeld = undefined;
					release();
				},
			};
		},
		calls() {
			return requests.filter((request) => request.kind !== "catalogue" && request.kind !== "other");
		},
		async fetch(input, init) {
			const recorded = await describeRequest(input, init);
			requests.push(recorded);
			const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
			const url = new URL(recorded.url);
			if (recorded.kind === "catalogue") {
				if (catalogueHeld !== undefined) {
					try {
						await abortableWait(catalogueHeld, signal);
					} catch (error) {
						recorded.aborted = true;
						throw error;
					}
				}
				recorded.completed = true;
				return catalogue(url);
			}
			if (recorded.kind === "images") {
				recorded.completed = true;
				return imagesResponse(queuedImages.shift() ?? {}, recorded.body);
			}
			if (recorded.method === "GET" && url.pathname.startsWith("/fake-images/")) {
				recorded.completed = true;
				return new Response(
					Uint8Array.from(atob(FAKE_IMAGE_PNG), (char) => char.charCodeAt(0)),
					{
						headers: { "content-type": "image/png" },
					},
				);
			}
			if (recorded.kind === "other") {
				recorded.completed = true;
				return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404 });
			}
			const api = recorded.kind;
			if (api === "openai-completions" && asksForImages(recorded.body)) {
				recorded.completed = true;
				return chatImagesResponse(queuedImages.shift() ?? {}, recorded.body);
			}
			const script: FakeUpstreamScript = queued.shift() ?? options.script ?? DEFAULT_FAKE_SCRIPT;
			if (script.error !== undefined) {
				recorded.completed = true;
				return errorResponse(api, script.error);
			}
			const model = modelOf(recorded.body);
			const events =
				api === "openai-completions"
					? completionsEvents(script, model)
					: api === "anthropic-messages"
						? anthropicEvents(script, model)
						: responsesEvents(script, model);
			const onAbort = () => {
				if (!recorded.completed) recorded.aborted = true;
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			let at = 0;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						if (at > 0 && (script.delayMs ?? 0) > 0) await abortableDelay(script.delayMs ?? 0, signal);
						if (signal?.aborted) throw signal.reason;
					} catch (error) {
						controller.error(error);
						return;
					}
					controller.enqueue(encoder.encode(events[at]!));
					at += 1;
					if (at === events.length) {
						recorded.completed = true;
						controller.close();
					}
				},
				cancel() {
					if (!recorded.completed) recorded.aborted = true;
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_fake" },
			});
		},
	};
	return upstream;
}

// ----------------------------------------------------------------------------------------------------------------
// The subject and pi-ai's client
// ----------------------------------------------------------------------------------------------------------------

/**
 * What a gateway provider hands each case. The gateway is built on `deps.clock` and `deps.audit`, reads keys through
 * `credentials` (a vault: `readConnectorCredential` as the gateway, `putItem` and `listUses` for the suite) and
 * reaches upstreams through `upstream.fetch`.
 */
export interface ModelGatewaySubject {
	/** Reaches the gateway's HTTP API: its fetch handler, or real HTTP. */
	readonly fetch: typeof fetch;
	/** The gateway's base URL; `/v1/config` must return it. */
	readonly baseUrl: string;
	/** A session token for `scope`, minted by the gateway's `ModelSessionTokens` as the session runtime would. */
	mintToken(scope: ModelCallScope, ttlMs?: number): Promise<string>;
	readonly connectors: ModelConnectors;
	readonly upstream: RecordingUpstream;
	readonly credentials: Pick<Vault, "putItem" | "listUses">;
}

export type ModelGatewayConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: ModelGatewaySubject) => Promise<void>,
) => Promise<void>;

/** The gateway subject with the fake upstream, which the gateway suite scripts. */
export interface FakeModelGatewaySubject extends ModelGatewaySubject {
	readonly upstream: FakeModelUpstream;
}

export type FakeModelGatewayConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: FakeModelGatewaySubject) => Promise<void>,
) => Promise<void>;

async function loadConfig(subject: ModelGatewaySubject, token: string): Promise<Response> {
	return subject.fetch(new URL(`${subject.baseUrl.replace(/\/+$/, "")}${MODEL_GATEWAY_PATHS.config}`), {
		headers: { authorization: `Bearer ${token}`, accept: "application/json" },
	});
}

async function config(subject: ModelGatewaySubject, token: string): Promise<ModelGatewayConfig> {
	const response = await loadConfig(subject, token);
	if (!response.ok) throw new Error(`GET /v1/config answered ${response.status}: ${await response.text()}`);
	return (await response.json()) as ModelGatewayConfig;
}

/** The pi model the runtime builds from one `/v1/config` entry, as pi's Radius provider does. */
function kantelModel(entry: ModelGatewayModel, baseUrl: string): Model<"pi-messages"> {
	return {
		...entry,
		input: [...entry.input],
		cost: { ...entry.cost },
		...(entry.thinkingLevelMap === undefined
			? {}
			: { thinkingLevelMap: entry.thinkingLevelMap as Model<"pi-messages">["thinkingLevelMap"] }),
		api: "pi-messages",
		provider: KANTEL_MODEL_PROVIDER,
		baseUrl,
	};
}

/** A model the config doesn't list, so a call to it reaches the gateway's own refusal. */
function unlistedModel(id: string, baseUrl: string): Model<"pi-messages"> {
	return {
		id,
		name: id,
		api: "pi-messages",
		provider: KANTEL_MODEL_PROVIDER,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

const USER_CONTEXT: Context = {
	systemPrompt: "You are a test.",
	messages: [{ role: "user", content: "Say hello.", timestamp: 1_790_000_000_000 }],
};

const TOOL_CONTEXT: Context = {
	...USER_CONTEXT,
	tools: [
		{
			name: "lookup",
			description: "Looks a thing up.",
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } as never,
		},
	],
};

/** A tool pi sends strict where the model supports it, and would re-send without strict mode after certain 400s. */
const STRICT_TOOL_CONTEXT: Context = {
	...USER_CONTEXT,
	tools: [{ ...TOOL_CONTEXT.tools![0]!, constrainedSampling: { type: "json_schema", strict: "prefer" } }],
};

interface CallResult {
	readonly events: readonly AssistantMessageEvent[];
	readonly message: AssistantMessage;
	/** Whether the upstream was still writing when the first delta reached the client. */
	readonly firstDeltaBeforeUpstreamDone?: boolean;
}

interface CallOptions {
	readonly reasoning?: ThinkingLevel;
	readonly context?: Context;
	readonly signal?: AbortSignal;
	readonly headers?: Record<string, string>;
	/** Called with each event as it arrives. */
	readonly onEvent?: (event: AssistantMessageEvent) => void;
	readonly sessionId?: string;
}

/** Calls the gateway with pi-ai's own `pi-messages` client, unchanged, as the session runtime does. */
async function call(
	subject: ModelGatewaySubject,
	token: string,
	model: Model<"pi-messages">,
	options: CallOptions = {},
): Promise<CallResult> {
	const events: AssistantMessageEvent[] = [];
	let firstDeltaBeforeUpstreamDone: boolean | undefined;
	const piStream = piMessages(model, normalizeContext(options.context ?? USER_CONTEXT), {
		apiKey: token,
		fetch: subject.fetch,
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
		...(options.headers === undefined ? {} : { headers: options.headers }),
		...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
	} as never);
	for await (const event of piStream) {
		if (
			firstDeltaBeforeUpstreamDone === undefined &&
			(event.type === "text_delta" || event.type === "thinking_delta")
		) {
			const last = subject.upstream.requests.at(-1);
			firstDeltaBeforeUpstreamDone = last !== undefined && !last.completed;
		}
		events.push(event);
		options.onEvent?.(event);
	}
	const message = await piStream.result();
	return {
		events,
		message,
		...(firstDeltaBeforeUpstreamDone === undefined ? {} : { firstDeltaBeforeUpstreamDone }),
	};
}

async function routeModel(subject: ModelGatewaySubject, token: string, id: string): Promise<Model<"pi-messages">> {
	const loaded = await config(subject, token);
	const entry = loaded.models.find((model) => model.id === id);
	if (entry === undefined) throw new Error(`/v1/config does not list ${id}`);
	return kantelModel(entry, loaded.baseUrl);
}

/** Puts a vault item holding `key` for `owner`, bound to the base URL's host, and returns its ID. */
async function putKey(
	subject: ModelGatewaySubject,
	ctx: CallContext,
	owner: ModelConnector["owner"],
	baseUrl: string,
	key: string,
	name: string,
): Promise<string> {
	const item = await subject.credentials.putItem(ctx, {
		owner,
		name,
		hosts: [new URL(baseUrl).hostname],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: key,
	});
	return item.id;
}

// ----------------------------------------------------------------------------------------------------------------
// The gateway suite
// ----------------------------------------------------------------------------------------------------------------

const ORG = "org-models-a";
const OTHER_ORG = "org-models-b";
const PROJECT = "proj-models-a";
const NARROW_PROJECT = "proj-models-narrow";
const OTHER_PROJECT = "proj-models-b";
const ADMIN = actors.human("models-admin-a");
/** Kantel's operator, the only caller that changes the platform's connectors, routes and vault items. */
const OPERATOR = contextFor(actors.system("operator"), ORG);
const OTHER_ADMIN = actors.human("models-admin-b");

/** The platform connector's key. It holds the canary, so a leak into audit shows too. */
const PLATFORM_KEY = `sk-platform-${CANARY_SECRET}`;
const OTHER_KEY = "sk-org-b-5d0c1a7e-never-show-org-a";
const PLATFORM_BASE_URL = "http://litellm.fake.internal:4000/v1";
const OTHER_BASE_URL = "https://openrouter.fake.internal/api/v1";

const PLATFORM_CONNECTOR = "platform-litellm";
const OTHER_CONNECTOR = "org-b-openrouter";

/** Distinct sessions, so pins never carry over from another call. */
let sessionCounter = 0;
function scopeFor(projectId = PROJECT, organisationId = ORG): ModelCallScope {
	sessionCounter += 1;
	return {
		organisationId,
		projectId,
		agentId: `agent-models-${sessionCounter}`,
		sessionId: `sess-models-${sessionCounter}`,
	};
}

/**
 * The directory every gateway case starts from:
 *
 * - a platform LiteLLM connector (gateway-refreshed from `/model/info`) with routes `default` (claude-sonnet-4-5 on
 *   Messages), `fast` (gemini-2.5-pro on Chat Completions) and `deep` (gpt-5 on Responses, thinking high), and a
 *   `house-model` the pi catalogue doesn't know but an override describes;
 * - organisation B's own OpenRouter connector and route `b-route`;
 * - a narrowed project in organisation A whose policy allows only claude-sonnet-4-5 and gemini-2.5-pro.
 */
async function seedGateway(subject: FakeModelGatewaySubject, deps: ConformanceDeps): Promise<void> {
	deps.tenancy.bind(ADMIN, ORG, "admin");
	deps.tenancy.bind(OTHER_ADMIN, OTHER_ORG, "admin");
	subject.upstream.setModels([
		{ id: "claude-sonnet-4-5" },
		{ id: "gemini-2.5-pro" },
		{ id: "gpt-5" },
		{ id: "house-model" },
		{ id: "mystery-model" },
	]);
	const platformItem = await putKey(
		subject,
		OPERATOR,
		{ kind: "platform" },
		PLATFORM_BASE_URL,
		PLATFORM_KEY,
		"Platform LiteLLM",
	);
	await subject.connectors.putConnector(OPERATOR, {
		id: PLATFORM_CONNECTOR,
		owner: { kind: "platform" },
		preset: "litellm",
		baseUrl: PLATFORM_BASE_URL,
		vaultItemId: platformItem,
		catalogue: {
			refresh: "gateway",
			overrides: {
				"gpt-5": { api: "openai-responses" },
				"house-model": { name: "House model", contextWindow: 32_000, maxTokens: 4096 },
			},
		},
	});
	const platform = { kind: "platform" } as const;
	await subject.connectors.putRoute(OPERATOR, {
		name: "default",
		owner: platform,
		connectorId: PLATFORM_CONNECTOR,
		modelId: "claude-sonnet-4-5",
	});
	await subject.connectors.putRoute(OPERATOR, {
		name: "fast",
		owner: platform,
		connectorId: PLATFORM_CONNECTOR,
		modelId: "gemini-2.5-pro",
	});
	await subject.connectors.putRoute(OPERATOR, {
		name: "deep",
		owner: platform,
		connectorId: PLATFORM_CONNECTOR,
		modelId: "gpt-5",
		thinking: "high",
	});

	const otherAdmin = contextFor(OTHER_ADMIN, OTHER_ORG);
	const otherItem = await putKey(
		subject,
		otherAdmin,
		{ kind: "organisation", organisationId: OTHER_ORG },
		OTHER_BASE_URL,
		OTHER_KEY,
		"Organisation B OpenRouter",
	);
	await subject.connectors.putConnector(otherAdmin, {
		id: OTHER_CONNECTOR,
		owner: { kind: "organisation", organisationId: OTHER_ORG },
		preset: "openrouter",
		baseUrl: OTHER_BASE_URL,
		vaultItemId: otherItem,
		catalogue: { refresh: "static", include: ["anthropic/claude-sonnet-4.5"] },
	});
	await subject.connectors.putRoute(otherAdmin, {
		name: "b-route",
		owner: { kind: "organisation", organisationId: OTHER_ORG },
		connectorId: OTHER_CONNECTOR,
		modelId: "anthropic/claude-sonnet-4.5",
	});

	await subject.connectors.setProjectPolicy(contextFor(ADMIN, ORG), {
		organisationId: ORG,
		projectId: NARROW_PROJECT,
		connectors: [PLATFORM_CONNECTOR],
		models: ["claude-sonnet-4-5", "gemini-2.5-pro"],
	});
}

const errorText = (message: AssistantMessage) => message.errorMessage ?? "";

/** `promise`, or a rejection once `ms` of real time pass without it settling. */
function within<T>(ms: number, promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${label}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `text` with every character as a JSON `\uXXXX` escape, alternating the escape's case. */
function jsonEscaped(text: string): string {
	return [...text]
		.map((char, at) => `\\${at % 2 === 0 ? "u" : "U"}${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
		.join("");
}

/** `text` with its JSON `\uXXXX` and `\/` escapes decoded, as a JSON parser would read them. */
function decodeJsonEscapes(text: string): string {
	return text
		.replace(/\\[uU]([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replaceAll("\\/", "/");
}

/** Every string in `value`, object keys included. */
function stringsIn(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
	else if (typeof value === "object" && value !== null) {
		for (const [key, inner] of Object.entries(value)) {
			out.push(key);
			stringsIn(inner, out);
		}
	}
	return out;
}

/** The strings in `value` that hold `secret`, literally or in JSON escapes. */
function leaksOf(value: unknown, secret: string): readonly string[] {
	return stringsIn(value).filter((text) => decodeJsonEscapes(text).includes(secret));
}

export function createModelGatewayConformance(options: {
	assertions: ConformanceAssertions;
	provider: FakeModelGatewayConformanceProvider;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (
		name: string,
		body: (subject: FakeModelGatewaySubject, deps: ConformanceDeps) => Promise<void>,
	): ConformanceCase => ({
		name,
		timeoutMs: 20_000,
		run: async () => {
			const deps = createDeps();
			await options.provider(deps, async (subject) => {
				await seedGateway(subject, deps);
				await body(subject, deps);
			});
		},
	});

	/** The session's token and the pi model for `route`, from its own `/v1/config`. */
	async function session(subject: ModelGatewaySubject, route: string, scope = scopeFor()) {
		const token = await subject.mintToken(scope);
		return { scope, token, model: await routeModel(subject, token, route) };
	}

	function assertOneCallRecorded(deps: ConformanceDeps, scope: ModelCallScope, expected: number, label: string) {
		const calls = deps.audit.ofType("model.call").filter((event) => event.sessionId === scope.sessionId);
		assert.strictEqual(calls.length, expected, `${label}: ${expected} model.call event(s) for the session`);
		for (const event of calls) {
			assert.strictEqual(event.source, "session", `${label}: model.call is a session event`);
			assert.partialDeepEqual(event.subject, { kind: "model.call" }, `${label}: model.call names the call`);
		}
	}

	return [
		test("config: lists only the session's routes, with the route's other models as overrides", async (subject) => {
			const scope = scopeFor();
			const loaded = await config(subject, await subject.mintToken(scope));
			assert.strictEqual(loaded.baseUrl, subject.baseUrl, "config returns the gateway's base URL");
			const ids = loaded.models.map((model) => model.id).sort();
			for (const id of ["default", "fast", "deep"]) assert.ok(ids.includes(id), `config lists route ${id}`);
			assert.ok(!ids.includes("b-route"), "config never lists another organisation's route");
			assert.ok(ids.includes("default:gpt-5"), "a route's other models are listed as <route>:<modelId>");
			assert.ok(ids.includes("default:house-model"), "a model described by an override is listed");
			assert.ok(
				!ids.some((id) => id.endsWith(":mystery-model")),
				"a model with neither pi metadata nor an override isn't offered",
			);
			assert.ok(!ids.includes("default:claude-sonnet-4-5"), "a route's own model isn't repeated as an override");
			const byId = new Map(loaded.models.map((model) => [model.id, model]));
			const routed = byId.get("default");
			assert.strictEqual(routed?.name, "Claude Sonnet 4.5 (latest)", "a route carries its upstream model's metadata");
			assert.strictEqual(routed?.contextWindow, 200_000, "the route's context window is the upstream model's");
			assert.strictEqual(routed?.reasoning, true, "the route says whether the model reasons");
			assert.ok((routed?.cost.input ?? 0) > 0, "the route carries the upstream model's rates");
			assert.strictEqual(byId.get("default:house-model")?.contextWindow, 32_000, "an override's context window holds");

			const narrow = await config(subject, await subject.mintToken(scopeFor(NARROW_PROJECT)));
			const narrowIds = narrow.models.map((model) => model.id);
			assert.ok(narrowIds.includes("default"), "the narrowed project keeps its allowed routes");
			assert.ok(!narrowIds.includes("deep"), "a route to a model the policy excludes isn't listed");
			assert.ok(!narrowIds.includes("default:gpt-5"), "an override the policy excludes isn't listed");
			assert.ok(narrowIds.includes("default:gemini-2.5-pro"), "an override the policy allows is listed");

			const other = await config(subject, await subject.mintToken(scopeFor(OTHER_PROJECT, OTHER_ORG)));
			const otherIds = other.models.map((model) => model.id);
			assert.ok(otherIds.includes("b-route"), "organisation B sees its own route");
			assert.ok(otherIds.includes("default"), "organisation B sees the platform's routes");
		}),

		test("messages: deltas arrive incrementally, before the upstream finishes", async (subject) => {
			const { token, model } = await session(subject, "default");
			subject.upstream.next({
				text: "One two three four five six seven eight nine ten. ".repeat(6),
				chunks: 12,
				delayMs: 15,
			});
			const result = await call(subject, token, model);
			assert.strictEqual(result.message.stopReason, "stop", "the call ends done");
			assert.strictEqual(result.firstDeltaBeforeUpstreamDone, true, "the first delta arrives before the last byte");
			const deltas = result.events.filter((event) => event.type === "text_delta");
			assert.greaterThan(deltas.length, 1, "the text arrives as several deltas");
		}),

		test("messages: text, thinking and a tool call round-trip on every wire API", async (subject) => {
			const toolCall = { id: "call_fake_1", name: "lookup", arguments: { query: "harbour", limit: 3 } };
			for (const route of ["default", "fast", "deep"]) {
				const { token, model } = await session(subject, route);
				subject.upstream.next({ thinking: "Thinking it over.", text: "Here you go.", toolCall });
				const { message } = await call(subject, token, model, { context: TOOL_CONTEXT, reasoning: "high" });
				assert.strictEqual(message.stopReason, "toolUse", `${route}: the call ends with tool use`);
				const thinking = message.content.find((block) => block.type === "thinking");
				const text = message.content.find((block) => block.type === "text");
				const tool = message.content.find((block) => block.type === "toolCall");
				assert.strictEqual(
					thinking?.type === "thinking" && thinking.thinking,
					"Thinking it over.",
					`${route}: thinking`,
				);
				assert.strictEqual(text?.type === "text" && text.text, "Here you go.", `${route}: text`);
				assert.strictEqual(tool?.type === "toolCall" && tool.name, "lookup", `${route}: the tool call's name`);
				assert.deepEqual(
					tool?.type === "toolCall" ? tool.arguments : undefined,
					toolCall.arguments,
					`${route}: the tool call's arguments`,
				);
				assert.ok(
					tool?.type === "toolCall" && tool.id.startsWith("call_fake_1"),
					`${route}: the tool call keeps the upstream's ID`,
				);
			}
		}),

		test("messages: usage carries tokens and cost, computed or reported", async (subject, deps) => {
			const { scope, token, model } = await session(subject, "default");
			subject.upstream.next({ usage: { input: 1000, output: 500 } });
			const computed = await call(subject, token, model);
			assert.strictEqual(computed.message.usage.input, 1000, "input tokens reach the runtime");
			assert.strictEqual(computed.message.usage.output, 500, "output tokens reach the runtime");
			// claude-sonnet-4-5: $3 in, $15 out per million.
			assert.ok(
				Math.abs(computed.message.usage.cost.total - (1000 * 3 + 500 * 15) / 1_000_000) < 1e-9,
				"cost is computed from the catalogue's rates",
			);

			const fast = await routeModel(subject, token, "fast");
			subject.upstream.next({ usage: { input: 1000, output: 500 }, reportedCost: 0.0421 });
			const reported = await call(subject, token, fast);
			assert.ok(Math.abs(reported.message.usage.cost.total - 0.0421) < 1e-12, "a reported cost is the upstream's");
			const sources = deps.audit
				.ofType("model.call")
				.filter((event) => event.sessionId === scope.sessionId)
				.map((event) => event.data?.costSource);
			assert.deepEqual(sources, ["computed", "reported"], "model.call records where each cost came from");
		}),

		test("errors: 429 and 5xx reach the runtime as retryable, 401 as not", async (subject) => {
			const { token, model } = await session(subject, "default");
			for (const [status, message] of [
				[429, "Rate limit reached for requests"],
				[500, "Internal server error"],
				[503, "The upstream is overloaded"],
			] as const) {
				subject.upstream.next({ error: { status, message } });
				const result = await call(subject, token, model);
				assert.strictEqual(result.message.stopReason, "error", `${status}: the call ends in an error`);
				assert.ok(errorText(result.message).includes(message), `${status}: the upstream's text reaches the runtime`);
				assert.strictEqual(isRetryableAssistantError(result.message), true, `${status} is retryable`);
			}
			subject.upstream.next({ error: { status: 401, message: `Invalid API key: ${PLATFORM_KEY}` } });
			const denied = await call(subject, token, model);
			assert.strictEqual(denied.message.stopReason, "error", "401: the call ends in an error");
			assert.strictEqual(isRetryableAssistantError(denied.message), false, "401 is not retryable");
			assert.ok(errorText(denied.message).includes("Invalid API key"), "401: the upstream's text reaches the runtime");
		}),

		test("errors: a context overflow passes through unchanged", async (subject) => {
			for (const route of ["default", "fast", "deep"]) {
				const { token, model } = await session(subject, route);
				subject.upstream.next({ error: FAKE_CONTEXT_OVERFLOW });
				const result = await call(subject, token, model);
				assert.ok(
					errorText(result.message).includes(FAKE_CONTEXT_OVERFLOW.message),
					`${route}: the overflow text is verbatim`,
				);
				assert.strictEqual(isContextOverflow(result.message, model.contextWindow), true, `${route}: an overflow`);
				assert.strictEqual(isRetryableAssistantError(result.message), false, `${route}: an overflow isn't retried`);
			}
		}),

		test("errors: one upstream attempt per call", async (subject) => {
			const { token, model } = await session(subject, "default");
			for (const status of [429, 500, 401]) {
				const before = subject.upstream.calls().length;
				subject.upstream.next({ error: { status, message: `Failure ${status}` } });
				await call(subject, token, model);
				assert.strictEqual(subject.upstream.calls().length - before, 1, `${status}: the upstream saw one attempt`);
			}
		}),

		test("errors: one upstream request even where pi would retry without strict tools", async (subject, deps) => {
			// `default` is claude-sonnet-4-5 on Messages, which supports strict tools: pi sends the preferred-strict tool as
			// strict, and on this 400 would post again without strict mode.
			const { scope, token, model } = await session(subject, "default");
			const before = subject.upstream.calls().length;
			const message = "The compiled grammar is too large, which would cause performance issues.";
			subject.upstream.next({ error: { status: 400, message } });
			const result = await call(subject, token, model, { context: STRICT_TOOL_CONTEXT });
			const sent = subject.upstream.calls().slice(before);
			assert.strictEqual(sent.length, 1, "the upstream saw one request");
			const tools = (sent[0]?.body as { tools?: { strict?: boolean }[] } | undefined)?.tools;
			assert.strictEqual(tools?.[0]?.strict, true, "the request carried the strict tool");
			assert.strictEqual(result.message.stopReason, "error", "the call ends in an error");
			assert.ok(errorText(result.message).includes(message), "the runtime sees the upstream's own error");
			assert.ok(errorText(result.message).startsWith("400"), "with its status");
			await eventually(
				() => deps.audit.ofType("model.call").some((event) => event.sessionId === scope.sessionId),
				5000,
				"the call to be recorded",
			);
			const recorded = deps.audit.ofType("model.call").filter((event) => event.sessionId === scope.sessionId);
			assert.strictEqual(recorded.at(-1)?.data?.status, "error", "and is recorded as an error");
		}),

		test("abort: the client's abort cancels the upstream request", async (subject, deps) => {
			const { scope, token, model } = await session(subject, "default");
			subject.upstream.next({ text: "Slowly, slowly. ".repeat(40), chunks: 40, delayMs: 25 });
			const controller = new AbortController();
			const result = await call(subject, token, model, {
				signal: controller.signal,
				onEvent: (event) => {
					if (event.type === "text_delta") controller.abort();
				},
			});
			assert.strictEqual(result.message.stopReason, "aborted", "the client sees the call aborted");
			const upstreamCall = subject.upstream.calls().at(-1);
			await eventually(() => upstreamCall?.aborted === true, 5000, "the upstream request to be aborted");
			assert.strictEqual(upstreamCall?.completed, false, "the upstream never finished writing");
			await eventually(
				() => deps.audit.ofType("model.call").some((event) => event.sessionId === scope.sessionId),
				5000,
				"the aborted call to be recorded",
			);
			const recorded = deps.audit.ofType("model.call").filter((event) => event.sessionId === scope.sessionId);
			assert.strictEqual(recorded.length, 1, "the aborted call is recorded once");
			assert.strictEqual(recorded[0]?.data?.status, "aborted", "and recorded as aborted");
		}),

		test("abort: aborting while the catalogue refreshes ends the call at once, and it runs on no further", async (subject, deps) => {
			const { model } = await session(subject, "default");
			// Past the catalogue's default 10-minute TTL, so the next call refreshes the platform connector's listing.
			deps.clock.advance(11 * 60_000);
			const scope = scopeFor();
			const token = await subject.mintToken(scope);
			const catalogueReads = () => subject.upstream.requests.filter((request) => request.kind === "catalogue");
			const readsBefore = catalogueReads().length;
			const callsBefore = subject.upstream.calls().length;
			const held = subject.upstream.holdCatalogue();
			try {
				const controller = new AbortController();
				const pending = call(subject, token, model, { signal: controller.signal });
				await eventually(() => catalogueReads().length > readsBefore, 5000, "the gateway to refresh the catalogue");
				controller.abort();
				const result = await within(2000, pending, "the aborted call to end");
				assert.strictEqual(result.message.stopReason, "aborted", "the client sees the call aborted");
				assert.strictEqual(catalogueReads().at(-1)?.completed, false, "while the catalogue read still hangs");
				// The client has given up; over real HTTP the server sees the connection close a moment later.
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				held.release();
			}
			await eventually(() => catalogueReads().at(-1)?.completed === true, 5000, "the catalogue read to finish");
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(subject.upstream.calls().length, callsBefore, "the aborted call never reaches the upstream");
			assertOneCallRecorded(deps, scope, 0, "a call aborted while it resolved");
			// Nor did it pin: the session's next call takes the route as it now is.
			await subject.connectors.putRoute(OPERATOR, {
				name: "default",
				owner: { kind: "platform" },
				connectorId: PLATFORM_CONNECTOR,
				modelId: "gemini-2.5-pro",
			});
			await call(subject, token, model);
			assert.strictEqual(
				(subject.upstream.calls().at(-1)?.body as { model?: string })?.model,
				"gemini-2.5-pro",
				"the aborted call pinned nothing",
			);
		}),

		test("scope: an organisation A token is refused on organisation B's route", async (subject, deps) => {
			const scope = scopeFor();
			const token = await subject.mintToken(scope);
			const before = subject.upstream.calls().length;
			const result = await call(subject, token, unlistedModel("b-route", subject.baseUrl));
			assert.strictEqual(result.message.stopReason, "error", "the call fails");
			assert.ok(errorText(result.message).startsWith("404"), "as not found");
			assert.ok(errorText(result.message).includes("(not_found)"), "with the code");
			const sideways = await call(
				subject,
				token,
				unlistedModel(`b-route:anthropic/claude-sonnet-4.5`, subject.baseUrl),
			);
			assert.ok(errorText(sideways.message).startsWith("404"), "an override on organisation B's route is not found");
			assert.strictEqual(subject.upstream.calls().length, before, "no upstream request was made");
			assertOneCallRecorded(deps, scope, 0, "a refused call");
		}),

		test("scope: a model the project's policy excludes is refused", async (subject, deps) => {
			const scope = scopeFor(NARROW_PROJECT);
			const token = await subject.mintToken(scope);
			const before = subject.upstream.calls().length;
			const excluded = await call(subject, token, unlistedModel("default:gpt-5", subject.baseUrl));
			assert.strictEqual(excluded.message.stopReason, "error", "the call fails");
			assert.ok(errorText(excluded.message).includes("(refused)"), "as refused");
			const route = await call(subject, token, unlistedModel("deep", subject.baseUrl));
			assert.ok(errorText(route.message).includes("(not_found)"), "a route to an excluded model is not found");
			assert.strictEqual(subject.upstream.calls().length, before, "no upstream request was made");
			assertOneCallRecorded(deps, scope, 0, "a refused call");
			const allowed = await call(subject, token, await routeModel(subject, token, "default:gemini-2.5-pro"));
			assert.strictEqual(allowed.message.stopReason, "stop", "an allowed override is served");
			assert.strictEqual((subject.upstream.calls().at(-1)?.body as { model?: string })?.model, "gemini-2.5-pro");
		}),

		test("messages: a context not in pi's shape is invalid before it resolves", async (subject, deps) => {
			const { scope, token, model } = await session(subject, "default");
			const before = subject.upstream.calls().length;
			const user = USER_CONTEXT.messages[0]!;
			const malformed: readonly (readonly [string, unknown])[] = [
				["an assistant message without usage", { role: "assistant", content: [], stopReason: "stop", timestamp: 1 }],
				["a user message with a number for content", { role: "user", content: 42, timestamp: 1 }],
				["a tool result without isError", { role: "toolResult", toolCallId: "c", toolName: "lookup", content: [] }],
				["a message of no known role", { role: "developer", content: "Hi", timestamp: 1 }],
			];
			for (const [label, bad] of malformed) {
				const result = await call(subject, token, model, {
					context: { ...USER_CONTEXT, messages: [user, bad as never] },
				});
				assert.strictEqual(result.message.stopReason, "error", `${label}: the call fails`);
				assert.ok(
					errorText(result.message).includes("(invalid)"),
					`${label}: as invalid: ${errorText(result.message)}`,
				);
			}
			const badTool = await call(subject, token, model, {
				context: { ...USER_CONTEXT, tools: [{ name: "lookup" } as never] },
			});
			assert.ok(errorText(badTool.message).includes("(invalid)"), "a tool without a description or parameters too");
			assert.strictEqual(subject.upstream.calls().length, before, "no upstream request was made");
			assertOneCallRecorded(deps, scope, 0, "an invalid call");
		}),

		test("pins: a session keeps its model across a route edit", async (subject) => {
			const { token, model } = await session(subject, "default");
			await call(subject, token, model);
			assert.strictEqual((subject.upstream.calls().at(-1)?.body as { model?: string })?.model, "claude-sonnet-4-5");
			await subject.connectors.putRoute(OPERATOR, {
				name: "default",
				owner: { kind: "platform" },
				connectorId: PLATFORM_CONNECTOR,
				modelId: "gpt-5",
			});
			await call(subject, token, model);
			assert.strictEqual(
				(subject.upstream.calls().at(-1)?.body as { model?: string })?.model,
				"claude-sonnet-4-5",
				"the pinned session still calls the model it started with",
			);
			assert.strictEqual(
				(await routeModel(subject, token, "default")).contextWindow,
				200_000,
				"its config still describes the pinned model",
			);
			const fresh = await session(subject, "default", scopeFor());
			await call(subject, fresh.token, fresh.model);
			assert.strictEqual(
				(subject.upstream.calls().at(-1)?.body as { model?: string })?.model,
				"gpt-5",
				"a new session gets the edited route",
			);
		}),

		test("pins: a pin outlives its route's edit to a model the policy excludes, and its deletion", async (subject) => {
			const bodyModel = () => (subject.upstream.calls().at(-1)?.body as { model?: string })?.model;
			// The narrowed project allows claude-sonnet-4-5 and gemini-2.5-pro only.
			const { token, model } = await session(subject, "default", scopeFor(NARROW_PROJECT));
			await call(subject, token, model);
			const platform = { kind: "platform" } as const;
			await subject.connectors.putRoute(OPERATOR, {
				name: "default",
				owner: platform,
				connectorId: PLATFORM_CONNECTOR,
				modelId: "gpt-5",
			});
			const edited = await call(subject, token, model);
			assert.strictEqual(edited.message.stopReason, "stop", `the pin is served: ${errorText(edited.message)}`);
			assert.strictEqual(bodyModel(), "claude-sonnet-4-5", "by the model it pinned");
			assert.ok(
				(await config(subject, token)).models.some((entry) => entry.id === "default"),
				"and config lists it",
			);
			const fresh = await subject.mintToken(scopeFor(NARROW_PROJECT));
			assert.ok(
				!(await config(subject, fresh)).models.some((entry) => entry.id === "default"),
				"a new session of the project doesn't get the excluded route",
			);

			await subject.connectors.deleteRoute(OPERATOR, platform, "default");
			const deleted = await call(subject, token, model);
			assert.strictEqual(
				deleted.message.stopReason,
				"stop",
				`the pin outlives its route: ${errorText(deleted.message)}`,
			);
			assert.strictEqual(bodyModel(), "claude-sonnet-4-5");
			assert.ok(
				(await config(subject, token)).models.some((entry) => entry.id === "default"),
				"config still lists the pinned route",
			);

			await subject.connectors.setProjectPolicy(contextFor(ADMIN, ORG), {
				organisationId: ORG,
				projectId: NARROW_PROJECT,
				connectors: [PLATFORM_CONNECTOR],
				models: ["gemini-2.5-pro"],
			});
			const before = subject.upstream.calls().length;
			const refused = await call(subject, token, model);
			assert.strictEqual(refused.message.stopReason, "error", "a pin the policy now excludes is refused");
			assert.strictEqual(subject.upstream.calls().length, before, "before reaching the upstream");
			assert.ok(
				!(await config(subject, token)).models.some((entry) => entry.id === "default"),
				"and config no longer lists it",
			);
		}),

		test("pins: config describes each model ID as messages serves it, pinned or not", async (subject, deps) => {
			const bodyOf = () => subject.upstream.calls().at(-1)?.body as { model?: string; reasoning?: { effort?: string } };
			const { scope, token } = await session(subject, "default");
			const pinned = await routeModel(subject, token, "default:house-model");
			await call(subject, token, pinned);
			const deep = await routeModel(subject, token, "deep");
			await call(subject, token, deep);
			assert.strictEqual(bodyOf()?.reasoning?.effort, "high", "deep calls with its route's thinking");

			// The operator moves `default` to a second connector, which describes house-model differently and offers no
			// gpt-5, and turns `deep`'s thinking down.
			const { vaultItemId } = await subject.connectors.getConnector(OPERATOR, PLATFORM_CONNECTOR);
			const platform = { kind: "platform" } as const;
			await subject.connectors.putConnector(OPERATOR, {
				id: "platform-small",
				owner: platform,
				preset: "litellm",
				baseUrl: PLATFORM_BASE_URL,
				vaultItemId,
				catalogue: {
					refresh: "static",
					include: ["gemini-2.5-pro", "house-model"],
					overrides: { "house-model": { name: "Small house model", contextWindow: 8_000, maxTokens: 1024 } },
				},
			});
			await subject.connectors.putRoute(OPERATOR, {
				name: "default",
				owner: platform,
				connectorId: "platform-small",
				modelId: "gemini-2.5-pro",
			});
			await subject.connectors.putRoute(OPERATOR, {
				name: "deep",
				owner: platform,
				connectorId: PLATFORM_CONNECTOR,
				modelId: "gpt-5",
				thinking: "low",
			});

			const listed = new Map((await config(subject, token)).models.map((entry) => [entry.id, entry]));
			assert.strictEqual(
				listed.get("default:house-model")?.contextWindow,
				32_000,
				"a pinned override is described by the connector it is pinned to",
			);
			assert.ok(!listed.has("default:gpt-5"), "an unpinned override is listed only if the route's connector offers it");
			const unpinned = await call(subject, token, unlistedModel("default:gpt-5", subject.baseUrl));
			assert.strictEqual(unpinned.message.stopReason, "error", "and messages doesn't serve it");
			assert.ok(!listed.has("default:claude-sonnet-4-5"), "nor are the old connector's other models");

			await call(subject, token, pinned);
			assert.strictEqual(bodyOf()?.model, "house-model", "the pinned override is served");
			await eventually(
				() => deps.audit.ofType("model.call").filter((event) => event.sessionId === scope.sessionId).length === 3,
				5000,
				"the call to be recorded",
			);
			const recorded = deps.audit.ofType("model.call").filter((event) => event.sessionId === scope.sessionId);
			assert.strictEqual(recorded.at(-1)?.data?.connectorId, PLATFORM_CONNECTOR, "by the connector it is pinned to");
			await call(subject, token, deep);
			assert.strictEqual(bodyOf()?.reasoning?.effort, "low", "a pinned route calls with the route's current thinking");
			await subject.connectors.deleteRoute(OPERATOR, platform, "deep");
			await call(subject, token, deep);
			const effort = bodyOf()?.reasoning?.effort;
			assert.ok(effort === undefined || effort === "none", `and with none once the route is gone, not ${effort}`);
		}),

		test("secrets: the upstream key reaches no client event and the canary no audit event", async (subject, deps) => {
			// The upstream echoes the key everywhere it sets a string: names in its catalogue, response and tool-call IDs,
			// the tool's namespace, content and error text.
			subject.upstream.setModels([
				{ id: "claude-sonnet-4-5", name: `Claude for ${PLATFORM_KEY}` },
				{ id: "gemini-2.5-pro" },
				{ id: "gpt-5", name: PLATFORM_KEY },
				{ id: "house-model" },
			]);
			const { token, model } = await session(subject, "default");
			const seen: unknown[] = [await config(subject, token)];
			subject.upstream.next({
				text: `Your key is ${PLATFORM_KEY}, as you asked.`,
				chunks: 9,
				responseId: `msg_${PLATFORM_KEY}`,
				toolCall: { id: PLATFORM_KEY, name: "lookup", arguments: { query: "harbour" } },
			});
			seen.push(...(await call(subject, token, model, { context: TOOL_CONTEXT })).events);
			subject.upstream.next({ error: { status: 401, message: `Incorrect API key provided: ${PLATFORM_KEY}` } });
			const denied = await call(subject, token, model);
			seen.push(...denied.events);
			const deep = await routeModel(subject, token, "deep");
			subject.upstream.next({
				thinking: `I could use ${PLATFORM_KEY}`,
				responseId: `resp_${PLATFORM_KEY}`,
				toolCall: { id: PLATFORM_KEY, name: "lookup", arguments: { query: PLATFORM_KEY }, namespace: PLATFORM_KEY },
			});
			seen.push(...(await call(subject, token, deep, { context: TOOL_CONTEXT })).events);
			assert.ok(!JSON.stringify(seen).includes(PLATFORM_KEY), "no event the client sees holds the key");
			assert.ok(!containsCanary(seen), "nor the canary");
			assert.ok(errorText(denied.message).includes("Incorrect API key provided"), "the error text survives redaction");
			assert.ok(!containsCanary(deps.audit.events), "no audit event holds the canary");
			const upstreamKeys = subject.upstream.calls().map((request) => request.headers.authorization ?? "");
			assert.ok(
				subject.upstream.calls().every((request) => !JSON.stringify(request.body).includes(token)),
				"the session token never reaches the upstream",
			);
			assert.ok(upstreamKeys.length > 0, "the upstream was called");
		}),

		test("secrets: a key split inside JSON escapes reaches no delta and no partial tool call", async (subject) => {
			const escaped = jsonEscaped(PLATFORM_KEY);
			const argumentJson = `{"query":"${escaped}","limit":3}`;
			const argumentDeltas: string[] = [];
			for (let at = 0; at < argumentJson.length; at += 5) argumentDeltas.push(argumentJson.slice(at, at + 5));
			for (const route of ["default", "fast", "deep"]) {
				const { token, model } = await session(subject, route);
				subject.upstream.next({
					thinking: "",
					text: `Echoed: {"key":"${escaped}"}`,
					chunks: 61,
					toolCall: {
						id: "call_escaped",
						name: "lookup",
						arguments: { query: PLATFORM_KEY, limit: 3 },
						argumentDeltas,
					},
				});
				const leaks: string[] = [];
				const result = await call(subject, token, model, {
					context: TOOL_CONTEXT,
					// Each event as it arrives, its partial message included: pi's client parses the partial tool arguments
					// from the deltas so far, decoding their escapes.
					onEvent: (event) => {
						for (const leak of leaksOf(event, PLATFORM_KEY)) leaks.push(`${event.type}: ${leak}`);
					},
				});
				assert.strictEqual(result.message.stopReason, "toolUse", `${route}: ${errorText(result.message)}`);
				assert.deepEqual(leaks, [], `${route}: no event, delta or partial tool call holds the key`);
				const tool = result.message.content.find((block) => block.type === "toolCall");
				assert.ok(
					tool?.type === "toolCall" && tool.arguments.limit === 3 && tool.arguments.query !== PLATFORM_KEY,
					`${route}: the tool call's arguments arrive, the key redacted`,
				);
			}
		}),

		test("accounting: exactly one model.call per resolved call, none for a refused one", async (subject, deps) => {
			const { scope, token, model } = await session(subject, "default");
			await call(subject, token, model);
			subject.upstream.next({ error: { status: 500, message: "Internal server error" } });
			await call(subject, token, model);
			await call(subject, token, unlistedModel("no-such-route", subject.baseUrl));
			await eventually(
				() => deps.audit.ofType("model.call").filter((event) => event.sessionId === scope.sessionId).length >= 2,
				5000,
				"two model.call events",
			);
			assertOneCallRecorded(deps, scope, 2, "two resolved calls");
			const [first, second] = deps.audit.ofType("model.call").filter((event) => event.sessionId === scope.sessionId);
			assert.partialDeepEqual(
				first,
				{ organisationId: ORG, projectId: PROJECT, agentId: scope.agentId },
				"model.call names the session's scope",
			);
			assert.partialDeepEqual(
				first?.data,
				{ route: "default", connectorId: PLATFORM_CONNECTOR, modelId: "claude-sonnet-4-5", status: "done" },
				"model.call names the route, connector and model",
			);
			assert.strictEqual(second?.data?.status, "error", "a failed call is recorded as an error");
			const serialised = JSON.stringify(deps.audit.ofType("model.call"));
			assert.ok(!serialised.includes("Say hello."), "model.call holds no prompt");
			assert.ok(!serialised.includes(DEFAULT_FAKE_SCRIPT.text), "model.call holds no completion");
		}),

		test("credentials: the key is read through the vault, cached, and read again after a 401", async (subject, deps) => {
			const { scope, token, model } = await session(subject, "default");
			deps.tenancy.session({
				id: scope.sessionId,
				organisationId: scope.organisationId,
				projectId: scope.projectId,
				agentId: scope.agentId,
			});
			const admin = contextFor(ADMIN, ORG, PROJECT);
			const uses = async () =>
				(await subject.credentials.listUses(admin, { sessionId: scope.sessionId })).items.filter(
					(use) => use.outcome === "injected",
				).length;
			await call(subject, token, model);
			const afterFirst = await uses();
			assert.greaterThan(afterFirst, 0, "the gateway read the key through the vault, which recorded a use");
			await call(subject, token, model);
			assert.strictEqual(await uses(), afterFirst, "a second call uses the cached key");
			subject.upstream.next({ error: { status: 401, message: "Invalid API key" } });
			await call(subject, token, model);
			await call(subject, token, model);
			assert.greaterThan(await uses(), afterFirst, "after a 401 the key is read again");
			const keys = subject.upstream.calls().map((request) => request.headers["x-api-key"]);
			assert.ok(
				keys.every((key) => key === PLATFORM_KEY),
				"every Messages call carried the key in x-api-key",
			);
		}),

		test("headers: the client's headers never reach the upstream", async (subject) => {
			const { scope, token, model } = await session(subject, "fast");
			await call(subject, token, model, {
				headers: { "x-litellm-tags": "project:someone-else", "x-harbour-evil": "1", "x-api-key": "sk-client" },
				sessionId: "client-chosen-session",
			});
			const upstream = subject.upstream.calls().at(-1);
			assert.strictEqual(upstream?.headers["x-harbour-evil"], undefined, "an arbitrary client header is dropped");
			assert.ok(
				upstream?.headers["x-litellm-tags"]?.includes(`project:${scope.projectId}`) === true &&
					!upstream.headers["x-litellm-tags"].includes("someone-else"),
				"attribution comes from the token, not the client",
			);
			assert.strictEqual(upstream?.headers.authorization, `Bearer ${PLATFORM_KEY}`, "the key is the connector's");
			assert.ok(
				!JSON.stringify(upstream?.body).includes("client-chosen-session"),
				"the session comes from the token, not the body",
			);
		}),

		test("tokens: a bad, tampered or expired token is refused", async (subject, deps) => {
			const scope = scopeFor();
			const token = await subject.mintToken(scope, 60_000);
			for (const [label, bad] of [
				["garbage", "not-a-token"],
				["tampered", `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`],
				["empty", ""],
			] as const) {
				const response = await loadConfig(subject, bad);
				assert.strictEqual(response.status, 401, `a ${label} token is refused`);
				await response.body?.cancel();
			}
			const model = await routeModel(subject, token, "default");
			deps.clock.advance(61_000);
			const expired = await loadConfig(subject, token);
			assert.strictEqual(expired.status, 401, "an expired token is refused");
			assert.partialDeepEqual(await expired.json(), { error: { code: "expired" } }, "as expired");
			const before = subject.upstream.calls().length;
			const result = await call(subject, token, model);
			assert.ok(errorText(result.message).startsWith("401"), "messages refuses an expired token too");
			assert.strictEqual(subject.upstream.calls().length, before, "no upstream request was made");
		}),
	];
}

export function registerModelGatewayConformance(
	runner: ConformanceRunner,
	name: string,
	provider: FakeModelGatewayConformanceProvider,
): void {
	registerCases(
		runner,
		name,
		createModelGatewayConformance({ assertions: createExpectAssertions(runner.expect), provider }),
	);
}

// ----------------------------------------------------------------------------------------------------------------
// The connector suite
// ----------------------------------------------------------------------------------------------------------------

/** One connector under test: a preset, a wire API, a model it serves, and where and with what key to reach it. */
export interface ModelConnectorTarget {
	readonly preset: ConnectorPreset;
	readonly api: ModelWireApi;
	/** The upstream's own model ID. */
	readonly modelId: string;
	readonly baseUrl: string;
	readonly key: string;
	/** How the connector's catalogue refreshes. Default `gateway`. */
	readonly refresh?: "gateway" | "static";
}

/** Where a preset puts the key, per wire API (docs/model-connectors.md, "The six providers"). */
function expectedKeyHeader(api: ModelWireApi): "authorization" | "x-api-key" {
	return api === "anthropic-messages" ? "x-api-key" : "authorization";
}

type Body = { readonly [key: string]: unknown } | undefined;
const record = (value: unknown): Body =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as { readonly [key: string]: unknown })
		: undefined;

/** How each preset's session affinity reaches the upstream; undefined where it has none. */
const AFFINITY: {
	readonly [preset in ConnectorPreset]?: (request: UpstreamRequest, api: ModelWireApi) => string | undefined;
} = {
	"vercel-ai-gateway": (request) => request.headers["x-session-id"],
	openrouter: (request) => request.headers["x-session-id"],
	cliproxyapi: (request) => request.headers["x-session-affinity"],
	openai: (request) => record(request.body)?.prompt_cache_key as string | undefined,
};

/** Each preset's attribution, checked against the scope; undefined where the preset carries none. */
const ATTRIBUTION: {
	readonly [preset in ConnectorPreset]?: (
		request: UpstreamRequest,
		scope: ModelCallScope,
		api: ModelWireApi,
	) => boolean;
} = {
	litellm: (request, scope, api) => {
		const tags = request.headers["x-litellm-tags"] ?? "";
		const metadata = record(record(request.body)?.metadata);
		const inBody =
			api === "anthropic-messages"
				? String(metadata?.user_id ?? "").includes(scope.sessionId)
				: JSON.stringify(metadata?.tags ?? []).includes(`project:${scope.projectId}`) &&
					metadata?.organisation_id === scope.organisationId &&
					metadata?.project_id === scope.projectId;
		// The IDs as spend-log metadata, on every wire API, under the keys Lleverage's agent-service uses.
		let spend: { readonly [key: string]: unknown } | undefined;
		try {
			spend = record(JSON.parse(request.headers["x-litellm-spend-logs-metadata"] ?? "null"));
		} catch {
			spend = undefined;
		}
		return (
			spend?.organisation_id === scope.organisationId &&
			spend?.project_id === scope.projectId &&
			spend?.session_id === scope.sessionId &&
			tags.includes(`organisation:${scope.organisationId}`) &&
			tags.includes(`project:${scope.projectId}`) &&
			tags.includes(`agent:${scope.agentId}`) &&
			tags.includes(`session:${scope.sessionId}`) &&
			inBody
		);
	},
	anthropic: (request, scope) =>
		String(record(record(request.body)?.metadata)?.user_id ?? "").includes(scope.sessionId),
	"anthropic-compatible": (request, scope) =>
		String(record(record(request.body)?.metadata)?.user_id ?? "").includes(scope.sessionId),
	openai: (request, scope) => String(record(request.body)?.user ?? "").includes(scope.sessionId),
};

const EFFORT_RANK: { readonly [effort: string]: number } = {
	none: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

/**
 * How hard the upstream payload asks the model to think: 0 for not at all, else a budget in tokens or the rank of an
 * effort, comparable within one model. Covers Anthropic's `thinking` and `output_config.effort`, Responses'
 * `reasoning.effort`, and Chat Completions' `reasoning_effort`, OpenRouter's `reasoning` and `thinking` flags.
 */
export function thinkingStrength(body: unknown): number {
	const payload = record(body);
	const thinking = record(payload?.thinking);
	const outputEffort = record(payload?.output_config)?.effort;
	const reasoning = record(payload?.reasoning);
	if (thinking !== undefined) {
		if (thinking.type === "disabled") return 0;
		if (typeof outputEffort === "string") return EFFORT_RANK[outputEffort] ?? 1;
		if (typeof thinking.budget_tokens === "number") return thinking.budget_tokens;
		return thinking.type === "enabled" || thinking.type === "adaptive" ? 1 : 0;
	}
	const effort = reasoning?.effort ?? payload?.reasoning_effort;
	if (typeof effort === "string") return EFFORT_RANK[effort] ?? 1;
	if (reasoning?.enabled === true || payload?.enable_thinking === true) return 1;
	return 0;
}

const CONNECTOR_ROUTE = "under-test";
const CONNECTOR_ID = "connector-under-test";

export function createModelConnectorConformance(options: {
	assertions: ConformanceAssertions;
	provider: ModelGatewayConformanceProvider;
	targets: readonly ModelConnectorTarget[];
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const cases: ConformanceCase[] = [];

	for (const target of options.targets) {
		const label = `${target.preset} on ${target.api} (${target.modelId})`;
		const test = (
			name: string,
			body: (
				subject: ModelGatewaySubject,
				context: { readonly scope: ModelCallScope; readonly token: string; readonly model: Model<"pi-messages"> },
			) => Promise<void>,
		): void => {
			cases.push({
				name: `${label}: ${name}`,
				timeoutMs: 120_000,
				run: async () => {
					const deps = createDeps();
					await options.provider(deps, async (subject) => {
						const item = await putKey(subject, OPERATOR, { kind: "platform" }, target.baseUrl, target.key, label);
						await subject.connectors.putConnector(OPERATOR, {
							id: CONNECTOR_ID,
							owner: { kind: "platform" },
							preset: target.preset,
							baseUrl: target.baseUrl,
							vaultItemId: item,
							catalogue: {
								refresh: target.refresh ?? "gateway",
								...(target.refresh === "static" ? { include: [target.modelId] } : {}),
								overrides: { [target.modelId]: { api: target.api } },
							},
						});
						await subject.connectors.putRoute(OPERATOR, {
							name: CONNECTOR_ROUTE,
							owner: { kind: "platform" },
							connectorId: CONNECTOR_ID,
							modelId: target.modelId,
						});
						const scope = scopeFor();
						const token = await subject.mintToken(scope);
						await body(subject, { scope, token, model: await routeModel(subject, token, CONNECTOR_ROUTE) });
					});
				},
			});
		};

		const lastCall = (subject: ModelGatewaySubject) =>
			subject.upstream.requests.filter((request) => request.kind === target.api).at(-1);

		test("the catalogue lists the route's model with its context window", async (_subject, { model }) => {
			assert.greaterThan(model.contextWindow, 0, "the route's model has a context window");
			assert.greaterThan(model.maxTokens, 0, "and a maximum output");
		});

		test("a call streams back and ends with usage, the key in the preset's header", async (subject, ctx) => {
			const result = await call(subject, ctx.token, ctx.model);
			assert.strictEqual(result.message.stopReason, "stop", `the call ends done: ${result.message.errorMessage ?? ""}`);
			assert.greaterThan(result.message.usage.output, 0, "usage counts output tokens");
			const request = lastCall(subject);
			assert.ok(request !== undefined, `the upstream saw a ${target.api} request`);
			const header = expectedKeyHeader(target.api);
			const value = request?.headers[header];
			assert.strictEqual(
				value,
				header === "authorization" ? `Bearer ${target.key}` : target.key,
				`the key travels in ${header}`,
			);
			const other = header === "authorization" ? request?.headers["x-api-key"] : request?.headers.authorization;
			assert.ok(other === undefined || !other.includes(target.key), "and nowhere else");
			assert.strictEqual(record(request?.body)?.model, target.modelId, "the upstream is asked for its own model ID");
		});

		test("the key travels in the preset's header whatever its form, never changing the auth scheme", async (subject, ctx) => {
			// A key shaped like an Anthropic OAuth token, or, on the OpenAI APIs, like a ChatGPT sign-in token (no `sk-`),
			// from which pi would pick another auth scheme if it were given the key. The upstream may refuse it; what
			// matters is how it is sent.
			const synthetic =
				target.api === "anthropic-messages" ? "sk-ant-oat01-harbour-synthetic-7c2e9a" : "harbour-synthetic-7c2e9a";
			const item = await putKey(
				subject,
				OPERATOR,
				{ kind: "platform" },
				target.baseUrl,
				synthetic,
				`${label} synthetic`,
			);
			await subject.connectors.putConnector(OPERATOR, {
				id: `${CONNECTOR_ID}-synthetic`,
				owner: { kind: "platform" },
				preset: target.preset,
				baseUrl: target.baseUrl,
				vaultItemId: item,
				catalogue: {
					refresh: "static",
					include: [target.modelId],
					overrides: { [target.modelId]: { api: target.api } },
				},
			});
			await subject.connectors.putRoute(OPERATOR, {
				name: "synthetic",
				owner: { kind: "platform" },
				connectorId: `${CONNECTOR_ID}-synthetic`,
				modelId: target.modelId,
			});
			await call(subject, ctx.token, await routeModel(subject, ctx.token, "synthetic"), { context: USER_CONTEXT });
			const request = lastCall(subject);
			assert.ok(request !== undefined, `the upstream saw a ${target.api} request`);
			const header = expectedKeyHeader(target.api);
			assert.strictEqual(
				request?.headers[header],
				header === "authorization" ? `Bearer ${synthetic}` : synthetic,
				`the key travels in ${header}`,
			);
			assert.ok(!(request?.headers.authorization ?? "").includes("unused"), "with no placeholder key beside it");
			if (target.api === "anthropic-messages") {
				assert.strictEqual(request?.headers.authorization, undefined, "not as an OAuth bearer token");
				assert.ok(!(request?.headers["user-agent"] ?? "").includes("claude-cli"), "nor as Claude Code");
				assert.strictEqual(request?.headers["x-app"], undefined, "with no Claude Code app header");
				assert.ok(
					!JSON.stringify(record(request?.body)?.system ?? "").includes("Claude Code"),
					"and no Claude Code system prompt",
				);
			}
		});

		test("prompt caching reaches the upstream: Anthropic cache breakpoints, the Responses cache key", async (subject, ctx) => {
			// Chat Completions carries no cache hint pi sets for these upstreams (only api.openai.com takes a cache key, and
			// breakpoints only where a preset's compat asks), so a target on it has nothing to show.
			if (target.api === "openai-completions") return;
			await call(subject, ctx.token, ctx.model, { context: USER_CONTEXT });
			const body = record(lastCall(subject)?.body);
			assert.ok(body !== undefined, `the upstream saw a ${target.api} request`);
			if (target.api === "anthropic-messages") {
				assert.ok(JSON.stringify(body).includes('"cache_control"'), "the request marks cache breakpoints");
			} else {
				assert.strictEqual(
					body?.prompt_cache_key,
					[...ctx.scope.sessionId].slice(0, 64).join(""),
					"the cache key is the token's session, clamped to 64 characters",
				);
			}
		});

		test("attribution and session affinity come from the token's scope", async (subject, ctx) => {
			await call(subject, ctx.token, ctx.model);
			const request = lastCall(subject);
			assert.ok(request !== undefined, `the upstream saw a ${target.api} request`);
			if (request === undefined) return;
			const affinity = AFFINITY[target.preset];
			if (affinity !== undefined) {
				assert.strictEqual(affinity(request, target.api), ctx.scope.sessionId, "the session ID carries affinity");
			}
			const attribution = ATTRIBUTION[target.preset];
			if (attribution !== undefined) {
				assert.ok(attribution(request, ctx.scope, target.api), "attribution names the session's scope");
			}
		});

		test("every thinking level the model supports reaches the upstream payload", async (subject, ctx) => {
			if (!ctx.model.reasoning) return;
			const levels = getSupportedThinkingLevels(ctx.model).filter((level) => level !== "off");
			const strengths: number[] = [];
			await call(subject, ctx.token, ctx.model);
			assert.strictEqual(thinkingStrength(lastCall(subject)?.body), 0, "without a level the route's (none) applies");
			for (const level of levels) {
				const result = await call(subject, ctx.token, ctx.model, { reasoning: level });
				assert.strictEqual(result.message.stopReason, "stop", `${level}: ${result.message.errorMessage ?? ""}`);
				const strength = thinkingStrength(lastCall(subject)?.body);
				assert.greaterThan(strength, 0, `${level} asks the upstream to think`);
				strengths.push(strength);
			}
			for (let at = 1; at < strengths.length; at += 1) {
				assert.ok(strengths[at]! >= strengths[at - 1]!, `${levels[at]} asks for no less than ${levels[at - 1]}`);
			}
			if (strengths.length > 1) {
				assert.greaterThan(strengths.at(-1)!, strengths[0]!, "the highest level asks for more than the lowest");
			}
		});
	}
	return cases;
}

export function registerModelConnectorConformance(
	runner: ConformanceRunner,
	name: string,
	provider: ModelGatewayConformanceProvider,
	targets: readonly ModelConnectorTarget[],
): void {
	registerCases(
		runner,
		name,
		createModelConnectorConformance({ assertions: createExpectAssertions(runner.expect), provider, targets }),
	);
}

/** A key the fake upstream takes, for connector targets in CI. */
export const FAKE_UPSTREAM_KEY = "sk-fake-upstream-0b7e4c11";

/**
 * Every preset on every wire API it speaks, against the fake upstream: the connector suite's CI matrix. Model IDs are
 * ones pi's catalogue knows, so metadata joins as it would on the real upstream.
 */
export const FAKE_CONNECTOR_TARGETS: readonly ModelConnectorTarget[] = (
	[
		["litellm", "anthropic-messages", "claude-sonnet-4-5", "http://litellm.fake.internal:4000/v1"],
		["litellm", "openai-completions", "gemini-2.5-pro", "http://litellm.fake.internal:4000/v1"],
		["litellm", "openai-responses", "gpt-5", "http://litellm.fake.internal:4000/v1"],
		["vercel-ai-gateway", "anthropic-messages", "anthropic/claude-sonnet-4.5", "https://ai-gateway.fake.internal/v1"],
		["vercel-ai-gateway", "openai-completions", "openai/gpt-5", "https://ai-gateway.fake.internal/v1"],
		["vercel-ai-gateway", "openai-responses", "openai/gpt-5", "https://ai-gateway.fake.internal/v1"],
		["openrouter", "openai-completions", "openai/gpt-5", "https://openrouter.fake.internal/api/v1"],
		["openrouter", "anthropic-messages", "anthropic/claude-sonnet-4.5", "https://openrouter.fake.internal/api/v1"],
		["anthropic", "anthropic-messages", "claude-sonnet-4-5", "https://anthropic.fake.internal/v1"],
		["openai", "openai-responses", "gpt-5", "https://openai.fake.internal/v1"],
		["openai", "openai-completions", "gpt-5", "https://openai.fake.internal/v1"],
		["cliproxyapi", "anthropic-messages", "claude-sonnet-4-5", "http://cpa.fake.internal:8317/v1"],
		["cliproxyapi", "openai-completions", "gemini-2.5-pro", "http://cpa.fake.internal:8317/v1"],
		["cliproxyapi", "openai-responses", "gpt-5", "http://cpa.fake.internal:8317/v1"],
		["openai-compatible", "openai-completions", "gpt-5", "http://compatible.fake.internal/v1"],
		["openai-compatible", "openai-responses", "gpt-5", "http://compatible.fake.internal/v1"],
		["anthropic-compatible", "anthropic-messages", "claude-sonnet-4-5", "http://anthropic-compatible.fake.internal/v1"],
	] as const
).map(([preset, api, modelId, baseUrl]) => ({ preset, api, modelId, baseUrl, key: FAKE_UPSTREAM_KEY }));

/** The models `FAKE_CONNECTOR_TARGETS` name, for the fake upstream's catalogue. */
export const FAKE_CONNECTOR_MODELS: readonly FakeListedModel[] = [
	...new Set(FAKE_CONNECTOR_TARGETS.map((target) => target.modelId)),
].map((id) => ({ id }));
