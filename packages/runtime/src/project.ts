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
	argsAppends,
	attentionFor,
	type DeltaOp,
	type DraftDocument,
	type NoticeItem,
	type PresentedFile,
	type SessionStatus,
	type Timestamp,
	TOOL_IMAGE_TYPES,
	type ToolImage,
	type ToolItem,
	type ToolItemStatus,
	type Usage,
	type UserAttachment,
	type UserItem,
	type UserItemVia,
} from "@harbour/protocol";

/** The entry kind Harbour places user input as, so the projection knows how the input was sent. */
export const HARBOUR_USER_ENTRY = "harbour.user";

export interface HarbourUserEntryData {
	readonly via: UserItemVia;
	readonly requestId?: string;
	/** The files sent with the input, as the transcript names them. */
	readonly attachments?: readonly UserAttachment[];
	/**
	 * How many of the message's leading content blocks are the attachments' (their text and images), so the transcript
	 * shows only the typed words after them.
	 */
	readonly attachmentBlocks?: number;
}

/** The entry a Harbour input is placed as: its kind and how it was sent. The model still sees the text. */
export function harbourUserEntry(
	via: UserItemVia,
	requestId?: string,
	attached?: { readonly attachments: readonly UserAttachment[]; readonly blocks: number },
): InputEntry {
	const data: HarbourUserEntryData = {
		via,
		...(requestId === undefined ? {} : { requestId }),
		...(attached === undefined || attached.attachments.length === 0
			? {}
			: {
					attachments: attached.attachments.map(({ id, name, type, size, kind }) => ({ id, name, type, size, kind })),
					attachmentBlocks: attached.blocks,
				}),
	};
	return { kind: HARBOUR_USER_ENTRY, data: data as unknown as InputEntry["data"] };
}

/** The plain-language chip label of a tool call. */
export function toolLabel(name: string, args?: unknown): string {
	return (
		browserToolLabel(name, args) ??
		presentLabel(name, args) ??
		documentLabel(name, args) ??
		imageLabel(name, args) ??
		`Calling ${name}`
	);
}

/** `generate_image`'s label: "Making an image", "Making 2 images", or "Editing an image" from reference images. */
function imageLabel(name: string, args: unknown): string | undefined {
	if (name !== "generate_image") return undefined;
	const input = typeof args === "object" && args !== null ? (args as { readonly [key: string]: unknown }) : {};
	const count = typeof input.count === "number" && Number.isInteger(input.count) && input.count > 1 ? input.count : 1;
	const editing = Array.isArray(input.reference_images) && input.reference_images.length > 0;
	const what = count === 1 ? "an image" : `${count} images`;
	return `${editing ? "Editing" : "Making"} ${what}`;
}

/** `create_document`'s label: "Writing Quarterly plan". */
function documentLabel(name: string, args: unknown): string | undefined {
	if (name !== "create_document") return undefined;
	const title = typeof args === "object" && args !== null ? (args as { title?: unknown }).title : undefined;
	return typeof title === "string" && title.trim() !== "" ? `Writing ${title.trim()}` : "Writing a document";
}

/** `present_files`' label: "Presenting report.pdf", or "Presenting 3 files". */
function presentLabel(name: string, args: unknown): string | undefined {
	if (name !== "present_files") return undefined;
	const paths = typeof args === "object" && args !== null ? (args as { filepaths?: unknown }).filepaths : undefined;
	if (!Array.isArray(paths) || paths.length === 0) return "Presenting files";
	if (paths.length > 1) return `Presenting ${paths.length} files`;
	const only = paths[0];
	const file =
		typeof only === "string"
			? only
					.split("/")
					.filter((part) => part !== "")
					.at(-1)
			: undefined;
	return file === undefined ? "Presenting a file" : `Presenting ${file}`;
}

/** A page's host as a person names it: "kayak.co.uk" for https://www.kayak.co.uk/flights. */
function hostOf(url: unknown): string | undefined {
	if (typeof url !== "string") return undefined;
	try {
		return new URL(url).host.replace(/^www\./, "") || undefined;
	} catch {
		return undefined;
	}
}

