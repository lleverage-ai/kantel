/**
 * `Noise_IK_25519_AESGCM_SHA256` (revision 34 of https://noiseprotocol.org/noise.html), the handshake every E2E
 * session opens with. The initiator (a device) already knows the responder's (a host's) static key from the space
 * chain, so IK finishes in one round trip, and the device's own static key travels encrypted: the relay sees neither
 * who is talking nor what they say. The Go side is apps/host/internal/e2e/noise.go; both pass the same test vector.
 *
 *   <- s
 *   ...
 *   -> e, es, s, ss
 *   <- e, ee, se
 *
 * X25519, AES-256-GCM, SHA-256 and HMAC are all in WebCrypto, which is why this suite rather than ChaChaPoly or BLAKE2.
 * Every operation is async because WebCrypto's are.
 */
import { concat, equalBytes, own, utf8 } from "./bytes.ts";
import { type DhKeyPair, generateDh, KEY_BYTES, type WebKey } from "./keys.ts";

export const NOISE_PROTOCOL = "Noise_IK_25519_AESGCM_SHA256";
/** The largest Noise message, handshake or transport (the spec's limit). */
export const NOISE_MAX_MESSAGE = 65_535;
/** AES-GCM's tag. */
export const NOISE_TAG_BYTES = 16;
/** The most plaintext one transport message carries. */
export const NOISE_MAX_PLAINTEXT = NOISE_MAX_MESSAGE - NOISE_TAG_BYTES;

const HASH_BYTES = 32;
const EMPTY = new Uint8Array(0);

async function hash(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", own(data)));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const imported = await crypto.subtle.importKey("raw", own(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", imported, own(data)));
}

/** The spec's HKDF: two outputs, from the chaining key and the input key material. */
async function hkdf2(chainingKey: Uint8Array, input: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
	const temp = await hmac(chainingKey, input);
	const one = await hmac(temp, Uint8Array.of(1));
	const two = await hmac(temp, concat(one, Uint8Array.of(2)));
	return [one, two];
}

/** AES-GCM's 96-bit nonce: 32 bits of zeros, then the 64-bit counter, big-endian. */
function nonce(n: bigint): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(12);
	new DataView(out.buffer).setBigUint64(4, n, false);
	return out;
}

/** The highest nonce is reserved (the spec's rekey); a key that reaches it is spent. */
const MAX_NONCE = 2n ** 64n - 1n;

/** One direction's key and counter: the spec's CipherState. */
export class CipherState {
	#key: WebKey | undefined;
	#n = 0n;

