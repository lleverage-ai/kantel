/**
 * The host's side of an E2E session (`session.ts`), in TypeScript. Hosts run the Go one
 * (apps/host/internal/e2e/session.go); this one is for tests, such as the gateway's, that need a host which really
 * decrypts, and as the reference the Go one is checked against (vectors/session.json).
 */
import { fromUtf8, toBase64url, utf8 } from "./bytes.ts";
import { type ChainDevice, type ChainEntry, deviceAllowed, deviceByDh, type SpaceState } from "./chain.ts";
import type { DhKeyPair } from "./keys.ts";
import { NoiseResponder } from "./noise.ts";
import {
	type ByteChannel,
	ControlStream,
	frame,
	type Hello,
	prologue,
	RecordReader,
	SESSION_VERSION,
	SecureStream,
} from "./session.ts";

export interface ServeSessionOptions {
	readonly channel: ByteChannel;
	readonly static: DhKeyPair;
	readonly hostId: string;
	/** The host's verified chain, and how it takes newer entries a device brings (verifying them). */
	readonly chain: {
		state(): SpaceState;
		extend(from: number, entries: readonly ChainEntry[]): Promise<SpaceState>;
	};
	/** A reason to refuse, or undefined to let the session go ahead (such as: the host has no such sandbox). */
	readonly authorize?: (device: ChainDevice, hello: Hello) => string | undefined;
	readonly rpc?: (
		device: ChainDevice,
		sandbox: string,
		method: string,
		params: unknown,
		emit: (event: unknown) => void,
	) => Promise<unknown>;
	readonly port?: (device: ChainDevice, sandbox: string, port: number) => Promise<ByteChannel>;
	readonly ephemeral?: DhKeyPair;
}

const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function parseHello(payload: Uint8Array): Hello {
	const value: unknown = JSON.parse(fromUtf8(payload));
	if (!isObject(value) || value.v !== SESSION_VERSION) throw new Error("Not a hello this host reads");
	const { sandbox, op, port } = value;
	if (typeof sandbox !== "string" || (op !== "rpc" && op !== "port")) throw new Error("A bad hello");
	if (op === "port" && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)) {
		throw new Error("A port session names its port");
	}
	return { v: SESSION_VERSION, sandbox, op, ...(op === "port" ? { port: port as number } : {}) };
}

/** Serves one session on `channel`; resolves when it ends, with why. */
export function serveSession(options: ServeSessionOptions): Promise<string> {
	const { channel } = options;
	return new Promise((done) => {
		const reader = new RecordReader(2, 65_535);
		let started = false;
		const refuse = (reason: string) => {
			try {
				channel.close();
			} catch {
				// Gone.
			}
			done(reason);
		};
		channel.onClose((reason) => {
			if (!started) done(reason);
		});
		/** Records after the handshake's, until the secure stream takes over the channel. */
		const rest: Uint8Array[] = [];
		channel.onData((bytes) => {
			let records: Uint8Array[];
			try {
				records = reader.push(bytes);
			} catch {
				refuse("A bad record");
				return;
			}
			if (started) {
				rest.push(...records);
				return;
			}
			const [first, ...more] = records;
			if (first === undefined) return;
			started = true;
			rest.push(...more);
			void (async () => {
				const state = options.chain.state();
				const responder = new NoiseResponder({
					prologue: prologue(state.space, options.hostId),
					static: options.static,
					...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
				});
				let hello: Hello;
				let remoteStatic: Uint8Array;
				try {
					const read = await responder.readMessage1(first);
					remoteStatic = read.remoteStatic;
					hello = parseHello(read.payload);
				} catch (error) {
					refuse(error instanceof Error ? error.message : "The handshake failed");
					return;
				}
				const head = { seq: state.seq, hash: state.head };
				const { message, transport } = await responder.writeMessage2(
					utf8(JSON.stringify({ v: SESSION_VERSION, head })),
				);
				channel.send(frame(2, message));
				const stream = new SecureStream(channel, transport, reader, rest);
				stream.onClose((reason) => done(reason));
				const control = new ControlStream(stream);
				let device: ChainDevice;
				try {
					const open = await control.next();
					if (!isObject(open) || open.type !== "open") throw new Error("The device didn't open the session");
					let current = state;
					if (isObject(open.chain)) {
						const { from, entries } = open.chain;
						if (typeof from !== "number" || !Array.isArray(entries)) throw new Error("A bad chain");
						current = await options.chain.extend(from, entries as ChainEntry[]);
					}
					const found = deviceByDh(current, toBase64url(remoteStatic));
					if (found === undefined) throw new Error("This device isn't in the space's chain");
					const allowed = deviceAllowed(current, found.id);
					if (!allowed.ok) throw new Error(allowed.reason);
					const why = options.authorize?.(found, hello);
					if (why !== undefined) throw new Error(why);
					device = found;
				} catch (error) {
					const reason = error instanceof Error ? error.message : "Refused";
					await control.send({ type: "refused", reason }).catch(() => undefined);
					stream.close(reason);
					return;
				}
				if (hello.op === "port") {
					if (options.port === undefined || hello.port === undefined) {
						await control.send({ type: "refused", reason: "This host has no ports" });
						stream.close("no ports");
						return;
					}
					let target: ByteChannel;
					try {
						target = await options.port(device, hello.sandbox, hello.port);
					} catch (error) {
						const reason = error instanceof Error ? error.message : "The port didn't open";
						await control.send({ type: "refused", reason });
						stream.close(reason);
						return;
					}
					await control.send({ type: "ready" });
					const leftover = control.detach();
					target.onData((bytes) => void stream.write(bytes).catch(() => target.close()));
					target.onClose(() => stream.close("the port closed"));
					stream.onData((bytes) => target.send(bytes));
					stream.onClose(() => target.close());
					if (leftover.byteLength > 0) target.send(leftover);
					return;
				}
				await control.send({ type: "ready" });
				control.onMessage((request) => {
					if (!isObject(request) || typeof request.id !== "number" || typeof request.method !== "string") return;
					const { id, method } = request;
					if (options.rpc === undefined) {
						void control.send({ id, error: { code: "unsupported", message: "No calls here" } });
						return;
					}
					options
						.rpc(device, hello.sandbox, method, request.params, (event) => void control.send({ id, event }))
						.then(
							(result) => control.send({ id, result }),
							(error: unknown) =>
								control.send({
									id,
									error: {
										code: isObject(error) && typeof error.code === "string" ? error.code : "internal",
										message: error instanceof Error ? error.message : String(error),
									},
								}),
						)
						.catch(() => stream.close("couldn't answer"));
				});
			})().catch((error: unknown) => refuse(error instanceof Error ? error.message : "The session failed"));
		});
	});
}
