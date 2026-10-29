/**
 * Harbour's client wire protocol: what a console or host app sees of a session.
 *
 * A client connects with `hello` (optionally `after` a cursor it already holds). The server answers with `hello`, then
 * either the deltas after that cursor or, when it cannot resume from it, a full `snapshot`, then live deltas.
 * Applying every delta to a snapshot in order gives the same state as a fresh snapshot at the last cursor.
 *
 * This package has no dependencies, so the console, the targets and host apps can all import it. Pi types never
 * appear here: the runtime projects Pi Durable's entries onto these items.
 */

export const PROTOCOL_VERSION = 1 as const;

/** An opaque, ordered position in a session's stream. Compare cursors only for equality. */
export type Cursor = string;

/** Epoch milliseconds, UTC. */
export type Timestamp = number;

export type SessionStatus = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled";

/** How the session list groups a session: working, waiting on you, or done. */
export type Attention = "working" | "waiting" | "done";

export type SandboxTierName = "isolate" | "container";

export interface Usage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly costUsd?: number;
}

export type UserItemVia = "prompt" | "steer" | "followUp";

export interface UserItem {
	readonly kind: "user";
	readonly id: string;
	readonly at: Timestamp;
	readonly text: string;
	readonly via: UserItemVia;
	readonly requestId?: string;
}

export interface AssistantItem {
	readonly kind: "assistant";
	readonly id: string;
	readonly at: Timestamp;
	readonly text: string;
	/** True while tokens are still arriving; deltas until then are provisional. */
	readonly streaming: boolean;
	readonly thinking?: string;
}

export type ToolItemStatus = "running" | "done" | "error" | "interrupted";

/** The image types a tool item may carry: raster only, never SVG. */
export const TOOL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ToolImageType = (typeof TOOL_IMAGE_TYPES)[number];

/** An image a tool returned, such as a browser screenshot. */
export interface ToolImage {
	readonly mimeType: ToolImageType;
	/** Base64. */
	readonly data: string;
}

export interface ToolItem {
	readonly kind: "tool";
	readonly id: string;
	readonly at: Timestamp;
	readonly callId: string;
	readonly name: string;
	/** A plain-language chip label, such as "Reading notes/x.md". */
	readonly label: string;
	readonly status: ToolItemStatus;
	readonly args?: unknown;
	readonly output?: string;
	/** Images the call returned, in order, such as a browser's screenshot of the page it is on. */
	readonly images?: readonly ToolImage[];
	readonly tier?: SandboxTierName;
	readonly endedAt?: Timestamp;
}

/** Approval card for a vault proposal. The value is never part of it. */
export interface VaultApprovalCard {
	readonly type: "vault.approval";
	readonly proposalId: string;
	readonly status: "pending" | "approved" | "denied" | "expired" | "withdrawn";
	/** Always shown on the card and on the vault page. */
	readonly bindingCode: string;
	readonly what: string;
	readonly why: string;
	readonly host: string;
	readonly methods: readonly string[];
	readonly pathPrefix: string;
	readonly injectionTemplate?: string;
	/** `agent-proposed` until a human decides; `approved` shows the actual (possibly narrowed) terms. */
	readonly termsSource: "agent-proposed" | "approved";
	readonly expiresAt: Timestamp;
	readonly link: string;
}

export interface QuestionCard {
	readonly type: "question";
	readonly questionId: string;
	readonly text: string;
	readonly options?: readonly string[];
	readonly status: "open" | "answered" | "withdrawn";
	readonly answer?: string;
}

export interface BrowserGrantCard {
	readonly type: "browser.grant";
	readonly requestId: string;
	readonly reason: string;
	readonly status: "pending" | "granted" | "denied";
}

export type Card = VaultApprovalCard | QuestionCard | BrowserGrantCard;

export interface CardItem {
	readonly kind: "card";
	readonly id: string;
	readonly at: Timestamp;
	readonly card: Card;
}

