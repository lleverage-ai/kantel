/**
 * Hosts' connections held in this process: the self-hosted gateway's, and tests'. The server checks the host's
 * credential and accepts the WebSocket, then hands the socket here with the host it was checked against. The hub
 * waits for the host's hello, asks the service for the welcome (the service reconciles the sandboxes the host says it
 * holds), and from then on carries calls, events and port streams.
 *
 * One connection per host: a newer one takes over, and the older is closed with 4008. Only the current connection's
 * close marks the host gone, so a takeover never reads as a disconnect.
 *
 * Nothing here is Node-only: a Cloudflare Durable Object holding the socket can host it the same way.
 */
import {
	decodeStreamFrame,
	encodeStreamFrame,
	HOST_CLOSE_PROTOCOL,
	HOST_CLOSE_REPLACED,
	HOST_PROTOCOL_VERSION,
	type HostCapacity,
	type HostError,
	type HostEvent,
	type HostHello,
	HostMethods,
	type HostWelcome,
	parseHostMessage,
} from "./protocol.ts";

/** What the server gives the hub of a socket it accepted. */
export interface HostSocket {
	sendText(text: string): void;
	sendBinary(bytes: Uint8Array): void;
	close(code: number, reason: string): void;
}

/** What the hub gives back: the server feeds it the socket's frames. */
export interface AcceptedHost {
	receive(frame: string | Uint8Array): void;
	closed(code: number, reason: string): void;
}

/** A call the host answered with an error, or that never got an answer. */
export class HostCallError extends Error {
	readonly code: string;
	constructor(error: HostError) {
		super(error.message);
		this.name = "HostCallError";
		this.code = error.code;
	}
}

export interface CallOptions {
	/** Default `HostHubOptions.callTimeoutMs`. */
	readonly timeoutMs?: number;
	/** Progress the host sends on the call (a streamed command's output). */
	readonly onEvent?: (event: HostEvent) => void;
	readonly signal?: AbortSignal;
}

/** One end of a port stream: bytes from the sandbox's port arrive at `data`. */
export interface PortSink {
	data(bytes: Uint8Array): void;
	/** The sandbox's side ended. */
	end(reason: string): void;
}

/** The other end: bytes written go to the sandbox's port. */
export interface PortStream {
	readonly stream: number;
	write(bytes: Uint8Array): void;
	/** Closes the stream both ways. */
	close(): void;
}

export interface HostHubOptions {
	/**
	 * The host said hello: reconcile and answer with its welcome. Throwing refuses the connection (closed with 4002 and
	 * the error's message).
	 */
	onHello(hostId: string, hello: HostHello): Promise<HostWelcome>;
	onHeartbeat?(hostId: string, capacity: HostCapacity): void;
	/** A sandbox changed state (an event not tied to a call). */
	onEvent?(hostId: string, event: HostEvent): void;
	/** The host's current connection ended. */
	onDisconnected?(hostId: string): void;
	/** Default 120 s: a cold boot and a template build are slow. */
	readonly callTimeoutMs?: number;
	/** How long a host may take to say hello. Default 30 s. */
	readonly helloTimeoutMs?: number;
}