	async initializeKey(key: Uint8Array | undefined): Promise<void> {
		this.#key =
			key === undefined
				? undefined
				: await crypto.subtle.importKey("raw", own(key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
		this.#n = 0n;
	}

	hasKey(): boolean {
		return this.#key !== undefined;
	}

	async encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
		if (this.#key === undefined) return plaintext;
		if (this.#n >= MAX_NONCE) throw new Error("This Noise key is spent");
		const out = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce(this.#n), additionalData: own(ad), tagLength: 128 },
			this.#key,
			own(plaintext),
		);
		this.#n += 1n;
		return new Uint8Array(out);
	}

	/** Throws when the ciphertext isn't authentic; the counter moves on only when it is. */
	async decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
		if (this.#key === undefined) return ciphertext;
		if (this.#n >= MAX_NONCE) throw new Error("This Noise key is spent");
		let out: ArrayBuffer;
		try {
			out = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: nonce(this.#n), additionalData: own(ad), tagLength: 128 },
				this.#key,
				own(ciphertext),
			);
		} catch {
			throw new Error("A Noise message failed to decrypt");
		}
		this.#n += 1n;
		return new Uint8Array(out);
	}
}

/** The spec's SymmetricState. */
class SymmetricState {
	readonly cipher = new CipherState();
	ck: Uint8Array = EMPTY;
	h: Uint8Array = EMPTY;

	async initialize(protocolName: string): Promise<void> {
		const name = utf8(protocolName);
		this.h =
			name.byteLength <= HASH_BYTES ? concat(name, new Uint8Array(HASH_BYTES - name.byteLength)) : await hash(name);
		this.ck = this.h;
		await this.cipher.initializeKey(undefined);
	}

	async mixKey(input: Uint8Array): Promise<void> {
		const [ck, key] = await hkdf2(this.ck, input);
		this.ck = ck;
		await this.cipher.initializeKey(key);
	}

	async mixHash(data: Uint8Array): Promise<void> {
		this.h = await hash(concat(this.h, data));
	}

	async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
		const ciphertext = await this.cipher.encryptWithAd(this.h, plaintext);
		await this.mixHash(ciphertext);
		return ciphertext;
	}

	async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
		const plaintext = await this.cipher.decryptWithAd(this.h, ciphertext);
		await this.mixHash(ciphertext);
		return plaintext;
	}

	async split(): Promise<[CipherState, CipherState]> {
		const [one, two] = await hkdf2(this.ck, EMPTY);
		const first = new CipherState();
		const second = new CipherState();
		await first.initializeKey(one);
		await second.initializeKey(two);
		return [first, second];
	}
}

/** What a finished handshake gives each side. */
export interface NoiseTransport {
	/** Encrypts what this side sends. */
	readonly send: CipherState;
	/** Decrypts what it receives. */
	readonly receive: CipherState;
	/** The handshake hash: the same on both sides, and bound to everything said in the handshake. */
	readonly handshakeHash: Uint8Array;
	/** The other side's static public key (the initiator's, for the responder). */
	readonly remoteStatic: Uint8Array;
}

export interface InitiatorOptions {
	readonly prologue: Uint8Array;
	readonly static: DhKeyPair;
	/** The responder's static key, known before the handshake (the chain's host key). */
	readonly remoteStatic: Uint8Array;
	/** For test vectors only; a fresh one otherwise. */
	readonly ephemeral?: DhKeyPair;
}

/** The device's side: `writeMessage1`, then `readMessage2`, which gives the transport. */
export class NoiseInitiator {
	readonly #options: InitiatorOptions;
	readonly #state = new SymmetricState();
	#ephemeral: DhKeyPair | undefined;
	#step = 0;

	constructor(options: InitiatorOptions) {
		if (options.remoteStatic.byteLength !== KEY_BYTES) throw new Error("The responder's key is 32 bytes");
		this.#options = options;
	}

	/** `-> e, es, s, ss`, with `payload` encrypted. */
	async writeMessage1(payload: Uint8Array): Promise<Uint8Array> {
		if (this.#step !== 0) throw new Error("Out of order");
		this.#step = 1;
		const { prologue, remoteStatic } = this.#options;
		const state = this.#state;
		await state.initialize(NOISE_PROTOCOL);
		await state.mixHash(prologue);
		await state.mixHash(remoteStatic);
		const e = this.#options.ephemeral ?? (await generateDh());
		this.#ephemeral = e;
		await state.mixHash(e.publicKey);
		await state.mixKey(await e.dh(remoteStatic));
		const s = await state.encryptAndHash(this.#options.static.publicKey);
		await state.mixKey(await this.#options.static.dh(remoteStatic));
		const body = await state.encryptAndHash(payload);
		const message = concat(e.publicKey, s, body);
		if (message.byteLength > NOISE_MAX_MESSAGE) throw new Error("The first handshake message is too big");
		return message;
	}

	/** `<- e, ee, se`: the responder's payload, and the transport. Throws unless the responder holds its static key. */
	async readMessage2(
		message: Uint8Array,
	): Promise<{ readonly payload: Uint8Array; readonly transport: NoiseTransport }> {
		if (this.#step !== 1 || this.#ephemeral === undefined) throw new Error("Out of order");
		this.#step = 2;
		if (message.byteLength < KEY_BYTES + NOISE_TAG_BYTES) throw new Error("The second handshake message is short");
		const state = this.#state;
		const re = message.subarray(0, KEY_BYTES);
		await state.mixHash(re);
		await state.mixKey(await this.#ephemeral.dh(re));
		await state.mixKey(await this.#options.static.dh(re));
		const payload = await state.decryptAndHash(message.subarray(KEY_BYTES));
		const [send, receive] = await state.split();
		return {
			payload,
			transport: { send, receive, handshakeHash: state.h, remoteStatic: this.#options.remoteStatic },
		};
	}
}

export interface ResponderOptions {
	readonly prologue: Uint8Array;
	readonly static: DhKeyPair;
	/** For test vectors only. */
	readonly ephemeral?: DhKeyPair;
}

/** The host's side (in TypeScript for tests and for the relay's own checks; hosts run the Go one). */
export class NoiseResponder {
	readonly #options: ResponderOptions;
	readonly #state = new SymmetricState();
	#remoteStatic: Uint8Array | undefined;
	#remoteEphemeral: Uint8Array | undefined;
	#step = 0;

	constructor(options: ResponderOptions) {
		this.#options = options;
	}

	/** The initiator's static key and payload; throws if the message isn't authentic. */
	async readMessage1(
		message: Uint8Array,
	): Promise<{ readonly remoteStatic: Uint8Array; readonly payload: Uint8Array }> {
		if (this.#step !== 0) throw new Error("Out of order");
		this.#step = 1;
		const minimum = KEY_BYTES + KEY_BYTES + NOISE_TAG_BYTES + NOISE_TAG_BYTES;
		if (message.byteLength < minimum) throw new Error("The first handshake message is short");
		const state = this.#state;
		const s = this.#options.static;
		await state.initialize(NOISE_PROTOCOL);
		await state.mixHash(this.#options.prologue);
		await state.mixHash(s.publicKey);
		const re = message.slice(0, KEY_BYTES);
		this.#remoteEphemeral = re;
		await state.mixHash(re);
		await state.mixKey(await s.dh(re));
		const rs = await state.decryptAndHash(message.subarray(KEY_BYTES, KEY_BYTES + KEY_BYTES + NOISE_TAG_BYTES));
		this.#remoteStatic = rs;
		await state.mixKey(await s.dh(rs));
		const payload = await state.decryptAndHash(message.subarray(KEY_BYTES + KEY_BYTES + NOISE_TAG_BYTES));
		return { remoteStatic: rs, payload };
	}

	async writeMessage2(
		payload: Uint8Array,
	): Promise<{ readonly message: Uint8Array; readonly transport: NoiseTransport }> {
		if (this.#step !== 1 || this.#remoteStatic === undefined || this.#remoteEphemeral === undefined) {
			throw new Error("Out of order");
		}
		this.#step = 2;
		const state = this.#state;
		const e = this.#options.ephemeral ?? (await generateDh());
		await state.mixHash(e.publicKey);
		await state.mixKey(await e.dh(this.#remoteEphemeral));
		await state.mixKey(await e.dh(this.#remoteStatic));
		const body = await state.encryptAndHash(payload);
		const message = concat(e.publicKey, body);
		if (message.byteLength > NOISE_MAX_MESSAGE) throw new Error("The second handshake message is too big");
		const [receive, send] = await state.split();
		return {
			message,
			transport: { send, receive, handshakeHash: state.h, remoteStatic: this.#remoteStatic },
		};
	}
}

/** Whether two handshake hashes match, for tests and channel binding. */
export const sameHandshake = (a: NoiseTransport, b: NoiseTransport): boolean =>
	equalBytes(a.handshakeHash, b.handshakeHash);
