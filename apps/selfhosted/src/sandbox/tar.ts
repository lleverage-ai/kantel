// Minimal ustar writer and reader, enough to move a workspace version into a
// container and back through Docker's archive API. Long names use PAX headers.

export type TarEntry =
	| { type: "file"; path: string; mode: number; data: Uint8Array }
	| { type: "dir"; path: string; mode: number }
	| { type: "symlink"; path: string; target: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BLOCK = 512;

function octal(value: number, length: number): string {
	return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(name: string, options: { size: number; mode: number; type: string; linkname?: string }): Uint8Array {
	const block = new Uint8Array(BLOCK);
	const put = (text: string, offset: number, length: number) => block.set(encoder.encode(text).subarray(0, length), offset);
	put(name, 0, 100);
	put(octal(options.mode & 0o7777, 8), 100, 8);
	// Owned by the sandbox user (uid and gid 1000 in images/sandbox).
	put(octal(1000, 8), 108, 8);
	put(octal(1000, 8), 116, 8);
	put(octal(options.size, 12), 124, 12);
	put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
	put("        ", 148, 8);
	put(options.type, 156, 1);
	put(options.linkname ?? "", 157, 100);
	put("ustar\0", 257, 6);
	put("00", 263, 2);
	let sum = 0;
	for (const byte of block) sum += byte;
	put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
	return block;
}

function pax(records: Record<string, string>): Uint8Array {
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

export function writeTar(entries: TarEntry[]): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const entry of entries) {
		const name = entry.type === "dir" ? `${entry.path}/` : entry.path;
		const linkname = entry.type === "symlink" ? entry.target : undefined;
		if (encoder.encode(name).length > 100 || (linkname && encoder.encode(linkname).length > 100)) {
			const records: Record<string, string> = { path: name };
			if (linkname) records.linkpath = linkname;
			const body = pax(records);
			parts.push(header("././@PaxHeader", { size: body.length, mode: 0o644, type: "x" }), ...padded(body));
		}
		if (entry.type === "file") {
			parts.push(header(name, { size: entry.data.length, mode: entry.mode, type: "0" }), ...padded(entry.data));
		} else if (entry.type === "dir") {
			parts.push(header(name, { size: 0, mode: entry.mode, type: "5" }));
		} else {
			parts.push(header(name, { size: 0, mode: 0o777, type: "2", linkname }));
		}
	}
	parts.push(new Uint8Array(BLOCK * 2));
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

const field = (block: Uint8Array, offset: number, length: number) => {
	const slice = block.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
};

function parsePax(body: string): Record<string, string> {
	const records: Record<string, string> = {};
	let offset = 0;
	while (offset < body.length) {
		const space = body.indexOf(" ", offset);
		if (space === -1) break;
		const length = Number(body.slice(offset, space));
		if (!Number.isFinite(length) || length <= 0) break;
		const line = body.slice(space + 1, offset + length - 1);
		const eq = line.indexOf("=");
		records[line.slice(0, eq)] = line.slice(eq + 1);
		offset += length;
	}
	return records;
}

export function readTar(archive: Uint8Array): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	let next: Record<string, string> = {};
	while (offset + BLOCK <= archive.length) {
		const block = archive.subarray(offset, offset + BLOCK);
		if (block.every((b) => b === 0)) break;
		const size = Number.parseInt(field(block, 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(block[156] || 48);
		const prefix = field(block, 345, 155);
		let name = field(block, 0, 100);
		if (prefix) name = `${prefix}/${name}`;
		const data = archive.subarray(offset + BLOCK, offset + BLOCK + size);
		offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
		if (type === "x") {
			next = { ...next, ...parsePax(decoder.decode(data)) };
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
		const path = (next.path ?? name).replace(/\/+$/, "");
		const mode = Number.parseInt(field(block, 100, 8).trim() || "644", 8);
		const linkname = next.linkpath ?? field(block, 157, 100);
		next = {};
		if (type === "0" || type === "7") entries.push({ type: "file", path, mode, data: data.slice() });
		else if (type === "5") entries.push({ type: "dir", path, mode });
		else if (type === "2") entries.push({ type: "symlink", path, target: linkname });
		// Hard links, devices and FIFOs are not part of a workspace.
	}
	return entries;
}
