/**
 * An E2E session: a device's Noise IK session with one host, carried as opaque bytes on a relay stream (the `e2e`
 * target of `port.open`, reached through a tunnel ticket's WebSocket). The relay passes the bytes on and can't read,
 * change or replay any of them. The Go responder is apps/host/internal/e2e/session.go; both replay vectors/session.json.
 *
 * On the stream, every Noise message is two bytes of length (big-endian) and the message. The prologue binds the
 * session to its space and host: `kantel-e2e/1\n{space}\n{hostId}`.
 *
 *   device -> host   handshake 1, payload `{ v: 1, sandbox, op: "rpc" | "port", port? }`
 *   host -> device   handshake 2, payload `{ v: 1, head: { seq, hash } }`: the host's chain head
 *
 * After it, each side's plaintext is a byte stream cut into transport messages of at most 65,519 bytes. On it, a
 * control message is four bytes of length and JSON. The device's first is `{ type: "open", chain? }`, with the chain
 * entries after the host's head when the device has newer ones (`{ from, entries }`); the host verifies them, then
 * checks that the device is in the space and the session may do what it asks, and answers `{ type: "ready" }` or
 * `{ type: "refused", reason }`. Then:
 *
 *   rpc    `{ id, method, params }` from the device, `{ id, result }`, `{ id, error }` or `{ id, event }` from the host
 *   port   the rest of each side's byte stream is the sandbox port's bytes (SSH, DevTools, the desktop)
 */
import { concat, fromBase64url, fromUtf8, utf8 } from "./bytes.ts";
import type { ChainEntry, SpaceState } from "./chain.ts";
import { type DhKeyPair, KEY_BYTES } from "./keys.ts";
import { NOISE_MAX_PLAINTEXT, NoiseInitiator, type NoiseTransport } from "./noise.ts";

export const SESSION_VERSION = 1;
/** The largest control or RPC message: a file read's base64 fits. */
export const MAX_CONTROL_MESSAGE = 64 * 1024 * 1024;

export type SessionOp = "rpc" | "port";

export interface Hello {
	readonly v: number;
	readonly sandbox: string;
	readonly op: SessionOp;
	readonly port?: number;
}

export interface HostHead {
	readonly seq: number;
	readonly hash: string;
}

export function prologue(space: string, hostId: string): Uint8Array {
	return utf8(`kantel-e2e/1\n${space}\n${hostId}`);
}

/** A relay stream as this side sees it: bytes in either direction, and its end. */
export interface ByteChannel {
	send(bytes: Uint8Array): void;
	/**
	 * Sets the one listener for the chunks the relay delivers, in order, replacing any before it. Chunks needn't line up
	 * with what the other side sent.
	 */
	onData(listener: (bytes: Uint8Array) => void): void;
	/** Adds a listener for the channel's end. */
	onClose(listener: (reason: string) => void): void;
	close(): void;
}

/** Reassembles length-prefixed records from chunks that may split or join them. */
export class RecordReader {
	#buffer: Uint8Array = new Uint8Array(0);
	readonly #lengthBytes: 2 | 4;
	readonly #max: number;

	constructor(lengthBytes: 2 | 4, max: number) {
		this.#lengthBytes = lengthBytes;
		this.#max = max;
	}

	/** What is buffered after the last whole record, which is no record's. */
	rest(): Uint8Array {
		const out = this.#buffer;
		this.#buffer = new Uint8Array(0);
		return out;
	}

