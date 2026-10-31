/**
 * One tunnel socket as Kantel holds it, the same on both hosts: the Durable Object on Cloudflare and the gateway
 * self-hosted each hand it the socket's frames and close, and it does the rest. It answers liveness pings, holds the
 * protocol's frame rules, initialises the server and takes its tools, takes them again when the server says they
 * changed, and passes tool calls through.
 *
 * A host that hibernates keeps `state()` with the socket and builds a new connection from it on waking. One rebuilt
 * from an initialised state doesn't initialise or list again: the server's side is still on the same session.
 */
import { type Clock, systemClock, type Timestamp, type ToolServerSnapshot } from "@kantel/contracts";
import { type McpCallToolInput, type McpClientState, type McpServerInfo, McpTunnelClient } from "./mcp-client.ts";
import {
	exceedsMessageLimit,
	TUNNEL_CLOSE_BAD_MESSAGE,
	TUNNEL_CLOSE_TOO_BIG,
	TUNNEL_CLOSE_UNSUPPORTED_DATA,
	TUNNEL_MAX_MESSAGE_BYTES,
	TUNNEL_PING,
	TUNNEL_PONG,
} from "./protocol.ts";
import { snapshotOf } from "./snapshot.ts";

/** What the connection needs of the socket: WHATWG's and `ws`'s both fit. */
export interface TunnelSocket {
	send(text: string): void;
	close(code: number, reason: string): void;
}

/** What a host keeps across hibernation; JSON. */
export interface TunnelConnectionState {
	readonly client: McpClientState;
	/** The hash of the snapshot last reported, so only a real change is reported again. */
	readonly snapshotHash?: string;
}

/** The server initialised and listed its tools. */
export interface TunnelReady {
	readonly serverInfo: McpServerInfo | undefined;
	readonly snapshot: ToolServerSnapshot;
}

export interface TunnelConnectionOptions {
	readonly socket: TunnelSocket;
	readonly clock?: Clock;
	/** From an earlier connection's `state()` on the same socket. */
	readonly state?: TunnelConnectionState;
	/** After `start()` has initialised the server and taken its tools. */
	onReady(info: TunnelReady): void | Promise<void>;
	/** The server's tools changed: a new snapshot, given only when its hash differs from the last one. */
	onSnapshot(snapshot: ToolServerSnapshot): void | Promise<void>;
	/** The connection closed, from either side. Given once. */
	onClosed?(code: number, reason: string): void;
}

/** The longest close reason a WebSocket carries, in UTF-8 bytes. */
const CLOSE_REASON_MAX_BYTES = 123;

function closeReason(text: string): string {
	const encoder = new TextEncoder();
	let reason = text;
	while (encoder.encode(reason).byteLength > CLOSE_REASON_MAX_BYTES) reason = reason.slice(0, -1);
	return reason;
}

export class TunnelConnection {
	readonly #socket: TunnelSocket;
	readonly #clock: Clock;
	readonly #client: McpTunnelClient;
	readonly #onReady: TunnelConnectionOptions["onReady"];
	readonly #onSnapshot: TunnelConnectionOptions["onSnapshot"];
	readonly #onClosed: TunnelConnectionOptions["onClosed"];
	#snapshotHash: string | undefined;
	#lastSeenAt: Timestamp;
	#ready: boolean;
	#listing: Promise<void> | undefined;
	#listAgain = false;
	#closed = false;

