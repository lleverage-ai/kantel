/**
 * Kantel's client wire protocol: what a console or host app sees of a session.
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

/**
 * Model token usage and cost. On a snapshot and in a `usage` op it is the session's running total over every model
 * response so far; on a run result it is the run's answer. `inputTokens` excludes cached input: a prompt served from
 * the provider's cache counts under `cacheReadTokens`, one written to it under `cacheWriteTokens`.
 */
export interface Usage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	/** Zero when the connector reports no cost and computes none (CLIProxyAPI records tokens only). */
	readonly costUsd?: number;
}

export type UserItemVia = "prompt" | "steer" | "followUp";

/** A file the person attached to a message (`PromptAttachment` in `@kantel/contracts`), as the transcript shows it. */
export interface UserAttachment {
	/** The host's ID for the upload. */
	readonly id: string;
	readonly name: string;
	/** The MIME type, such as `image/png` or `application/pdf`. */
	readonly type: string;
	/** In bytes. */
	readonly size: number;
	readonly kind: "image" | "file" | "text";
}

export interface UserItem {
	readonly kind: "user";
	readonly id: string;
	readonly at: Timestamp;
	/** What the person typed; empty when they sent only attachments. */
	readonly text: string;
	readonly via: UserItemVia;
	readonly requestId?: string;
	/** The files sent with the message, in the order they were attached. The model saw their contents. */
	readonly attachments?: readonly UserAttachment[];
}

export interface AssistantItem {
	readonly kind: "assistant";
	readonly id: string;
	readonly at: Timestamp;
	readonly text: string;
	/** True while tokens are still arriving; deltas until then are provisional. */
	readonly streaming: boolean;
	readonly thinking?: string;
	/**
	 * The document the model is writing in a `create_document` call, while the answer streams: its title and the Markdown
	 * so far. Gone once the answer is done, when the call's tool item presents the saved document instead.
	 */
	readonly document?: DraftDocument;
}

/** A document as it streams in (`create_document`'s arguments so far). */
export interface DraftDocument {
	/** The tool call writing it. */
	readonly callId: string;
	readonly title: string;
	/** Its Markdown so far. */
	readonly text: string;
}

export type ToolItemStatus = "running" | "done" | "error" | "interrupted";

/** The image types a tool item may carry: raster only, never SVG. */
export const TOOL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ToolImageType = (typeof TOOL_IMAGE_TYPES)[number];

/**
 * An image a tool returned, such as a browser screenshot: by reference (`url`, a path on the API's origin read with the
 * same credentials as the API), or inline as base64 (`data`) where the server can't serve it by reference.
 *
 * - `/v1/sessions/<sessionId>/images/<sha256>`: an image in the session's own conversation, named by the SHA-256 of its
 *   bytes (`getSessionImage`). It never changes, so a client may cache it for good. `width`, `height` and `size` come
 *   with it, so a client can make room for it before it loads.
 * - `/v1/attachments/<id>?projectId=<id>`: a browser's screenshot kept as a project attachment. It may not be stored yet
 *   when its item arrives (it is taken after its step answers): a read that finds nothing is tried again shortly.
 */
export type ToolImage =
	| { readonly mimeType: ToolImageType /** Base64. */; readonly data: string; readonly url?: never }
	| {
			readonly mimeType: ToolImageType;
			readonly url: string;
			readonly data?: never;
			/** Its width in pixels, when known. */
			readonly width?: number;
			/** Its height in pixels, when known. */
			readonly height?: number;
			/** Its size in bytes, when known. */
			readonly size?: number;
	  };

/**
 * A file the agent presented to the person (the `present_files` tool): a card in the transcript that opens a viewer.
 * Only where it is: a client reads its bytes through the workspace read API with its own credentials
 * (`GET /v1/workspaces/{workspaceId}/content?path=`), never from a link in the stream.
 */
