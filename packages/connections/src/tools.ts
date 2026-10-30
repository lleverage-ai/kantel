/**
 * The session's connection tools. They run on the host, not in the sandbox: the credential is added by the
 * connections service on the way out (the vault opens it for the request's host only) and cut out of the answer, so
 * the agent never sees it, on Cloudflare (whose isolates have no network) and self-hosted alike.
 *
 * - `connections_list`: the connections this session may use (`connectionUsableIn`), most specific owner first.
 * - `connection_tools`: a remote MCP connection's tools.
 * - `connection_call`: calls one of them.
 * - `connection_request`: one HTTP request to an API connection's hosts.
 *
 * Every use is recorded against the session and the tool call (`ConnectionUse`), with the session's audience then.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
	type ConnectionSessionScope,
	type HttpMethod,
	isHarbourError,
	type SessionAudience,
	type SessionRecord,
	systemContext,
} from "@harbour/contracts";
import type { ConnectionsService } from "./service.ts";

const CONTEXT = systemContext("connections");

/** The tools' names, for a profile's `tools`. */
export const CONNECTION_TOOL_NAMES = [
	"connections_list",
	"connection_tools",
	"connection_call",
	"connection_request",
] as const;
const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
/** The most text a tool result carries back to the model. */
const TEXT_LIMIT = 60_000;

export interface ConnectionToolsOptions {
	readonly connections: ConnectionsService;
	/**
	 * Who can see a session. Default: `private` to its acting person when `personal` is set (a deployment with one
	 * person, such as a personal agent), otherwise `shared`. A deployment that knows better passes its own.
	 */
	readonly audienceOf?: (record: SessionRecord) => SessionAudience;
	/** Every session acting for a person is that person's alone. */
	readonly personal?: boolean;
}

type Content = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

const clip = (text: string) =>
	text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT)}\n[cut: ${text.length - TEXT_LIMIT} more characters]`;

const failure = (error: unknown) => ({
	output: [
		{
			type: "text" as const,
			text: isHarbourError(error) ? `${error.code}: ${error.message}` : "The connection call failed",
		},
	],
	isError: true,
});

/** The scope a session's connection calls are checked against. Never from the model's arguments. */
export function sessionScope(record: SessionRecord, audience: SessionAudience): ConnectionSessionScope {
	return {
		organisationId: record.organisationId,
		...(record.projectId === undefined ? {} : { projectId: record.projectId }),
		sessionId: record.id,
		agentId: record.agentId,
		...(record.userId === undefined ? {} : { actingUserId: record.userId }),
		audience,
	};
}

export function connectionTools(options: ConnectionToolsOptions): (record: SessionRecord) => ToolRegistration[] {
	const { connections } = options;
	const audienceOf =
		options.audienceOf ??
		((record: SessionRecord): SessionAudience =>
			options.personal === true && record.userId !== undefined
				? { kind: "private", userId: record.userId }
				: { kind: "shared" });

	return (record) => {
		const scope = () => sessionScope(record, audienceOf(record));
		const list = defineTool({
			name: "connections_list",
			description:
				"List the connections (outside services and remote MCP servers someone connected) this session may use. " +
				"Use connection_tools and connection_call for an MCP connection, connection_request for an API connection. " +
				"Credentials are added for you; never ask for or handle a token.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => {
				try {
					const usable = await connections.usable(CONTEXT, scope());
					const text =
						usable.length === 0
							? "No connections are available to this session."
							: JSON.stringify(
									usable.map((connection) => ({
										id: connection.id,
										name: connection.name,
										kind: connection.kind,
										owner: connection.owner,
										...(connection.templateId === undefined ? {} : { template: connection.templateId }),
										...(connection.account === undefined ? {} : { account: connection.account }),
										hosts: connection.hosts,
									})),
									null,
									2,
								);
					return { output: [{ type: "text" as const, text }], isError: false };
				} catch (error) {
					return failure(error);
				}
			},
		});

		const tools = defineTool({
			name: "connection_tools",
			description: "List the tools a remote MCP connection offers, with their input schemas.",
			parameters: Type.Object({ connectionId: Type.String({ description: "From connections_list." }) }),
			replay: "safe",
			execute: async (args, api) => {
				try {
					const found = await connections.listTools(CONTEXT, scope(), args.connectionId, { toolCallId: api.callId });
					const text = JSON.stringify(
						found.map((tool) => ({
							name: tool.name,
							...(tool.description === undefined ? {} : { description: tool.description }),
							...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
							...(tool.annotations?.readOnlyHint === undefined ? {} : { readOnly: tool.annotations.readOnlyHint }),
						})),
					);
					return { output: [{ type: "text" as const, text: clip(text) }], isError: false };
				} catch (error) {
					return failure(error);
				}
			},
		});

		const call = defineTool({
			name: "connection_call",
			description:
				"Call one tool on a remote MCP connection. Get its name and input schema from connection_tools first.",
			parameters: Type.Object({
				connectionId: Type.String({ description: "From connections_list." }),
				tool: Type.String({ description: "The tool's name, from connection_tools." }),
				arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The tool's arguments." })),
			}),
			replay: "unsafe",
			execute: async (args, api) => {
				try {
					const result = await connections.callTool(CONTEXT, scope(), args.connectionId, {
						name: args.tool,
						arguments: args.arguments ?? {},
						toolCallId: api.callId,
					});
					const content: Content[] = [];
					for (const item of result.content) {
						const part = item as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown };
						if (part.type === "text" && typeof part.text === "string")
							content.push({ type: "text", text: clip(part.text) });
						else if (part.type === "image" && typeof part.mimeType === "string" && typeof part.data === "string") {
							content.push({ type: "image", mimeType: part.mimeType, data: part.data });
						} else content.push({ type: "text", text: clip(JSON.stringify(item)) });
					}
					if (content.length === 0 && result.structuredContent !== undefined) {
						content.push({ type: "text", text: clip(JSON.stringify(result.structuredContent)) });
					}
					if (content.length === 0) content.push({ type: "text", text: "(no content)" });
					return { output: content, isError: result.isError === true };
				} catch (error) {
					return failure(error);
				}
			},
		});

		const request = defineTool({
			name: "connection_request",
			description:
				"Send one HTTPS request to an API connection's hosts, with its credential added for you. Never put a token in " +
				"the headers.",
			parameters: Type.Object({
				connectionId: Type.String({ description: "From connections_list." }),
				method: Type.Union(METHODS.map((method) => Type.Literal(method))),
				url: Type.String({ description: "An absolute https URL on one of the connection's hosts." }),
				headers: Type.Optional(Type.Record(Type.String(), Type.String())),
				body: Type.Optional(Type.String()),
			}),
			replay: "unsafe",
			execute: async (args, api) => {
				try {
					const response = await connections.send(CONTEXT, scope(), args.connectionId, {
						method: args.method as HttpMethod,
						url: args.url,
						...(args.headers === undefined ? {} : { headers: args.headers }),
						...(args.body === undefined ? {} : { body: args.body }),
						kind: "http",
						toolCallId: api.callId,
					});
					const type = response.headers["content-type"] ?? "";
					const text = `HTTP ${response.status}${type === "" ? "" : ` (${type})`}\n\n${clip(response.body)}`;
					return { output: [{ type: "text" as const, text }], isError: response.status >= 400 };
				} catch (error) {
					return failure(error);
				}
			},
		});

		return [list, tools, call, request] as unknown as ToolRegistration[];
	};
}
