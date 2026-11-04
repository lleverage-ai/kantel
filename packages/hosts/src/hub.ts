/**
 * Hosts' connections held in this process: the self-hosted gateway's, and tests'. The server checks the host's
 * credential and accepts the WebSocket, then hands the socket here with the host it was checked against. The hub
 * waits for the host's hello, asks the service for the welcome (the service reconciles the sandboxes the host says it
 * holds), and from then on carries calls, events and port streams.
 *
 * One connection per host: a newer one takes over, and the older is closed with 4008. Only the current connection's
 * close marks the host gone, so a takeover never reads as a disconnect.
 *
 * A welcomed host may call Kantel for one thing, `secrets.fetch`: the hub answers it through `secrets`, naming the
 * host the connection was checked against, never one the host names, so a host is given only its own sandboxes'
 * values. Its egress proxy's `egress` events go to `onEgress`.
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
	type HostEgressRecord,
	type HostError,
	type HostEvent,
	type HostHello,
	type HostMessage,
	HostMethods,
	type HostSecrets,
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
	/** A welcomed host's usage tick (a `usage` message), as it came: the service checks it. */
	onUsage?(hostId: string, usage: unknown): void;
	/** A sandbox changed state (an event not tied to a call). */
	onEvent?(hostId: string, event: HostEvent): void;
	/** The host's current connection ended. */
	onDisconnected?(hostId: string): void;
	/**
	 * A host's `secrets.fetch`: the sandbox's protected values, or `undefined` unless the sandbox is on `hostId` (answered
	 * `not_found`). Absent, every fetch is answered `unavailable`.
	 */
	secrets?(hostId: string, sandboxId: string): Promise<HostSecrets | undefined>;
	/** A batch of what a host's egress proxy handled (an `egress` event). */
	onEgress?(hostId: string, records: readonly HostEgressRecord[]): void | Promise<void>;
	/**
	 * The host's welcome as its record says now. Given, `rewelcome` sends this, read afresh (one read at a time per
	 * connection, each after the last was sent), not the welcome it was handed, which may be older; and settings changed
	 * while a hello is being answered are read again once it is welcomed.
	 */
	welcomeNow?(hostId: string): Promise<HostWelcome>;
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
	/** Sends a welcome again, such as with a drain or a desired version. */
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
	/**
	 * Settings changed while its hello was still being answered, which that answer may have read before: with
	 * `welcomeNow`, `true` (read again once welcomed); without, the newest welcome handed over, sent after.
	 */
	later?: HostWelcome | true;
	/** The rewelcomes read and sent in turn. */
	rewelcoming?: Promise<void>;
	readonly pending: Map<string, Pending>;
	readonly streams: Map<number, PortSink>;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_HELLO_TIMEOUT_MS = 30_000;

/** A payload a host sent that is an object, which is all its type claims until it's checked further. */
const isObject = <T>(value: T): value is NonNullable<T> & object => typeof value === "object" && value !== null;

/** A WebSocket close reason is at most 123 bytes of UTF-8 (RFC 6455); a longer one makes `close` throw. */
const CLOSE_REASON_BYTES = 123;

/** `reason`, cut at a character boundary to fit a close frame. */
export function closeReason(reason: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(reason).byteLength <= CLOSE_REASON_BYTES) return reason;
	let out = "";
	let bytes = 0;
	for (const character of reason) {
		const size = encoder.encode(character).byteLength;
		if (bytes + size > CLOSE_REASON_BYTES) break;
		out += character;
		bytes += size;
	}
	return out;
}

/**
 * Closes `socket` with `reason` cut to fit (`closeReason`), and never throws: a socket that is already gone, or a code
 * or reason it won't take, is the same as closed. For a client's socket closed with what a host said (a port's end,
 * a refused open), which an untrusted host can make anything.
 */
export function closeQuietly(
	socket: { close(code?: number, reason?: string): void },
	code: number,
	reason: string,
): void {
	try {
		socket.close(code, closeReason(reason));
	} catch {
		try {
			socket.close(1011);
		} catch {
			// Already closed.
		}
	}
}