export interface PresentedFile {
	/** The session's workspace the file is in. */
	readonly workspaceId: string;
	/** Its path in the workspace, as the read API takes it: "out/report.pdf", or "/project/README.md" under a mount. */
	readonly path: string;
	/** Its file name: "report.pdf". */
	readonly name: string;
	/** Its media type, from its name: "application/pdf". */
	readonly mimeType: string;
	/** Its size in bytes when it was presented. */
	readonly size: number;
	/** The first lines of a text file (Markdown, CSV, plain text), for the card; never more than a few hundred characters. */
	readonly preview?: string;
	/** A title to show for it rather than its name: a document's (`create_document`). */
	readonly title?: string;
	/** A document the agent wrote (`create_document`): Markdown the person edits in a document panel. */
	readonly document?: boolean;
	/** The model that made the file: an image `generate_image` made, such as "gpt-image-1". */
	readonly model?: string;
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
	/**
	 * The call's arguments. While `streaming`, the model's partial JSON parsed so far: any field may be missing or cut
	 * short, and `args` ops grow its strings.
	 */
	readonly args?: unknown;
	/**
	 * True while the model is still writing the call: its arguments are arriving and it hasn't started. The item is
	 * replaced without it once the call is whole. Absent otherwise.
	 */
	readonly streaming?: boolean;
	readonly output?: string;
	/** Images the call returned, in order, such as a browser's screenshot of the page it is on. */
	readonly images?: readonly ToolImage[];
	/**
	 * The browser the call used, such as the one `browser_open` opened or the one `browser_act` stepped, so a client can
	 * ask for its live view. Only an ID: never a link or a credential.
	 */
	readonly browserSessionId?: string;
	/**
	 * The files the call presented to the person (`present_files`; `create_document` its document; `generate_image` the
	 * images it made), the most relevant first.
	 */
	readonly files?: readonly PresentedFile[];
	readonly tier?: SandboxTierName;
	readonly endedAt?: Timestamp;
}

/** Approval card for a connection request: a credential an agent asked to use. The value is never part of it. */
export interface ConnectionApprovalCard {
	readonly type: "connection.approval";
	/** The request's ID. */
	readonly proposalId: string;
	readonly status: "pending" | "approved" | "denied" | "expired" | "withdrawn";
	/** Always shown on the card and on the connection request page. */
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
	/**
	 * For an approval of one exact request a rule asked about (#333): the request, and the digest only it matches. Its
	 * headers and body are on the connection request page.
	 */
	readonly request?: ConnectionApprovalRequest;
	/**
	 * The tool call waiting on this approval: a connection call's `callId`, or for a request a `codemode` script made, the
	 * script's inner call (`<scriptCallId>/<key>`, such as `toolu_01/c9`). A client that renders that call may show the
	 * approval in it and leave this card out; one that doesn't still has the card. Absent on cards written before it.
	 */
	readonly callId?: string;
}

/** The exact request a connection approval card is for. */
export interface ConnectionApprovalRequest {
	readonly connectionId: string;
	readonly connectionName: string;
	readonly kind: "http" | "mcp_call" | "mcp_tools";
	readonly method: string;
	/** The URL as it will be sent, query included. */
	readonly url: string;
	/** For an MCP tool call: the tool. */
	readonly tool?: string;
	readonly digest: string;
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

/**
 * @deprecated The same card under its old type, `vault.approval`, as transcripts written before #324 carry it. New
 * cards are `ConnectionApprovalCard`; a reader takes both for one release.
 */
export interface VaultApprovalCard extends Omit<ConnectionApprovalCard, "type"> {
	readonly type: "vault.approval";
}

/** Card types that are a connection approval: the current one and its deprecated alias. */
export const CONNECTION_APPROVAL_CARD_TYPES: readonly string[] = ["connection.approval", "vault.approval"];

/** Whether a card is a connection approval, under its current type or the deprecated `vault.approval`. */
export function isConnectionApprovalCard(card: Card): card is ConnectionApprovalCard | VaultApprovalCard {
	return card.type === "connection.approval" || card.type === "vault.approval";
}

export type Card = ConnectionApprovalCard | VaultApprovalCard | QuestionCard | BrowserGrantCard;

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
	/**
	 * Appends streamed text to an assistant item's `text` (or `thinking` when `field` is "thinking", or its draft
	 * document's `text` when `field` is "document").
	 */
	| {
			readonly op: "text";
			readonly itemId: string;
			readonly append: string;
			readonly field?: "text" | "thinking" | "document";
	  }
	/**
	 * Appends streamed text to the string at `path` in a tool item's `args`, while the model writes the call. A missing
	 * string starts empty, and missing objects (arrays, for a number key) on the way to it are created.
	 */
	| {
			readonly op: "args";
			readonly itemId: string;
			readonly path: readonly ArgsKey[];
			readonly append: string;
	  }
	| { readonly op: "status"; readonly status: SessionStatus; readonly attention: Attention }
	| { readonly op: "title"; readonly title: string }
	| { readonly op: "usage"; readonly usage: Usage };

/** A step into a tool call's arguments: an object's key, or an array's index. */
export type ArgsKey = string | number;

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

export { type ArgsAppend, appendArgs, argsAppends } from "./args.ts";
export { parseFixture, serializeFixture } from "./fixture.ts";
export { applyDelta, applyFrames, attentionFor, ProtocolError } from "./reduce.ts";
