/**
 * One tool server's tunnel as its `KantelTunnel` object holds it (`src/tunnel-object.ts`), with the rules
 * `createTunnelHub` keeps self-hosted (`@kantel/tools/hub`): one socket per server, a newer one taking over and the
 * older closed with 4008, only the current socket's close marking the server offline, and a close with a token closing
 * only a socket that token opened.
 *
 * The socket is held with the hibernation API: the object can leave memory while it stays open, and wakes for the
 * socket's next frame or the stack's next call. So what the next instance needs is in the object's storage, not only in
 * memory: which socket is current (by its tag), the grant it was opened with, and the MCP client's state with the last
 * snapshot's hash (`TunnelConnection.state()`), saved after every frame sent. A woken object rebuilds the connection
 * from it and carries on over the same socket without initialising the server again.
 *
 * Calls waiting on an answer are in memory only: the stack's RPC in flight, and the client's timer for each request,
 * keep the object awake until each is answered or times out, so none is lost to hibernation. An eviction (a deploy, a
 * restart) drops the sockets anyway, and the client reconnects.
 *
 * Portable: the object's `ctx` comes in as `HeldSockets` and its synchronous storage, so the tests run it in Node.
 */
import { type Clock, isKantelError, systemClock, type ToolServerTokenId } from "@kantel/contracts";
import { TunnelConnection, type TunnelConnectionState, type TunnelSocket } from "@kantel/tools/connection";
import type { ToolServerRef } from "@kantel/tools/links";
import { TUNNEL_CLOSE_GOING_AWAY, TUNNEL_CLOSE_REPLACED } from "@kantel/tools/protocol";
import type { TunnelGrant } from "@kantel/tools/service";
import type { StackTunnelRpc, TunnelCallAnswer, TunnelCallInput } from "./tool-servers.ts";
import type { SyncKvLike } from "./workspace-heads.ts";

/**
 * The header the Worker forwards a checked upgrade with: the grant the stack gave for the token, as JSON. The Worker
 * sets it after dropping any the client sent, and only the Worker reaches a tunnel object.
 */
export const TUNNEL_GRANT_HEADER = "harbour-tunnel-grant";

export function tunnelGrantHeader(grant: TunnelGrant): string {
	return JSON.stringify({
		organisationId: grant.organisationId,
		toolServerId: grant.toolServerId,
		tokenId: grant.tokenId,
	});
}

/** The grant a forwarded upgrade carries, or undefined when it has none or a malformed one. */
export function tunnelGrantFrom(request: Request): TunnelGrant | undefined {
	const header = request.headers.get(TUNNEL_GRANT_HEADER);
	if (header === null) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(header);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { organisationId, toolServerId, tokenId } = value as { [key: string]: unknown };
	if (typeof organisationId !== "string" || typeof toolServerId !== "string" || typeof tokenId !== "string") {
		return undefined;
	}
	return { organisationId, toolServerId, tokenId };
}

/** The hibernation API's sockets, as the object's `ctx` offers them. */
export interface HeldSockets<Socket> {
	/** `ctx.acceptWebSocket`. */
	accept(socket: Socket, tags: string[]): void;
	/** `ctx.getWebSockets`: every socket still open, or those with `tag`. */
	get(tag?: string): Socket[];
	/** `ctx.getTags`. */
	tags(socket: Socket): string[];
}

export interface TunnelHolderOptions<Socket extends TunnelSocket> {
	readonly sockets: HeldSockets<Socket>;
	/** The object's `ctx.storage.kv`. */
	readonly kv: SyncKvLike;
	/** The stack object, for the server's connection and tools. */
	readonly stack: () => StackTunnelRpc;
	readonly clock?: Clock;
	/** Keeps a report to the stack running after the event that made it (`ctx.waitUntil`). */
	readonly background?: (work: Promise<unknown>) => void;
	/** A new socket's ID, for its tag. Default a random UUID. */
	readonly newId?: () => string;
}

/** What the next instance of the object needs of the current socket. */
interface StoredTunnel {
	readonly connectionId: string;
	readonly grant: TunnelGrant;
	readonly state: TunnelConnectionState;
}