	/** The whole records the chunk completes. Throws on one longer than the maximum. */
	push(chunk: Uint8Array): Uint8Array[] {
		this.#buffer = concat(this.#buffer, chunk);
		const out: Uint8Array[] = [];
		for (;;) {
			const n = this.#lengthBytes;
			if (this.#buffer.byteLength < n) break;
			const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, n);
			const length = n === 2 ? view.getUint16(0, false) : view.getUint32(0, false);
			if (length > this.#max) throw new Error("A record is too long");
			if (this.#buffer.byteLength < n + length) break;
			out.push(this.#buffer.slice(n, n + length));
			this.#buffer = this.#buffer.slice(n + length);
		}
		return out;
	}
}

export function frame(lengthBytes: 2 | 4, record: Uint8Array): Uint8Array {
	const out = new Uint8Array(lengthBytes + record.byteLength);
	const view = new DataView(out.buffer);
	if (lengthBytes === 2) view.setUint16(0, record.byteLength, false);
	else view.setUint32(0, record.byteLength, false);
	out.set(record, lengthBytes);
	return out;
}

const EMPTY = new Uint8Array(0);

/**
 * The plaintext byte stream over a finished handshake: `write` cuts bytes into transport messages, and `onData` gets
 * each one's plaintext. Order is kept, as AES-GCM's counter needs; a message that doesn't decrypt ends the session.
 */
export class SecureStream {
	readonly #channel: ByteChannel;
	readonly #transport: NoiseTransport;
	#sending: Promise<void> = Promise.resolve();
	#receiving: Promise<void> = Promise.resolve();
	#listener: ((bytes: Uint8Array) => void) | undefined;
	#early: Uint8Array[] = [];
	#closed = false;
	#closeListeners: ((reason: string) => void)[] = [];

	constructor(channel: ByteChannel, transport: NoiseTransport, reader: RecordReader, pending: readonly Uint8Array[]) {
		this.#channel = channel;
		this.#transport = transport;
		const receive = (record: Uint8Array) => {
			this.#receiving = this.#receiving.then(async () => {
				if (this.#closed) return;
				try {
					const plain = await this.#transport.receive.decryptWithAd(EMPTY, record);
					if (this.#listener === undefined) this.#early.push(plain);
					else this.#listener(plain);
				} catch (error) {
					this.#end(error instanceof Error ? error.message : "A message failed to decrypt");
				}
			});
		};
		for (const record of pending) receive(record);
		channel.onData((bytes) => {
			let records: Uint8Array[];
			try {
				records = reader.push(bytes);
			} catch (error) {
				this.#end(error instanceof Error ? error.message : "A bad record");
				return;
			}
			for (const record of records) receive(record);
		});
		// After what came before the end is read: a host's refusal comes just before it closes.
		channel.onClose((reason) => {
			this.#receiving = this.#receiving.then(() => this.#end(reason));
		});
	}

	#end(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#channel.close();
		} catch {
			// Gone already.
		}
		for (const listener of this.#closeListeners) listener(reason);
	}

	get closed(): boolean {
		return this.#closed;
	}

	onData(listener: (bytes: Uint8Array) => void): void {
		this.#listener = listener;
		const early = this.#early;
		this.#early = [];
		for (const bytes of early) listener(bytes);
	}

	onClose(listener: (reason: string) => void): void {
		this.#closeListeners.push(listener);
	}

	/** Sends `bytes`, in order with every earlier write; resolves once they are on the channel. */
	write(bytes: Uint8Array): Promise<void> {
		this.#sending = this.#sending.then(async () => {
			for (let at = 0; at < bytes.byteLength || (at === 0 && bytes.byteLength === 0); at += NOISE_MAX_PLAINTEXT) {
				if (this.#closed) throw new Error("The session is closed");
				const sealed = await this.#transport.send.encryptWithAd(EMPTY, bytes.subarray(at, at + NOISE_MAX_PLAINTEXT));
				this.#channel.send(frame(2, sealed));
				if (bytes.byteLength === 0) break;
			}
		});
		return this.#sending;
	}

	close(reason = "closed"): void {
		this.#end(reason);
	}
}

/** JSON control messages, four-byte framed, over a secure stream. */
export class ControlStream {
	readonly #stream: SecureStream;
	readonly #reader = new RecordReader(4, MAX_CONTROL_MESSAGE);
	#listener: ((message: unknown) => void) | undefined;
	#queue: unknown[] = [];
	#waiters: { resolve(message: unknown): void; reject(error: Error): void }[] = [];
	#detached = false;
	#closedReason: string | undefined;

