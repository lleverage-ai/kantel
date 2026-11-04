/**
 * The keys a device or a host holds: an Ed25519 key that signs (chain entries, join tickets) and an X25519 key that
 * Noise sessions are opened with. Both come from 32-byte seeds kept by their owner (a 0600 file for the CLI, root's
 * /etc/kantel-host for a host); nothing else ever has them. Public keys and IDs are what the chain records.
 *
 * WebCrypto only, so the same code runs in browsers (Chrome 137+, Firefox 129+, Safari 17+), Workers, Bun and Node.
 * WebCrypto takes a private key of either curve only as PKCS #8, so a seed is wrapped in the fixed PKCS #8 prefix of
 * RFC 8410 to import it; the public half is read back from the key's JWK.
 */
import { concat, equalBytes, fromBase64url, fromHex, own, sha256, toBase64url, toHex, utf8 } from "./bytes.ts";

/** The DER of a PKCS #8 private key of each curve, up to the 32-byte seed (RFC 8410, section 7). */
const PKCS8_PREFIX = {
	Ed25519: fromHex("302e020100300506032b657004220420"),
	X25519: fromHex("302e020100300506032b656e04220420"),
} as const;

type Curve = keyof typeof PKCS8_PREFIX;

/** WebCrypto's key, named without the DOM lib (the repo type-checks against Node's and Workers' globals). */
export type WebKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type Usage = "sign" | "verify" | "deriveBits";

export const KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

export function randomSeed(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

async function importSeed(
	curve: Curve,
	seed: Uint8Array,
	usages: Usage[],
): Promise<{ privateKey: WebKey; publicKey: WebKey }> {
	if (seed.byteLength !== KEY_BYTES) throw new Error(`A ${curve} seed is ${KEY_BYTES} bytes`);
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		own(concat(PKCS8_PREFIX[curve], seed)),
		{ name: curve },
		true,
		usages,
	);
	// Cast: Workers' types answer exportKey with a union whatever the format.
	const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as { x?: string };
	if (typeof jwk.x !== "string") throw new Error(`This runtime didn't give the ${curve} public key`);
	const publicKey = await crypto.subtle.importKey(
		"raw",
		own(fromBase64url(jwk.x)),
		{ name: curve },
		true,
		curve === "Ed25519" ? ["verify"] : [],
	);
	return { privateKey, publicKey };
}

async function rawPublic(key: WebKey): Promise<Uint8Array> {
	return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

/** An Ed25519 key that signs. */
export interface Signer {
	/** The raw 32-byte public key. */
	readonly publicKey: Uint8Array;
	sign(message: Uint8Array): Promise<Uint8Array>;
}

export async function signerFromSeed(seed: Uint8Array): Promise<Signer> {
	const pair = await importSeed("Ed25519", seed, ["sign"]);
	const publicKey = await rawPublic(pair.publicKey);
	return {
		publicKey,
		async sign(message) {
			return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, own(message)));
		},
	};
}

/** Whether `signature` is `publicKey`'s over `message`. A key or signature of the wrong length is simply not. */
export async function verifySignature(
	publicKey: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	if (publicKey.byteLength !== KEY_BYTES || signature.byteLength !== SIGNATURE_BYTES) return false;
	try {
		const key = await crypto.subtle.importKey("raw", own(publicKey), { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify({ name: "Ed25519" }, key, own(signature), own(message));
	} catch {
		return false;
	}
}

/** An X25519 key pair for Noise. */
export interface DhKeyPair {
	readonly publicKey: Uint8Array;
	/** The shared secret with `remote` (32 bytes); throws on a low-order point, whose secret would be all zero. */
	dh(remote: Uint8Array): Promise<Uint8Array>;
}

export async function dhFromSeed(seed: Uint8Array): Promise<DhKeyPair> {
	const pair = await importSeed("X25519", seed, ["deriveBits"]);
	const publicKey = await rawPublic(pair.publicKey);
	return {
		publicKey,
		async dh(remote) {
			if (remote.byteLength !== KEY_BYTES) throw new Error("An X25519 public key is 32 bytes");
			const key = await crypto.subtle.importKey("raw", own(remote), { name: "X25519" }, false, []);
			const shared = new Uint8Array(
				// Cast: Workers' types spell the standard `public` member `$public`; the runtime takes `public`.
				await crypto.subtle.deriveBits(
					{ name: "X25519", public: key } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0],
					pair.privateKey,
					256,
				),
			);
			if (equalBytes(shared, new Uint8Array(KEY_BYTES))) throw new Error("A low-order X25519 key");
			return shared;
		},
	};
}

/** A fresh X25519 pair: a Noise session's ephemeral key. */
export function generateDh(): Promise<DhKeyPair> {
	return dhFromSeed(randomSeed());
}

/** What a device or host keeps secret: the two seeds. */
export interface KeySeeds {
	/** Base64url of the Ed25519 seed. */
	readonly sign: string;
	/** Base64url of the X25519 private key. */
	readonly dh: string;
}

export interface Identity {
	readonly signer: Signer;
	readonly static: DhKeyPair;
	readonly seeds: KeySeeds;
}

export async function identityFromSeeds(seeds: KeySeeds): Promise<Identity> {
	return {
		signer: await signerFromSeed(fromBase64url(seeds.sign)),
		static: await dhFromSeed(fromBase64url(seeds.dh)),
		seeds,
	};
}

export function newIdentity(): Promise<Identity> {
	return identityFromSeeds({ sign: toBase64url(randomSeed()), dh: toBase64url(randomSeed()) });
}

/**
 * The ID a key pair goes by in the chain: a prefix (`kd` for a device, `kh` for a host), then the first 16 bytes of the
 * SHA-256 of its Ed25519 public key, in hex. Anyone can work it out from the key, so nobody can claim another's.
 */
export async function keyId(prefix: "kd" | "kh", signPublicKey: Uint8Array): Promise<string> {
	return `${prefix}_${toHex((await sha256(signPublicKey)).subarray(0, 16))}`;
}

/**
 * A fingerprint people compare by reading it out: the first 10 bytes of the SHA-256 of both public keys, as five
 * groups of four hex digits. A device's when it is approved; a host's when its join command came through the hosted
 * console; a chain's genesis the first time a device sees it.
 */
export async function fingerprint(...publicKeys: readonly Uint8Array[]): Promise<string> {
	const digest = toHex((await sha256(concat(utf8("kantel-fingerprint/1"), ...publicKeys))).subarray(0, 10));
	return (digest.match(/.{4}/g) ?? []).join("-");
}