interface Held<Socket> {
	readonly connectionId: string;
	readonly grant: TunnelGrant;
	readonly connection: TunnelConnection;
	readonly socket: Socket;
}

export const TUNNEL_STORAGE_KEY = "tunnel.current";
const connectionTag = (connectionId: string) => `connection:${connectionId}`;
const tokenTag = (tokenId: ToolServerTokenId) => `token:${tokenId}`;
const refOf = (grant: TunnelGrant): ToolServerRef => ({
	organisationId: grant.organisationId,
	toolServerId: grant.toolServerId,
});

const refusal = (status: number, code: string, message: string) =>
	Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });

export class TunnelHolder<Socket extends TunnelSocket> {
	readonly #sockets: HeldSockets<Socket>;
	readonly #kv: SyncKvLike;
	readonly #stack: () => StackTunnelRpc;
	readonly #clock: Clock;
	readonly #background: ((work: Promise<unknown>) => void) | undefined;
	readonly #newId: () => string;
	#held: Held<Socket> | undefined;

	constructor(options: TunnelHolderOptions<Socket>) {
		this.#sockets = options.sockets;
		this.#kv = options.kv;
		this.#stack = options.stack;
		this.#clock = options.clock ?? systemClock;
		this.#background = options.background;
		this.#newId = options.newId ?? (() => crypto.randomUUID());
	}