	constructor(stream: SecureStream) {
		this.#stream = stream;
		stream.onData((bytes) => this.#push(bytes));
		stream.onClose((reason) => {
			this.#closedReason = reason;
			for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error(`The session closed: ${reason}`));
		});
	}

	#push(bytes: Uint8Array): void {
		if (this.#detached) return;
		let records: Uint8Array[];
		try {
			records = this.#reader.push(bytes);
		} catch {
			this.#stream.close("A control message was too long");
			return;
		}
		for (const record of records) {
			let message: unknown;
			try {
				message = JSON.parse(fromUtf8(record));
			} catch {
				this.#stream.close("A control message wasn't JSON");
				return;
			}
			const waiter = this.#waiters.shift();
			if (waiter !== undefined) waiter.resolve(message);
			else if (this.#listener !== undefined) this.#listener(message);
			else this.#queue.push(message);
		}
	}

	/** Every message from now on (and any that came before a listener was set). */
	onMessage(listener: (message: unknown) => void): void {
		this.#listener = listener;
		for (const message of this.#queue.splice(0)) listener(message);
	}

	send(message: unknown): Promise<void> {
		return this.#stream.write(frame(4, utf8(JSON.stringify(message))));
	}

	/** The next message, or a rejection when the session ends first. */
	next(): Promise<unknown> {
		const queued = this.#queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		if (this.#closedReason !== undefined) return Promise.reject(new Error(`The session closed: ${this.#closedReason}`));
		return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
	}

	/** Stops reading control messages: the bytes after the last one are a port's, and come on the stream from now. */
	detach(): Uint8Array {
		this.#detached = true;
		return this.#reader.rest();
	}
}

/** A call the host refused or failed. */
export class SessionError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "SessionError";
		this.code = code;
	}
}

export interface OpenSessionOptions {
	readonly channel: ByteChannel;
	/** The device's Noise key. */
	readonly static: DhKeyPair;
	/** The device's verified view of the space, and the entries it is from (sent when the host is behind). */
	readonly state: SpaceState;
	readonly entries: readonly ChainEntry[];
	readonly hostId: string;
	readonly sandbox: string;
	readonly op: SessionOp;
	readonly port?: number;
	/** For test vectors only. */
	readonly ephemeral?: DhKeyPair;
}

export interface OpenedSession {
	readonly stream: SecureStream;
	/** The host's chain head when the session opened. */
	readonly hostHead: HostHead;
	/** For `rpc`, the calls' messages. For `port` it is detached: the port's bytes come on `stream`. */
	readonly control: ControlStream;
	/** For `port`: the port's first bytes, which came with the host's ready. */
	readonly leftover: Uint8Array;
}

const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Opens a session to the host the chain lists as `hostId`, as `op`, and resolves once the host is ready. Rejects when
 * the host isn't in the chain, when whatever answers doesn't hold the host's key (the relay, or anyone it hands the
 * stream to), or when the host refuses this device.
 */
