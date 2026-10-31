/**
 * Lazy hydration's staging packs (packages/workspace/CONTRACT.md). A lazy seed stores its tree at once and its
 * file bodies as a few pack objects instead of one object per body, so `create` costs a handful of object writes
 * whatever the repository's size. A read of a body that is not yet in its own blob object reads it from its pack (a
 * ranged read where the store has one), so only that read waits; a background pass then copies every body out to its
 * blob, and the workspace is hydrated.
 *
 * Layout, under the organisation's prefix like every other object:
 *   org/<organisation>/packs/<sha256>.pack        the bodies, concatenated; the key is the hash of these bytes
 *   org/<organisation>/packs/<sha256>.pack.json   its index: each body's digest, offset and length
 *   org/<organisation>/packs/<sha256>.pack.done   written once every body in the pack is in its own blob object
 *
 * Packs are immutable and content-addressed, as blobs and trees are, so two seeds of the same content share them and
 * a pack is never stale. Every body read from a pack is checked against its digest before it is returned.
 */
import { KantelError } from "@kantel/contracts";
import { sha256Hex, toBytes } from "./index.ts";

/** The most bytes one staging pack holds; larger seeds are split, so no single write or read is unbounded. */
export const PACK_BYTES = 32 * 1024 * 1024;

/** A pack's index: each body's digest, mapped to its offset and length in the pack. */
export type PackIndex = ReadonlyMap<string, readonly [offset: number, length: number]>;

/** A staging pack as built, before it is written. */
export interface BuiltPack {
	readonly key: string;
	readonly bytes: Uint8Array;
	readonly index: PackIndex;
}

/** What the packs need of a store: `WorkspaceStore`'s objects, with its optional ranged read. */
export interface PackObjects {
	getObject(key: string): Promise<Uint8Array | undefined>;
	getObjectRange?(key: string, offset: number, length: number): Promise<Uint8Array | undefined>;
	putObject(key: string, bytes: Uint8Array): Promise<void>;
}

export function packIndexKey(packKey: string): string {
	return `${packKey}.json`;
}

export function packDoneKey(packKey: string): string {
	return `${packKey}.done`;
}

/**
 * Packs the bodies into packs of at most `maxBytes` each (a body larger than that is a pack of its own), in the order
 * given, so a caller can put the bodies it expects to be read first at the front.
 */
export async function buildPacks(
	prefix: string,
	bodies: ReadonlyMap<string, Uint8Array>,
	maxBytes = PACK_BYTES,
): Promise<BuiltPack[]> {
	const groups: [string, Uint8Array][][] = [];
	let current: [string, Uint8Array][] = [];
	let size = 0;
	for (const entry of bodies) {
		if (current.length > 0 && size + entry[1].byteLength > maxBytes) {
			groups.push(current);
			current = [];
			size = 0;
		}
		current.push(entry);
		size += entry[1].byteLength;
	}
	if (current.length > 0) groups.push(current);
	const packs: BuiltPack[] = [];
	for (const group of groups) {
		const total = group.reduce((sum, [, body]) => sum + body.byteLength, 0);
		const bytes = new Uint8Array(total);
		const index = new Map<string, readonly [number, number]>();
		let offset = 0;
		for (const [digest, body] of group) {
			bytes.set(body, offset);
			index.set(digest, [offset, body.byteLength]);
			offset += body.byteLength;
		}
		packs.push({ key: `${prefix}/packs/${await sha256Hex(bytes)}.pack`, bytes, index });
	}
	return packs;
}

export function serialisePackIndex(index: PackIndex): Uint8Array {
	const entries: Record<string, readonly [number, number]> = Object.create(null);
	for (const [digest, range] of index) entries[digest] = range;
	return toBytes(JSON.stringify({ v: 1, entries }));
}

