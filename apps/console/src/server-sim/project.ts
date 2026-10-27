// Host side: turns Pi Durable agent events into Harbour's client protocol (@harbour/protocol). In M1 this moves into
// the session host; it lives here only because M0 has no backend. Nothing in src/ui or src/state imports it.
//
// How Pi maps onto the protocol:
// - One Pi assistant message becomes one or more assistant items. Its text and thinking blocks fill an item; a tool
//   call closes it, so text written after a tool call starts a new item below that tool's chip, in the order it was
//   written. Streamed text arrives as `{ op: "text", itemId, append }`; the message's end replaces each item whole,
//   with `streaming: false`.
// - Every tool call is a tool item. Pi streams a tool's output as a trim-and-append window; the protocol replaces the
//   tool item whole, so the projector keeps each tool's current state and sends all of it.
// - A reply that ended in an error or was stopped adds a notice after it.

import type {
	AssistantItem,
	DeltaOp,
	NoticeItem,
	SessionStatus,
	Timestamp,
	ToolItem,
	ToolItemStatus,
	TranscriptItem,
} from "@harbour/protocol";
import type {
	AgentEvent,
	AssistantMessage,
	Block,
	EntryRecord,
	Message,
	SnapshotEvent,
	ToolResultMessage,
} from "../pi-durable/events.ts";

const toolId = (callId: string): string => `tool:${callId}`;

function userText(message: Extract<Message, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
}

