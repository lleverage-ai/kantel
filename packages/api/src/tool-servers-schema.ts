/**
 * The tool servers API's wire shapes (docs/design/private-mcp-tools.md, section 5), each mirroring a type in
 * `@kantel/contracts`'s `tool-servers.ts`. `test/types.test.ts` checks that each matches its contract type. The only
 * shape that carries a secret is `IssuedToolServerToken`, the one answer that shows a tunnel token.
 */
import Type from "typebox";
import { Actor, JsonValue, Timestamp } from "./schema.ts";

const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }));
const cursor = Type.Optional(Type.String({ description: "A previous page's `nextCursor`." }));
const nextCursor = Type.Optional(Type.String({ description: "Present when more items follow." }));

export const ToolServerTransport = Type.Union(
	[Type.Literal("tunnel"), Type.Literal("http"), Type.Literal("callback")],
	{
		title: "ToolServerTransport",
		description:
			"How Kantel reaches the server: `tunnel`, the server's side dials out over a WebSocket; `http`, Streamable HTTP " +
			"to a public URL; `callback`, signed HTTPS host callbacks. Only `tunnel` is built yet.",
	},
);

const ReplayPolicy = Type.Union([Type.Literal("safe"), Type.Literal("idempotent"), Type.Literal("unsafe")], {
	title: "ReplayPolicy",
	description: "How a tool call may be repeated after a crash.",
});

export const ToolServerToolAnnotations = Type.Object(
	{
		title: Type.Optional(Type.String()),
		readOnlyHint: Type.Optional(Type.Boolean()),
		destructiveHint: Type.Optional(Type.Boolean()),
		idempotentHint: Type.Optional(Type.Boolean()),
		openWorldHint: Type.Optional(Type.Boolean()),
	},
	{ title: "ToolServerToolAnnotations", description: "MCP's tool annotations, as the server gave them. Hints only." },
);

const toolFields = {
	name: Type.String({ description: "The server's own name for the tool, as `tools/call` takes it." }),
	description: Type.String(),
	inputSchema: Type.Record(Type.String(), JsonValue, { description: "The tool's input, a JSON Schema object." }),
	annotations: Type.Optional(ToolServerToolAnnotations),
	replay: ReplayPolicy,
};

export const ToolServerTool = Type.Object(toolFields, {
	title: "ToolServerTool",
	description: "One tool as the server listed it in `tools/list`.",
});

export const ToolServerSnapshot = Type.Object(
	{
		tools: Type.Array(ToolServerTool),
		hash: Type.String({ description: "`sha256:<hex>` of the tools' canonical JSON." }),
		takenAt: Timestamp,
	},
	{ title: "ToolServerSnapshot", description: "The server's tools as Kantel last took them." },
);

export const ToolServerConnection = Type.Object(
	{
		status: Type.Union([Type.Literal("connected"), Type.Literal("offline")]),
		connectedAt: Type.Optional(Timestamp),
		lastSeenAt: Type.Optional(Timestamp),
		serverInfo: Type.Optional(Type.Object({ name: Type.String(), version: Type.Optional(Type.String()) })),
	},
	{ title: "ToolServerConnection", description: "Whether the server's side is connected now." },
);

export const ToolServer = Type.Object(
	{
		id: Type.String({ minLength: 1, description: "The tool server's ID, `ts_…`." }),
		organisationId: Type.String(),
		projectId: Type.Optional(
			Type.String({ description: "The owning project; absent for a server the organisation owns." }),
		),
		name: Type.String({
			description: "A slug, unique in the organisation: the `<server>` in the tool names the model sees.",
		}),
		description: Type.Optional(Type.String({ description: "What it is for, for people; never sent to a model." })),
		transport: ToolServerTransport,
		snapshot: Type.Optional(ToolServerSnapshot),
		disabledTools: Type.Array(Type.String(), { description: "Tools sessions are not offered." }),
		connection: ToolServerConnection,
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{
		title: "ToolServer",
		description: "An MCP server Kantel calls for tools, owned by an organisation or one of its projects.",
	},
);

export const ToolServerPage = Type.Object({ items: Type.Array(ToolServer), nextCursor }, { title: "ToolServerPage" });

export const ToolServerToken = Type.Object(
	{
		id: Type.String({ description: "The token's ID, `tst_…`." }),
		toolServerId: Type.String(),
		prefix: Type.String({ description: "The token's first characters (`hbt_` and four more)." }),
		createdBy: Actor,
		createdAt: Timestamp,
		lastUsedAt: Type.Optional(Timestamp),
	},
	{ title: "ToolServerToken", description: "A tunnel token as reads show it: never the token itself." },
);

export const ToolServerTokenList = Type.Object(
	{ items: Type.Array(ToolServerToken) },
	{ title: "ToolServerTokenList" },
);

export const IssuedToolServerToken = Type.Object(
	{
		token: ToolServerToken,
		secret: Type.String({ description: "`hbt_…`. Shown once, in this answer; Kantel keeps only its hash." }),
	},
	{ title: "IssuedToolServerToken", description: "A tunnel token just made: the only time its secret is given." },
);

export const CreatedToolServer = Type.Object(
	{ server: ToolServer, token: Type.Optional(IssuedToolServerToken) },
	{ title: "CreatedToolServer", description: "A new server, and for a tunnel its first token." },
);

export const CreateToolServerBody = Type.Object({
	projectId: Type.Optional(
		Type.String({ description: "The owning project; leave it out for a server the organisation owns." }),
	),
	name: Type.String({
		description: "Lower-case letters, digits and single hyphens, at most 32 characters. Can't be changed.",
	}),
	description: Type.Optional(Type.String()),
	transport: ToolServerTransport,
});

export const UpdateToolServerBody = Type.Object({
	description: Type.Optional(Type.String()),
	disabledTools: Type.Optional(Type.Array(Type.String(), { description: "Replaces the disabled list." })),
});

export const ListToolServersQuery = Type.Object({
	projectId: Type.Optional(
		Type.String({ description: "Only this project's servers and the organisation's: what its sessions could see." }),
	),
	limit,
	cursor,
});

export const ToolServerPath = Type.Object({ toolServerId: Type.String({ minLength: 1 }) });

export const ToolServerTokenPath = Type.Object({
	toolServerId: Type.String({ minLength: 1 }),
	tokenId: Type.String({ minLength: 1 }),
});

export const ToolServerToolView = Type.Object(
	{
		...toolFields,
		enabled: Type.Boolean(),
		modelName: Type.String({ description: "`<server>__<tool>`: the name the model sees." }),
		unavailableReason: Type.Optional(
			Type.String({ description: "Why a session can't be offered it although it may be enabled." }),
		),
	},
	{ title: "ToolServerToolView", description: "One tool of a server's snapshot, with what a session would see." },
);

export const ToolServerTools = Type.Object(
	{
		toolServerId: Type.String(),
		hash: Type.Optional(Type.String()),
		takenAt: Type.Optional(Timestamp),
		tools: Type.Array(ToolServerToolView),
	},
	{ title: "ToolServerTools", description: "A server's latest snapshot, with what is enabled." },
);
