/**
 * Checks a tar as it streams past, before any of it is extracted (`PUT /sandboxes/{id}/files/archive`): every entry must
 * land inside the directory it is extracted into. Refused (`invalid`): an absolute name or one that climbs out (`..`),
 * a symbolic link that points out (absolute, or climbing past the top, as resolved through the archive's other links in
 * whatever order they come), an entry at or under a link the archive made, hard links, devices, FIFOs and any other
 * kind of entry. POSIX (ustar, pax) and GNU (long names) tars are read; a
 * pax or GNU long name replaces the header's own, as tar itself does.
 *
 * It only reads: the caller keeps the bytes, and extracts them (with the sandbox's own `tar`) only once `end` has
 * answered, so a bad entry anywhere means nothing is written.
 */
import { KantelError } from "@kantel/contracts";

const BLOCK = 512;

/** What an archive holds, as `ExtractedArchive` answers it. */
export interface TarSummary {
	readonly files: number;
	readonly directories: number;
	readonly symlinks: number;
	/** Bytes of the files. */
	readonly bytes: number;
}

export interface TarCheckOptions {
	/** The most bytes of files it may hold: past it, `invalid`. */
	readonly maxBytes: number;
	/** The most entries it may hold. Default 1,000,000. */
	readonly maxEntries?: number;
}

const refuse = (message: string): never => {
	throw new KantelError("invalid", message);
};

/** Text of a NUL-terminated header field. */
function field(block: Uint8Array, offset: number, length: number): string {
	const bytes = block.subarray(offset, offset + length);
	const end = bytes.indexOf(0);
	return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** A numeric header field: octal text, or GNU's base-256 when its first byte's top bit is set. */
function numeric(block: Uint8Array, offset: number, length: number): number {
	const bytes = block.subarray(offset, offset + length);
	if (((bytes[0] ?? 0) & 0x80) !== 0) {
		let value = (bytes[0] ?? 0) & 0x7f;
		for (const byte of bytes.subarray(1)) value = value * 256 + byte;
		return value;
	}
	const text = new TextDecoder()
		.decode(bytes)
		.replace(/[\0 ]+$/, "")
		.trim();
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) refuse("The archive isn't a tar: a header has a bad number");
	return Number.parseInt(text, 8);
}

function checksumOk(block: Uint8Array): boolean {
	const stored = numeric(block, 148, 8);
	let sum = 0;
	for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
	return sum === stored;
}

/** A pax extended header's records: `<length> <key>=<value>\n` each. */
function paxRecords(data: Uint8Array): Map<string, string> {
	const records = new Map<string, string>();
	let at = 0;
	while (at < data.length) {
		const space = data.indexOf(0x20, at);
		if (space === -1) break;
		const length = Number.parseInt(new TextDecoder().decode(data.subarray(at, space)), 10);
		if (!Number.isInteger(length) || length <= 0 || at + length > data.length) {
			refuse("The archive has a bad pax header");
		}
		const record = new TextDecoder().decode(data.subarray(space + 1, at + length - 1));
		const equals = record.indexOf("=");
		if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
		at += length;
	}
	return records;
}

/**
 * An entry's name as a path relative to the top (`a/b`), or `""` for the top itself (`./`). Refuses an absolute name,
 * or one with `..` in it.
 */
export function entryPath(name: string): string {
	if (name.startsWith("/")) refuse(`The archive has an absolute name: ${JSON.stringify(name)}`);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
	if (/[\u0000-\u001f\u007f]/.test(name))
		refuse(`The archive has a name with control characters: ${JSON.stringify(name)}`);
	const parts: string[] = [];
	for (const part of name.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") refuse(`The archive has a name that climbs out: ${JSON.stringify(name)}`);
		parts.push(part);
	}
	return parts.join("/");
}

/** Whether a link at `path` (relative to the top) pointing at `target` stays inside the top. */
export function linkStaysInside(path: string, target: string): boolean {
	if (target === "" || target.startsWith("/")) return false;
	const parts = path.split("/").slice(0, -1);
	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return false;
			parts.pop();
		} else parts.push(part);
	}
	return true;
}

/**
 * The archive's symbolic links by path, a component at a time, so finding the link an entry is at or under, or the
 * link a component of a target names, costs the path's length and not the number of links.
 */
interface LinkNode {
	readonly children: Map<string, LinkNode>;
	/** Set when a link is at this path: its target and its whole path, for messages. */
	link?: { readonly target: string; readonly path: string };
}

/** How many links one link's target may go through, as Linux's `MAXSYMLINKS`: past it, a loop. */
const MAX_LINK_HOPS = 40;
/** The longest name or link target, as Linux's `PATH_MAX`. */
const MAX_NAME_LENGTH = 4096;
/** The most bytes of link names and targets an archive may hold, as they are kept until its end. */
const MAX_LINK_BYTES = 64 * 1024 * 1024;

