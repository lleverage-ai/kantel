/**
 * A minimal tar writer and reader, enough to move workspace files into a container and back through Docker's archive
 * API and an in-container `tarfile`. Ported from apps/selfhosted/src/sandbox/tar.ts.
 *
 * - The writer emits ustar entries for regular files and directories, with a PAX header when a name (or a size) does not
 *   fit the ustar fields. Ownership is per entry, the sandbox user (1000:1000) by default.
 * - The reader returns regular files (with their mode bits and contents) and directories, and skips every other kind
 *   (symlinks, hard links, devices, FIFOs): none of them is part of a workspace. It understands PAX (`x`, `g`) and GNU
 *   long-name (`L`, `K`) records.
 */

export type TarEntry =
	| {
			readonly type: "file";
			readonly path: string;
			readonly mode: number;
			readonly data: Uint8Array;
			readonly uid?: number;
			readonly gid?: number;
	  }
	| {
			readonly type: "dir";
			readonly path: string;
			readonly mode: number;
			readonly uid?: number;
			readonly gid?: number;
	  };

export interface TarWriteOptions {
	/** Modification time of every entry, in seconds since the epoch; now when absent. */
	readonly mtime?: number;
}

/** The sandbox user's IDs (images/sandbox/Dockerfile). */
export const SANDBOX_UID = 1000;
export const SANDBOX_GID = 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BLOCK = 512;
/** The largest size the 12-byte octal field holds; bigger files carry their size in a PAX record. */
const MAX_OCTAL_SIZE = 0o77777777777;

