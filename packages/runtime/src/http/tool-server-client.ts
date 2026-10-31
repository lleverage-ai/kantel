/**
 * Tool servers in the session API client (docs/design/private-mcp-tools.md, section 5), while they are experimental:
 * the `/v1/tool-servers` registry over HTTP, `serve()`, which opens a server's tunnel in-process and serves a host's
 * tools or an MCP server object on it, and host tools served through a tunnel, the `tunnel` host transport.
 *
 * The tunnel itself is `@kantel/tunnel`'s `openTunnel()`, given to the client as `tunnels`: this directory imports
 * only `@kantel/contracts`, and the tunnel needs a WebSocket client that can send headers, which a browser's can't.
 */
import {
	type CallContext,
	type CreatedToolServer,
	type CreateToolServerInput,
	type HostToolDefinition,
	type HostToolHandler,
	type IssuedToolServerToken,
	KantelError,
	type Page,
	type PageRequest,
	type Subscription,
	type ToolServer,
	type ToolServerFilter,
	type ToolServerId,
	type ToolServers,
	type ToolServerToken,
	type ToolServerTokenId,
	type ToolServerTools,
	type ToolServerUpdate,
	toolServerNameProblem,
} from "@kantel/contracts";
import {
	hostToolServer,
	isMcpServerLike,
	type McpServerLike,
	mcpServerEndpoint,
	type ToolServerEndpoint,
} from "./tool-server.ts";

/** A tunnel's state: `TunnelStatus` in `@kantel/tunnel`. */
export type ToolServerTunnelStatus =
	| { readonly state: "connecting" }
	| { readonly state: "connected" }
	| { readonly state: "reconnecting"; readonly delayMs: number; readonly reason: string }
	/** `fatal` when Kantel said to stop (a revoked token, a removed server); not when `close()` stopped it. */
	| { readonly state: "stopped"; readonly reason: string; readonly fatal: boolean };

/** What the client asks of a tunnel: `OpenTunnelOptions` in `@kantel/tunnel`, less its timings. */
export interface ToolServerTunnelOptions {
	/** Kantel's origin, from the client's `baseUrl`. */
	readonly harbour: string;
	readonly serverId: ToolServerId;
	/** A tunnel token of the server, `hbt_…`. */
	readonly token: string;
	readonly endpoint: ToolServerEndpoint;
	/** Sent with the upgrade: the client's credential headers other than `authorization`, such as Access's. */
	readonly headers?: { readonly [name: string]: string };
	readonly onStatus?: (status: ToolServerTunnelStatus) => void;
}

export interface OpenedToolServerTunnel {
	close(): Promise<void>;
	readonly status: ToolServerTunnelStatus;
}

/** Opens a Kantel tunnel: `openTunnel` from `@kantel/tunnel` is one. */
export type ToolServerTunnelOpener = (options: ToolServerTunnelOptions) => OpenedToolServerTunnel;

/** What `serve()` serves: a host's tools and handler, or an MCP server object such as the MCP SDK's `McpServer`. */
export type InProcessToolServer =
	| { readonly tools: readonly HostToolDefinition[]; readonly handler: HostToolHandler }
	| McpServerLike;

export interface ServeToolServerOptions {
	/** A tunnel token of the server. Without one the client makes one (operator on the owner) and revokes it on close. */
	readonly token?: string;
	readonly onStatus?: (status: ToolServerTunnelStatus) => void;
	/** How long to wait for Kantel to take the server's tools before giving up. Default 30 s. */
	readonly readyTimeoutMs?: number;
}

/** A tool server served in-process. Closing it closes the tunnel, so the server goes offline. */
export interface ServedToolServer extends Subscription {
	/** The server as Kantel had it once it was connected, with the tools it took. */
	readonly server: ToolServer;
	readonly status: ToolServerTunnelStatus;
}

/** The registry over HTTP, and `serve()`. */
export interface ToolServerClient extends ToolServers {
	/**
	 * Opens `serverId`'s tunnel in-process and serves `server` on it. Settles once Kantel has connected and taken the
	 * server's tools, so a session made after it is offered them; rejects if the tunnel is refused or isn't ready in
	 * time. Needs the client's `tunnels`.
	 */
	serve(
		ctx: CallContext,
		serverId: ToolServerId,
		server: InProcessToolServer,
		options?: ServeToolServerOptions,
	): Promise<ServedToolServer>;
}

type Call = <T>(ctx: CallContext, method: string, path: string, body?: unknown) => Promise<T>;

export interface ToolServerClientOptions {
	/** The API's base URL, `…/v1`. */
	readonly baseUrl: string;
	readonly call: Call;
	/** The client's credential headers for `ctx`. */
	readonly credentials: (
		ctx: CallContext,
	) => { readonly [name: string]: string } | Promise<{ readonly [name: string]: string }>;
	readonly tunnels?: ToolServerTunnelOpener;
}

