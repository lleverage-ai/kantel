/**
 * Projects a Pi Durable conversation view onto `@harbour/protocol` transcript items. The projector keeps what it has
 * already shown and turns each new view into delta ops, so a runtime can publish them on its session stream. It holds
 * no Pi handles: any target that watches a Pi Durable conversation can feed it views.
 */
import type {
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, InputEntry, LiveState } from "@earendil-works/pi-durable";
import {
	type AssistantItem,
	attentionFor,
	type DeltaOp,
	type NoticeItem,
	type SessionStatus,
	type Timestamp,
	TOOL_IMAGE_TYPES,
	type ToolImage,
	type ToolItem,
	type ToolItemStatus,
	type UserItem,
	type UserItemVia,
} from "@harbour/protocol";

/** The entry kind Harbour places user input as, so the projection knows how the input was sent. */
export const HARBOUR_USER_ENTRY = "harbour.user";

export interface HarbourUserEntryData {
	readonly via: UserItemVia;
	readonly requestId?: string;
}

/** The entry a Harbour input is placed as: its kind and how it was sent. The model still sees the text. */
export function harbourUserEntry(via: UserItemVia, requestId?: string): InputEntry {
	return { kind: HARBOUR_USER_ENTRY, data: requestId === undefined ? { via } : { via, requestId } };
}

/** The plain-language chip label of a tool call. */
export function toolLabel(name: string, args?: unknown): string {
	return browserToolLabel(name, args) ?? `Calling ${name}`;
}

function hostOf(url: unknown): string | undefined {
	if (typeof url !== "string") return undefined;
	try {
		return new URL(url).host || undefined;
	} catch {
		return undefined;
	}
}

/** Labels for the browser's tools (`@harbour/browser`), from their arguments. */
function browserToolLabel(name: string, args: unknown): string | undefined {
	if (!name.startsWith("browser_")) return undefined;
	const input = typeof args === "object" && args !== null ? (args as { readonly [key: string]: unknown }) : {};
	const host = hostOf(input.url);
	switch (name) {
		case "browser_request":
			return "Asking for a browser";
		case "browser_open":
			return host === undefined ? "Opening a browser" : `Opening ${host}`;
		case "browser_screenshot":
			return "Taking a screenshot";
		case "browser_close":
			return "Closing the browser";
		case "browser_act":
			switch (input.action) {
				case "goto":
					return host === undefined ? "Going to a page" : `Going to ${host}`;
				case "look":
					return "Reading the page";
				case "click":
					return "Clicking on the page";
				case "fill":
					return "Typing into the page";
				case "select":
					return "Choosing an option";
				case "check":
					return "Ticking a box";
				case "press":
					return typeof input.key === "string" ? `Pressing ${input.key}` : "Pressing a key";
				case "scroll":
					return "Scrolling the page";
				case "wait":
					return "Waiting for the page";
				default:
					return "Using the browser";
			}
		default:
			return undefined;
	}
}

/** The most images one tool item carries; a tool returning more shows its first ones. */
export const MAX_TOOL_IMAGES = 4;

function toolImage(value: unknown): ToolImage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { mimeType, data } = value as { readonly mimeType?: unknown; readonly data?: unknown };
	if (typeof data !== "string" || data === "") return undefined;
	if (!(TOOL_IMAGE_TYPES as readonly unknown[]).includes(mimeType)) return undefined;
	return { mimeType: mimeType as ToolImage["mimeType"], data };
}

/**
 * The images a tool result shows: its image content (what the model sees), then the images in its UI details
 * (`details.images`, for the transcript only), raster types only, at most `MAX_TOOL_IMAGES`.
 */
export function toolImagesOf(message: Pick<ToolResultMessage, "content" | "details">): ToolImage[] {
	const images: ToolImage[] = [];
	const content = typeof message.content === "string" ? [] : message.content;
	for (const block of content) {
		if (block.type !== "image") continue;
		const image = toolImage(block);
		if (image !== undefined) images.push(image);
	}
	const details = message.details as { readonly images?: unknown } | undefined;
	if (typeof details === "object" && details !== null && Array.isArray(details.images)) {
		for (const value of details.images) {
			const image = toolImage(value);
			if (image !== undefined) images.push(image);
		}
	}
	return images.slice(0, MAX_TOOL_IMAGES);
}

/** Tool result diagnostics that mean the call stopped before it finished. */
const INTERRUPTED_CODES = new Set(["aborted", "interrupted", "abandoned"]);

type ContentBlock = TextContent | ThinkingContent | ToolCall | { readonly type: string };