	/**
	 * Takes an upgrade the Worker checked and forwarded, with its grant in `TUNNEL_GRANT_HEADER`. `open` makes the
	 * socket pair: the object's end to hold, and the answer that hands the other to the client.
	 */
	upgrade(request: Request, open: () => { readonly socket: Socket; readonly response: Response }): Response {
		const grant = tunnelGrantFrom(request);
		if (grant === undefined) return refusal(400, "invalid", "The tunnel's upgrade came without its grant");
		if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
			return refusal(426, "invalid", "The tunnel is a WebSocket upgrade");
		}
		const { socket, response } = open();
		this.accept(grant, socket);
		return response;
	}

	/** Holds `socket`, opened with `grant`, as the server's current tunnel, and initialises the server over it. */
	accept(grant: TunnelGrant, socket: Socket): void {
		// A takeover never reads as a disconnect, even of an older socket that went while the object was away.
		const older = this.#current(false);
		const connectionId = this.#newId();
		this.#sockets.accept(socket, [connectionTag(connectionId), tokenTag(grant.tokenId)]);
		const held = this.#hold(connectionId, grant, socket, undefined);
		older?.connection.close(TUNNEL_CLOSE_REPLACED, "A newer connection for the tool server took over");
		this.#report("initialising the tool server", () => held.connection.start());
	}

	/** A frame from one of the object's sockets. Only the current socket's are read. */
	message(socket: Socket, frame: string | ArrayBuffer): void {
		this.#heldFor(socket)?.connection.receive(frame);
	}

	/** One of the object's sockets closed or failed. Only the current socket's close takes the server offline. */
	closed(socket: Socket, code: number, reason: string): void {
		this.#heldFor(socket)?.connection.close(code, reason);
	}

	/** Calls a tool over the current socket; `offline` when there is none for `ref`. */
	async call(ref: ToolServerRef, input: TunnelCallInput): Promise<TunnelCallAnswer> {
		const held = this.#current();
		if (
			held === undefined ||
			held.grant.organisationId !== ref.organisationId ||
			held.grant.toolServerId !== ref.toolServerId
		) {
			return { offline: true };
		}
		try {
			return { result: await held.connection.callTool(input) };
		} catch (error) {
			if (isKantelError(error)) return { error: { code: error.code, message: error.message } };
			return { error: { code: "unavailable", message: error instanceof Error ? error.message : String(error) } };
		}
	}

	/** Closes the server's tunnel with `code`; with `tokenId`, only a socket that token opened. */
	close(code: number, reason: string, tokenId?: ToolServerTokenId): void {
		const held = this.#current();
		if (held !== undefined && (tokenId === undefined || held.grant.tokenId === tokenId)) {
			held.connection.close(code, reason);
		}
		// Any other socket still open (one replaced and not gone yet): the token's, or, without one, the server's.
		for (const socket of this.#sockets.get(tokenId === undefined ? undefined : tokenTag(tokenId))) {
			if (held !== undefined && this.#sockets.tags(socket).includes(connectionTag(held.connectionId))) continue;
			try {
				socket.close(code, reason);
			} catch {
				// Already closed.
			}
		}
	}

	#hold(connectionId: string, grant: TunnelGrant, socket: Socket, state: TunnelConnectionState | undefined) {
		const ref = refOf(grant);
		let held: Held<Socket> | undefined;
		const current = () => held !== undefined && this.#held === held;
		const connection = new TunnelConnection({
			socket: {
				send: (text) => {
					socket.send(text);
					// After the client has finished with the request (its ID taken, `initialized` set), not before.
					queueMicrotask(() => this.#save(held));
				},
				close: (code, reason) => socket.close(code, reason),
			},
			clock: this.#clock,
			...(state === undefined ? {} : { state }),
			onReady: async ({ serverInfo, snapshot }) => {
				if (!current()) return;
				this.#save(held);
				await this.#stack().tunnelConnected(grant, { serverInfo, snapshot, at: this.#clock.now() });
			},
			onSnapshot: async (snapshot) => {
				if (!current()) return;
				this.#save(held);
				await this.#stack().tunnelSnapshotChanged(ref, snapshot);
			},
			onClosed: () => {
				if (!current()) return;
				this.#held = undefined;
				this.#kv.delete(TUNNEL_STORAGE_KEY);
				this.#report("reporting the tunnel closed", () => this.#stack().tunnelDisconnected(ref, this.#clock.now()));
			},
		});
		held = { connectionId, grant, connection, socket };
		this.#held = held;
		this.#save(held);
		return held;
	}

	#save(held: Held<Socket> | undefined): void {
		if (held === undefined || this.#held !== held) return;
		const stored: StoredTunnel = {
			connectionId: held.connectionId,
			grant: held.grant,
			state: held.connection.state(),
		};
		this.#kv.put(TUNNEL_STORAGE_KEY, stored);
	}

	/**
	 * The current socket's connection: in memory, or rebuilt from storage by a woken object. A stored socket that is gone
	 * is forgotten, and reported closed unless `reportGone` is false.
	 */
	#current(reportGone = true): Held<Socket> | undefined {
		if (this.#held !== undefined) return this.#held;
		const stored = this.#kv.get<StoredTunnel>(TUNNEL_STORAGE_KEY);
		if (stored === undefined) return undefined;
		const socket = this.#sockets.get(connectionTag(stored.connectionId))[0];
		if (socket === undefined || !stored.state.client.initialized) {
			// The socket went while the object was away, with no close for it (a restart drops held sockets), or the object
			// went before the server initialised: either way the server is offline until its client dials again.
			this.#kv.delete(TUNNEL_STORAGE_KEY);
			if (socket !== undefined) {
				try {
					socket.close(TUNNEL_CLOSE_GOING_AWAY, "The tunnel restarted");
				} catch {
					// Already closed.
				}
			}
			if (reportGone) {
				const ref = refOf(stored.grant);
				this.#report("reporting the tunnel closed", () => this.#stack().tunnelDisconnected(ref, this.#clock.now()));
			}
			return undefined;
		}
		return this.#hold(stored.connectionId, stored.grant, socket, stored.state);
	}

	#heldFor(socket: Socket): Held<Socket> | undefined {
		const held = this.#current();
		if (held === undefined) return undefined;
		return this.#sockets.tags(socket).includes(connectionTag(held.connectionId)) ? held : undefined;
	}

	/** Runs a report to the stack past the event that made it. The stack's outage is its own; the tunnel carries on. */
	#report(what: string, work: () => Promise<unknown>): void {
		const running = work().catch((error: unknown) => console.warn(`harbour: ${what} failed`, error));
		this.#background?.(running);
	}
}
