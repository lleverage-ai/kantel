// Host side: turns Pi Durable agent events into Harbour transcript ops. In M1 this moves into the session host; it
// lives here only because M0 has no backend. Nothing in src/ui or src/state imports it.

import type {
	AgentEvent,
	AssistantMessage,
	Block,
	EntryRecord,
	Message,
	SnapshotEvent,
	ToolResultMessage,
} from "../pi-durable/events.ts";
import type { AssistantItem, AssistantPart, DeltaOp, RunState, ToolItem, TranscriptItem } from "../protocol-local/index.ts";

const toolId = (callId: string): string => `tool:${callId}`;

function userText(message: Extract<Message, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
}

function resultText(message: ToolResultMessage): string {
	return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
}

function partOf(block: Block): AssistantPart {
	if (block.type === "text") return { kind: "text", text: block.text };
	if (block.type === "thinking") return { kind: "thinking", text: block.redacted ? "" : block.thinking };
	return { kind: "tool", callId: block.id };
}

function assistantStatus(message: AssistantMessage): AssistantItem["status"] {
	if (message.stopReason === "error") return "error";
	if (message.stopReason === "aborted") return "aborted";
	if (message.stopReason === "pending") return "streaming";
	return "done";
}

function newTool(callId: string, name: string, args: Record<string, unknown>, at: number): ToolItem {
	return { kind: "tool", id: toolId(callId), callId, name, args, status: "pending", output: "", at };
}

/**
 * Projects one conversation's stream. Keeps just enough of Pi's state to map content indexes to parts and to know
 * which tools it has seen; the transcript itself is the caller's.
 */
export class Projector {
	private streaming:
		| { id: string; partOf: Map<number, number>; parts: number; calls: Map<number, { callId: string; args: Record<string, unknown> }> }
		| undefined;
	private readonly tools = new Set<string>();
	private messageCount = 0;

	/** Items for a Pi snapshot: committed entries, plus the in-flight generation and tool slots if any. */
	fromSnapshot(snapshot: SnapshotEvent): { items: TranscriptItem[]; run: RunState } {
		const items: TranscriptItem[] = [];
		const toolAt = new Map<string, number>();
		for (const entry of snapshot.entries) this.entryItems(entry, items, toolAt);
		const ops: DeltaOp[] = [];
		if (snapshot.generation?.message !== undefined) this.startAssistant(snapshot.generation.message, ops);
		for (const op of ops) if (op.op === "item.add") items.push(op.item);
		for (const slot of snapshot.tools) {
			const position = toolAt.get(slot.callId);
			if (position === undefined) continue;
			const item = items[position] as ToolItem;
			items[position] = { ...item, status: slot.status === "done" ? item.status : slot.status, output: slot.output ?? item.output };
		}
		return { items, run: snapshot.run === undefined ? "idle" : "working" };
	}

