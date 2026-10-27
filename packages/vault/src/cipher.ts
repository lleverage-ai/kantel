/**
 * How the vault seals item values at rest. Portable: Web Crypto only (Workers, Bun and Node), never `node:crypto`.
 *
 * `createAesGcmCipher` seals with AES-256-GCM, a fresh random 96-bit IV per seal, in a versioned envelope that names
 * the key: `hv1.<keyId>.<iv>.<ciphertext>`, both parts base64url. The additional authenticated data binds the item ID
 * and value version, so a sealed value copied onto another item (or replayed as another version) fails to open.
 */
import { HarbourError } from "@harbour/contracts";

/** What a sealed value is bound to; opening it under any other binding fails. */
export interface SealBinding {
	readonly itemId: string;
	readonly valueVersion: number;
}

export interface VaultCipher {
	/** Seals `value` for one item's value version. The result holds no plaintext and is safe to store. */
	seal(value: string, binding: SealBinding): Promise<string>;
	/** Opens what `seal` returned for the same binding; rejects with `unavailable` when it does not open. */
	open(sealed: string, binding: SealBinding): Promise<string>;
}

export interface AesGcmCipherOptions {
	/** The 256-bit key: 32 raw bytes, or those bytes base64-encoded (standard or url alphabet). */
	readonly key: Uint8Array | string;
	/**
	 * Names the key in every envelope, so a value sealed under another key is refused rather than misread. Letters,
	 * digits, `_` and `-`. Default: a fingerprint of the key (16 hex characters of a SHA-256 over a fixed label).
	 */
	readonly keyId?: string;
}

const ENVELOPE_VERSION = "hv1";
const IV_BYTES = 12;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Decode(text: string): Uint8Array {
	const standard = text.replace(/-/g, "+").replace(/_/g, "/");
	const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function keyBytes(key: Uint8Array | string): Uint8Array {
	let bytes: Uint8Array;
	try {
		bytes = typeof key === "string" ? base64Decode(key.trim()) : key;
	} catch {
		throw new HarbourError("invalid", "The vault key is not valid base64");
	}
	if (bytes.byteLength !== 32) throw new HarbourError("invalid", "The vault key must be 32 bytes (AES-256)");
	return bytes;
}

function additionalData(binding: SealBinding): Uint8Array<ArrayBuffer> {
	// Copied so the type is `Uint8Array<ArrayBuffer>` under workers-types too, whose `encode` returns `ArrayBufferLike`.
	return new Uint8Array(
		new TextEncoder().encode(`harbour-vault:${ENVELOPE_VERSION}:${binding.itemId}:${binding.valueVersion}`),
	);
}

/** A fresh random 256-bit key, for a vault whose values need not outlive the process (the in-memory target). */
export function randomCipherKey(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

/** AES-256-GCM over Web Crypto, in the `hv1` envelope. */
export function createAesGcmCipher(options: AesGcmCipherOptions): VaultCipher {
	const raw = keyBytes(options.key);
	if (options.keyId !== undefined && !KEY_ID.test(options.keyId)) {
		throw new HarbourError("invalid", "A key ID is 1 to 64 letters, digits, _ or -");
	}
	const material = new Uint8Array(raw);
	const cryptoKey = crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
	const keyId: Promise<string> =
		options.keyId !== undefined
			? Promise.resolve(options.keyId)
			: crypto.subtle
					.digest("SHA-256", new Uint8Array([...new TextEncoder().encode("harbour-vault-key-id:"), ...material]))
					.then((digest) =>
						[...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
					);

	return {
		async seal(value, binding) {
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
			const ciphertext = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: additionalData(binding) },
				await cryptoKey,
				new TextEncoder().encode(value),
			);
			return [ENVELOPE_VERSION, await keyId, base64UrlEncode(iv), base64UrlEncode(new Uint8Array(ciphertext))].join(
				".",
			);
		},

		async open(sealed, binding) {
			const parts = sealed.split(".");
			if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
				throw new HarbourError("unavailable", "The sealed value is not in a known envelope");
			}
			if (parts[1] !== (await keyId)) {
				throw new HarbourError(
					"unavailable",
					`The value is sealed under key ${parts[1]}, which this vault does not hold`,
				);
			}
			try {
				const iv = new Uint8Array(base64Decode(parts[2]!));
				const ciphertext = new Uint8Array(base64Decode(parts[3]!));
				const plaintext = await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv, additionalData: additionalData(binding) },
					await cryptoKey,
					ciphertext,
				);
				return new TextDecoder().decode(plaintext);
			} catch {
				throw new HarbourError("unavailable", `The value of item ${binding.itemId} does not open`);
			}
		},
	};
}