function textOf(content: readonly ContentBlock[] | string | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) if (block.type === "text") text += (block as TextContent).text;
	return text;
}

function thinkingOf(content: readonly ContentBlock[]): string {
	let thinking = "";
	for (const block of content) if (block.type === "thinking") thinking += (block as ThinkingContent).thinking;
	return thinking;
}

/** A stored time, when the message carries a usable one. */
const timeOf = (value: unknown): Timestamp | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * When an answer was generated: when its response ended (the request's start plus its duration), or when it started
 * for a message without a duration. From the stored message, so it is the same when the session is projected again.
 */
function answeredAt(message: AssistantMessage): Timestamp | undefined {
	const started = timeOf(message.timestamp);
	if (started === undefined) return undefined;
	const took = timeOf(message.durationMs);
	return took === undefined ? started : started + took;
}

function userViaOf(entry: EntryRecord): { via: UserItemVia; requestId?: string } {
	if (entry.kind !== HARBOUR_USER_ENTRY || typeof entry.data !== "object" || entry.data === null) {
		return { via: "prompt" };
	}
	const data = entry.data as Partial<HarbourUserEntryData>;
	const via: UserItemVia = data.via === "steer" || data.via === "followUp" ? data.via : "prompt";
	return typeof data.requestId === "string" ? { via, requestId: data.requestId } : { via };
}

/**
 * Turns successive views of one conversation into delta ops. New entries append items; a streamed answer grows one
 * assistant item with `text` ops; a tool call is a `tool` item replaced when its result lands; status changes become
 * `status` ops.
 */
export class ConversationProjector {
	readonly #now: () => Timestamp;
	readonly #seenEntries = new Set<string>();
	/** Tool items by Pi tool call ID, while their result is outstanding. */
	readonly #runningTools = new Map<string, ToolItem>();
	/** The entry behind each user and settled assistant item, by item ID: where a fork or an edit starts. */
	readonly #entries = new Map<string, EntryRecord>();
	#streaming: AssistantItem | undefined;
	#streamCount = 0;
	#status: SessionStatus = "idle";
	#lastRunFailed = false;
	#closed = false;

	constructor(options: { readonly now: () => Timestamp }) {
		this.#now = options.now;
	}

	get status(): SessionStatus {
		return this.#status;
	}

	/**
	 * The entry a user message or a settled answer was projected from, by its item ID. `undefined` for any other item, an
	 * answer still streaming, and an ID this projection never gave out.
	 */
	entryOf(itemId: string): { readonly kind: "user" | "assistant"; readonly entry: EntryRecord } | undefined {
		const entry = this.#entries.get(itemId);
		if (entry === undefined) return undefined;
		return { kind: entry.kind === "pi.assistant" ? "assistant" : "user", entry };
	}

	/** The ops that bring the projection from the previous view to `view`; empty when nothing shown changed. */
	project(view: ConversationView): DeltaOp[] {
		const ops: DeltaOp[] = [];
		for (const entry of view.entries) {
			const id = String(entry.id);
			if (this.#seenEntries.has(id)) continue;
			this.#seenEntries.add(id);
			this.#projectEntry(entry, ops);
		}
		const live = view.docs["pi.live"] as LiveState | undefined;
		this.#projectPartial(live, ops);
		this.#projectStatus(live?.run !== undefined, ops);
		return ops;
	}

	/** Marks the session done for good; later views no longer change its status. */
	close(): DeltaOp[] {
		this.#closed = true;
		const ops: DeltaOp[] = [];
		this.#projectStatus(false, ops);
		return ops;
	}

	#projectEntry(entry: EntryRecord, ops: DeltaOp[]): void {
		const message = entry.model?.[0];
		if (entry.kind === HARBOUR_USER_ENTRY || entry.kind === "pi.user") {
			if (message?.role !== "user") return;
			const item: UserItem = {
				kind: "user",
				id: `u${entry.id}`,
				// When it was sent, from the stored message: a session projected again keeps its times.
				at: timeOf(message.timestamp) ?? this.#now(),
				text: textOf(message.content),
				...userViaOf(entry),
			};
			this.#entries.set(item.id, entry);
			ops.push({ op: "append", item });
			return;
		}
		if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			this.#projectAssistant(entry, message, ops);
			return;
		}
		if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			this.#projectToolResult(entry, message, ops);
		}
	}

	#projectAssistant(entry: EntryRecord, message: AssistantMessage, ops: DeltaOp[]): void {
		const text = textOf(message.content);
		const thinking = thinkingOf(message.content);
		const streaming = this.#streaming;
		const at = answeredAt(message) ?? this.#now();
		if (streaming !== undefined) {
			this.#streaming = undefined;
			const { thinking: _previous, ...rest } = streaming;
			// A finished answer is timed by when it was generated, not when it started streaming.
			const item: AssistantItem = { ...rest, at, text, streaming: false, ...(thinking === "" ? {} : { thinking }) };
			this.#entries.set(item.id, entry);
			ops.push({ op: "replace", item });
		} else if (text !== "" || thinking !== "") {
			const item: AssistantItem = {
				kind: "assistant",
				id: `a${entry.id}`,
				at,
				text,
				streaming: false,
				...(thinking === "" ? {} : { thinking }),
			};
			this.#entries.set(item.id, entry);
			ops.push({ op: "append", item });
		}
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const item: ToolItem = {
				kind: "tool",
				id: `t${entry.id}:${block.id}`,
				at: this.#now(),
				callId: block.id,
				name: block.name,
				label: toolLabel(block.name, block.arguments),
				status: "running",
				args: block.arguments,
			};
			this.#runningTools.set(block.id, item);
			ops.push({ op: "append", item });
		}
		this.#lastRunFailed = message.stopReason === "error";
		if (message.stopReason === "error") {
			const notice: NoticeItem = {
				kind: "notice",
				id: `n${entry.id}`,
				at: this.#now(),
				level: "error",
				text: message.errorMessage ?? "The model request failed",
				code: "model_error",
			};
			ops.push({ op: "append", item: notice });
		}
	}

	#projectToolResult(entry: EntryRecord, message: ToolResultMessage, ops: DeltaOp[]): void {
		const running = this.#runningTools.get(message.toolCallId);
		if (running === undefined) return;
		this.#runningTools.delete(message.toolCallId);
		const diagnostics = (entry.data as { diagnostics?: readonly { code?: string }[] } | undefined)?.diagnostics ?? [];
		const interrupted = diagnostics.some((diagnostic) => INTERRUPTED_CODES.has(diagnostic.code ?? ""));
		const status: ToolItemStatus = interrupted ? "interrupted" : message.isError ? "error" : "done";
		const images = toolImagesOf(message);
		const item: ToolItem = {
			...running,
			status,
			output: textOf(message.content),
			...(images.length === 0 ? {} : { images }),
			endedAt: this.#now(),
		};
		ops.push({ op: "replace", item });
	}

	#projectPartial(live: LiveState | undefined, ops: DeltaOp[]): void {
		const partial = live?.generation?.message as AssistantMessage | undefined;
		const text = partial === undefined ? "" : textOf(partial.content);
		const thinking = partial === undefined ? "" : thinkingOf(partial.content);
		const current = this.#streaming;
		if (text === "" && thinking === "") {
			// The answer entry claims a streaming item; one left when the run ends without it stops streaming here.
			if (current !== undefined && live?.run === undefined) {
				this.#streaming = undefined;
				ops.push({ op: "replace", item: { ...current, streaming: false } });
			}
			return;
		}
		if (current === undefined) {
			this.#streamCount += 1;
			const item: AssistantItem = {
				kind: "assistant",
				id: `p${this.#streamCount}`,
				at: this.#now(),
				text,
				streaming: true,
				...(thinking === "" ? {} : { thinking }),
			};
			this.#streaming = item;
			ops.push({ op: "append", item });
			return;
		}
		const currentThinking = current.thinking ?? "";
		const textGrows = text.startsWith(current.text);
		const thinkingGrows = thinking.startsWith(currentThinking);
		if (!textGrows || !thinkingGrows) {
			const { thinking: _previous, ...rest } = current;
			const item: AssistantItem = { ...rest, text, ...(thinking === "" ? {} : { thinking }) };
			this.#streaming = item;
			ops.push({ op: "replace", item });
			return;
		}
		if (thinking.length > currentThinking.length) {
			ops.push({ op: "text", itemId: current.id, append: thinking.slice(currentThinking.length), field: "thinking" });
		}
		if (text.length > current.text.length) {
			ops.push({ op: "text", itemId: current.id, append: text.slice(current.text.length) });
		}
		this.#streaming = { ...current, text, ...(thinking === "" ? {} : { thinking }) };
	}

	#projectStatus(running: boolean, ops: DeltaOp[]): void {
		const status: SessionStatus = this.#closed ? "done" : running ? "running" : this.#lastRunFailed ? "failed" : "idle";
		if (status === this.#status) return;
		this.#status = status;
		ops.push({ op: "status", status, attention: attentionFor(status) });
	}
}
