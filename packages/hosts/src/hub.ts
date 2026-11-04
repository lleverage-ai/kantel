/**
 * Hosts' connections held in this process: the self-hosted gateway's, and tests'. The server checks the host's
 * credential and accepts the WebSocket, then hands the socket here with the host it was checked against. The hub
 * waits for the host's hello, asks the service for the welcome (the service reconciles the sandboxes the host says it
 * holds), and from then on carries calls, events and port streams.
 *
 * One connection per host: a newer one takes over, and the older is closed with 4008. Only the current connection's
 * close marks the host gone, so a takeover never reads as a disconnect.
 *
 * A welcomed host may call Kantel for two things, `secrets.fetch` and `bucket.fetch`: the hub answers them through
 * `secrets` and `bucketSource`, naming the host the connection was checked against, never one the host names, so a
 * host is given only its own sandboxes' values and bucket sources. Its egress proxy's `egress` events go to
 * `onEgress`, and its `sandbox.mounts` events, checked, to `onMounts`.
 *
 * A file stream (`openFile`) is a port stream carrying a file of a sandbox's: the host sends a read's bytes and ends it
 * with a `stream.close` whose reason says how it went; a write's bytes go the other way, then an empty frame for the
 * end of them. Either way the receiver's `stream.ack`s say how much it has taken, and the sender keeps only
 * `FILE_STREAM_WINDOW_BYTES` ahead of them: the host's of a write, Kantel's reader's of a read (`ack`).
 *
 * Nothing here is Node-only: a Cloudflare Durable Object holding the socket can host it the same way.
 */
import { parseMountStatuses, parseMountsAt } from "./facts.ts";
import {
	decodeStreamFrame,
	encodeStreamFrame,
	FILE_STREAM_WINDOW_BYTES,
	HOST_CLOSE_PROTOCOL,
	HOST_CLOSE_REPLACED,
	HOST_EVENT_MOUNTS,
	HOST_PROTOCOL_VERSION,
	type HostBucketSource,
	type HostCapacity,
	type HostEgressRecord,
	type HostError,
	type HostEvent,
	type HostFileOpen,
	type HostHello,
	type HostMessage,
	HostMethods,
	type HostMountStatus,
	type HostSecrets,
	type HostWelcome,
	parseHostMessage,
} from "./protocol.ts";

/** What the server gives the hub of a socket it accepted. */
export interface HostSocket {
	sendText(text: string): void;
	sendBinary(bytes: Uint8Array): void;
	close(code: number, reason: string): void;
	/**
	 * The bytes sent but not yet written out (a WebSocket's `bufferedAmount`), so a file stream's writer can wait for
	 * the host to keep up. Absent, a writer can't tell and doesn't wait.
	 */
	bufferedAmount?(): number;
}

/** What the hub gives back: the server feeds it the socket's frames. */
export interface AcceptedHost {
	receive(frame: string | Uint8Array): void;
	closed(code: number, reason: string): void;
}

