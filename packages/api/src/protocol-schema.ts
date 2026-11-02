/**
 * `@kantel/protocol`'s frames as JSON Schema, for the stream route and the history route: what a session's stream
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

const ToolImageType = Type.Union(
	[Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp"), Type.Literal("image/gif")],
	{ title: "ToolImageType", description: "The image types a tool item carries: raster only, never SVG." },
);

export const ToolImage = Type.Union(
	[
		Type.Object(
			{
				mimeType: ToolImageType,
				url: Type.String({
					description:
						"A path on the API's origin, read with your own credentials: `/v1/sessions/{sessionId}/images/{imageId}` " +
						"(`getSessionImage`), or a browser screenshot's `/v1/attachments/{id}?projectId=`, which may take a moment " +
						"to be stored after its item arrives (a read that finds nothing is tried again shortly).",
				}),
				width: Type.Optional(Type.Integer({ description: "Its width in pixels, when known." })),
				height: Type.Optional(Type.Integer({ description: "Its height in pixels, when known." })),
				size: Type.Optional(Type.Integer({ description: "Its size in bytes, when known." })),
			},
			{ title: "ToolImageReference" },
		),
		Type.Object(
			{
				mimeType: ToolImageType,
				data: Type.String({ description: "The image as base64." }),
			},
			{ title: "InlineToolImage" },
		),
	],
	{
		title: "ToolImage",
		description:
			"An image a tool returned, such as a browser screenshot or a generated image. By reference (`url`) wherever the " +
			"server can serve it, so a snapshot or a delta carries no image bytes; inline as base64 (`data`) otherwise, such " +
			"as on a self-hosted server.",
	},
);

const optionalString = (description: string) => Type.Optional(Type.String({ description }));

/** One connection call, as a tool item carries it (#464). */
export const ConnectionCallDetails = Type.Object(
	{
		callId: Type.String({
			description:
				"The tool call: a connection tool's own `callId`, or a script's inner call (`toolu_01/c9`). `/v1/connections/uses` records it as `toolCallId`.",
		}),
		connection: Type.Object({
			id: Type.String(),
			name: Type.String(),
			templateId: optionalString("The catalogue template it was made from, such as `github`."),
			account: optionalString("Whose identity acted, in the service's words: a login, a name or an email."),
			owner: Type.Union([
				Type.Object({ kind: Type.Literal("organisation") }),
				Type.Object({ kind: Type.Literal("project"), projectId: Type.String() }),
				Type.Object({ kind: Type.Literal("user"), userId: Type.String() }),
			]),
			viaShare: Type.Optional(
				Type.Literal(true, { description: "A person's connection used in a project it is shared with." }),
			),
		}),
		request: Type.Object({
			kind: Type.Union([Type.Literal("http"), Type.Literal("mcp_call"), Type.Literal("mcp_tools")]),
			method: Type.String(),
			host: Type.String(),
			path: Type.String(),
			query: optionalString("The query as sent, without its `?`."),
			tool: optionalString("For an MCP call: the tool."),
			operation: Type.Optional(
				Type.Object(
					{
						id: Type.Optional(Type.String()),
						label: Type.String(),
						group: Type.String(),
						access: Type.Union([
							Type.Literal("read"),
							Type.Literal("write"),
							Type.Literal("delete"),
							Type.Literal("admin"),
						]),
						resource: Type.Optional(Type.String()),
					},
					{ description: "What it did, when the connection's template classifies it." },
				),
			),
		}),
		decision: Type.Optional(
			Type.Object({
				action: Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]),
				decidedBy: Type.Union([
					Type.Literal("rule"),
					Type.Literal("unmatched"),
					Type.Literal("approval"),
					Type.Literal("usage"),
					Type.Literal("connection"),
					Type.Literal("ceiling"),
					Type.Literal("listing"),
				]),
				ruleId: Type.Optional(Type.String()),
				approvalId: Type.Optional(Type.String()),
			}),
		),
		outcome: Type.Union([Type.Literal("allowed"), Type.Literal("denied"), Type.Literal("held")]),
		reason: optionalString("Why it was refused or held."),
		response: Type.Optional(
			Type.Object({
				status: Type.Optional(Type.Integer()),
				contentType: Type.Optional(Type.String()),
				bytes: Type.Integer(),
				ms: Type.Integer(),
				failed: Type.Optional(Type.Boolean()),
			}),
		),
		approval: Type.Optional(
			Type.Object({
				proposalId: Type.String(),
				status: Type.Union([
					Type.Literal("pending"),
					Type.Literal("approved"),
					Type.Literal("denied"),
					Type.Literal("expired"),
					Type.Literal("withdrawn"),
				]),
			}),
		),
	},
	{
		title: "ConnectionCallDetails",
		description:
			"Which connection a call used, as whose account, what it did, what decided it and how the service answered. Never a credential.",
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
		images: Type.Optional(
			Type.Array(ToolImage, {
				description: "Images the call returned, in order, such as a browser's screenshot of the page it is on.",
			}),
		),
		files: Type.Optional(
			Type.Array(PresentedFile, {
				description:
					"The files the call presented to the person (`present_files`; `create_document` its document; `generate_image` the images it made), the most relevant first.",
			}),
		),
		tier: Type.Optional(Type.Union([Type.Literal("isolate"), Type.Literal("container")])),
		connection: Type.Optional(ConnectionCallDetails),
		connectionCalls: Type.Optional(
			Type.Array(ConnectionCallDetails, {
				description: "For a `codemode` script: the connection calls it made, in order, under their inner call IDs.",
			}),
		),
		endedAt: Type.Optional(Timestamp),
	},
	{ title: "ToolItem" },
);