function resultText(message: ToolResultMessage): string {
	return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const short = (value: string, max = 72): string => {
	const line = value.split("\n")[0] ?? "";
	return line.length > max || value.includes("\n") ? `${line.slice(0, max).trimEnd()}…` : line;
};

/** The chip's plain-language label for a call, such as "Reading docs/x.md" or, once it has run, "Read docs/x.md". */
export function toolLabel(name: string, args: unknown, status: ToolItemStatus): string {
	const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	let words: [running: string, done: string, object: string];
	switch (name) {
		case "bash":
			words = ["Running", "Ran", short(text(a.command))];
			break;
		case "read":
			words = ["Reading", "Read", text(a.path)];
			break;
		case "grep": {
			const where = text(a.path);
			words = ["Searching for", "Searched for", `“${text(a.pattern)}”${where ? ` in ${where}` : ""}`];
			break;
		}
		case "edit":
			words = ["Editing", "Edited", text(a.path)];
			break;
		case "write":
			words = ["Writing", "Wrote", text(a.path)];
			break;
		case "web_fetch":
			words = ["Opening", "Opened", text(a.url)];
			break;
		default:
			words = ["Using", "Used", name];
	}
	const [running, done, object] = words;
	const verb =
		status === "running"
			? running
			: status === "done"
				? done
				: status === "error"
					? `Tried: ${done.toLowerCase()}`
					: `Stopped: ${running.toLowerCase()}`;
	return object ? `${verb} ${object}` : verb;
}

function tool(
	callId: string,
	name: string,
	args: unknown,
	at: Timestamp,
	status: ToolItemStatus = "running",
): ToolItem {
	return { kind: "tool", id: toolId(callId), at, callId, name, label: toolLabel(name, args, status), status, args };
}

function withTool(
	item: ToolItem,
	patch: Partial<Pick<ToolItem, "status" | "args" | "output" | "endedAt" | "at">>,
): ToolItem {
	const next = { ...item, ...patch };
	return { ...next, label: toolLabel(next.name, next.args, next.status) };
}

type Segment = { text: string; thinking: string };

/** A message's text and thinking, split at each tool call: one segment per assistant item. */
function segmentsOf(message: AssistantMessage): Segment[] {
	const segments: Segment[] = [];
	let current: Segment | undefined;
	for (const block of message.content) {
		if (block.type === "toolCall") {
			current = undefined;
			continue;
		}
		if (block.type === "thinking" && block.redacted) continue;
		if (current === undefined) {
			current = { text: "", thinking: "" };
			segments.push(current);
		}
		if (block.type === "text") current.text = current.text ? `${current.text}\n\n${block.text}` : block.text;
		else current.thinking = current.thinking ? `${current.thinking}\n\n${block.thinking}` : block.thinking;
	}
	return segments;
}

function assistantItem(id: string, at: Timestamp, segment: Segment, streaming: boolean): AssistantItem {
	return {
		kind: "assistant",
		id,
		at,
		text: segment.text,
		streaming,
		...(segment.thinking === "" ? {} : { thinking: segment.thinking }),
	};
}

function endNotice(id: string, message: AssistantMessage, at: Timestamp): NoticeItem | undefined {
	if (message.stopReason === "error") {
		const detail = message.errorMessage ? `: ${message.errorMessage}` : ".";
		return { kind: "notice", id: `n:${id}`, at, level: "error", text: `This reply stopped with an error${detail}` };
	}
	if (message.stopReason === "aborted") return { kind: "notice", id: `n:${id}`, at, level: "info", text: "Stopped." };
	return undefined;
}

const COMPACTED = "Earlier context was summarised to save space.";

/** The message being streamed: its items so far, and where each of Pi's content blocks goes. */
type Live = {
	base: string;
	at: Timestamp;
	items: string[];
	/** Text and thinking each item has had, so a second block in the same item starts on a new paragraph. */
	filled: Map<string, { text: boolean; thinking: boolean }>;
	afterTool: boolean;
	/** Pi's content index to the item and field it streams into. */
	blocks: Map<number, { itemId: string; field: "text" | "thinking" }>;
	calls: Map<number, { callId: string; args: Record<string, unknown> }>;
};

/**
 * Projects one conversation's stream. Keeps the tool items (the protocol replaces them whole) and the message being
 * streamed; the transcript itself is the caller's.
 */
export class Projector {
	private live: Live | undefined;
	private readonly tools = new Map<string, ToolItem>();
	private messages = 0;

	/** Items for a Pi snapshot: committed entries, plus the in-flight generation and tool slots if any. */
	fromSnapshot(snapshot: SnapshotEvent, at: Timestamp): { items: TranscriptItem[]; status: SessionStatus } {
		const items: TranscriptItem[] = [];
		for (const entry of snapshot.entries) this.entryItems(entry, items);
		const ops: DeltaOp[] = [];
		if (snapshot.generation?.message !== undefined) this.startAssistant(snapshot.generation.message, at, ops);
		// The generation's content so far arrives as appends followed by text ops; fold both into the items.
		for (const op of ops) {
			if (op.op === "append") items.push(op.item);
			else if (op.op === "text") {
				const position = items.findIndex((candidate) => candidate.id === op.itemId);
				const item = items[position];
				if (item?.kind !== "assistant") continue;
				items[position] =
					op.field === "thinking"
						? { ...item, thinking: (item.thinking ?? "") + op.append }
						: { ...item, text: item.text + op.append };
			}
		}
		for (const slot of snapshot.tools) {
			const item = this.tools.get(slot.callId);
			if (item === undefined || slot.status === "done") continue;
			const next = withTool(item, { status: "running", ...(slot.output === undefined ? {} : { output: slot.output }) });
			this.tools.set(slot.callId, next);
			const position = items.findIndex((candidate) => candidate.id === next.id);
			if (position >= 0) items[position] = next;
		}
		return { items, status: snapshot.run === undefined ? "idle" : "running" };
	}

	private entryItems(entry: EntryRecord, items: TranscriptItem[]): void {
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message?.role === "user") {
			items.push({ kind: "user", id: `u:${entry.id}`, at: message.timestamp, text: userText(message), via: "prompt" });
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const base = `a:${entry.id}`;
			const segments = segmentsOf(message);
			let segment = 0;
			let open = false;
			for (const block of message.content) {
				if (block.type === "toolCall") {
					open = false;
					const item = tool(block.id, block.name, block.arguments, message.timestamp);
					this.tools.set(block.id, item);
					items.push(item);
				} else if (!open && !(block.type === "thinking" && block.redacted)) {
					open = true;
					const content = segments[segment];
					const id = segment === 0 ? base : `${base}:${segment}`;
					segment++;
					if (content !== undefined && (content.text !== "" || content.thinking !== "")) {
						items.push(assistantItem(id, message.timestamp, content, false));
					}
				}
			}
			const notice = endNotice(base, message, message.timestamp);
			if (notice !== undefined) items.push(notice);
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const ended = message.timestamp;
			const done = this.finishTool(
				message,
				ended,
				message.durationMs === undefined ? undefined : ended - message.durationMs,
			);
			const position = items.findIndex((candidate) => candidate.id === done.id);
			if (position >= 0) items[position] = done;
			else items.push(done);
		} else if (entry.kind === "pi.compaction") {
			items.push({ kind: "notice", id: `n:${entry.id}`, at: 0, level: "info", text: COMPACTED });
		}
	}

	/** The tool item a result settles, creating it when the call was never seen. */
	private finishTool(message: ToolResultMessage, ended: Timestamp, started: Timestamp | undefined): ToolItem {
		const known =
			this.tools.get(message.toolCallId) ?? tool(message.toolCallId, message.toolName, {}, started ?? ended);
		const done = withTool(known, {
			status: message.isError ? "error" : "done",
			output: resultText(message),
			endedAt: ended,
			...(started === undefined ? {} : { at: started }),
		});
		this.tools.set(message.toolCallId, done);
		return done;
	}

	private startAssistant(message: AssistantMessage, at: Timestamp, ops: DeltaOp[]): void {
		this.live = {
			base: `a:live:${++this.messages}`,
			at: message.timestamp || at,
			items: [],
			filled: new Map(),
			afterTool: false,
			blocks: new Map(),
			calls: new Map(),
		};
		// A snapshot taken mid-generation already holds some content.
		message.content.forEach((block, index) => {
			this.startBlock(index, block, at, ops);
		});
	}

	/** The item a new text or thinking block streams into: the open one, or a new one after a tool call. */
	private openItem(live: Live, ops: DeltaOp[]): string {
		const last = live.items.at(-1);
		if (last !== undefined && !live.afterTool) return last;
		const id = live.items.length === 0 ? live.base : `${live.base}:${live.items.length}`;
		live.items.push(id);
		live.filled.set(id, { text: false, thinking: false });
		live.afterTool = false;
		ops.push({ op: "append", item: assistantItem(id, live.at, { text: "", thinking: "" }, true) });
		return id;
	}

	private startBlock(index: number, block: Block, at: Timestamp, ops: DeltaOp[]): void {
		const live = this.live;
		if (live === undefined) return;
		if (block.type === "toolCall") {
			live.afterTool = true;
			live.calls.set(index, { callId: block.id, args: structuredClone(block.arguments) });
			this.addTool(block, at, ops);
			return;
		}
		if (block.type === "thinking" && block.redacted) return;
		const itemId = this.openItem(live, ops);
		const field = block.type === "text" ? "text" : "thinking";
		live.blocks.set(index, { itemId, field });
		const filled = live.filled.get(itemId)!;
		const content = block.type === "text" ? block.text : block.thinking;
		const append = filled[field] ? `\n\n${content}` : content;
		filled[field] = true;
		if (append !== "") ops.push({ op: "text", itemId, append, ...(field === "thinking" ? { field } : {}) });
	}

	private addTool(block: Extract<Block, { type: "toolCall" }>, at: Timestamp, ops: DeltaOp[]): void {
		if (this.tools.has(block.id)) return;
		const item = tool(block.id, block.name, block.arguments, at);
		this.tools.set(block.id, item);
		ops.push({ op: "append", item });
	}

	/** Replace a tool item whole with a change, if it changed anything. */
	private updateTool(callId: string, patch: Parameters<typeof withTool>[1], ops: DeltaOp[]): void {
		const item = this.tools.get(callId);
		if (item === undefined) return;
		const next = withTool(item, patch);
		this.tools.set(callId, next);
		ops.push({ op: "replace", item: next });
	}

	/** Ops for one commit's batch of events, at `at` (epoch ms). */
	batch(events: readonly AgentEvent[], at: Timestamp): DeltaOp[] {
		const ops: DeltaOp[] = [];
		for (const event of events) this.event(event, at, ops);
		return ops;
	}

	private status(status: SessionStatus, ops: DeltaOp[]): void {
		ops.push({ op: "status", status, attention: status === "running" ? "working" : "done" });
	}

	private event(event: AgentEvent, at: Timestamp, ops: DeltaOp[]): void {
		switch (event.type) {
			case "run_start":
				this.status("running", ops);
				return;
			case "run_end":
				this.status("idle", ops);
				return;
			case "message_start":
				if (event.message.role === "assistant") this.startAssistant(event.message, at, ops);
				return;
			case "message_update":
				for (const change of event.changes) this.change(change, at, ops);
				return;
			case "message_end":
				this.endMessage(event.entry, at, ops);
				return;
			case "tool_execution_start":
				if (event.parentToolCallId !== undefined) return;
				if (!this.tools.has(event.toolCallId)) {
					this.addTool(
						{ type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args },
						at,
						ops,
					);
				}
				this.updateTool(event.toolCallId, { status: "running", args: event.args, at }, ops);
				return;
			case "tool_execution_update": {
				if (event.parentToolCallId !== undefined || event.output === undefined) return;
				const item = this.tools.get(event.toolCallId);
				if (item === undefined) return;
				const before = item.output ?? "";
				const output =
					"set" in event.output
						? event.output.set
						: before.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
				this.updateTool(event.toolCallId, { output }, ops);
				return;
			}
			case "tool_execution_end": {
				if (event.parentToolCallId !== undefined) return;
				const message = event.entry?.model?.[0];
				if (message?.role === "toolResult") {
					// The chip's clock started when execution did; the result's duration ends it.
					const started = this.tools.get(event.toolCallId)?.at ?? at;
					const ended = message.durationMs === undefined ? at : started + message.durationMs;
					const known = this.tools.has(event.toolCallId);
					// A result for a call the stream never showed adds the tool rather than replacing nothing.
					ops.push({ op: known ? "replace" : "append", item: this.finishTool(message, ended, started) });
				} else {
					this.updateTool(event.toolCallId, { status: "interrupted", endedAt: at }, ops);
				}
				return;
			}
			case "auto_retry_start":
				ops.push({
					op: "append",
					item: {
						kind: "notice",
						id: `n:retry:${event.attempt}:${event.at}`,
						at,
						level: "warning",
						text: `The model call failed; retrying (attempt ${event.attempt}).`,
					},
				});
				return;
			case "task_failed":
				ops.push({
					op: "append",
					item: {
						kind: "notice",
						id: `n:task:${event.taskId}`,
						at,
						level: "warning",
						text: `A step failed: ${event.message}`,
					},
				});
				return;
			case "entry_appended":
				if (event.entry.kind === "pi.compaction") {
					ops.push({
						op: "append",
						item: { kind: "notice", id: `n:${event.entry.id}`, at, level: "info", text: COMPACTED },
					});
				}
				return;
			default:
				return;
		}
	}

	private change(
		change: Extract<AgentEvent, { type: "message_update" }>["changes"][number],
		at: Timestamp,
		ops: DeltaOp[],
	): void {
		const live = this.live;
		if (live === undefined) return;
		switch (change.type) {
			case "text_start":
			case "thinking_start":
			case "toolcall_start":
				this.startBlock(change.contentIndex, change.block, at, ops);
				return;
			case "text_delta":
			case "thinking_delta": {
				const block = live.blocks.get(change.contentIndex);
				if (block === undefined || change.delta === "") return;
				ops.push({
					op: "text",
					itemId: block.itemId,
					append: change.delta,
					...(block.field === "thinking" ? { field: "thinking" as const } : {}),
				});
				return;
			}
			case "toolcall_delta": {
				// Pi appends to one string leaf of the call, addressed from the block: ["arguments", ...].
				const call = live.calls.get(change.contentIndex);
				const [root, ...path] = change.path;
				if (call === undefined || root !== "arguments" || path.length === 0) return;
				let target = call.args as Record<string | number, unknown>;
				for (const key of path.slice(0, -1)) {
					target[key] ??= {};
					target = target[key] as Record<string | number, unknown>;
				}
				const leaf = path.at(-1)!;
				target[leaf] = String(target[leaf] ?? "") + change.delta;
				this.updateTool(call.callId, { args: structuredClone(call.args) }, ops);
				return;
			}
			case "block":
			case "message":
				// Rare structural rewrites: let message_end carry the settled message.
				return;
		}
	}

	private endMessage(entry: EntryRecord, at: Timestamp, ops: DeltaOp[]): void {
		const message = entry.model?.[0];
		if (message === undefined) return;
		if (message.role === "user") {
			ops.push({
				op: "append",
				item: { kind: "user", id: `u:${entry.id}`, at: message.timestamp, text: userText(message), via: "prompt" },
			});
			return;
		}
		if (message.role !== "assistant") return; // Tool results arrive with tool_execution_end.
		const live = this.live;
		this.live = undefined;
		const base = live?.base ?? `a:${entry.id}`;
		const itemAt = live?.at ?? message.timestamp;
		const known = live?.items ?? [];
		segmentsOf(message).forEach((segment, index) => {
			const id = known[index] ?? (index === 0 ? base : `${base}:${index}`);
			ops.push({
				op: known[index] === undefined ? "append" : "replace",
				item: assistantItem(id, itemAt, segment, false),
			});
		});
		// Streamed items the settled message no longer has (a structural rewrite) end empty rather than streaming.
		for (const id of known.slice(segmentsOf(message).length)) {
			ops.push({ op: "replace", item: assistantItem(id, itemAt, { text: "", thinking: "" }, false) });
		}
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			this.addTool(block, message.timestamp, ops);
			const item = this.tools.get(block.id);
			if (item !== undefined && JSON.stringify(item.args) !== JSON.stringify(block.arguments)) {
				this.updateTool(block.id, { args: block.arguments }, ops);
			}
		}
		const notice = endNotice(base, message, at);
		if (notice !== undefined) ops.push({ op: "append", item: notice });
	}
}