/** A value the agent typed or chose, quoted and cut short: “Amsterdam”. */
function quotedValue(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const text = value.trim().replace(/\s+/g, " ");
	return `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;
}

/**
 * Labels for the browser's tools (`@harbour/browser`), from their arguments: what a step is doing while it runs, and
 * all a call's arguments can say. Once a step has run, a transcript names it from its result (the `Did:` line), as
 * `@harbour/ui`'s browser renderer does ("Clicked “Reject all”"); the label stays as the call's own words.
 */
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
				case "fill": {
					const value = quotedValue(input.value);
					return value === undefined ? "Typing into the page" : `Typing ${value}`;
				}
				case "select": {
					const value = quotedValue(input.value);
					return value === undefined ? "Choosing an option" : `Choosing ${value}`;
				}
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

/** The browser a tool result's UI details say the call used (`details.browserSessionId`), if any. */
export function toolBrowserSessionOf(message: Pick<ToolResultMessage, "details">): string | undefined {
	const details = message.details as { readonly browserSessionId?: unknown } | undefined;
	if (typeof details !== "object" || details === null) return undefined;
	const id = details.browserSessionId;
	return typeof id === "string" && id !== "" && id.length <= 200 ? id : undefined;
}

/** The most files one tool item presents. */
export const MAX_PRESENTED_FILES = 20;
/** The longest preview a presented file carries. */
export const MAX_PRESENTED_PREVIEW = 600;

function presentedFile(value: unknown): PresentedFile | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { workspaceId, path, name, mimeType, size, preview, title, document, model } = value as {
		readonly [key: string]: unknown;
	};
	if (typeof workspaceId !== "string" || workspaceId === "" || workspaceId.length > 200) return undefined;
	if (typeof path !== "string" || path === "" || path.length > 1024) return undefined;
	if (typeof name !== "string" || name === "" || name.length > 255) return undefined;
	if (typeof mimeType !== "string" || mimeType === "" || mimeType.length > 200) return undefined;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
	return {
		workspaceId,
		path,
		name,
		mimeType,
		size,
		...(typeof preview === "string" && preview !== "" ? { preview: preview.slice(0, MAX_PRESENTED_PREVIEW) } : {}),
		...(typeof title === "string" && title.trim() !== "" ? { title: title.trim().slice(0, MAX_PRESENTED_TITLE) } : {}),
		...(document === true ? { document: true } : {}),
		...(typeof model === "string" && model.trim() !== "" ? { model: model.trim().slice(0, MAX_PRESENTED_TITLE) } : {}),
	};
}

function withoutDocument(file: PresentedFile): PresentedFile {
	if (file.document === undefined) return file;
	const { document: _document, ...rest } = file;
	return rest;
}

function withoutModel(file: PresentedFile): PresentedFile {
	if (file.model === undefined) return file;
	const { model: _model, ...rest } = file;
	return rest;
}

/** The longest title a presented file carries. */
export const MAX_PRESENTED_TITLE = 200;

/**
 * The tools whose results present files: `present_files`, `create_document` its document, and `generate_image` the
 * images it made.
 */
const PRESENTING_TOOLS = new Set(["present_files", "create_document", "generate_image"]);

/**
 * The document a partial answer is writing: the last `create_document` call in it, once its title has arrived. Its
 * arguments are the provider's partial JSON parsed so far, so `content` grows as the model writes.
 */
export function draftDocumentOf(content: readonly ContentBlock[] | undefined): DraftDocument | undefined {
	if (content === undefined) return undefined;
	for (let index = content.length - 1; index >= 0; index--) {
		const block = content[index];
		if (block?.type !== "toolCall") continue;
		const call = block as ToolCall;
		if (call.name !== "create_document") continue;
		const args = (typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {}) as {
			readonly title?: unknown;
			readonly content?: unknown;
		};
		const title = typeof args.title === "string" ? args.title.trim().slice(0, MAX_PRESENTED_TITLE) : "";
		const text = typeof args.content === "string" ? args.content : "";
		if (title === "" && text === "") return undefined;
		return { callId: call.id, title: title === "" ? "Untitled document" : title, text };
	}
	return undefined;
}

/** The files a tool result's UI details say it presented (`details.presentedFiles`), at most `MAX_PRESENTED_FILES`. */
export function toolPresentedFilesOf(message: Pick<ToolResultMessage, "details">): PresentedFile[] {
	const details = message.details as { readonly presentedFiles?: unknown } | undefined;
	if (typeof details !== "object" || details === null || !Array.isArray(details.presentedFiles)) return [];
	const files: PresentedFile[] = [];
	for (const value of details.presentedFiles) {
		const file = presentedFile(value);
		if (file !== undefined) files.push(file);
	}
	return files.slice(0, MAX_PRESENTED_FILES);
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
 * A user message's words and attachments: the attachments' blocks lead the content and the model reads them, but the
 * transcript shows only what the person typed, with the files named beside it.
 */
function userContentOf(
	entry: EntryRecord,
	content: readonly ContentBlock[] | string,
): { text: string; attachments?: readonly UserAttachment[] } {
	const data =
		entry.kind === HARBOUR_USER_ENTRY && typeof entry.data === "object" && entry.data !== null
			? (entry.data as Partial<HarbourUserEntryData>)
			: undefined;
	const attachments = Array.isArray(data?.attachments) ? data.attachments : undefined;
	if (attachments === undefined || attachments.length === 0 || typeof content === "string") {
		return { text: textOf(content) };
	}
	const skip = typeof data?.attachmentBlocks === "number" ? data.attachmentBlocks : 0;
	return { text: textOf(content.slice(skip)), attachments };
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * A session's model usage so far: every model response's `usage` (a `pi.assistant` entry, failed ones included),
 * summed once per entry. A session shares one tally across its projections, so a fork or an edit, which projects a new
 * conversation, still counts what the earlier conversation used; entries the conversations share count once.
 */
export class UsageTally {
	readonly #counted = new Set<string>();
	#usage: Usage | undefined;
	#revision = 0;

	/** The running total, or undefined before any response reported usage. */
	get usage(): Usage | undefined {
		return this.#usage;
	}

	/** Goes up each time the total changes. */
	get revision(): number {
		return this.#revision;
	}

	/** Counts `message`'s usage under `entryId`, unless that entry was counted already or carries none. */
	add(entryId: string, message: AssistantMessage): void {
		const usage = (message as { readonly usage?: unknown }).usage;
		if (typeof usage !== "object" || usage === null || this.#counted.has(entryId)) return;
		this.#counted.add(entryId);
		const fields = usage as { readonly [key: string]: unknown };
		const cost = typeof fields.cost === "object" && fields.cost !== null ? (fields.cost as { total?: unknown }) : {};
		const before = this.#usage;
		this.#usage = {
			inputTokens: (before?.inputTokens ?? 0) + count(fields.input),
			outputTokens: (before?.outputTokens ?? 0) + count(fields.output),
			cacheReadTokens: (before?.cacheReadTokens ?? 0) + count(fields.cacheRead),
			cacheWriteTokens: (before?.cacheWriteTokens ?? 0) + count(fields.cacheWrite),
			costUsd: (before?.costUsd ?? 0) + count(cost.total),
		};
		this.#revision += 1;
	}
}

/**
 * Turns successive views of one conversation into delta ops. New entries append items; a streamed answer grows one
 * assistant item with `text` ops; a tool call is a `tool` item replaced when its result lands; status changes become
 * `status` ops; the session's usage total, after each response that reports usage, a `usage` op.
 */
export class ConversationProjector {
	readonly #now: () => Timestamp;
	readonly #usage: UsageTally;
	/** The tally's revision the last `usage` op showed. */
	#shownUsage = 0;
	readonly #seenEntries = new Set<string>();
	/** Tool items by Pi tool call ID, while their result is outstanding. */
	readonly #runningTools = new Map<string, ToolItem>();
	/**
	 * Tool items for the calls the model is writing, by Pi tool call ID, until the answer's entry claims them: their
	 * arguments as last shown, which `args` ops grow.
	 */
	readonly #streamingTools = new Map<string, ToolItem>();
	#streamingToolCount = 0;
	/** The entry behind each user and settled assistant item, by item ID: where a fork or an edit starts. */
	readonly #entries = new Map<string, EntryRecord>();
	#streaming: AssistantItem | undefined;
	#streamCount = 0;
	#status: SessionStatus = "idle";
	#lastRunFailed = false;
	#closed = false;

	/** `usage` is the session's tally, shared by its projections; by default this projection's own. */
	constructor(options: { readonly now: () => Timestamp; readonly usage?: UsageTally }) {
		this.#now = options.now;
		this.#usage = options.usage ?? new UsageTally();
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
		const usage = this.#usage.usage;
		if (usage !== undefined && this.#usage.revision !== this.#shownUsage) {
			this.#shownUsage = this.#usage.revision;
			ops.push({ op: "usage", usage });
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
				...userContentOf(entry, message.content),
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
		this.#usage.add(String(entry.id), message);
		const text = textOf(message.content);
		const thinking = thinkingOf(message.content);
		const streaming = this.#streaming;
		const at = answeredAt(message) ?? this.#now();
		if (streaming !== undefined) {
			this.#streaming = undefined;
			// The draft document goes: the call's tool item presents the saved one.
			const { thinking: _previous, document: _draft, ...rest } = streaming;
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
			// A call shown while the model wrote it keeps its item, and its place, now that it is whole.
			const streamed = this.#streamingTools.get(block.id);
			this.#streamingTools.delete(block.id);
			const item: ToolItem = {
				kind: "tool",
				id: streamed?.id ?? `t${entry.id}:${block.id}`,
				at: streamed?.at ?? this.#now(),
				callId: block.id,
				name: block.name,
				label: toolLabel(block.name, block.arguments),
				status: "running",
				args: block.arguments,
			};
			this.#runningTools.set(block.id, item);
			ops.push({ op: streamed === undefined ? "append" : "replace", item });
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
		const browserSessionId = toolBrowserSessionOf(message);
		// Only `present_files`, `create_document` and `generate_image` present files: another tool's details can't put a
		// card in the transcript, and only `create_document`'s are documents. Only `generate_image` says which model made a
		// file.
		const files =
			PRESENTING_TOOLS.has(running.name) && status === "done"
				? toolPresentedFilesOf(message).map((file) => {
						const shown = running.name === "create_document" ? { ...file, document: true } : withoutDocument(file);
						return running.name === "generate_image" ? shown : withoutModel(shown);
					})
				: [];
		const item: ToolItem = {
			...running,
			status,
			output: textOf(message.content),
			...(images.length === 0 ? {} : { images }),
			...(browserSessionId === undefined ? {} : { browserSessionId }),
			...(files.length === 0 ? {} : { files }),
			endedAt: this.#now(),
		};
		ops.push({ op: "replace", item });
	}

	#projectPartial(live: LiveState | undefined, ops: DeltaOp[]): void {
		const partial = live?.generation?.message as AssistantMessage | undefined;
		this.#projectPartialText(live, partial, ops);
		this.#projectPartialTools(partial, ops);
	}

	/**
	 * Tool calls the model is writing, as tool items with `streaming: true` placed where the call starts: an `append`
	 * when a call first shows, then `args` ops as its strings grow (a `replace` for any other change, or a new label).
	 * The answer's entry replaces each with the whole call. A call the generation drops without an entry (a retry, an
	 * abort) is left interrupted.
	 */
	#projectPartialTools(partial: AssistantMessage | undefined, ops: DeltaOp[]): void {
		const seen = new Set<string>();
		for (const block of partial?.content ?? []) {
			if (block.type !== "toolCall") continue;
			const call = block as ToolCall;
			// A document being written streams as the answer's draft, not as a call; a settled call is no longer streaming.
			if (call.name === "create_document" || this.#runningTools.has(call.id)) continue;
			seen.add(call.id);
			const args: unknown = call.arguments ?? {};
			const label = toolLabel(call.name, args);
			const current = this.#streamingTools.get(call.id);
			if (current === undefined) {
				this.#streamingToolCount += 1;
				const item: ToolItem = {
					kind: "tool",
					id: `ts${this.#streamingToolCount}:${call.id}`,
					at: this.#now(),
					callId: call.id,
					name: call.name,
					label,
					status: "running",
					args: structuredClone(args),
					streaming: true,
				};
				this.#streamingTools.set(call.id, item);
				ops.push({ op: "append", item });
				continue;
			}
			const appends =
				current.name === call.name && current.label === label ? argsAppends(current.args, args) : undefined;
			if (appends !== undefined && appends.length === 0) continue;
			const item: ToolItem = { ...current, name: call.name, label, args: structuredClone(args) };
			this.#streamingTools.set(call.id, item);
			if (appends === undefined) ops.push({ op: "replace", item });
			else for (const append of appends) ops.push({ op: "args", itemId: item.id, ...append });
		}
		for (const [callId, item] of this.#streamingTools) {
			if (seen.has(callId)) continue;
			this.#streamingTools.delete(callId);
			const { streaming: _streaming, ...rest } = item;
			ops.push({ op: "replace", item: { ...rest, status: "interrupted", endedAt: this.#now() } });
		}
	}

	#projectPartialText(live: LiveState | undefined, partial: AssistantMessage | undefined, ops: DeltaOp[]): void {
		const text = partial === undefined ? "" : textOf(partial.content);
		const thinking = partial === undefined ? "" : thinkingOf(partial.content);
		const document = partial === undefined ? undefined : draftDocumentOf(partial.content);
		const current = this.#streaming;
		if (text === "" && thinking === "" && document === undefined) {
			// The answer entry claims a streaming item; one left when the run ends without it stops streaming here.
			if (current !== undefined && live?.run === undefined) {
				this.#streaming = undefined;
				const { document: _draft, ...rest } = current;
				ops.push({ op: "replace", item: { ...rest, streaming: false } });
			}
			return;
		}
		const fields = {
			text,
			...(thinking === "" ? {} : { thinking }),
			...(document === undefined ? {} : { document }),
		};
		if (current === undefined) {
			this.#streamCount += 1;
			const item: AssistantItem = {
				kind: "assistant",
				id: `p${this.#streamCount}`,
				at: this.#now(),
				streaming: true,
				...fields,
			};
			this.#streaming = item;
			ops.push({ op: "append", item });
			return;
		}
		const currentThinking = current.thinking ?? "";
		const textGrows = text.startsWith(current.text);
		const thinkingGrows = thinking.startsWith(currentThinking);
		// A draft grows when it's the same call and title with more text; a new call, a new title or a shorter text replaces.
		const draft = current.document;
		const documentGrows =
			document === undefined
				? draft === undefined
				: draft !== undefined &&
					draft.callId === document.callId &&
					draft.title === document.title &&
					document.text.startsWith(draft.text);
		if (!textGrows || !thinkingGrows || !documentGrows) {
			const { thinking: _previous, document: _draft, ...rest } = current;
			const item: AssistantItem = { ...rest, ...fields };
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
		if (document !== undefined && draft !== undefined && document.text.length > draft.text.length) {
			ops.push({ op: "text", itemId: current.id, append: document.text.slice(draft.text.length), field: "document" });
		}
		this.#streaming = { ...current, ...fields };
	}

	#projectStatus(running: boolean, ops: DeltaOp[]): void {
		const status: SessionStatus = this.#closed ? "done" : running ? "running" : this.#lastRunFailed ? "failed" : "idle";
		if (status === this.#status) return;
		this.#status = status;
		ops.push({ op: "status", status, attention: attentionFor(status) });
	}
}
