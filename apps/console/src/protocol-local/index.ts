// LOCAL COPY of Harbour's client wire protocol, for M0-FE1 only.
//
// TODO(M0-BE1, tvdavies/harbour#2): switch every import of this module to `@harbour/protocol` once packages/protocol
// lands, then delete this directory. Where the two differ, @harbour/protocol wins and the console adapts; the names
// here (SessionSnapshot, SessionDelta, the hello handshake) are the ones the plan uses.
//
// The protocol is Harbour's, not Pi's: the session host projects Pi Durable's agent events into transcript items, so
// no Pi type crosses the wire. The handshake follows durable-pi: the client says hello with the last cursor it
// applied; the host answers with the deltas after that cursor if it still holds them, or with a fresh snapshot.

/** Position in a session's stream: the seq of the last commit applied. Only ever goes up. */
export type Cursor = number;
export type ItemId = string;

export type RunState = "idle" | "working" | "waiting";

export type TextPart = { kind: "text"; text: string };
export type ThinkingPart = { kind: "thinking"; text: string };
/** A tool call the assistant made; its progress is the tool item with the same `callId`. */
export type ToolCallPart = { kind: "tool"; callId: string };
export type AssistantPart = TextPart | ThinkingPart | ToolCallPart;

export type UserItem = { kind: "user"; id: ItemId; text: string; at: number };

export type AssistantItem = {
	kind: "assistant";
	id: ItemId;
	parts: AssistantPart[];
	/** `streaming` until the message ends; text may still change only then. */
	status: "streaming" | "done" | "error" | "aborted";
	model?: string;
	error?: string;
	at: number;
	durationMs?: number;
};

export type ToolStatus = "pending" | "running" | "done" | "error";

export type ToolItem = {
	kind: "tool";
	id: ItemId;
	callId: string;
	name: string;
	args: Record<string, unknown>;
	status: ToolStatus;
	/** Running output while it runs (a bounded window), then the result text. */
	output: string;
	at: number;
	durationMs?: number;
};

export type NoticeItem = { kind: "notice"; id: ItemId; text: string; tone: "info" | "warn"; at: number };

export type TranscriptItem = UserItem | AssistantItem | ToolItem | NoticeItem;

/** One change to the transcript or the run. Ops apply in order; each names the item it changes. */
export type DeltaOp =
	| { op: "item.add"; item: TranscriptItem }
	/** Replace an item whole, such as a message at its end. */
	| { op: "item.put"; item: TranscriptItem }
	| { op: "part.add"; id: ItemId; part: AssistantPart }
	| { op: "text.append"; id: ItemId; part: number; text: string }
	| {
			op: "tool.update";
			id: ItemId;
			status?: ToolStatus;
			/** A front trim then an append of the retained window, or its replacement, as Pi's tool updates. */
			output?: { trimStart?: number; append?: string } | { set: string };
			args?: Record<string, unknown>;
			durationMs?: number;
	  }
	| { op: "run"; state: RunState };

export type SessionSnapshot = {
	type: "snapshot";
	sessionId: string;
	title: string;
	cursor: Cursor;
	/** The newest page of the transcript, oldest first. Older items come from history pages. */
	items: TranscriptItem[];
	/** Token for the page before `items`, or null at the start of the session. */
	before: string | null;
	run: RunState;
	/** Total items in the session, so the console can say how much history there is. */
	total: number;
};

export type SessionDelta = {
	type: "delta";
	sessionId: string;
	/** The commit this delta is; deltas arrive in cursor order with no gaps. */
	cursor: Cursor;
	ops: DeltaOp[];
	/**
	 * True while the commit is visible but not yet stored (Pi persists streamed progress up to about a second later).
	 * The console shows it, but treats it as provisional until a later delta or snapshot covers it.
	 */
	provisional?: boolean;
};

export type HistoryPage = {
	type: "history";
	sessionId: string;
	/** Oldest first, ending just before the page the token named. */
	items: TranscriptItem[];
	before: string | null;
};

export type Welcome = {
	type: "welcome";
	sessionId: string;
	/** How the host will catch the client up: deltas after its cursor, or a snapshot. */
	resume: "deltas" | "snapshot";
	head: Cursor;
};

export type ServerMessage = Welcome | SessionSnapshot | SessionDelta | HistoryPage;

export type Hello = { type: "hello"; sessionId: string; cursor?: Cursor };
export type HistoryRequest = { type: "history"; sessionId: string; before: string; limit: number };
export type ClientMessage = Hello | HistoryRequest;