/** A call the host answered with an error, or that never got an answer. */
export class HostCallError extends Error {
	readonly code: string;
	/**
	 * The host wasn't there to answer: not connected, or gone while the call waited. A host's own refusal or failure,
	 * and a timeout, isn't this.
	 */
	readonly disconnected: boolean;
	constructor(error: HostError, how: { readonly disconnected?: boolean } = {}) {
		super(error.message);
		this.name = "HostCallError";
		this.code = error.code;
		this.disconnected = how.disconnected === true;
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

/** `sandbox.files.open`'s params but the stream, which the hub picks. */
export interface FileOpenParams {
	readonly sandboxId: string;
	readonly path: string;
	readonly op: "read" | "write";
	/** For a write: the file's permissions, such as 0o644. */
	readonly mode?: number;
}

/** Kantel's end of a file stream: a port stream, and what a write needs on top. */
export interface FileStreamHandle extends PortStream {
	/** The end of a write's bytes: an empty frame, which the host reads as the end of input. */
	finish(): void;
	/**
	 * Resolves once the sandbox has taken all but `FILE_STREAM_WINDOW_BYTES` of what was written (the host's
	 * `stream.ack`), and the host's socket has less than `FILE_STREAM_BUFFER_BYTES` waiting to go out, so a writer
	 * doesn't pile a whole file into memory; at once when the stream has ended.
	 */
	drained(): Promise<void>;
	/**
	 * A read's reader has taken `taken` bytes of it in all: a `stream.ack` to the host, which sends no more than
	 * `FILE_STREAM_WINDOW_BYTES` past what it was last told.
	 */
	ack(taken: number): void;
}

/** A file stream once the host has opened it: the size it answered for a read. */
export interface OpenedFile {
	readonly stream: FileStreamHandle;
	readonly size?: number;
}

/** How much a file stream's writer lets wait in the host's socket before it waits too. */
export const FILE_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
// How far a file stream's writer may get ahead of what the sandbox has taken (the host's `stream.ack`) is
// `FILE_STREAM_WINDOW_BYTES`. The socket's own count isn't enough: under Bun, ws's `bufferedAmount` never comes down
// again, and a send past its backpressure limit is queued and may be sent twice. Kept well under that limit (16 MiB),
// so a write never reaches it.
const DRAIN_POLL_MS = 10;
const OPEN_TIMEOUT_MS = 20_000;

export interface HostHubOptions {
	/**
	 * The host said hello: reconcile and answer with its welcome. Throwing refuses the connection (closed with 4002 and
	 * the error's message).
	 */
	onHello(hostId: string, hello: HostHello): Promise<HostWelcome>;
	onHeartbeat?(hostId: string, capacity: HostCapacity): void;
	/**
	 * A welcomed host's usage tick (a `usage` message), as it came: the service checks it. A promise answered is the tick
	 * being taken: once it resolves, on a connection whose welcome had `usageAcks`, the hub acknowledges the tick's `seq`
	 * (`usage.ack`). Nothing answered, or a promise that rejects, acknowledges nothing. An ack covers every earlier tick
	 * too, so the promise must resolve only once this tick and every one the host sent before it are taken (the compute
	 * plane holds a tick it couldn't take, and every one after it, until they can be: `ComputeService.recordUsage`).
	 */
	onUsage?(hostId: string, usage: unknown): Promise<unknown> | undefined;
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
	 * A host's `bucket.fetch`: the bucket source with its credentials, or `undefined` unless the sandbox is on `hostId`
	 * and mounts it (answered `not_found`). Absent, every fetch is answered `unavailable`.
	 */
	bucketSource?(hostId: string, sandboxId: string, bucketSourceId: string): Promise<HostBucketSource | undefined>;
	/**
	 * A sandbox's mounts changed status (a `sandbox.mounts` event), checked and clipped, with when the host set them
	 * (`HostSandbox.mountsAt`; absent from a host too old to say).
	 */
	onMounts?(
		hostId: string,
		sandboxId: string,
		mounts: readonly HostMountStatus[],
		mountsAt?: number,
	): void | Promise<void>;
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
	/**
	 * Opens a file of a sandbox on the host as a stream (`sandbox.files.open`): a read's bytes arrive at `sink.data`, and
	 * either way the host's `stream.close` reason (`ok <size>` or `error <code>: <message>`) at `sink.end`.
	 */
	openFile(hostId: string, params: FileOpenParams, sink: PortSink): Promise<OpenedFile>;
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
	/** A file write stream's `stream.ack`s: how much of it the sandbox has taken. */
	readonly acks: Map<number, (taken: number) => void>;
	/** Its first welcome had `usageAcks`: usage ticks taken are acknowledged (`usage.ack`). */
	usageAcks: boolean;
	/** The newest `seq` acknowledged on it, so acks only go forward. */
	usageAcked: number;
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
			pending.reject(
				new HostCallError({ code: "unavailable", message: `The host disconnected: ${reason}` }, { disconnected: true }),
			);
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
			throw new HostCallError(
				{ code: "unavailable", message: `Host ${hostId} is not connected` },
				{ disconnected: true },
			);
		}
		return connection;
	};

	/** A new stream on `connection`, its frames from the host going to `sink`. */
	const register = (connection: Connection, sink: PortSink): number => {
		nextStream = (nextStream % 0x7fff_ffff) + 1;
		connection.streams.set(nextStream, sink);
		return nextStream;
	};

