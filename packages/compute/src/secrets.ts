/**
 * Sealing for what the compute plane must keep but never show: environments' protected variable values and secret
 * files. AES-256-GCM through WebCrypto (`crypto.subtle`), so it runs on Node, Bun and Cloudflare Workers alike.
 *
 * The key is the deployment's `KANTEL_SECRETS_KEY`: 32 bytes, base64. Each value is sealed with a fresh 96-bit IV and
 * with additional data naming where it is kept, `<collection>:<recordId>:<field>` (`sealedAt`), so a sealed value
 * copied into another record or field fails to open rather than turning up there. A sealed value is kept as
 * `{ v: 1, iv, ct }`, both base64.
 *
 * Without a key, a store that lasts only as long as the process (memory) seals with a key made at random for the
 * process (`createEphemeralSealer`); a store that outlasts it (SQL) seals nothing, as what it sealed would be
 * unreadable after a restart: the service refuses protected values and secret files there.
 */
import { KantelError } from "@kantel/contracts";
import { base64ToBytes, bytesToBase64 } from "./util.ts";

/** A value sealed with AES-256-GCM: version 1, the IV and the ciphertext with its tag, both base64. */
export interface SealedValue {
	readonly v: 1;
	readonly iv: string;
	readonly ct: string;
}

/** Seals and opens values with one key. */
export interface Sealer {
	/** Seals `plain` (UTF-8 for a string) for the place `aad` names (`sealedAt`). */
	seal(plain: string | Uint8Array, aad: string): Promise<SealedValue>;
	/** The bytes `seal` was given; `unavailable` when they were sealed with another key or for another place. */
	open(sealed: SealedValue, aad: string): Promise<Uint8Array>;
	/** `open`, as UTF-8 text. */
	openText(sealed: SealedValue, aad: string): Promise<string>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const encoder = new TextEncoder();
const KEY_SHAPE = "KANTEL_SECRETS_KEY must be 32 bytes in base64, such as `openssl rand -base64 32` prints";

/** Where a sealed value is kept, as its additional data: `<collection>:<recordId>:<field>`. */
export const sealedAt = (collection: string, recordId: string, field: string): string =>
	`${collection}:${recordId}:${field}`;

/**
 * The key's bytes from `KANTEL_SECRETS_KEY`'s text. Throws an `Error` that names the setting, never its value, unless
 * it is 32 bytes of base64: a deployment should fail to start with a key it can't use, not later on a write.
 */
export function parseSecretsKey(text: string): Uint8Array<ArrayBuffer> {
	const trimmed = text.trim();
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = base64ToBytes(trimmed);
	} catch {
		throw new Error(KEY_SHAPE);
	}
	if (bytes.byteLength !== KEY_BYTES) throw new Error(KEY_SHAPE);
	return bytes;
}

function sealerOver(raw: Uint8Array<ArrayBuffer>): Sealer {
	const key = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
	// Awaited by every call; a failure here is that call's.
	key.catch(() => undefined);
	const open = async (sealed: SealedValue, aad: string): Promise<Uint8Array> => {
		if (sealed?.v !== 1 || typeof sealed.iv !== "string" || typeof sealed.ct !== "string") {
			throw new KantelError("unavailable", "A sealed value is not in a form this version reads");
		}
		try {
			return new Uint8Array(
				await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv: base64ToBytes(sealed.iv), additionalData: encoder.encode(aad) },
					await key,
					base64ToBytes(sealed.ct),
				),
			);
		} catch {
			// Only that it didn't open: never the value, nor WebCrypto's reason.
			throw new KantelError(
				"unavailable",
				"A sealed value could not be opened: the deployment's secrets key may have changed",
			);
		}
	};
	return {
		async seal(plain, aad) {
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
			const bytes = typeof plain === "string" ? encoder.encode(plain) : new Uint8Array(plain);
			const ct = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
				await key,
				bytes,
			);
			return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
		},
		open,
		async openText(sealed, aad) {
			return new TextDecoder().decode(await open(sealed, aad));
		},
	};
}

/** A sealer over `KANTEL_SECRETS_KEY`'s text; throws at once when it isn't a key (`parseSecretsKey`). */
export function createSealer(keyText: string): Sealer {
	return sealerOver(parseSecretsKey(keyText));
}

/** A sealer over a key made at random now: only for a store that lasts as long as the process. */
export function createEphemeralSealer(): Sealer {
	return sealerOver(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}
