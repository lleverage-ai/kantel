/**
 * `KantelTunnel`: one tool server's tunnel on Cloudflare (docs/design/private-mcp-tools.md, section 2B), one Durable
 * Object per server, named by the server's ID and created with the deployment's location hint, as the stack is. It
 * holds the socket the server's client dialled, with the hibernation API, and runs `TunnelConnection` on it
 * (`src/tunnel.ts`, which says what survives hibernation and what doesn't).
 *
 * Who reaches it: the Worker, with an upgrade it has had the stack check (`src/route.ts`), and the stack, over RPC, to
 * call a tool or close the tunnel (`src/tool-servers.ts`). It reports the server's connection and tools to the stack
 * over RPC. Nothing else can reach a Durable Object, so the grant the Worker forwards is trusted here.
 *
 * Liveness pings are answered by the runtime (`setWebSocketAutoResponse`) without waking the object, so an idle tunnel
 * costs no duration.
 */
import { DurableObject } from "cloudflare:workers";
import type { ToolServerTokenId } from "@kantel/contracts";
import type { ToolServerRef } from "@kantel/tools/links";
import { TUNNEL_PING, TUNNEL_PONG } from "@kantel/tools/protocol";
import { namedObject, type PlacementVars, STACK_NAME } from "./route.ts";
import type { StackTunnelRpc, TunnelCallAnswer, TunnelCallInput } from "./tool-servers.ts";
import { TunnelHolder } from "./tunnel.ts";

export interface TunnelObjectEnv extends PlacementVars {
	readonly STACK: DurableObjectNamespace;
}

/** RFC 6455's code for a socket that ended without a close frame: reported, never sent. */
const ABNORMAL_CLOSE = 1006;

export class KantelTunnelBase extends DurableObject<TunnelObjectEnv> {
	readonly #holder: TunnelHolder<WebSocket>;

	constructor(ctx: DurableObjectState, env: TunnelObjectEnv) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(TUNNEL_PING, TUNNEL_PONG));
		this.#holder = new TunnelHolder<WebSocket>({
			sockets: {
				accept: (socket, tags) => ctx.acceptWebSocket(socket, tags),
				get: (tag) => ctx.getWebSockets(tag),
				tags: (socket) => ctx.getTags(socket),
			},
			kv: ctx.storage.kv,
			stack: () => namedObject(env.STACK, STACK_NAME, env) as unknown as StackTunnelRpc,
			background: (work) => ctx.waitUntil(work),
		});
	}

	override async fetch(request: Request): Promise<Response> {
		return this.#holder.upgrade(request, () => {
			const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
			return { socket: server, response: new Response(null, { status: 101, webSocket: client }) };
		});
	}

	override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		this.#holder.message(socket, message);
	}

	override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
		this.#holder.closed(socket, code, reason);
	}

	override async webSocketError(socket: WebSocket): Promise<void> {
		this.#holder.closed(socket, ABNORMAL_CLOSE, "The tunnel's socket failed");
	}

	/** The stack's call of one of the server's tools. */
	async call(ref: ToolServerRef, input: TunnelCallInput): Promise<TunnelCallAnswer> {
		return this.#holder.call(ref, input);
	}

	/** The stack closing the tunnel: the server removed, or (with `tokenId`) that token revoked. */
	async close(code: number, reason: string, tokenId?: ToolServerTokenId): Promise<void> {
		this.#holder.close(code, reason, tokenId);
	}
}