const segment = encodeURIComponent;
const READY_POLL_MS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createToolServerClient(options: ToolServerClientOptions): ToolServerClient {
	const { call } = options;
	const path = (id: ToolServerId, rest = "") => `/tool-servers/${segment(id)}${rest}`;

	const registry: ToolServers = {
		create: (ctx, input) => call<CreatedToolServer>(ctx, "POST", "/tool-servers", input),
		get: (ctx, id) => call<ToolServer>(ctx, "GET", path(id)),
		list(ctx, filter?: ToolServerFilter, page?: PageRequest) {
			const params = new URLSearchParams();
			if (filter?.projectId !== undefined) params.set("projectId", filter.projectId);
			if (page?.limit !== undefined) params.set("limit", String(page.limit));
			if (page?.cursor !== undefined) params.set("cursor", page.cursor);
			const query = params.toString();
			return call<Page<ToolServer>>(ctx, "GET", `/tool-servers${query === "" ? "" : `?${query}`}`);
		},
		update: (ctx, id, change: ToolServerUpdate) => call<ToolServer>(ctx, "PATCH", path(id), change),
		remove: (ctx, id) => call<void>(ctx, "DELETE", path(id)),
		createToken: (ctx, id) => call<IssuedToolServerToken>(ctx, "POST", path(id, "/tokens"), {}),
		async listTokens(ctx, id) {
			return (await call<{ items: ToolServerToken[] }>(ctx, "GET", path(id, "/tokens"))).items;
		},
		revokeToken: (ctx, id, tokenId: ToolServerTokenId) =>
			call<void>(ctx, "DELETE", path(id, `/tokens/${segment(tokenId)}`)),
		tools: (ctx, id) => call<ToolServerTools>(ctx, "GET", path(id, "/tools")),
	};

	/** The credential headers a tunnel's upgrade carries: all but `authorization`, which is the tunnel token's. */
	const upgradeHeaders = async (ctx: CallContext) => {
		const headers: { [name: string]: string } = {};
		for (const [name, value] of Object.entries(await options.credentials(ctx))) {
			if (name.toLowerCase() !== "authorization") headers[name] = value;
		}
		return headers;
	};

	const serve = async (
		ctx: CallContext,
		serverId: ToolServerId,
		server: InProcessToolServer,
		serveOptions: ServeToolServerOptions = {},
	): Promise<ServedToolServer> => {
		const open = options.tunnels;
		if (open === undefined) throw new KantelError("not_supported", "This client opens no tunnels (`tunnels`)");
		const before = await registry.get(ctx, serverId);
		const issued = serveOptions.token === undefined ? await registry.createToken(ctx, serverId) : undefined;
		const token = serveOptions.token ?? (issued as IssuedToolServerToken).secret;
		const endpoint = isMcpServerLike(server)
			? mcpServerEndpoint(server)
			: hostToolServer(server.tools, server.handler, { hostId: before.name });
		let stopped: string | undefined;
		const tunnel = open({
			harbour: new URL(options.baseUrl).origin,
			serverId,
			token,
			endpoint,
			headers: await upgradeHeaders(ctx),
			onStatus(status) {
				if (status.state === "stopped") stopped = status.reason;
				serveOptions.onStatus?.(status);
			},
		});
		let closing: Promise<void> | undefined;
		const close = () => {
			closing ??= (async () => {
				await tunnel.close();
				if (issued !== undefined) {
					await registry.revokeToken(ctx, serverId, issued.token.id).catch((error: unknown) => {
						// The server, and its tokens with it, may be gone already.
						if (!(error instanceof KantelError) || error.code !== "not_found") throw error;
					});
				}
			})();
			return closing;
		};
		// Ready once Kantel shows this connection: connected, since a time other than the one it had before. Kantel
		// marks a server connected only when it has initialised it and taken its tools.
		const deadline = Date.now() + (serveOptions.readyTimeoutMs ?? 30_000);
		const earlier = before.connection.status === "connected" ? before.connection.connectedAt : undefined;
		try {
			for (;;) {
				if (stopped !== undefined) {
					throw new KantelError("unavailable", `The tunnel for tool server ${before.name} stopped: ${stopped}`);
				}
				if (tunnel.status.state === "connected") {
					const now = await registry.get(ctx, serverId);
					const { connection } = now;
					if (connection.status === "connected" && connection.connectedAt !== earlier) {
						return {
							server: now,
							close,
							get status() {
								return tunnel.status;
							},
						};
					}
				}
				if (Date.now() >= deadline) {
					throw new KantelError("unavailable", `Tool server ${before.name} didn't connect in time`);
				}
				await sleep(READY_POLL_MS);
			}
		} catch (error) {
			await close().catch(() => undefined);
			throw error;
		}
	};

	return { ...registry, serve };
}