export interface NoticeItem {
	readonly kind: "notice";
	readonly id: string;
	readonly at: Timestamp;
	readonly level: "info" | "warning" | "error";
	/** For example "may have partially run" after an interrupted unsafe tool call. */
	readonly text: string;
	readonly code?: string;
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | CardItem | NoticeItem;

export interface SessionSnapshot {
	readonly v: typeof PROTOCOL_VERSION;
	readonly sessionId: string;
	readonly cursor: Cursor;
	readonly status: SessionStatus;
	readonly attention: Attention;
	readonly title?: string;
	/** The latest page of items, oldest first. Earlier items come from `history`. */
	readonly items: readonly TranscriptItem[];
	/** True when items before `items[0]` exist. */
	readonly hasEarlier: boolean;
	readonly usage?: Usage;
	readonly updatedAt: Timestamp;
}

export type DeltaOp =
	/** Adds an item at the end. */
	| { readonly op: "append"; readonly item: TranscriptItem }
	/** Replaces the item with the same id, keeping the identity of every other item. */
	| { readonly op: "replace"; readonly item: TranscriptItem }
	/** Appends streamed text to an assistant item's `text` (or `thinking` when `field` is "thinking"). */
	| { readonly op: "text"; readonly itemId: string; readonly append: string; readonly field?: "text" | "thinking" }
	| { readonly op: "status"; readonly status: SessionStatus; readonly attention: Attention }
	| { readonly op: "title"; readonly title: string }
	| { readonly op: "usage"; readonly usage: Usage };

export interface SessionDelta {
	readonly sessionId: string;
	/** The cursor after this delta. */
	readonly cursor: Cursor;
	readonly at: Timestamp;
	readonly ops: readonly DeltaOp[];
}

export interface HistoryPage {
	readonly sessionId: string;
	/** Items before `before`, oldest first. */
	readonly items: readonly TranscriptItem[];
	readonly hasEarlier: boolean;
}

export type ClientFrame =
	| { readonly type: "hello"; readonly v: typeof PROTOCOL_VERSION; readonly sessionId: string; readonly after?: Cursor }
	| { readonly type: "history"; readonly sessionId: string; readonly before: string; readonly limit: number };

export type ServerFrame =
	| {
			readonly type: "hello";
			readonly v: typeof PROTOCOL_VERSION;
			readonly sessionId: string;
			readonly cursor: Cursor;
			/** True when the server resumes from the client's cursor with deltas; false when a snapshot follows. */
			readonly resumed: boolean;
	  }
	| { readonly type: "snapshot"; readonly snapshot: SessionSnapshot }
	| { readonly type: "delta"; readonly delta: SessionDelta }
	| { readonly type: "history"; readonly page: HistoryPage }
	| { readonly type: "error"; readonly code: string; readonly message: string };

export interface StreamConnection {
	/** Stops live frames. Idempotent. */
	close(): Promise<void>;
}

/**
 * The server side of the protocol for one session, as each target implements it behind its WebSocket or SSE endpoint.
 */
export interface SessionStream {
	readonly sessionId: string;
	/**
	 * Answers a client hello. Sends a `hello` frame, then either every delta after `after` (when the stream still holds
	 * them; `resumed: true`) or one `snapshot` (`resumed: false`), then live deltas until the connection is closed.
	 * Frames are delivered one at a time, in order.
	 */
	connect(after: Cursor | undefined, onFrame: (frame: ServerFrame) => void): Promise<StreamConnection>;
	/** The current state, holding at most the latest page of items. */
	snapshot(): Promise<SessionSnapshot>;
	/** Up to `limit` items before the item `before`, oldest first. */
	history(before: string, limit: number): Promise<HistoryPage>;
}

/** The producer side: how a session runtime publishes changes to its stream. */
export interface SessionStreamWriter {
	/** Commits `ops` as one delta with a new cursor and delivers it to every connection. */
	publish(ops: readonly DeltaOp[]): Promise<SessionDelta>;
}

export { parseFixture, serializeFixture } from "./fixture.ts";
export { applyDelta, applyFrames, attentionFor, ProtocolError } from "./reduce.ts";