function octal(value: number, length: number): string {
	return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

interface HeaderFields {
	readonly size: number;
	readonly mode: number;
	readonly type: string;
	readonly uid: number;
	readonly gid: number;
	readonly mtime: number;
}

function header(name: string, fields: HeaderFields): Uint8Array {
	const block = new Uint8Array(BLOCK);
	const put = (text: string, offset: number, length: number) =>
		block.set(encoder.encode(text).subarray(0, length), offset);
	put(name, 0, 100);
	put(octal(fields.mode & 0o7777, 8), 100, 8);
	put(octal(fields.uid, 8), 108, 8);
	put(octal(fields.gid, 8), 116, 8);
	put(octal(Math.min(fields.size, MAX_OCTAL_SIZE), 12), 124, 12);
	put(octal(fields.mtime, 12), 136, 12);
	put("        ", 148, 8);
	put(fields.type, 156, 1);
	put("ustar\0", 257, 6);
	put("00", 263, 2);
	let sum = 0;
	for (const byte of block) sum += byte;
	put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
	return block;
}

/** PAX records: each line is `<length> <key>=<value>\n`, the length counting itself, in bytes. */
function pax(records: Readonly<Record<string, string>>): Uint8Array {
	let body = "";
	for (const [key, value] of Object.entries(records)) {
		const line = ` ${key}=${value}\n`;
		const base = encoder.encode(line).length;
		let length = base + String(base).length;
		while (base + String(length).length !== length) length = base + String(length).length;
		body += `${length}${line}`;
	}
	return encoder.encode(body);
}

function padded(data: Uint8Array): Uint8Array[] {
	const rest = data.length % BLOCK;
	return rest === 0 ? [data] : [data, new Uint8Array(BLOCK - rest)];
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** A tar archive of `entries`, in order. Directory paths may be given with or without a trailing slash. */
export function writeTar(entries: readonly TarEntry[], options: TarWriteOptions = {}): Uint8Array {
	const mtime = options.mtime ?? Math.floor(Date.now() / 1000);
	const parts: Uint8Array[] = [];
	for (const entry of entries) {
		const bare = entry.path.replace(/\/+$/, "");
		if (bare === "" || bare.startsWith("/")) throw new Error(`tar entry path must be relative: ${entry.path}`);
		const name = entry.type === "dir" ? `${bare}/` : bare;
		const size = entry.type === "file" ? entry.data.length : 0;
		const records: Record<string, string> = {};
		if (encoder.encode(name).length > 100) records.path = name;
		if (size > MAX_OCTAL_SIZE) records.size = String(size);
		if (Object.keys(records).length > 0) {
			const body = pax(records);
			parts.push(
				header("././@PaxHeader", { size: body.length, mode: 0o644, type: "x", uid: 0, gid: 0, mtime }),
				...padded(body),
			);
		}
		const owner = { uid: entry.uid ?? SANDBOX_UID, gid: entry.gid ?? SANDBOX_GID, mtime };
		if (entry.type === "file") {
			parts.push(header(name, { size, mode: entry.mode, type: "0", ...owner }), ...padded(entry.data));
		} else {
			parts.push(header(name, { size: 0, mode: entry.mode, type: "5", ...owner }));
		}
	}
	parts.push(new Uint8Array(BLOCK * 2));
	return concatBytes(parts);
}

const field = (block: Uint8Array, offset: number, length: number) => {
	const slice = block.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
};

function numeric(block: Uint8Array, offset: number, length: number, fallback: number): number {
	const text = field(block, offset, length).trim();
	if (text === "") return fallback;
	const value = Number.parseInt(text, 8);
	return Number.isFinite(value) ? value : fallback;
}

/** Parses PAX records on bytes: their lengths count bytes, not characters. */
function parsePax(body: Uint8Array): Record<string, string> {
	const records: Record<string, string> = {};
	let offset = 0;
	while (offset < body.length) {
		const space = body.indexOf(0x20, offset);
		if (space === -1) break;
		const length = Number(decoder.decode(body.subarray(offset, space)));
		if (!Number.isInteger(length) || length <= 0 || offset + length > body.length) break;
		const line = decoder.decode(body.subarray(space + 1, offset + length - 1));
		const eq = line.indexOf("=");
		if (eq > 0) records[line.slice(0, eq)] = line.slice(eq + 1);
		offset += length;
	}
	return records;
}

/** The regular files and directories of a tar archive, in order; every other kind is skipped. */
export function readTar(archive: Uint8Array): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	let next: Record<string, string> = {};
	while (offset + BLOCK <= archive.length) {
		const block = archive.subarray(offset, offset + BLOCK);
		if (block.every((byte) => byte === 0)) break;
		const type = String.fromCharCode(block[156] || 48);
		let size = numeric(block, 124, 12, 0);
		if (next.size !== undefined && type !== "x" && type !== "g") size = Number(next.size);
		const data = archive.subarray(offset + BLOCK, offset + BLOCK + size);
		offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
		if (type === "x") {
			next = { ...next, ...parsePax(data) };
			continue;
		}
		if (type === "g") continue;
		if (type === "L") {
			next.path = decoder.decode(data).replace(/\0+$/, "");
			continue;
		}
		if (type === "K") {
			next.linkpath = decoder.decode(data).replace(/\0+$/, "");
			continue;
		}
		let name = field(block, 0, 100);
		// The prefix field exists only in POSIX ustar headers; GNU headers keep other data there.
		const ustar = field(block, 257, 6) === "ustar";
		const prefix = ustar ? field(block, 345, 155) : "";
		if (prefix !== "") name = `${prefix}/${name}`;
		const path = (next.path ?? name).replace(/^\.\//, "").replace(/\/+$/, "");
		const mode = numeric(block, 100, 8, 0o644) & 0o7777;
		const uid = numeric(block, 108, 8, 0);
		const gid = numeric(block, 116, 8, 0);
		next = {};
		if (path === "" || path === ".") continue;
		if (type === "0" || type === "7") entries.push({ type: "file", path, mode, data: data.slice(), uid, gid });
		else if (type === "5") entries.push({ type: "dir", path, mode, uid, gid });
		// Symlinks, hard links, devices and FIFOs are not part of a workspace.
	}
	return entries;
}