/** A host's tools served through its own tool server, as `hostTools.register` does with the `tunnel` transport. */
export interface TunnelHostTools {
	register(
		ctx: CallContext,
		hostId: string,
		tools: readonly HostToolDefinition[],
		handler: HostToolHandler,
	): Promise<Subscription>;
	list(ctx: CallContext, hostId: string): Promise<readonly HostToolDefinition[]>;
}

/** The server named `name` that the caller can see from `projectId`, or undefined. */
async function findByName(client: ToolServerClient, ctx: CallContext, name: string): Promise<ToolServer | undefined> {
	let cursor: string | undefined;
	for (;;) {
		const page = await client.list(
			ctx,
			ctx.projectId === undefined ? {} : { projectId: ctx.projectId },
			cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
		);
		const found = page.items.find((server) => server.name === name);
		if (found !== undefined || page.nextCursor === undefined) return found;
		cursor = page.nextCursor;
	}
}

/**
 * Host tools over a tunnel: the host's ID is its tool server's name, so a profile names its tools `<hostId>/<tool>`
 * (or `<hostId>/*`) and the model sees `<hostId>__<tool>`. Registering makes the server, owned by `ctx.projectId`'s
 * project (or the organisation), when there is none yet (admin on the owner), else makes a new token for the one
 * there is (operator), so an operator's key serves a server an admin made for it; and
 * serves the tools on its tunnel until the subscription is closed. Closing removes a server this registration made,
 * while it is still the latest registration of the host here, and otherwise revokes its token.
 */
export function createTunnelHostTools(client: ToolServerClient): TunnelHostTools {
	/**
	 * Each host's latest registration in this client, so registering again replaces it rather than racing it, and whether
	 * this client made the host's server, so the last registration removes it.
	 */
	const current = new Map<string, { readonly close: () => Promise<void>; readonly serverId: string; made: boolean }>();

	return {
		async register(ctx, hostId, tools, handler) {
			const problem = toolServerNameProblem(hostId);
			if (problem !== undefined) {
				throw new KantelError("invalid", `With the tunnel transport a host's ID is its tool server's name: ${problem}`);
			}
			const input: CreateToolServerInput = {
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				name: hostId,
				description: `Host tools of ${hostId}`,
				transport: "tunnel",
			};
			let server: ToolServer;
			let issued: IssuedToolServerToken;
			let made = false;
			try {
				const created = await client.create(ctx, input);
				if (created.token === undefined) throw new KantelError("unavailable", "The tunnel server came without a token");
				server = created.server;
				issued = created.token;
				made = true;
			} catch (error) {
				// Taken, or the caller may not make servers (operator, not admin): one made earlier still serves.
				if (!(error instanceof KantelError) || (error.code !== "conflict" && error.code !== "forbidden")) throw error;
				const found = await findByName(client, ctx, hostId);
				if (found === undefined && error.code === "forbidden") {
					throw new KantelError(
						"forbidden",
						`There is no tool server ${hostId} yet, and making one needs admin on its owner: ${error.message}`,
					);
				}
				if (found === undefined || found.projectId !== ctx.projectId) {
					throw new KantelError("conflict", `Another owner's tool server is named ${hostId}`);
				}
				server = found;
				issued = await client.createToken(ctx, server.id);
			}
			// One tunnel per host in this client: a newer one would take over the older, which would take it back. The
			// older stops being the latest first, so closing it leaves the server, which this one takes over.
			const older = current.get(hostId);
			if (older !== undefined) {
				current.delete(hostId);
				if (older.made && older.serverId === server.id) made = true;
				older.made = false;
				await older.close().catch(() => undefined);
			}
			let served: ServedToolServer;
			try {
				served = await client.serve(ctx, server.id, { tools, handler }, { token: issued.secret });
			} catch (error) {
				await (made ? client.remove(ctx, server.id) : client.revokeToken(ctx, server.id, issued.token.id)).catch(
					() => undefined,
				);
				throw error;
			}
			let closing: Promise<void> | undefined;
			const registration = {
				serverId: server.id,
				made,
				close(): Promise<void> {
					closing ??= (async () => {
						await served.close();
						const latest = current.get(hostId) === registration;
						if (latest) current.delete(hostId);
						const gone = (error: unknown) => {
							if (!(error instanceof KantelError) || error.code !== "not_found") throw error;
						};
						if (registration.made && latest) await client.remove(ctx, server.id).catch(gone);
						else await client.revokeToken(ctx, server.id, issued.token.id).catch(gone);
					})().catch((error: unknown) => {
						closing = undefined;
						throw error;
					});
					return closing;
				},
			};
			current.set(hostId, registration);
			return registration;
		},
		async list(ctx, hostId) {
			const server = await findByName(client, ctx, hostId);
			if (server === undefined) return [];
			const listed = await client.tools(ctx, server.id);
			return listed.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				replay: tool.replay,
			}));
		},
	};
}