export async function openSession(options: OpenSessionOptions): Promise<OpenedSession> {
	const host = options.state.hosts.get(options.hostId);
	if (host === undefined) throw new SessionError("not_found", `Host ${options.hostId} isn't in the space's chain`);
	const remoteStatic = fromBase64url(host.dh);
	if (remoteStatic.byteLength !== KEY_BYTES) throw new SessionError("invalid", "The host's key isn't 32 bytes");
	const initiator = new NoiseInitiator({
		prologue: prologue(options.state.space, options.hostId),
		static: options.static,
		remoteStatic,
		...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
	});
	const hello: Hello = {
		v: SESSION_VERSION,
		sandbox: options.sandbox,
		op: options.op,
		...(options.port === undefined ? {} : { port: options.port }),
	};
	const reader = new RecordReader(2, 65_535);
	/** Records after the handshake's, until the secure stream takes over the channel. */
	const rest: Uint8Array[] = [];
	const handshake = new Promise<Uint8Array>((resolve, reject) => {
		let done = false;
		options.channel.onData((bytes) => {
			let records: Uint8Array[];
			try {
				records = reader.push(bytes);
			} catch (error) {
				if (!done) reject(error);
				done = true;
				return;
			}
			if (done) {
				rest.push(...records);
				return;
			}
			const [record, ...more] = records;
			if (record === undefined) return;
			done = true;
			rest.push(...more);
			resolve(record);
		});
		options.channel.onClose((reason) => {
			if (done) return;
			done = true;
			reject(new SessionError("unavailable", `The relay closed the stream before the host answered: ${reason}`));
		});
	});
	options.channel.send(frame(2, await initiator.writeMessage1(utf8(JSON.stringify(hello)))));
	const record = await handshake;
	let read: Awaited<ReturnType<NoiseInitiator["readMessage2"]>>;
	try {
		read = await initiator.readMessage2(record);
	} catch {
		options.channel.close();
		throw new SessionError("forbidden", "The answer didn't come from the host's key: the relay may be tampering");
	}
	let hostHead: HostHead;
	try {
		const answer: unknown = JSON.parse(fromUtf8(read.payload));
		if (!isObject(answer) || !isObject(answer.head)) throw new Error("no head");
		const { seq, hash } = answer.head;
		if (typeof seq !== "number" || typeof hash !== "string") throw new Error("bad head");
		hostHead = { seq, hash };
	} catch {
		options.channel.close();
		throw new SessionError("invalid", "The host's answer isn't one this CLI reads");
	}
	const stream = new SecureStream(options.channel, read.transport, reader, rest);
	const control = new ControlStream(stream);
	const newer = options.state.seq > hostHead.seq;
	await control.send({
		type: "open",
		...(newer ? { chain: { from: hostHead.seq + 1, entries: options.entries.slice(hostHead.seq + 1) } } : {}),
	});
	const reply = await control.next();
	if (!isObject(reply) || reply.type !== "ready") {
		const reason = isObject(reply) && typeof reply.reason === "string" ? reply.reason : "The host refused the session";
		stream.close(reason);
		throw new SessionError("forbidden", reason);
	}
	const leftover = options.op === "port" ? control.detach() : new Uint8Array(0);
	return { stream, hostHead, control, leftover };
}

interface Waiting {
	resolve(value: unknown): void;
	reject(error: Error): void;
	onEvent?: (event: unknown) => void;
}

/** RPC over an `rpc` session: host methods, run by the host for this device alone. */
export class SessionClient {
	readonly #control: ControlStream;
	readonly #stream: SecureStream;
	readonly #waiting = new Map<number, Waiting>();
	#next = 0;

	constructor(session: OpenedSession) {
		this.#control = session.control;
		this.#stream = session.stream;
		this.#control.onMessage((message) => {
			if (!isObject(message) || typeof message.id !== "number") return;
			const waiting = this.#waiting.get(message.id);
			if (waiting === undefined) return;
			if ("event" in message) {
				waiting.onEvent?.(message.event);
				return;
			}
			this.#waiting.delete(message.id);
			if (isObject(message.error)) {
				const { code, message: text } = message.error;
				waiting.reject(new SessionError(typeof code === "string" ? code : "internal", String(text ?? "failed")));
			} else waiting.resolve(message.result);
		});
		this.#stream.onClose((reason) => {
			for (const [id, waiting] of this.#waiting) {
				this.#waiting.delete(id);
				waiting.reject(new SessionError("unavailable", `The session closed: ${reason}`));
			}
		});
	}

	call<T = unknown>(method: string, params: object, onEvent?: (event: unknown) => void): Promise<T> {
		this.#next += 1;
		const id = this.#next;
		return new Promise<T>((resolve, reject) => {
			this.#waiting.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				...(onEvent === undefined ? {} : { onEvent }),
			});
			this.#control.send({ id, method, params }).catch((error: unknown) => {
				this.#waiting.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	close(): void {
		this.#stream.close("closed by the device");
	}
}
