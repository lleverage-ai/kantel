// Both bundle stores: a tar is kept once under its SHA-256 however often it is put, and a body that is too large or
// isn't what its digest says leaves nothing behind.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDirBundleStore, createMemoryBundleStore } from "../src/bundles.ts";
import type { BundleBlobStore } from "../src/mounts.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Made {
	readonly store: BundleBlobStore;
	/** The files a store keeps on disk, by subdirectory, or undefined for one in memory. */
	files(): Promise<{ readonly tmp: string[]; readonly blobs: string[] } | undefined>;
}

const listed = (dir: string) => readdir(dir).catch(() => [] as string[]);

const stores: readonly [string, () => Promise<Made>][] = [
	["memory", async () => ({ store: createMemoryBundleStore(), files: async () => undefined })],
	[
		"directory",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "kantel-bundles-"));
			dirs.push(dir);
			return {
				store: createDirBundleStore(dir),
				files: async () => ({ tmp: await listed(join(dir, "tmp")), blobs: await listed(join(dir, "sha256")) }),
			};
		},
	],
];

const encode = (text: string) => new TextEncoder().encode(text);
const digestOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A body of `chunks`, which records whether it was cancelled. */
function bodyOf(...chunks: Uint8Array[]) {
	const state = { cancelled: false };
	let index = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[index++];
			if (chunk === undefined) controller.close();
			else controller.enqueue(chunk);
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { body, state };
}

async function bytesOf(store: BundleBlobStore, digest: string): Promise<Uint8Array | undefined> {
	const blob = await store.open(digest);
	if (blob === undefined) return undefined;
	const bytes = new Uint8Array(await new Response(blob.body).arrayBuffer());
	expect(bytes.byteLength).toBe(blob.sizeBytes);
	return bytes;
}

describe.each(stores)("the %s bundle store", (_name, make) => {
	it("keeps a body under its digest once, however often it is put", async () => {
		const { store, files } = await make();
		const tar = encode("a tar's bytes, in two chunks");
		const first = await store.put(bodyOf(tar.slice(0, 5), tar.slice(5)).body, { maxBytes: 1024 });
		expect(first).toEqual({ digest: digestOf(tar), sizeBytes: tar.byteLength });
		const again = await store.put(bodyOf(tar).body, { maxBytes: 1024, expectDigest: digestOf(tar) });
		expect(again).toEqual(first);
		expect(await bytesOf(store, first.digest)).toEqual(tar);
		const onDisk = await files();
		if (onDisk !== undefined) expect(onDisk).toEqual({ tmp: [], blobs: [first.digest.slice("sha256:".length)] });
	});

	it("refuses a body whose digest isn't the one expected, keeping nothing", async () => {
		const { store, files } = await make();
		const tar = encode("not what was promised");
		const promised = digestOf(encode("something else"));
		await expect(store.put(bodyOf(tar).body, { maxBytes: 1024, expectDigest: promised })).rejects.toMatchObject({
			code: "invalid",
		});
		expect(await store.open(digestOf(tar))).toBeUndefined();
		expect(await store.open(promised)).toBeUndefined();
		const onDisk = await files();
		if (onDisk !== undefined) expect(onDisk).toEqual({ tmp: [], blobs: [] });
		// Not a digest at all: refused before anything is read.
		const { body, state } = bodyOf(tar);
		await expect(store.put(body, { maxBytes: 1024, expectDigest: "sha256:../../x" })).rejects.toMatchObject({
			code: "invalid",
		});
		expect(state.cancelled).toBe(true);
	});

	it("refuses a body past maxBytes, cancelling it and keeping nothing", async () => {
		const { store, files } = await make();
		const chunk = new Uint8Array(400).fill(7);
		const { body, state } = bodyOf(chunk, chunk, chunk, chunk);
		await expect(store.put(body, { maxBytes: 1000 })).rejects.toMatchObject({ code: "invalid" });
		expect(state.cancelled).toBe(true);
		const onDisk = await files();
		if (onDisk !== undefined) expect(onDisk).toEqual({ tmp: [], blobs: [] });
		// Exactly maxBytes is taken.
		const exact = await store.put(bodyOf(chunk).body, { maxBytes: 400 });
		expect(exact.sizeBytes).toBe(400);
	});

	it("opens what it keeps, and forgets it on delete", async () => {
		const { store, files } = await make();
		const tar = encode("open me");
		const { digest } = await store.put(bodyOf(tar).body, { maxBytes: 1024 });
		const blob = await store.open(digest);
		expect(blob?.sizeBytes).toBe(tar.byteLength);
		expect(new Uint8Array(await new Response(blob?.body).arrayBuffer())).toEqual(tar);
		// Read twice: each open is a stream of its own.
		expect(await bytesOf(store, digest)).toEqual(tar);

		await store.delete(digest);
		expect(await store.open(digest)).toBeUndefined();
		// Nothing stored is not an error.
		await store.delete(digest);
		const onDisk = await files();
		if (onDisk !== undefined) expect(onDisk.blobs).toEqual([]);

		// An empty tar is a body too.
		const empty = await store.put(bodyOf().body, { maxBytes: 1024 });
		expect(empty).toEqual({ digest: digestOf(new Uint8Array(0)), sizeBytes: 0 });
		expect(await bytesOf(store, empty.digest)).toEqual(new Uint8Array(0));
	});

	it("refuses a digest that isn't one before it names any path", async () => {
		const { store } = await make();
		for (const digest of ["../etc/passwd", `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}/`, "sha256:"]) {
			await expect(store.open(digest)).rejects.toMatchObject({ code: "invalid" });
			await expect(store.delete(digest)).rejects.toMatchObject({ code: "invalid" });
		}
	});
});