/** A connection approval card's fields after its `type`, shared by the card and its deprecated alias. */
const connectionApprovalFields = {
	proposalId: Type.String({ description: "The connection request's ID." }),
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
	request: Type.Optional(
		Type.Object(
			{
				connectionId: Type.String(),
				connectionName: Type.String(),
				kind: Type.Union([Type.Literal("http"), Type.Literal("mcp_call"), Type.Literal("mcp_tools")]),
				method: Type.String(),
				url: Type.String({ description: "The URL as it will be sent, query included." }),
				tool: Type.Optional(Type.String({ description: "For an MCP tool call: the tool." })),
				digest: Type.String({ description: "The exact request's digest: only an identical request matches it." }),
			},
			{
				title: "ConnectionApprovalRequest",
				description:
					"For an approval of one exact request a rule asked about (#333). Its headers and body are on the connection request page.",
			},
		),
	),
	callId: Type.Optional(
		Type.String({
			description:
				"The tool call waiting on this approval: a connection call's `callId`, or for a request a `codemode` script made, the script's inner call (`<scriptCallId>/<key>`, such as `toolu_01/c9`). A client that renders that call may show the approval in it and leave this card out; one that doesn't still has the card. Absent on cards written before it.",
		}),
	),
};

export const ConnectionApprovalCard = Type.Object(
	{ type: Type.Literal("connection.approval"), ...connectionApprovalFields },
	{
		title: "ConnectionApprovalCard",
		description:
			"A connection request waiting on a person: a credential an agent asked to use. The secret is never part of it.",
	},
);

/** The same card under its old type, kept for one release (#324). */
export const VaultApprovalCard = Type.Object(
	{ type: Type.Literal("vault.approval"), ...connectionApprovalFields },
	{
		title: "VaultApprovalCard",
		description:
			"A `ConnectionApprovalCard` under its old type, `vault.approval`, as transcripts written before the rename carry it. Deprecated: a reader takes both types for one release.",
		deprecated: true,
	},
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
		callId: Type.Optional(
			Type.String({
				description:
					"The `browser_request` call waiting on a person: for a code mode script's request, its inner call " +
					"(`<scriptCallId>/<key>`). A person answers it with `POST /browser/decisions`.",
			}),
		),
		sites: Type.Optional(Type.Array(Type.String(), { description: "The sites the agent asked for." })),
	},
	{
		title: "BrowserGrantCard",
		description:
			"An agent's request for a browser that a code mode script made: the transcript carries it while the call waits, " +
			"and settles it when the call returns (`denied` also when no one answered).",
	},
);

export const Card = Type.Union([ConnectionApprovalCard, VaultApprovalCard, QuestionCard, BrowserGrantCard], {
	title: "Card",
});

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
			"One frame of `@kantel/protocol`: `hello`, then a `snapshot` (or the deltas after the client's cursor), then " +
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
