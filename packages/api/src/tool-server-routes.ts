/**
 * The tool servers API's routes (docs/site/src/content/docs/api/tool-servers.md): the registry of MCP servers Kantel
 * calls for tools, their tunnel tokens and their tools. Experimental: a deployment serves them only with
 * `KANTEL_TOOL_SERVERS=experimental`, and answers 404 without it.
 *
 * The tunnel itself, `GET /v1/tool-servers/{toolServerId}/connect`, is a WebSocket the server's side dials with
 * `Authorization: Bearer hbt_…`, not a JSON route, so it isn't here: the protocol is written down in
 * `@kantel/tools/protocol`, and docs/site/src/content/docs/api/tool-servers.md says how to open one.
 */
import { defineRoute } from "./route.ts";
import {
	CreatedToolServer,
	CreateToolServerBody,
	IssuedToolServerToken,
	ListToolServersQuery,
	ToolServer,
	ToolServerPage,
	ToolServerPath,
	ToolServerTokenList,
	ToolServerTokenPath,
	ToolServerTools,
	UpdateToolServerBody,
} from "./tool-servers-schema.ts";

const tag = "tool-servers";
const EXPERIMENTAL = "Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`.";
const readErrors = ["invalid", "forbidden", "not_found"] as const;
const changeErrors = ["invalid", "forbidden", "not_found", "conflict"] as const;

export const listToolServers = defineRoute({
	operationId: "listToolServers",
	method: "GET",
	path: "/tool-servers",
	tag,
	summary: "List tool servers",
	description: `The tool servers the caller may read, by name: the organisation's and its projects'. ${EXPERIMENTAL}`,
	query: ListToolServersQuery,
	answer: { status: 200, description: "A page of tool servers.", schema: ToolServerPage },
	errors: ["invalid", "forbidden"],
});

export const createToolServer = defineRoute({
	operationId: "createToolServer",
	method: "POST",
	path: "/tool-servers",
	tag,
	summary: "Register a tool server",
	description:
		"Registers an MCP server for the organisation or one of its projects; needs admin on the owner. The name is unique " +
		"in the organisation (`conflict` otherwise). A `tunnel` server comes with its first tunnel token, shown in this " +
		`answer only. Only \`tunnel\` is accepted yet. ${EXPERIMENTAL}`,
	body: CreateToolServerBody,
	answer: { status: 201, description: "The server, and its first token.", schema: CreatedToolServer },
	errors: changeErrors,
});

export const getToolServer = defineRoute({
	operationId: "getToolServer",
	method: "GET",
	path: "/tool-servers/{toolServerId}",
	tag,
	summary: "Get a tool server",
	description: `The server, whether its side is connected, and its latest tools. ${EXPERIMENTAL}`,
	params: ToolServerPath,
	answer: { status: 200, description: "The server.", schema: ToolServer },
	errors: readErrors,
});

export const updateToolServer = defineRoute({
	operationId: "updateToolServer",
	method: "PATCH",
	path: "/tool-servers/{toolServerId}",
	tag,
	summary: "Change a tool server",
	description:
		"Its description, or which tools are disabled. A disabled tool isn't offered to new sessions; one a session was " +
		"offered already stays in its list, which never changes under it, and its calls answer an error result. Needs " +
		`admin on the owner. ${EXPERIMENTAL}`,
	params: ToolServerPath,
	body: UpdateToolServerBody,
	answer: { status: 200, description: "The server.", schema: ToolServer },
	errors: changeErrors,
});

export const removeToolServer = defineRoute({
	operationId: "removeToolServer",
	method: "DELETE",
	path: "/tool-servers/{toolServerId}",
	tag,
	summary: "Remove a tool server",
	description: `Removes the server and its tokens and closes its tunnel. Needs admin on the owner. ${EXPERIMENTAL}`,
	params: ToolServerPath,
	answer: { status: 204, description: "Removed." },
	errors: readErrors,
});

export const listToolServerTokens = defineRoute({
	operationId: "listToolServerTokens",
	method: "GET",
	path: "/tool-servers/{toolServerId}/tokens",
	tag,
	summary: "List a tool server's tunnel tokens",
	description: `Each token's ID, prefix and when it was made and last used; never the token. ${EXPERIMENTAL}`,
	params: ToolServerPath,
	answer: { status: 200, description: "The tokens.", schema: ToolServerTokenList },
	errors: readErrors,
});

export const createToolServerToken = defineRoute({
	operationId: "createToolServerToken",
	method: "POST",
	path: "/tool-servers/{toolServerId}/tokens",
	tag,
	summary: "Make a tunnel token",
	description:
		"A new tunnel token, `hbt_…`, shown in this answer only; Kantel keeps its hash. Older tokens keep working until " +
		`revoked. Needs operator on the owner. ${EXPERIMENTAL}`,
	params: ToolServerPath,
	answer: { status: 201, description: "The token, with its secret.", schema: IssuedToolServerToken },
	errors: readErrors,
});

export const revokeToolServerToken = defineRoute({
	operationId: "revokeToolServerToken",
	method: "DELETE",
	path: "/tool-servers/{toolServerId}/tokens/{tokenId}",
	tag,
	summary: "Revoke a tunnel token",
	description: `Revokes the token and closes any tunnel it opened. Needs operator on the owner. ${EXPERIMENTAL}`,
	params: ToolServerTokenPath,
	answer: { status: 204, description: "Revoked." },
	errors: readErrors,
});

export const getToolServerTools = defineRoute({
	operationId: "getToolServerTools",
	method: "GET",
	path: "/tool-servers/{toolServerId}/tools",
	tag,
	summary: "Get a tool server's tools",
	description:
		"The latest snapshot of the server's `tools/list`, each tool with whether it is enabled, the name the model sees " +
		`(\`<server>__<tool>\`), and why a session couldn't be offered it, such as a name too long. ${EXPERIMENTAL}`,
	params: ToolServerPath,
	answer: { status: 200, description: "The server's tools.", schema: ToolServerTools },
	errors: readErrors,
});

export const toolServerRoutes = {
	listToolServers,
	createToolServer,
	getToolServer,
	updateToolServer,
	removeToolServer,
	listToolServerTokens,
	createToolServerToken,
	revokeToolServerToken,
	getToolServerTools,
} as const;
