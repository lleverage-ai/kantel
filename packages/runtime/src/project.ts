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
export function toolLabel(name: string): string {
	return `Calling ${name}`;
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
				at: this.#now(),
				text: textOf(message.content),
				...userViaOf(entry),
			};
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
		if (streaming !== undefined) {
			this.#streaming = undefined;
			const { thinking: _previous, ...rest } = streaming;
			const item: AssistantItem = { ...rest, text, streaming: false, ...(thinking === "" ? {} : { thinking }) };
			ops.push({ op: "replace", item });
		} else if (text !== "" || thinking !== "") {
			const item: AssistantItem = {
				kind: "assistant",
				id: `a${entry.id}`,
				at: this.#now(),
				text,
				streaming: false,
				...(thinking === "" ? {} : { thinking }),
			};
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
				label: toolLabel(block.name),
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
		const item: ToolItem = { ...running, status, output: textOf(message.content), endedAt: this.#now() };
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