/** A tar's checker: `push` each chunk as it comes, then `end`. Either throws `invalid` at the first problem. */
export class TarCheck {
	private readonly maxBytes: number;
	private readonly maxEntries: number;
	private header = new Uint8Array(BLOCK);
	private headerFill = 0;
	/** Data still to come for the current entry, then its padding. */
	private dataLeft = 0;
	private padLeft = 0;
	/** The current entry's data, kept when it is a pax header or a GNU long name. */
	private keep:
		| { readonly kind: "pax" | "longName" | "longLink"; readonly bytes: Uint8Array; fill: number }
		| undefined;
	private pax = new Map<string, string>();
	private longName: string | undefined;
	private longLink: string | undefined;
	private zeroBlocks = 0;
	private ended = false;
	private readonly links: LinkNode = { children: new Map() };
	private readonly linkList: { readonly path: string; readonly target: string; readonly name: string }[] = [];
	private files = 0;
	private directories = 0;
	private symlinks = 0;
	private linkBytes = 0;
	private bytes = 0;
	private entries = 0;

	constructor(options: TarCheckOptions) {
		this.maxBytes = options.maxBytes;
		this.maxEntries = options.maxEntries ?? 1_000_000;
	}

	push(chunk: Uint8Array): void {
		let at = 0;
		while (at < chunk.length) {
			if (this.ended) return;
			if (this.dataLeft > 0) {
				const take = Math.min(this.dataLeft, chunk.length - at);
				if (this.keep !== undefined) {
					this.keep.bytes.set(chunk.subarray(at, at + take), this.keep.fill);
					this.keep.fill += take;
				}
				this.dataLeft -= take;
				at += take;
				if (this.dataLeft === 0) this.dataDone();
				continue;
			}
			if (this.padLeft > 0) {
				const take = Math.min(this.padLeft, chunk.length - at);
				this.padLeft -= take;
				at += take;
				continue;
			}
			const take = Math.min(BLOCK - this.headerFill, chunk.length - at);
			this.header.set(chunk.subarray(at, at + take), this.headerFill);
			this.headerFill += take;
			at += take;
			if (this.headerFill === BLOCK) {
				this.headerFill = 0;
				this.onHeader(this.header);
			}
		}
	}

	/** What the archive held; `invalid` when it stopped part-way through an entry. */
	end(): TarSummary {
		if (!this.ended && (this.headerFill !== 0 || this.dataLeft > 0 || this.padLeft > 0 || this.keep !== undefined)) {
			refuse("The archive ends part-way through an entry");
		}
		if (this.entries === 0 && this.zeroBlocks === 0) refuse("The archive is empty");
		// Each link resolved through all the others, which may come after it: none may lead out.
		for (const link of this.linkList) {
			if (!this.resolvesInside(link.path, link.target)) {
				refuse(`The archive has a symbolic link that points out: ${link.name} -> ${link.target}`);
			}
		}
		return { files: this.files, directories: this.directories, symlinks: this.symlinks, bytes: this.bytes };
	}

	/** The link at or above `path` (`a/b/c`), if the archive made one there. */
	private linkAtOrAbove(path: string): string | undefined {
		if (path === "") return undefined;
		let node = this.links;
		for (const part of path.split("/")) {
			const next = node.children.get(part);
			if (next === undefined) return undefined;
			if (next.link !== undefined) return next.link.path;
			node = next;
		}
		return undefined;
	}

	private addLink(path: string, target: string, name: string): void {
		this.linkBytes += path.length + target.length;
		if (this.linkBytes > MAX_LINK_BYTES) refuse("The archive's symbolic links come to more than 64 MiB of names");
		let node = this.links;
		for (const part of path.split("/")) {
			let next = node.children.get(part);
			if (next === undefined) {
				next = { children: new Map() };
				node.children.set(part, next);
			}
			node = next;
		}
		// A link over another (an earlier one under it) would move that one where its target is.
		if (node.children.size > 0) refuse(`The archive has a symbolic link over its own symbolic links: ${name}`);
		node.link = { target, path };
		this.linkList.push({ path, target, name });
	}

	/**
	 * Whether the link at `path` pointing at `target` stays inside the top once each component naming one of the
	 * archive's links is replaced by that link's target, as the kernel resolves it after extraction. What isn't one of
	 * the archive's links is taken for a directory (or a name yet to be made) inside the top. Too many hops is a loop,
	 * refused too.
	 */
	private resolvesInside(path: string, target: string): boolean {
		if (target === "" || target.startsWith("/")) return false;
		// Where the walk is (its nodes in the link tree, `undefined` once off it), and the components still to walk, last
		// first.
		const nodes: (LinkNode | undefined)[] = [];
		let node: LinkNode | undefined = this.links;
		for (const part of path.split("/").slice(0, -1)) {
			nodes.push(node);
			node = node?.children.get(part);
		}
		const todo = target.split("/").reverse();
		let hops = 0;
		while (todo.length > 0) {
			const part = todo.pop() as string;
			if (part === "" || part === ".") continue;
			if (part === "..") {
				if (nodes.length === 0) return false;
				node = nodes.pop();
				continue;
			}
			const next: LinkNode | undefined = node?.children.get(part);
			if (next?.link !== undefined) {
				hops++;
				if (hops > MAX_LINK_HOPS) return false;
				if (next.link.target === "" || next.link.target.startsWith("/")) return false;
				// Resolved from the directory the link is in, which is where the walk is.
				for (const inner of next.link.target.split("/").reverse()) todo.push(inner);
				continue;
			}
			nodes.push(node);
			node = next;
		}
		return true;
	}

