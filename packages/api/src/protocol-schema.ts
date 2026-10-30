/**
 * `@harbour/protocol`'s frames as JSON Schema, for the stream route and the history route: what a session's stream
 * sends (`ServerFrame`) and everything inside it. The protocol is the source; `test/types.test.ts` checks that each
 * schema's type and the protocol's type match.
 */
import Type from "typebox";
import { SessionStatus, Timestamp } from "./schema.ts";

export const Cursor = Type.String({ title: "Cursor", description: "An opaque position in a session's stream." });

export const Attention = Type.Union([Type.Literal("working"), Type.Literal("waiting"), Type.Literal("done")], {
	title: "Attention",
	description: "How a session list groups the session: working, waiting on someone, or done.",
});

export const Usage = Type.Object(
	{
		inputTokens: Type.Integer(),
		outputTokens: Type.Integer(),
		cacheReadTokens: Type.Optional(Type.Integer()),
		cacheWriteTokens: Type.Optional(Type.Integer()),
		costUsd: Type.Optional(Type.Number()),
	},
	{
		title: "Usage",
		description:
			"Model token usage and cost: the session's running total on a snapshot and in a `usage` op, the answer's on a " +
			"run result. `inputTokens` excludes input read from or written to the provider's cache.",
	},
);

export const UserAttachment = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		type: Type.String(),
		size: Type.Number(),
		kind: Type.Union([Type.Literal("image"), Type.Literal("file"), Type.Literal("text")]),
	},
	{
		title: "UserAttachment",
		description: "A file sent with a message. The model saw its contents; `text` leaves them out.",
	},
);

export const UserItem = Type.Object(
	{
		kind: Type.Literal("user"),
		id: Type.String(),
		at: Timestamp,
		text: Type.String(),
		via: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")]),
		requestId: Type.Optional(Type.String()),
		attachments: Type.Optional(Type.Array(UserAttachment)),
	},
	{ title: "UserItem" },
);

export const AssistantItem = Type.Object(
	{
		kind: Type.Literal("assistant"),
		id: Type.String(),
		at: Timestamp,
		text: Type.String(),
		streaming: Type.Boolean({ description: "True while tokens are still arriving." }),
		thinking: Type.Optional(Type.String()),
		document: Type.Optional(
			Type.Object(
				{
					callId: Type.String({ description: "The tool call writing it." }),
					title: Type.String(),
					text: Type.String({ description: "Its Markdown so far." }),
				},
				{
					title: "DraftDocument",
					description:
						"The document the model is writing in a `create_document` call, while the answer streams. Gone once the answer is done.",
				},
			),
		),
	},
	{ title: "AssistantItem" },
);

export const PresentedFile = Type.Object(
	{
		workspaceId: Type.String({ description: "The session's workspace the file is in." }),
		path: Type.String({
			description:
				'Its path in the workspace, for `GET /v1/workspaces/{workspaceId}/content?path=`: "out/report.pdf", or "/project/README.md" under a mount.',
		}),
		name: Type.String({ description: 'Its file name: "report.pdf".' }),
		mimeType: Type.String({ description: 'Its media type, from its name: "application/pdf".' }),
		size: Type.Integer({ description: "Its size in bytes when it was presented." }),
		preview: Type.Optional(Type.String({ description: "The first lines of a text file, for a preview card." })),
		title: Type.Optional(Type.String({ description: "A title to show rather than its name: a document's." })),
		document: Type.Optional(
			Type.Boolean({ description: "A document the agent wrote (`create_document`): Markdown the person edits." }),
		),
		model: Type.Optional(
			Type.String({
				description: 'The model that made the file: an image `generate_image` made, such as "gpt-image-1".',
			}),
		),
	},
	{
		title: "PresentedFile",
		description:
			"A file the agent presented to the person (`present_files`). Read its bytes through the workspace read API with your own credentials.",
	},
);

export const ToolItem = Type.Object(
	{
		kind: Type.Literal("tool"),
		id: Type.String(),
		at: Timestamp,
		callId: Type.String(),
		name: Type.String(),
		label: Type.String({ description: 'A plain-language label, such as "Reading notes/x.md".' }),
		status: Type.Union([
			Type.Literal("running"),
			Type.Literal("done"),
			Type.Literal("error"),
			Type.Literal("interrupted"),
		]),
		args: Type.Optional(
			Type.Unknown({
				description: "The call's arguments; while `streaming`, the model's partial JSON parsed so far.",
			}),
		),
		streaming: Type.Optional(
			Type.Boolean({
				description:
					"True while the model is still writing the call: its arguments are arriving and it hasn't started.",
			}),
		),
		output: Type.Optional(Type.String()),
		files: Type.Optional(
			Type.Array(PresentedFile, {
				description:
					"The files the call presented to the person (`present_files`; `create_document` its document; `generate_image` the images it made), the most relevant first.",
			}),
		),
		tier: Type.Optional(Type.Union([Type.Literal("isolate"), Type.Literal("container")])),
		endedAt: Type.Optional(Timestamp),
	},
	{ title: "ToolItem" },
);

export const VaultApprovalCard = Type.Object(
	{
		type: Type.Literal("vault.approval"),
		proposalId: Type.String(),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("approved"),
			Type.Literal("denied"),
			Type.Literal("expired"),
			Type.Literal("withdrawn"),
		]),
		bindingCode: Type.String(),
		what: Type.String(),
		why: Type.String(),
		host: Type.String(),
		methods: Type.Array(Type.String()),
		pathPrefix: Type.String(),
		injectionTemplate: Type.Optional(Type.String()),
		termsSource: Type.Union([Type.Literal("agent-proposed"), Type.Literal("approved")]),
		expiresAt: Timestamp,
		link: Type.String(),
	},
	{ title: "VaultApprovalCard", description: "A vault proposal waiting on a person. The secret is never part of it." },
);

