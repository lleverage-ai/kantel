/** Bytes helpers the rest of the package shares. Portable: browsers, Workers, Bun and Node. */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

/** UTF-8 that must be valid: throws on anything else, so a payload can't mean two things. */
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

/** Base64url without padding, as every key, signature and hash in the chain is written. */
export function toBase64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The bytes of base64url without padding; throws on anything else (padding, `+`, `/`, a stray length). */
export function fromBase64url(text: string): Uint8Array {
	if (!BASE64URL.test(text) || text.length % 4 === 1) throw new Error("Not base64url");
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	// One encoding per value: a string whose spare bits aren't zero decodes, but isn't the encoding of its bytes.
	if (toBase64url(out) !== text) throw new Error("Not base64url");
	return out;
}

export function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromHex(text: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/i.test(text)) throw new Error("Not hex");
	const out = new Uint8Array(text.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Compares in time that doesn't depend on where the bytes differ. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	let diff = a.byteLength ^ b.byteLength;
	for (let i = 0; i < Math.max(a.byteLength, b.byteLength); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

/** WebCrypto wants an ArrayBuffer-backed view; a subarray of a SharedArrayBuffer or a Node Buffer pool may not be. */
export function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", own(bytes)));
}