	/** Kantel's end of a stream the host opened. */
	const portStream = (connection: Connection, stream: number): PortStream => ({
		stream,
		write(bytes) {
			if (bytes.byteLength === 0 || connection.closed || !connection.streams.has(stream)) return;
			connection.socket.sendBinary(encodeStreamFrame(stream, bytes));
		},
		close() {
			connection.acks.delete(stream);
			if (!connection.streams.delete(stream)) return;
			send(connection, { type: "stream.close", stream, reason: "closed by the client" });
		},
	});

	/** Answers a host's `bucket.fetch`, for the host the connection was checked against, as `secrets.fetch` is. */
	const answerBucket = async (
		connection: Connection,
		params: unknown,
		reply: (body: { readonly result: unknown } | { readonly error: HostError }) => void,
	) => {
		const named: { readonly sandboxId?: unknown; readonly bucketSourceId?: unknown } = isObject(params) ? params : {};
		const { sandboxId, bucketSourceId } = named;
		if (typeof sandboxId !== "string" || sandboxId === "") {
			reply({ error: { code: "not_found", message: "bucket.fetch names no sandbox" } });
			return;
		}
		if (typeof bucketSourceId !== "string" || bucketSourceId === "") {
			reply({ error: { code: "not_found", message: "bucket.fetch names no bucket source" } });
			return;
		}
		if (!connection.welcomed || options.bucketSource === undefined) {
			reply({ error: { code: "unavailable", message: "Kantel has no bucket sources to give now" } });
			return;
		}
		try {
			const source = await options.bucketSource(connection.hostId, sandboxId, bucketSourceId);
			if (source === undefined) {
				const message = `No bucket source ${bucketSourceId} for sandbox ${sandboxId} on this host`;
				reply({ error: { code: "not_found", message } });
			} else {
				reply({ result: source });
			}
		} catch {
			// Not the error's own text, as for secrets: the host needs only to retry later.
			reply({ error: { code: "unavailable", message: "The bucket source is unavailable now" } });
		}
	};