	private dataDone(): void {
		const kept = this.keep;
		this.keep = undefined;
		if (kept === undefined) return;
		const text = (bytes: Uint8Array) => {
			const end = bytes.indexOf(0);
			return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
		};
		if (kept.kind === "pax") this.pax = paxRecords(kept.bytes);
		else if (kept.kind === "longName") this.longName = text(kept.bytes);
		else this.longLink = text(kept.bytes);
	}

	private onHeader(block: Uint8Array): void {
		if (block.every((byte) => byte === 0)) {
			// Two zero blocks end the archive; whatever follows (a writer's padding) is ignored.
			this.zeroBlocks++;
			if (this.zeroBlocks >= 2) this.ended = true;
			return;
		}
		if (this.zeroBlocks > 0) refuse("The archive has an entry after its end");
		if (!checksumOk(block)) refuse("The archive isn't a tar (a header's checksum is wrong)");
		const type = String.fromCharCode(block[156] ?? 0);
		const paxSize = this.pax.get("size");
		const size = paxSize === undefined ? numeric(block, 124, 12) : Number.parseInt(paxSize, 10);
		if (!Number.isSafeInteger(size) || size < 0) refuse("The archive has an entry with a bad size");
		this.dataLeft = size;
		this.padLeft = (BLOCK - (size % BLOCK)) % BLOCK;
		if (type === "x" || type === "L" || type === "K") {
			// Metadata for the next entry: kept, within reason.
			if (size > 1024 * 1024) refuse("The archive has an extended header over 1 MiB");
			this.keep = {
				kind: type === "x" ? "pax" : type === "L" ? "longName" : "longLink",
				bytes: new Uint8Array(size),
				fill: 0,
			};
			if (size === 0) this.dataDone();
			return;
		}
		if (type === "g") {
			// Global pax settings: nothing in them changes where entries go, as a path there would be every entry's.
			return;
		}
		this.entries++;
		if (this.entries > this.maxEntries) refuse(`The archive has more than ${this.maxEntries} entries`);
		const magic = field(block, 257, 6);
		const prefix = magic.startsWith("ustar") ? field(block, 345, 155) : "";
		const headerName = prefix === "" ? field(block, 0, 100) : `${prefix}/${field(block, 0, 100)}`;
		const name = this.pax.get("path") ?? this.longName ?? headerName;
		const linkName = this.pax.get("linkpath") ?? this.longLink ?? field(block, 157, 100);
		this.pax = new Map();
		this.longName = undefined;
		this.longLink = undefined;
		if (name.length > MAX_NAME_LENGTH || linkName.length > MAX_NAME_LENGTH) {
			refuse(`The archive has a name or link target longer than ${MAX_NAME_LENGTH} characters`);
		}
		const path = entryPath(name);
		const under = this.linkAtOrAbove(path);
		if (under !== undefined) refuse(`The archive has an entry at or under its own symbolic link ${under}: ${name}`);
		switch (type) {
			case "0":
			case "\0":
			case "7":
				if (path === "") refuse("The archive has a file with no name");
				this.files++;
				this.bytes += size;
				if (this.bytes > this.maxBytes) refuse(`The archive's files come to more than ${this.maxBytes} bytes`);
				return;
			case "5":
				if (path !== "") this.directories++;
				return;
			case "2":
				if (path === "") refuse("The archive has a symbolic link with no name");
				if (!linkStaysInside(path, linkName)) {
					refuse(`The archive has a symbolic link that points out: ${name} -> ${linkName}`);
				}
				this.addLink(path, linkName, name);
				this.symlinks++;
				return;
			case "1":
				refuse(`The archive has a hard link, which isn't extracted: ${name}`);
				return;
			case "3":
			case "4":
				refuse(`The archive has a device, which isn't extracted: ${name}`);
				return;
			case "6":
				refuse(`The archive has a FIFO, which isn't extracted: ${name}`);
				return;
			default:
				refuse(`The archive has an entry of a kind that isn't extracted (${JSON.stringify(type)}): ${name}`);
		}
	}
}

/** `body` as it is, or gunzipped when it starts with gzip's magic bytes. */
export async function gunzipIfGzipped(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (length < 2) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		length += value.length;
	}
	const head = new Uint8Array(length);
	let at = 0;
	for (const chunk of chunks) {
		head.set(chunk, at);
		at += chunk.length;
	}
	const whole = new ReadableStream<Uint8Array>({
		start(controller) {
			if (head.length > 0) controller.enqueue(head);
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	if (head[0] !== 0x1f || head[1] !== 0x8b) return whole;
	return whole.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}