export function parsePackIndex(bytes: Uint8Array, key: string): PackIndex {
	const corrupt = () => new KantelError("unavailable", `workspace pack index ${key} is malformed`);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw corrupt();
	}
	const entries = (value as { entries?: unknown } | null)?.entries;
	if (typeof entries !== "object" || entries === null || Array.isArray(entries)) throw corrupt();
	const index = new Map<string, readonly [number, number]>();
	for (const [digest, range] of Object.entries(entries as Record<string, unknown>)) {
		if (!/^[0-9a-f]{64}$/.test(digest) || !Array.isArray(range) || range.length !== 2) throw corrupt();
		const [offset, length] = range as unknown[];
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || (offset as number) < 0) throw corrupt();
		if ((length as number) < 0) throw corrupt();
		index.set(digest, [offset as number, length as number]);
	}
	return index;
}

/**
 * Reads bodies out of staging packs, for one `StoredWorkspaces` instance. Keeps the packs this process staged in
 * memory until they are hydrated (so its own reads cost no request), and every index it has read (immutable, so never
 * stale), bounded by count.
 */
export class PackReader {
	readonly #objects: PackObjects;
	readonly #staged = new Map<string, { readonly bytes: Uint8Array; readonly index: PackIndex }>();
	readonly #indexes = new Map<string, PackIndex>();
	readonly #limit: number;
	/** Reads served, by where they came from, for tests and timings. */
	readonly counts = { memory: 0, ranged: 0, whole: 0 };

	constructor(objects: PackObjects, indexLimit = 64) {
		this.#objects = objects;
		this.#limit = indexLimit;
	}

	/** Keeps a pack this process built, so reads and hydration here need not fetch it. */
	hold(pack: BuiltPack): void {
		this.#staged.set(pack.key, { bytes: pack.bytes, index: pack.index });
		this.#remember(pack.key, pack.index);
	}

	/** Drops a held pack once its bodies are in their blobs. */
	release(key: string): void {
		this.#staged.delete(key);
	}

	held(key: string): Uint8Array | undefined {
		return this.#staged.get(key)?.bytes;
	}

	async index(key: string): Promise<PackIndex> {
		const known = this.#indexes.get(key);
		if (known !== undefined) return known;
		const bytes = await this.#objects.getObject(packIndexKey(key));
		if (bytes === undefined) throw new KantelError("unavailable", `workspace pack index ${key} is missing`);
		return this.#remember(key, parsePackIndex(bytes, key));
	}

	/**
	 * The body with `digest` from the first of `packs` that holds it, checked against the digest; undefined when none
	 * does. A body that does not match its digest is `unavailable`, never returned.
	 */
	async read(packs: readonly string[], digest: string): Promise<Uint8Array | undefined> {
		for (const key of packs) {
			const held = this.#staged.get(key);
			const index = held?.index ?? (await this.index(key));
			const range = index.get(digest);
			if (range === undefined) continue;
			const [offset, length] = range;
			let body: Uint8Array | undefined;
			if (held !== undefined) {
				this.counts.memory++;
				// A copy: callers may keep or change what they are given.
				return held.bytes.slice(offset, offset + length);
			}
			if (length === 0) {
				body = new Uint8Array(0);
			} else if (this.#objects.getObjectRange !== undefined) {
				this.counts.ranged++;
				body = await this.#objects.getObjectRange(key, offset, length);
			} else {
				this.counts.whole++;
				body = (await this.#objects.getObject(key))?.slice(offset, offset + length);
			}
			if (body === undefined) throw new KantelError("unavailable", `workspace pack ${key} is missing`);
			if (body.byteLength !== length || (await sha256Hex(body)) !== digest) {
				throw new KantelError("unavailable", `workspace pack ${key} does not match its index`);
			}
			return body;
		}
		return undefined;
	}

	#remember(key: string, index: PackIndex): PackIndex {
		this.#indexes.delete(key);
		this.#indexes.set(key, index);
		for (const oldest of this.#indexes.keys()) {
			if (this.#indexes.size <= this.#limit) break;
			this.#indexes.delete(oldest);
		}
		return index;
	}
}
