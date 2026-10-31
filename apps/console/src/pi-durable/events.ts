// The subset of Pi Durable's experimental agent events that a recorded session holds, written from the source at
// earendil-works/pi@973b74c55fcf096ad5976f8d8850c147ee2e62d4 (packages/durable/src/harness/events.ts, the
// `AgentEvent` and `SnapshotEvent` types; message shapes from packages/ai/src/types.ts; entry kinds from
// packages/durable/src/entries.ts). Field names and nesting match that commit; IDs are plain numbers, as Pi's erased
// brands are at runtime. Only the server side of the console (src/server-sim) reads these: the console's UI sees
// Kantel's protocol, never Pi's types, so Pi's churn stays out of the public contracts.

export type EntryId = number;
export type SubmissionId = number;
export type TaskId = number;

export type TextContent = { type: "text"; text: string };
export type ThinkingContent = { type: "thinking"; thinking: string; redacted?: boolean };
export type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
export type ImageContent = { type: "image"; data: string; mimeType: string };

export type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type UserMessage = { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number };
export type AssistantMessage = {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
	durationMs?: number;
};
export type ToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	timestamp: number;
	durationMs?: number;
};
export type SystemMessage = { role: "system"; content: unknown[]; timestamp: number };
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, `pi.compaction`, or a host's own kind. */
export type EntryRecord = {
	id: EntryId;
	conversationId: number;
	kind: string;
	model?: Message[];
	data?: unknown;
	head?: EntryId;
	byTaskId?: TaskId;
};

export type Block = AssistantMessage["content"][number];

export type MessageChange =
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: (string | number)[]; delta: string }
	| { type: "block"; contentIndex: number; block: Block }
	| { type: "message"; message: AssistantMessage };

export type ToolSlot = {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	output?: string;
	taskId?: TaskId;
	entry?: EntryId;
};

export type QueuedItem = { id: SubmissionId; mode: "steer" | "followUp" };

export type SnapshotEvent = {
	type: "snapshot";
	entries: EntryRecord[];
	run?: { inputs: SubmissionId[] };
	generation?: { attempt: number; message?: AssistantMessage };
	tools: ToolSlot[];
	nestedTools: unknown[];
	compactions: unknown[];
	inbox: QueuedItem[];
	agent: Record<string, unknown>;
	usage: Record<string, unknown>;
};

export type ToolEventCall = {
	toolCallId: string;
	toolName: string;
	taskId?: TaskId;
	parentToolCallId?: string;
	parentTaskId?: TaskId;
};

export type SubmissionRecord = {
	id: SubmissionId;
	conversationId: number;
	type: "input";
	status: "queued" | "placed" | "done" | "rejected" | "cancelled";
	entry?: EntryId;
	answer?: EntryId;
};

export type AgentEvent =
	| SnapshotEvent
	| { type: "run_start"; inputs: SubmissionId[] }
	| { type: "run_end"; inputs: SubmissionId[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; usage: Usage; changes: MessageChange[] }
	| { type: "message_end"; entry: EntryRecord }
	| ({ type: "tool_execution_start"; args: Record<string, unknown> } & ToolEventCall)
	| ({
			type: "tool_execution_update";
			output?: { trimStart?: number; append?: string } | { set: string };
			details?: unknown;
	  } & ToolEventCall)
	| ({ type: "tool_execution_end"; entry?: EntryRecord } & ToolEventCall)
	| { type: "inbox_update"; items: QueuedItem[] }
	| { type: "submission"; record: SubmissionRecord }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "entry_appended"; entry: EntryRecord }
	| { type: "agent_changed"; agent: Record<string, unknown> }
	| { type: "usage_changed"; usage: Record<string, unknown> }
	| { type: "task_failed"; taskId: TaskId; kind: string; message: string };

/**
 * One line of a recorded session (fixtures/pi-durable/*.jsonl). Pi's `watchEvents()` stream calls its listener once per
 * commit with that commit's batch of events, after a first `snapshot`; the recorder writes each call as one line and
 * adds `seq`, the batch's position in the stream (0 for the snapshot), and `at`, milliseconds since the recording
 * started, so the stream can be replayed at its recorded pace. The events themselves are Pi's, unchanged.
 */
export type RecordedBatch = { seq: number; at: number; events: AgentEvent[] };

/** First line of a recording: what it is. Not part of Pi's stream. */
export type RecordingHeader = {
	recording: "pi-durable/watchEvents";
	pi: { repo: "earendil-works/pi"; commit: string; package: "@earendil-works/pi-durable" };
	title: string;
	note?: string;
};
