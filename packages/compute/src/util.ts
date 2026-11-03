/**
 * Small helpers the compute plane shares: random IDs and secrets, base64, SHA-256, paths and pages. Web APIs only
 * (`crypto`, `btoa`), so they run wherever `fetch` does.
 */
import { KantelError } from "@kantel/contracts";

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `length` characters drawn uniformly from `alphabet` (rejection sampling, so no character is likelier). */
function randomFrom(alphabet: string, length: number): string {
	const limit = 256 - (256 % alphabet.length);
	let out = "";
	while (out.length < length) {
		const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
		for (const byte of bytes) {
			if (byte >= limit) continue;
			out += alphabet.charAt(byte % alphabet.length);
			if (out.length === length) break;
		}
	}
	return out;
}

/** An ID such as `sbx_4kq9x2mt`. */
export const randomId = (prefix: string, length = 10): string => `${prefix}_${randomFrom(BASE36, length)}`;

/** A secret such as `ksk_` and 32 base62 characters. */
export const randomSecret = (prefix: string, length = 32): string => `${prefix}${randomFrom(BASE62, length)}`;

/**
 * A code for a person to read and type, such as `BCDF-GHJK`: eight upper-case consonants (no vowels, so no words; none
 * that look like digits), in two groups of four, as RFC 8628 suggests for a device sign-in's user code.
 */
export const randomUserCode = (): string => {
	const code = randomFrom("BCDFGHJKLMNPQRSTVWXZ", 8);
	return `${code.slice(0, 4)}-${code.slice(4)}`;
};

/** Lower-case letters and digits, for subdomains. */
export const randomSlug = (length: number): string => randomFrom(BASE36, length);

/** Bytes as standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/** Standard base64 as bytes; `invalid` when it isn't base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
	let binary: string;
	try {
		binary = atob(text);
	} catch {
		throw new KantelError("invalid", "The content is not valid base64");
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** The SHA-256 of a string, as lower-case hex. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The sandbox user's home, where relative paths start. */
export const HOME = "/home/user";

/** An absolute, normalised path: relative ones start at `HOME`; `.` and `..` are resolved, never above `/`. */
export function resolvePath(path: string, base = HOME): string {
	const joined = path.startsWith("/") ? path : `${base}/${path}`;
	const parts: string[] = [];
	for (const part of joined.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/** At most `length` bytes of `bytes` from `offset`; empty from the end on. */
export const sliceRange = (
	bytes: Uint8Array,
	range: { readonly offset: number; readonly length: number },
): Uint8Array =>
	bytes.subarray(Math.min(range.offset, bytes.byteLength), Math.min(range.offset + range.length, bytes.byteLength));

/** The last segment of an absolute path. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || "/";

/** The longest page a list answers, and the default. */
export const MAX_PAGE = 500;
export const DEFAULT_PAGE = 50;

/** One page of `items`, with an opaque cursor (a base64 offset) when more follow. */
export function paginate<T>(
	items: readonly T[],
	limit: number | undefined,
	cursor: string | undefined,
): { items: T[]; nextCursor?: string } {
	let offset = 0;
	if (cursor !== undefined) {
		let decoded = "";
		try {
			decoded = atob(cursor);
		} catch {
			throw new KantelError("invalid", "The cursor is not valid");
		}
		if (!/^\d+$/.test(decoded)) throw new KantelError("invalid", "The cursor is not valid");
		offset = Number(decoded);
	}
	const size = Math.min(Math.max(limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
	const page = items.slice(offset, offset + size);
	const next = offset + size;
	return next < items.length ? { items: page, nextCursor: btoa(String(next)) } : { items: page };
}