	constructor(options: TunnelConnectionOptions) {
		this.#socket = options.socket;
		this.#clock = options.clock ?? systemClock;
		this.#onReady = options.onReady;
		this.#onSnapshot = options.onSnapshot;
		this.#onClosed = options.onClosed;
		this.#snapshotHash = options.state?.snapshotHash;
		this.#ready = options.state?.client.initialized === true;
		this.#lastSeenAt = this.#clock.now();
		this.#client = new McpTunnelClient({
			send: (text) => this.#socket.send(text),
			onToolsChanged: () => this.#toolsChanged(),
			...(options.state === undefined ? {} : { state: options.state.client }),
		});
	}

	/** When a frame last came, the opening of the socket counting as one. */
	get lastSeenAt(): Timestamp {
		return this.#lastSeenAt;
	}

	/**
	 * Initialises the server, takes its tools and calls `onReady`; nothing when rebuilt from an initialised state. A
	 * server that won't initialise or list is closed with 1008, which `onClosed` reports; this rejects only when
	 * `onReady` does.
	 */
	async start(): Promise<void> {
		if (this.#ready || this.#closed) return;
		let ready: TunnelReady;
		try {
			const { serverInfo } = await this.#client.initialize();
			ready = { serverInfo, snapshot: await snapshotOf(await this.#client.listTools(), this.#clock.now()) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.close(TUNNEL_CLOSE_BAD_MESSAGE, `The tool server didn't start: ${message}`);
			return;
		}
		if (this.#closed) return;
		this.#snapshotHash = ready.snapshot.hash;
		this.#ready = true;
		await this.#onReady(ready);
		if (this.#listAgain) this.#toolsChanged();
	}

	/**
	 * Takes one frame from the socket: a text frame as a string, a binary one as bytes (which closes it). Answers a
	 * liveness ping itself, and gives JSON-RPC to the client.
	 */
	receive(frame: string | ArrayBuffer | ArrayBufferView): void {
		if (this.#closed) return;
		this.#lastSeenAt = this.#clock.now();
		if (typeof frame !== "string") {
			this.close(TUNNEL_CLOSE_UNSUPPORTED_DATA, "The tunnel takes text frames only");
			return;
		}
		if (frame === TUNNEL_PING) {
			try {
				this.#socket.send(TUNNEL_PONG);
			} catch {
				// The socket's close will say so.
			}
			return;
		}
		if (exceedsMessageLimit(frame)) {
			this.close(TUNNEL_CLOSE_TOO_BIG, `A frame is at most ${TUNNEL_MAX_MESSAGE_BYTES} bytes`);
			return;
		}
		if (!this.#client.receive(frame)) this.close(TUNNEL_CLOSE_BAD_MESSAGE, "A frame wasn't a JSON-RPC message");
	}

	/** Calls one of the server's tools; see `McpTunnelClient.callTool`. */
	callTool(input: McpCallToolInput): ReturnType<McpTunnelClient["callTool"]> {
		return this.#client.callTool(input);
	}

	/**
	 * Closes the socket with `code` and `reason`, rejecting every request still waiting. Hosts call it when the socket
	 * closes from the other side too; only the first call counts.
	 */
	close(code: number, reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		const trimmed = closeReason(reason);
		this.#client.close(
			trimmed.length === 0 ? "The tool server's tunnel closed" : `The tool server's tunnel closed: ${trimmed}`,
		);
		try {
			this.#socket.close(code, trimmed);
		} catch {
			// Already closed.
		}
		this.#onClosed?.(code, trimmed);
	}

	state(): TunnelConnectionState {
		return {
			client: this.#client.state(),
			...(this.#snapshotHash === undefined ? {} : { snapshotHash: this.#snapshotHash }),
		};
	}

	/** Lists again, one listing at a time: changes that come during one give at most one more. */
	#toolsChanged(): void {
		if (this.#closed) return;
		if (!this.#ready || this.#listing !== undefined) {
			this.#listAgain = true;
			return;
		}
		this.#listing = this.#relist().finally(() => {
			this.#listing = undefined;
		});
	}

	async #relist(): Promise<void> {
		do {
			this.#listAgain = false;
			let snapshot: ToolServerSnapshot;
			try {
				snapshot = await snapshotOf(await this.#client.listTools(), this.#clock.now());
			} catch {
				// Closed, or the server failed to list: the last snapshot stands until it says its tools changed again.
				return;
			}
			if (this.#closed) return;
			if (snapshot.hash !== this.#snapshotHash) {
				this.#snapshotHash = snapshot.hash;
				try {
					await this.#onSnapshot(snapshot);
				} catch {
					// The host's to report; the next change is still listed.
				}
			}
		} while (this.#listAgain && !this.#closed);
	}
}
