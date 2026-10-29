/**
 * Sealing for what a browser leaves behind: a context's profile (cookies, local storage) and a recording's frames. Both
 * go to a blob store (R2, S3 or a directory) sealed with AES-256-GCM, so the store alone gives away nothing. The key
 * is `HARBOUR_BROWSER_SEAL_KEY`, a secret of at least 32 bytes; each blob gets a fresh 12-byte IV and its key name as
 * associated data, so a blob moved to another key doesn't open.
 *
 * After brwsr's at-rest sealing (tvdavies/brwsr@0d22bf8, src/at-rest.ts and src/context-crypto.ts), much simplified:
 * one key per deployment, no rotation yet. Portable: WebCrypto only.
 */
import { HarbourError } from "@harbour/contracts";

const VERSION = 1;
const IV_BYTES = 12;
const encoder = new TextEncoder();

export interface Sealer {
	seal(key: string, plain: Uint8Array): Promise<Uint8Array>;
	open(key: string, sealed: Uint8Array): Promise<Uint8Array>;
}

/** A sealer over `secret` (any string of at least 32 characters; base64 of 32 random bytes is the usual). */
export function createSealer(secret: string): Sealer {
	if (secret.length < 32) throw new HarbourError("invalid", "The browser seal key must be at least 32 characters");
	const key = (async () => {
		const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`harbour-browser-seal:${secret}`));
		return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
	})();
	return {
		async seal(name, plain) {
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
			const cipher = new Uint8Array(
				await crypto.subtle.encrypt(
					{ name: "AES-GCM", iv, additionalData: encoder.encode(name) },
					await key,
					plain as Uint8Array<ArrayBuffer>,
				),
			);
			const out = new Uint8Array(1 + IV_BYTES + cipher.length);
			out[0] = VERSION;
			out.set(iv, 1);
			out.set(cipher, 1 + IV_BYTES);
			return out;
		},
		async open(name, sealed) {
			if (sealed.length < 1 + IV_BYTES + 16 || sealed[0] !== VERSION) {
				throw new HarbourError("invalid", "Not a sealed browser blob");
			}
			try {
				return new Uint8Array(
					await crypto.subtle.decrypt(
						{ name: "AES-GCM", iv: sealed.slice(1, 1 + IV_BYTES), additionalData: encoder.encode(name) },
						await key,
						sealed.slice(1 + IV_BYTES),
					),
				);
			} catch {
				throw new HarbourError("invalid", "A sealed browser blob did not open");
			}
		},
	};
}