	private entryItems(entry: EntryRecord, items: TranscriptItem[], toolAt: Map<string, number>): void {
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message?.role === "user") {
			items.push({ kind: "user", id: `u:${entry.id}`, text: userText(message), at: message.timestamp });
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			items.push(this.assistantItem(`a:${entry.id}`, message));
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				this.tools.add(block.id);
				toolAt.set(block.id, items.length);
				items.push(newTool(block.id, block.name, block.arguments, message.timestamp));
			}
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const position = toolAt.get(message.toolCallId);
			const done = { status: message.isError ? "error" : "done", output: resultText(message), durationMs: message.durationMs } as const;
			if (position === undefined) {
				items.push({ ...newTool(message.toolCallId, message.toolName, {}, message.timestamp), ...done });
			} else {
				items[position] = { ...(items[position] as ToolItem), ...done };
			}
		} else if (entry.kind === "pi.compaction") {
			items.push({ kind: "notice", id: `n:${entry.id}`, text: "Earlier context was summarised to save space.", tone: "info", at: 0 });
		}
	}

	private assistantItem(id: string, message: AssistantMessage): AssistantItem {
		const item: AssistantItem = {
			kind: "assistant",
			id,
			parts: message.content.map(partOf),
			status: assistantStatus(message),
			model: message.model,
			at: message.timestamp,
		};
		if (message.errorMessage !== undefined) item.error = message.errorMessage;
		if (message.durationMs !== undefined) item.durationMs = message.durationMs;
		return item;
	}

	private startAssistant(message: AssistantMessage, ops: DeltaOp[]): void {
		const id = `a:live:${++this.messageCount}`;
		const map = new Map<number, number>();
		message.content.forEach((_, index) => map.set(index, index));
		this.streaming = { id, partOf: map, parts: message.content.length, calls: new Map() };
		ops.push({ op: "item.add", item: { ...this.assistantItem(id, message), status: "streaming" } });
		for (const block of message.content) if (block.type === "toolCall") this.addTool(block, message.timestamp, ops);
	}

	private addTool(block: Extract<Block, { type: "toolCall" }>, at: number, ops: DeltaOp[]): void {
		if (this.tools.has(block.id)) return;
		this.tools.add(block.id);
		ops.push({ op: "item.add", item: newTool(block.id, block.name, block.arguments, at) });
	}

	/** Ops for one commit's batch of events. */
	batch(events: readonly AgentEvent[], at: number): DeltaOp[] {
		const ops: DeltaOp[] = [];
		for (const event of events) this.event(event, at, ops);
		return ops;
	}

	private event(event: AgentEvent, at: number, ops: DeltaOp[]): void {
		switch (event.type) {
			case "run_start":
				ops.push({ op: "run", state: "working" });
				return;
			case "run_end":
				ops.push({ op: "run", state: "idle" });
				return;
			case "message_start":
				if (event.message.role === "assistant") this.startAssistant(event.message, ops);
				return;
			case "message_update":
				for (const change of event.changes) this.change(change, at, ops);
				return;
			case "message_end":
				this.endMessage(event.entry, ops);
				return;
			case "tool_execution_start":
				if (event.parentToolCallId !== undefined) return;
				if (!this.tools.has(event.toolCallId)) this.addTool({ type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args }, at, ops);
				ops.push({ op: "tool.update", id: toolId(event.toolCallId), status: "running", args: event.args });
				return;
			case "tool_execution_update":
				if (event.parentToolCallId !== undefined || event.output === undefined) return;
				ops.push({ op: "tool.update", id: toolId(event.toolCallId), output: event.output });
				return;
			case "tool_execution_end": {
				if (event.parentToolCallId !== undefined) return;
				const message = event.entry?.model?.[0];
				if (message?.role === "toolResult") {
					const op: DeltaOp = { op: "tool.update", id: toolId(event.toolCallId), status: message.isError ? "error" : "done", output: { set: resultText(message) } };
					if (message.durationMs !== undefined) op.durationMs = message.durationMs;
					ops.push(op);
				} else {
					ops.push({ op: "tool.update", id: toolId(event.toolCallId), status: "error", output: { append: "\n(The call did not finish.)" } });
				}
				return;
			}
			case "auto_retry_start":
				ops.push({ op: "item.add", item: { kind: "notice", id: `n:retry:${event.attempt}:${event.at}`, text: `The model call failed; retrying (attempt ${event.attempt}).`, tone: "warn", at: event.at } });
				return;
			case "task_failed":
				ops.push({ op: "item.add", item: { kind: "notice", id: `n:task:${event.taskId}`, text: `A step failed: ${event.message}`, tone: "warn", at } });
				return;
			case "entry_appended":
				if (event.entry.kind === "pi.compaction") ops.push({ op: "item.add", item: { kind: "notice", id: `n:${event.entry.id}`, text: "Earlier context was summarised to save space.", tone: "info", at } });
				return;
			default:
				return;
		}
	}

	private change(change: Extract<AgentEvent, { type: "message_update" }>["changes"][number], at: number, ops: DeltaOp[]): void {
		const live = this.streaming;
		if (live === undefined) return;
		switch (change.type) {
			case "text_start":
			case "thinking_start":
			case "toolcall_start":
				live.partOf.set(change.contentIndex, live.parts++);
				ops.push({ op: "part.add", id: live.id, part: partOf(change.block) });
				if (change.block.type === "toolCall") {
					live.calls.set(change.contentIndex, { callId: change.block.id, args: structuredClone(change.block.arguments) });
					this.addTool(change.block, at, ops);
				}
				return;
			case "text_delta":
			case "thinking_delta": {
				const part = live.partOf.get(change.contentIndex);
				if (part !== undefined) ops.push({ op: "text.append", id: live.id, part, text: change.delta });
				return;
			}
			case "toolcall_delta": {
				// Pi appends to one string leaf of the call, addressed from the block: ["arguments", ...].
				const call = live.calls.get(change.contentIndex);
				const [root, ...path] = change.path;
				if (call === undefined || root !== "arguments" || path.length === 0) return;
				const args = call.args;
				let target = args as Record<string | number, unknown>;
				for (const key of path.slice(0, -1)) target = (target[key] ??= {}) as Record<string | number, unknown>;
				const leaf = path.at(-1)!;
				target[leaf] = String(target[leaf] ?? "") + change.delta;
				ops.push({ op: "tool.update", id: toolId(call.callId), args: structuredClone(args) });
				return;
			}
			case "block":
			case "message":
				// Rare structural rewrites: let message_end carry the settled message.
				return;
		}
	}

	private endMessage(entry: EntryRecord, ops: DeltaOp[]): void {
		const message = entry.model?.[0];
		if (message === undefined) return;
		if (message.role === "user") {
			ops.push({ op: "item.add", item: { kind: "user", id: `u:${entry.id}`, text: userText(message), at: message.timestamp } });
		} else if (message.role === "assistant") {
			const id = this.streaming?.id ?? `a:${entry.id}`;
			this.streaming = undefined;
			ops.push({ op: "item.put", item: this.assistantItem(id, message) });
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				this.addTool(block, message.timestamp, ops);
				ops.push({ op: "tool.update", id: toolId(block.id), args: block.arguments });
			}
		}
		// Tool results arrive with tool_execution_end; their message_start/end add nothing new.
	}
}