/** A host error as it came, made safe to throw: its code and message strings, or plain ones in their place. */
function hostError(error: unknown): HostError {
	if (!isObject(error)) return { code: "internal", message: `The host's call failed: ${typeof error}` };
	const { code, message } = error as { code?: unknown; message?: unknown };
	return {
		code: typeof code === "string" ? code : "internal",
		message: typeof message === "string" ? message : "The host's call failed",
	};
}

export function createHostHub(options: HostHubOptions): HostHub {
	const held = new Map<string, Connection>();
	let nextCall = 0;
	let nextStream = 0;
	const callTimeout = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

	const send = (connection: Connection, message: object) => {
		if (!connection.closed) connection.socket.sendText(JSON.stringify(message));
	};

	/**
	 * Sends the host its welcome as its record says now (`welcomeNow`), one read at a time per connection, each after
	 * the last was sent: the last sent was read after the last change that asked for it.
	 */
	const refresh = (connection: Connection) => {
		const read = options.welcomeNow;
		if (read === undefined) return;
		connection.rewelcoming = (connection.rewelcoming ?? Promise.resolve()).then(async () => {
			if (connection.closed) return;
			try {
				const welcome = await read(connection.hostId);
				send(connection, { type: "welcome", welcome });
			} catch {
				// A host revoked meanwhile is disconnected by its revoke.
			}
		});
	};

	/** Closes the socket and forgets the connection; a socket that is already gone (`close` throws) is the same. */
	const shut = (connection: Connection, code: number, reason: string) => {
		try {
			connection.socket.close(code, closeReason(reason));
		} catch {
			// Already closed.
		}
		teardown(connection, reason);
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

	/** Answers a call the host made: only `secrets.fetch`, for the host the connection was checked against. */
	const answer = async (connection: Connection, message: HostMessage) => {
		const id = message.id;
		if (typeof id !== "string" || id === "") return;
		const reply = (body: { readonly result: unknown } | { readonly error: HostError }) =>
			send(connection, { type: "result", id, ...body });
		if (message.method !== HostMethods.secretsFetch) {
			reply({ error: { code: "unsupported", message: `Kantel answers no ${String(message.method)} call` } });
			return;
		}
		const sandboxId = (message.params as { readonly sandboxId?: unknown } | null | undefined)?.sandboxId;
		if (typeof sandboxId !== "string" || sandboxId === "") {
			reply({ error: { code: "not_found", message: "secrets.fetch names no sandbox" } });
			return;
		}
		if (!connection.welcomed || options.secrets === undefined) {
			reply({ error: { code: "unavailable", message: "Kantel has no protected values to give now" } });
			return;
		}
		try {
			const secrets = await options.secrets(connection.hostId, sandboxId);
			if (secrets === undefined) {
				reply({ error: { code: "not_found", message: `No sandbox ${sandboxId} on this host` } });
			} else {
				reply({ result: secrets });
			}
		} catch {
			// Not the error's own text: it is the control plane's business, and the host needs only to retry later.
			reply({ error: { code: "unavailable", message: "The sandbox's protected values are unavailable now" } });
		}
	};

	const egress = (hostId: string, records: readonly HostEgressRecord[]) => {
		try {
			const kept = options.onEgress?.(hostId, records);
			if (kept instanceof Promise) kept.catch(() => undefined);
		} catch {
			// A log that fails to keep is no reason to drop the host.
		}
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
			const later = connection.later;
			connection.later = undefined;
			if (later === true) refresh(connection);
			else if (later !== undefined) send(connection, { type: "welcome", welcome: later });
		} catch (error) {
			shut(connection, HOST_CLOSE_PROTOCOL, error instanceof Error ? error.message : "The hello was refused");
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
				shut(older, HOST_CLOSE_REPLACED, "A newer connection for the host took over");
			}
			let greeted = false;
			const helloTimer = setTimeout(() => {
				if (greeted || connection.closed) return;
				shut(connection, HOST_CLOSE_PROTOCOL, "No hello");
			}, options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
			/** One port stream's sink failing (its client went away) ends that stream, not the host's connection. */
			const toSink = (stream: number, sink: PortSink, deliver: (sink: PortSink) => void) => {
				try {
					deliver(sink);
				} catch {
					if (connection.streams.get(stream) === sink) connection.streams.delete(stream);
				}
			};
			const handle = (frame: string | Uint8Array) => {
				if (typeof frame !== "string") {
					const decoded = decodeStreamFrame(frame);
					if (decoded === undefined) return;
					const sink = connection.streams.get(decoded.stream);
					if (sink === undefined) return;
					if (decoded.payload.byteLength === 0) {
						connection.streams.delete(decoded.stream);
						toSink(decoded.stream, sink, (s) => s.end("closed by the sandbox"));
					} else {
						toSink(decoded.stream, sink, (s) => s.data(decoded.payload));
					}
					return;
				}
				const message = parseHostMessage(frame);
				if (message === undefined) return;
				if (!greeted) {
					greeted = true;
					clearTimeout(helloTimer);
					// It settles on its own (refusals close the connection); this catch is the last line.
					hello(connection, message.type === "hello" ? message.hello : undefined).catch(() =>
						teardown(connection, "the hello failed"),
					);
					return;
				}
				// Anyone's machine can be a host (account hosts): a payload is read only once it is an object.
				switch (message.type) {
					case "call":
						// It settles on its own, answering the host even on a failure; this catch is the last line.
						answer(connection, message).catch(() => undefined);
						return;
					case "heartbeat":
						if (isObject(message.heartbeat)) options.onHeartbeat?.(hostId, message.heartbeat.capacity);
						return;
					case "usage":
						if (connection.welcomed && isObject(message.usage)) options.onUsage?.(hostId, message.usage);
						return;
					case "result": {
						const id = typeof message.id === "string" ? message.id : undefined;
						const pending = id === undefined ? undefined : connection.pending.get(id);
						if (pending === undefined || id === undefined) return;
						// What settles it is made first: only then is the call forgotten, so it can't be left unsettled.
						const failed =
							message.error === undefined || message.error === null
								? undefined
								: new HostCallError(hostError(message.error));
						connection.pending.delete(id);
						clearTimeout(pending.timer);
						if (failed !== undefined) pending.reject(failed);
						else pending.resolve(message.result);
						return;
					}
					case "event": {
						if (!isObject(message.event)) return;
						if (typeof message.call === "string" && message.call !== "") {
							connection.pending.get(message.call)?.onEvent?.(message.event);
							return;
						}
						if (message.event.kind === "egress") {
							if (connection.welcomed && Array.isArray(message.event.egress)) egress(hostId, message.event.egress);
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
						toSink(stream, sink, (s) => s.end(typeof message.reason === "string" ? message.reason : "closed"));
						return;
					}
					default:
						return;
				}
			};
			return {
				/**
				 * Never throws: a frame that can't be handled closes this host's connection (4002), so nothing a host sends
				 * escapes into the gateway's socket callback, and the host reconnects.
				 */
				receive(frame) {
					if (connection.closed) return;
					try {
						handle(frame);
					} catch (error) {
						const why = error instanceof Error ? error.message : typeof error;
						shut(connection, HOST_CLOSE_PROTOCOL, `A message from the host couldn't be handled: ${why}`);
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
			if (connection === undefined || connection.closed) return;
			// Mid-hello it waits for the welcome, not dropped: the hello's own may be older.
			const read = options.welcomeNow !== undefined;
			if (!connection.welcomed) connection.later = read ? true : welcome;
			else if (read) refresh(connection);
			else send(connection, { type: "welcome", welcome });
		},
		disconnect(hostId, code, reason) {
			const connection = held.get(hostId);
			if (connection === undefined) return;
			shut(connection, code, reason);
		},
		closeAll(code, reason) {
			for (const connection of [...held.values()]) shut(connection, code, reason);
		},
	};
}