export const QuestionCard = Type.Object(
	{
		type: Type.Literal("question"),
		questionId: Type.String(),
		text: Type.String(),
		options: Type.Optional(Type.Array(Type.String())),
		status: Type.Union([Type.Literal("open"), Type.Literal("answered"), Type.Literal("withdrawn")]),
		answer: Type.Optional(Type.String()),
	},
	{ title: "QuestionCard" },
);

export const BrowserGrantCard = Type.Object(
	{
		type: Type.Literal("browser.grant"),
		requestId: Type.String(),
		reason: Type.String(),
		status: Type.Union([Type.Literal("pending"), Type.Literal("granted"), Type.Literal("denied")]),
	},
	{ title: "BrowserGrantCard" },
);

export const Card = Type.Union([VaultApprovalCard, QuestionCard, BrowserGrantCard], { title: "Card" });

export const CardItem = Type.Object(
	{ kind: Type.Literal("card"), id: Type.String(), at: Timestamp, card: Card },
	{ title: "CardItem" },
);

export const NoticeItem = Type.Object(
	{
		kind: Type.Literal("notice"),
		id: Type.String(),
		at: Timestamp,
		level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
		text: Type.String(),
		code: Type.Optional(Type.String()),
	},
	{ title: "NoticeItem" },
);

export const TranscriptItem = Type.Union([UserItem, AssistantItem, ToolItem, CardItem, NoticeItem], {
	title: "TranscriptItem",
});

export const SessionSnapshot = Type.Object(
	{
		v: Type.Literal(1),
		sessionId: Type.String(),
		cursor: Cursor,
		status: SessionStatus,
		attention: Attention,
		title: Type.Optional(Type.String()),
		items: Type.Array(TranscriptItem, { description: "The latest page of items, oldest first." }),
		hasEarlier: Type.Boolean({ description: "True when items before `items[0]` exist." }),
		usage: Type.Optional(Usage),
		updatedAt: Timestamp,
	},
	{ title: "SessionSnapshot" },
);

export const DeltaOp = Type.Union(
	[
		Type.Object({ op: Type.Literal("append"), item: TranscriptItem }),
		Type.Object({ op: Type.Literal("replace"), item: TranscriptItem }),
		Type.Object({
			op: Type.Literal("text"),
			itemId: Type.String(),
			append: Type.String(),
			field: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("document")])),
		}),
		Type.Object({
			op: Type.Literal("args"),
			itemId: Type.String(),
			path: Type.Array(Type.Union([Type.String(), Type.Number()]), {
				description: "Keys and indexes to a string in the tool item's `args`; missing ones are created.",
			}),
			append: Type.String(),
		}),
		Type.Object({ op: Type.Literal("status"), status: SessionStatus, attention: Attention }),
		Type.Object({ op: Type.Literal("title"), title: Type.String() }),
		Type.Object({ op: Type.Literal("usage"), usage: Usage }),
	],
	{
		title: "DeltaOp",
		description:
			"`append` adds an item, `replace` swaps the item with the same id, `text` appends streamed text to an " +
			"assistant item, `args` appends streamed text to a string in a tool item's arguments, and `status`, `title` " +
			"and `usage` set the session's.",
	},
);

export const SessionDelta = Type.Object(
	{
		sessionId: Type.String(),
		cursor: Cursor,
		at: Timestamp,
		ops: Type.Array(DeltaOp),
	},
	{ title: "SessionDelta" },
);

export const HistoryPage = Type.Object(
	{
		sessionId: Type.String(),
		items: Type.Array(TranscriptItem, { description: "Oldest first." }),
		hasEarlier: Type.Boolean(),
	},
	{ title: "HistoryPage" },
);

export const ServerFrame = Type.Union(
	[
		Type.Object({
			type: Type.Literal("hello"),
			v: Type.Literal(1),
			sessionId: Type.String(),
			cursor: Cursor,
			resumed: Type.Boolean({
				description: "True when deltas after the client's cursor follow, false for a snapshot.",
			}),
		}),
		Type.Object({ type: Type.Literal("snapshot"), snapshot: SessionSnapshot }),
		Type.Object({ type: Type.Literal("delta"), delta: SessionDelta }),
		Type.Object({ type: Type.Literal("history"), page: HistoryPage }),
		Type.Object({ type: Type.Literal("error"), code: Type.String(), message: Type.String() }),
	],
	{
		title: "ServerFrame",
		description:
			"One frame of `@harbour/protocol`: `hello`, then a `snapshot` (or the deltas after the client's cursor), then " +
			"live `delta`s.",
	},
);

export const SessionHistoryPage = Type.Object(
	{
		sessionId: Type.String(),
		items: Type.Array(TranscriptItem, { description: "Newest first." }),
		nextCursor: Type.Optional(Type.String({ description: "Present when older items exist; pass it as `cursor`." })),
	},
	{ title: "SessionHistoryPage" },
);

export const HistoryQuery = Type.Object(
	{
		cursor: Type.Optional(Type.String({ description: "A previous page's `nextCursor`." })),
		before: Type.Optional(
			Type.String({ description: "Items older than this item ID, such as a snapshot's `items[0].id`." }),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, description: "At most this many items. Default 50, cut to 200." })),
	},
	{ title: "HistoryQuery" },
);

export const StreamQuery = Type.Object(
	{
		after: Type.Optional(
			Type.String({
				description:
					"Resume after this cursor (a snapshot's or a delta's): the stream sends the deltas after it, or a snapshot " +
					"when it no longer holds them.",
			}),
		),
	},
	{ title: "StreamQuery" },
);
