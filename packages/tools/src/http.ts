/**
 * The tool servers API's routes (`@harbour/api`'s `toolServerRoutes`) over a `ToolServersService`. The tunnel,
 * `GET /v1/tool-servers/{id}/connect`, is a WebSocket upgrade the host serves itself, so this answers `undefined` for
 * it as for any path that isn't its own. Who the caller is stays the host's job (`authenticate`).
 */
import { createRouter, STATUS_BY_CODE, toolServerRoutes } from "@harbour/api";
import { type CallContext, isHarbourError } from "@harbour/contracts";
import type { ToolServersService } from "./service.ts";

export interface ToolServersApiOptions {
	readonly toolServers: ToolServersService;
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

export interface ToolServersApi {
	/** Answers a tool servers route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

export const TOOL_SERVERS_BODY_LIMIT = 64 * 1024;

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

export function toolServersErrorResponse(error: unknown): Response {
	if (isHarbourError(error)) {
		return json(
			{
				error: {
					code: error.code,
					message: error.message,
					...(error.details === undefined ? {} : { details: error.details }),
				},
			},
			STATUS_BY_CODE[error.code],
		);
	}
	return json({ error: { code: "unavailable", message: "The tool servers API failed" } }, 500);
}

/** Whether `path` is under `/v1/tool-servers`, the tunnel's path included. */
export function isToolServersPath(path: string, basePath = "/v1"): boolean {
	const under = `${basePath.replace(/\/+$/, "")}/tool-servers`;
	return path === under || path.startsWith(`${under}/`);
}

/** The server ID of a tunnel's path (`/v1/tool-servers/{id}/connect`), or undefined for any other path. */
export function tunnelServerId(path: string, basePath = "/v1"): string | undefined {
	const prefix = `${basePath.replace(/\/+$/, "")}/tool-servers/`;
	if (!path.startsWith(prefix) || !path.endsWith("/connect")) return undefined;
	const encoded = path.slice(prefix.length, -"/connect".length);
	if (encoded.length === 0 || encoded.includes("/")) return undefined;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return undefined;
	}
}

export function createToolServersApi(options: ToolServersApiOptions): ToolServersApi {
	const { toolServers } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		toolServerRoutes,
		{
			listToolServers: (ctx: CallContext, { query }) =>
				toolServers.list(ctx, query.projectId === undefined ? {} : { projectId: query.projectId }, {
					...(query.limit === undefined ? {} : { limit: query.limit }),
					...(query.cursor === undefined ? {} : { cursor: query.cursor }),
				}),
			createToolServer: (ctx: CallContext, { body }) => toolServers.create(ctx, body),
			getToolServer: (ctx: CallContext, { params }) => toolServers.get(ctx, params.toolServerId),
			updateToolServer: (ctx: CallContext, { params, body }) => toolServers.update(ctx, params.toolServerId, body),
			removeToolServer: async (ctx: CallContext, { params }) => {
				await toolServers.remove(ctx, params.toolServerId);
				return undefined;
			},
			listToolServerTokens: async (ctx: CallContext, { params }) => ({
				items: await toolServers.listTokens(ctx, params.toolServerId),
			}),
			createToolServerToken: (ctx: CallContext, { params }) => toolServers.createToken(ctx, params.toolServerId),
			revokeToolServerToken: async (ctx: CallContext, { params }) => {
				await toolServers.revokeToken(ctx, params.toolServerId, params.tokenId);
				return undefined;
			},
			getToolServerTools: (ctx: CallContext, { params }) => toolServers.tools(ctx, params.toolServerId),
		},
		{ basePath, maxBodyBytes: TOOL_SERVERS_BODY_LIMIT },
	);

	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (!isToolServersPath(path, basePath) || tunnelServerId(path, basePath) !== undefined) return undefined;
			try {
				const ctx = await options.authenticate(request);
				const answered = await router(ctx, request);
				if (answered !== undefined) return answered;
				return json({ error: { code: "not_found", message: "No such route" } }, 404);
			} catch (error) {
				return toolServersErrorResponse(error);
			}
		},
	};
}