	/** Answers a host's call (`secrets.fetch` or `bucket.fetch`) for the host its connection was checked against. */
	const answer = async (connection: Connection, message: HostMessage) => {
		const id = message.id;
		if (typeof id !== "string" || id === "") return;
		const reply = (body: { readonly result: unknown } | { readonly error: HostError }) =>
			send(connection, { type: "result", id, ...body });
		if (message.method === HostMethods.bucketFetch) {
			await answerBucket(connection, message.params, reply);
			return;
		}
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

	/**
	 * A `sandbox.mounts` event: `{ sandboxId, mounts }`, or the sandbox with its `mounts` as a create answers it. One
	 * that isn't shaped so is dropped; a report that fails to keep is no reason to drop the host.
	 */
	const mounts = (hostId: string, event: HostEvent) => {
		if (options.onMounts === undefined) return;
		const fields: { readonly sandboxId?: unknown; readonly mounts?: unknown; readonly mountsAt?: unknown } = event;
		const sandbox: { readonly id?: unknown; readonly mounts?: unknown; readonly mountsAt?: unknown } = isObject(
			event.sandbox,
		)
			? event.sandbox
			: {};
		const sandboxId = typeof fields.sandboxId === "string" ? fields.sandboxId : sandbox.id;
		if (typeof sandboxId !== "string" || sandboxId === "") return;
		const statuses = parseMountStatuses(fields.mounts !== undefined ? fields.mounts : sandbox.mounts);
		if (statuses === undefined) return;
		const at = parseMountsAt(fields.mounts !== undefined ? fields.mountsAt : sandbox.mountsAt);
		try {
			const kept = options.onMounts(hostId, sandboxId, statuses, at);
			if (kept instanceof Promise) kept.catch(() => undefined);
		} catch {
			// As for egress.
		}
	};

	/**
	 * A usage tick, to the service; with acks on, its `seq` acknowledged once the service has taken it. The service takes
	 * a host's ticks in the order they came, so acks go out in order too; one that would go back is left out.
	 */
	const takeUsage = (connection: Connection, report: object) => {
		const taken = options.onUsage?.(connection.hostId, report);
		const seq = (report as { readonly seq?: unknown }).seq;
		if (!connection.usageAcks || !(taken instanceof Promise)) return;
		if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
			taken.catch(() => undefined);
			return;
		}
		taken.then(
			() => {
				if (connection.closed || seq <= connection.usageAcked) return;
				connection.usageAcked = seq;
				try {
					send(connection, { type: "usage.ack", acked: seq });
				} catch {
					// A socket gone meanwhile: the host sends the tick again on its next connection.
				}
			},
			() => undefined,
		);
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
			// The first welcome decides it for the connection, as it does on the host: a rewelcome forwarded by an older
			// replica, without it, changes nothing.
			connection.usageAcks = welcome.usageAcks === true;
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
				acks: new Map(),
				usageAcks: false,
				usageAcked: 0,
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
						if (connection.welcomed && isObject(message.usage)) takeUsage(connection, message.usage);
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
						if (message.event.kind === HOST_EVENT_MOUNTS) {
							if (connection.welcomed) mounts(hostId, message.event);
							return;
						}
						options.onEvent?.(hostId, message.event);
						return;
					}
					case "stream.ack": {
						const stream = message.stream ?? 0;
						const ack = connection.acks.get(stream);
						if (ack === undefined) return;
						if (!connection.streams.has(stream)) connection.acks.delete(stream);
						else if (typeof message.acked === "number" && Number.isSafeInteger(message.acked)) ack(message.acked);
						return;
					}
					case "stream.close": {
						const stream = message.stream ?? 0;
						connection.acks.delete(stream);
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
			const stream = register(connection, sink);
			try {
				await this.call(hostId, HostMethods.portOpen, { sandboxId, port, stream }, { timeoutMs: OPEN_TIMEOUT_MS });
			} catch (error) {
				connection.streams.delete(stream);
				throw error;
			}
			return portStream(connection, stream);
		},
		async openFile(hostId, params, sink) {
			const connection = current(hostId);
			// Registered before the call: a read's bytes may follow its answer before the caller has the stream.
			const stream = register(connection, sink);
			let opened: unknown;
			try {
				// A read says its reader acks (`handle.ack`), so the host keeps within its window; one from an older Kantel,
				// which doesn't, is sent as fast as the host can.
				const call: HostFileOpen = { ...params, stream, ...(params.op === "read" ? { acks: true } : {}) };
				opened = await this.call(hostId, HostMethods.fileOpen, call, { timeoutMs: OPEN_TIMEOUT_MS });
			} catch (error) {
				connection.streams.delete(stream);
				throw error;
			}
			const size = isObject(opened) ? (opened as { readonly size?: unknown }).size : undefined;
			const open = () => !connection.closed && connection.streams.has(stream);
			const base = portStream(connection, stream);
			// A write's bytes sent, and how many of them the host says the sandbox has taken.
			let sent = 0;
			let taken = 0;
			let wake: (() => void) | undefined;
			if (params.op === "write") {
				connection.acks.set(stream, (bytes) => {
					if (bytes > taken) taken = bytes;
					wake?.();
				});
			}
			const handle: FileStreamHandle = {
				...base,
				write(bytes) {
					if (bytes.byteLength === 0 || !open()) return;
					sent += bytes.byteLength;
					base.write(bytes);
				},
				finish() {
					// Its own send: `write` drops an empty chunk, which would otherwise read as the end.
					if (open()) connection.socket.sendBinary(encodeStreamFrame(stream, new Uint8Array(0)));
				},
				ack(bytes) {
					if (params.op === "read" && open()) send(connection, { type: "stream.ack", stream, acked: bytes });
				},
				drained() {
					const waiting = () => {
						if (!open()) return false;
						if (sent - taken >= FILE_STREAM_WINDOW_BYTES) return true;
						const buffered = connection.socket.bufferedAmount?.();
						return buffered !== undefined && buffered >= FILE_STREAM_BUFFER_BYTES;
					};
					if (!waiting()) return Promise.resolve();
					// Checked again on each ack, and every DRAIN_POLL_MS for the socket (and for a stream that ended).
					return new Promise<void>((resolve) => {
						let timer: ReturnType<typeof setTimeout> | undefined;
						const check = () => {
							if (waiting()) return;
							if (timer !== undefined) clearTimeout(timer);
							wake = undefined;
							resolve();
						};
						const poll = () => {
							check();
							if (wake === check) timer = setTimeout(poll, DRAIN_POLL_MS);
						};
						wake = check;
						timer = setTimeout(poll, DRAIN_POLL_MS);
					});
				},
			};
			return {
				stream: handle,
				...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
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