export interface HostHub {
	accept(hostId: string, socket: HostSocket): AcceptedHost;
	/** Whether the host has a welcomed connection now. */
	connected(hostId: string): boolean;
	connectedHosts(): string[];
	call<T = unknown>(hostId: string, method: string, params: unknown, options?: CallOptions): Promise<T>;
	/** Connects a stream to a port of a sandbox on the host. */
	openPort(hostId: string, sandboxId: string, port: number, sink: PortSink): Promise<PortStream>;
	/** Sends a welcome again, such as with new pools or a desired version. */
	rewelcome(hostId: string, welcome: HostWelcome): void;
	disconnect(hostId: string, code: number, reason: string): void;
	closeAll(code: number, reason: string): void;
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	onEvent?: (event: HostEvent) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface Connection {
	readonly hostId: string;
	readonly socket: HostSocket;
	welcomed: boolean;
	closed: boolean;
	readonly pending: Map<string, Pending>;
	readonly streams: Map<number, PortSink>;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_HELLO_TIMEOUT_MS = 30_000;

export function createHostHub(options: HostHubOptions): HostHub {
	const held = new Map<string, Connection>();
	let nextCall = 0;
	let nextStream = 0;
	const callTimeout = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

	const send = (connection: Connection, message: object) => {
		if (!connection.closed) connection.socket.sendText(JSON.stringify(message));
	};

	const teardown = (connection: Connection, reason: string) => {
		if (connection.closed) return;
		connection.closed = true;
		for (const [id, pending] of connection.pending) {
			clearTimeout(pending.timer);
			pending.reject(new HostCallError({ code: "unavailable", message: `The host disconnected: ${reason}` }));
			connection.pending.delete(id);
		}
		for (const [id, sink] of connection.streams) {
			connection.streams.delete(id);
			sink.end("the host disconnected");
		}
		if (held.get(connection.hostId) === connection) {
			held.delete(connection.hostId);
			options.onDisconnected?.(connection.hostId);
		}
	};

	const current = (hostId: string): Connection => {
		const connection = held.get(hostId);
		if (connection === undefined || !connection.welcomed || connection.closed) {
			throw new HostCallError({ code: "unavailable", message: `Host ${hostId} is not connected` });
		}
		return connection;
	};

	const hello = async (connection: Connection, message: HostHello | undefined) => {
		try {
			if (message === undefined) throw new Error("The first message must be a hello");
			if (message.facts?.protocol !== HOST_PROTOCOL_VERSION) {
				throw new Error(
					`This control plane speaks host protocol ${HOST_PROTOCOL_VERSION}, not ${String(message.facts?.protocol)}`,
				);
			}
			if (message.hostId !== "" && message.hostId !== connection.hostId) {
				throw new Error("The hello names another host than the credential");
			}
			const welcome = await options.onHello(connection.hostId, message);
			if (connection.closed) return;
			connection.welcomed = true;
			send(connection, { type: "welcome", welcome });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			connection.socket.close(HOST_CLOSE_PROTOCOL, reason.slice(0, 120));
			teardown(connection, reason);
		}
	};

	return {
		accept(hostId, socket) {
			const connection: Connection = {
				hostId,
				socket,
				welcomed: false,
				closed: false,
				pending: new Map(),
				streams: new Map(),
			};
			const older = held.get(hostId);
			held.set(hostId, connection);
			if (older !== undefined) {
				older.socket.close(HOST_CLOSE_REPLACED, "A newer connection for the host took over");
				teardown(older, "replaced");
			}
			let greeted = false;
			const helloTimer = setTimeout(() => {
				if (greeted || connection.closed) return;
				socket.close(HOST_CLOSE_PROTOCOL, "No hello");
				teardown(connection, "no hello");
			}, options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
			return {
				receive(frame) {
					if (connection.closed) return;
					if (typeof frame !== "string") {
						const decoded = decodeStreamFrame(frame);
						if (decoded === undefined) return;
						const sink = connection.streams.get(decoded.stream);
						if (sink === undefined) return;
						if (decoded.payload.byteLength === 0) {
							connection.streams.delete(decoded.stream);
							sink.end("closed by the sandbox");
						} else {
							sink.data(decoded.payload);
						}
						return;
					}
					const message = parseHostMessage(frame);
					if (message === undefined) return;
					if (!greeted) {
						greeted = true;
						clearTimeout(helloTimer);
						void hello(connection, message.type === "hello" ? message.hello : undefined);
						return;
					}
					switch (message.type) {
						case "heartbeat":
							if (message.heartbeat !== undefined) options.onHeartbeat?.(hostId, message.heartbeat.capacity);
							return;
						case "result": {
							const pending = message.id === undefined ? undefined : connection.pending.get(message.id);
							if (pending === undefined || message.id === undefined) return;
							connection.pending.delete(message.id);
							clearTimeout(pending.timer);
							if (message.error !== undefined) pending.reject(new HostCallError(message.error));
							else pending.resolve(message.result);
							return;
						}
						case "event": {
							if (message.event === undefined) return;
							if (message.call !== undefined && message.call !== "") {
								connection.pending.get(message.call)?.onEvent?.(message.event);
								return;
							}
							options.onEvent?.(hostId, message.event);
							return;
						}
						case "stream.close": {
							const stream = message.stream ?? 0;
							const sink = connection.streams.get(stream);
							if (sink === undefined) return;
							connection.streams.delete(stream);
							sink.end(message.reason ?? "closed");
							return;
						}
						default:
							return;
					}
				},
				closed(_code, reason) {
					clearTimeout(helloTimer);
					teardown(connection, reason || "closed");
				},
			};
		},
		connected(hostId) {
			const connection = held.get(hostId);
			return connection?.welcomed === true && !connection.closed;
		},
		connectedHosts() {
			return [...held.values()].filter((c) => c.welcomed && !c.closed).map((c) => c.hostId);
		},
		call<T>(hostId: string, method: string, params: unknown, callOptions: CallOptions = {}) {
			return new Promise<T>((resolve, reject) => {
				let connection: Connection;
				try {
					connection = current(hostId);
				} catch (error) {
					reject(error);
					return;
				}
				nextCall += 1;
				const id = `c${nextCall}`;
				const timeoutMs = callOptions.timeoutMs ?? callTimeout;
				const timer = setTimeout(() => {
					connection.pending.delete(id);
					reject(new HostCallError({ code: "timeout", message: `${method} took longer than ${timeoutMs} ms` }));
				}, timeoutMs);
				connection.pending.set(id, {
					resolve: resolve as (value: unknown) => void,
					reject,
					timer,
					...(callOptions.onEvent === undefined ? {} : { onEvent: callOptions.onEvent }),
				});
				callOptions.signal?.addEventListener(
					"abort",
					() => {
						if (!connection.pending.delete(id)) return;
						clearTimeout(timer);
						reject(new HostCallError({ code: "timeout", message: `${method} was aborted` }));
					},
					{ once: true },
				);
				send(connection, { type: "call", id, method, params });
			});
		},
		async openPort(hostId, sandboxId, port, sink) {
			const connection = current(hostId);
			nextStream = (nextStream % 0x7fff_ffff) + 1;
			const stream = nextStream;
			connection.streams.set(stream, sink);
			try {
				await this.call(hostId, HostMethods.portOpen, { sandboxId, port, stream }, { timeoutMs: 20_000 });
			} catch (error) {
				connection.streams.delete(stream);
				throw error;
			}
			return {
				stream,
				write(bytes) {
					if (bytes.byteLength === 0 || connection.closed || !connection.streams.has(stream)) return;
					connection.socket.sendBinary(encodeStreamFrame(stream, bytes));
				},
				close() {
					if (!connection.streams.delete(stream)) return;
					send(connection, { type: "stream.close", stream, reason: "closed by the client" });
				},
			};
		},
		rewelcome(hostId, welcome) {
			const connection = held.get(hostId);
			if (connection?.welcomed) send(connection, { type: "welcome", welcome });
		},
		disconnect(hostId, code, reason) {
			const connection = held.get(hostId);
			if (connection === undefined) return;
			connection.socket.close(code, reason);
			teardown(connection, reason);
		},
		closeAll(code, reason) {
			for (const connection of [...held.values()]) {
				connection.socket.close(code, reason);
				teardown(connection, reason);
			}
		},
	};
}
