/**
 * `@kantel/compute/bundles`: where self-hosted bundles' tars are kept (`BundleBlobStore`). Node only, so it isn't
 * exported from the package's index, which also runs on Cloudflare Workers.
 *
 * Both stores hash a body as it streams in (never holding a 2 GiB tar in memory to do it, for the directory) and stage
 * it, then keep it as a generation of its digest when told, so bytes many accounts upload are stored once. A body past
 * `maxBytes`, or whose digest isn't the one expected, is refused with `invalid` and leaves nothing behind.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, type FileHandle, link, mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { KantelError } from "@kantel/contracts";
import type { BundleBlobStore, StagedBlob, StoredBlob } from "./mounts.ts";

/** A digest a store takes: checked before it names any path, so `../` or a stray byte can't reach outside the store. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const notADigest = (digest: string) =>
	new KantelError(
		"invalid",
		`A bundle's digest is sha256: and 64 lower-case hex digits, not ${JSON.stringify(digest.slice(0, 80))}`,
	);

/** The hex part of `digest`, or `invalid` when it isn't `sha256:` and 64 lower-case hex digits. */
function hexOf(digest: string): string {
	if (!DIGEST.test(digest)) throw notADigest(digest);
	return digest.slice("sha256:".length);
}

/** `generation`, checked to be a whole number before it names any path. */
function generationOf(generation: number): number {
	if (!Number.isSafeInteger(generation) || generation < 0) {
		throw new KantelError("invalid", `A bundle's generation is a whole number, not ${String(generation)}`);
	}
	return generation;
}

/** What a generation of a digest is stored as: the hex alone for generation 0, as before there were generations. */
const nameOf = (digest: string, generation: number) => {
	const hex = hexOf(digest);
	return generationOf(generation) === 0 ? hex : `${hex}.${generation}`;
};

/**
 * Reads `body` to its end, handing each chunk to `sink` as it comes, and answers its digest and size. Past `maxBytes`
 * it cancels the body and rejects with `invalid`; so does a digest that isn't `expectDigest`, once all of it is read.
 */
async function consume(
	body: ReadableStream<Uint8Array>,
	options: { readonly maxBytes: number; readonly expectDigest?: string },
	sink: (chunk: Uint8Array) => Promise<void> | void,
): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
	const hash = createHash("sha256");
	const reader = body.getReader();
	let sizeBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			sizeBytes += value.byteLength;
			if (sizeBytes > options.maxBytes) {
				throw new KantelError("invalid", `The bundle is larger than ${options.maxBytes} bytes`);
			}
			hash.update(value);
			await sink(value);
		}
	} catch (error) {
		// The sender is told to stop: nothing more of it is wanted.
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const digest = `sha256:${hash.digest("hex")}`;
	if (options.expectDigest !== undefined && digest !== options.expectDigest) {
		throw new KantelError("invalid", `The bundle's digest is ${digest}, not ${options.expectDigest}`);
	}
	return { digest, sizeBytes };
}

/** Checks `expectDigest` before any byte is read, cancelling the body when it isn't a digest at all. */
async function checkExpected(body: ReadableStream<Uint8Array>, expectDigest: string | undefined): Promise<void> {
	if (expectDigest === undefined || DIGEST.test(expectDigest)) return;
	await body.cancel().catch(() => undefined);
	throw notADigest(expectDigest);
}

const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "ENOENT";

/** Bundles in memory, for tests and a gateway with nowhere on disk to keep them: gone with the process. */
export function createMemoryBundleStore(): BundleBlobStore {
	const blobs = new Map<string, Uint8Array>();
	return {
		async put(body, options) {
			await checkExpected(body, options.expectDigest);
			const chunks: Uint8Array[] = [];
			const { digest, sizeBytes } = await consume(body, options, (chunk) => {
				chunks.push(chunk);
			});
			let bytes: Uint8Array | undefined = new Uint8Array(sizeBytes);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return {
				digest,
				sizeBytes,
				async keep(generation) {
					if (bytes === undefined) throw new Error("This staged bundle was discarded");
					const name = nameOf(digest, generation);
					if (!blobs.has(name)) blobs.set(name, bytes.slice());
				},
				async discard() {
					bytes = undefined;
				},
			} satisfies StagedBlob;
		},
		async open(digest, generation) {
			const bytes = blobs.get(nameOf(digest, generation));
			if (bytes === undefined) return undefined;
			// A copy, so whoever reads it can't change what is stored.
			const copy = bytes.slice();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					if (copy.byteLength > 0) controller.enqueue(copy);
					controller.close();
				},
			});
			return { sizeBytes: bytes.byteLength, body } satisfies StoredBlob;
		},
		async delete(digest, generation) {
			blobs.delete(nameOf(digest, generation));
		},
	};
}

/**
 * Bundles in a directory: each generation of a tar at `<dir>/sha256/<hex>.<generation>` (`<hex>` alone for generation
 * 0). A body is written first to `<dir>/tmp/<random>`, and linked into place for each generation it is kept as once all
 * of it arrived and its digest was checked, so a reader never sees half a tar, and a refused or broken upload leaves
 * nothing but a temporary file it removes.
 */
export function createDirBundleStore(dir: string): BundleBlobStore {
	const tmpDir = join(dir, "tmp");
	const blobDir = join(dir, "sha256");
	const pathOf = (digest: string, generation: number) => join(blobDir, nameOf(digest, generation));
	return {
		async put(body, options) {
			await checkExpected(body, options.expectDigest);
			try {
				await mkdir(tmpDir, { recursive: true });
			} catch (error) {
				await body.cancel().catch(() => undefined);
				throw error;
			}
			const temporary = join(tmpDir, randomUUID());
			let handle: FileHandle | undefined;
			let stored: { readonly digest: string; readonly sizeBytes: number };
			try {
				handle = await open(temporary, "wx", 0o600);
				const file = handle;
				stored = await consume(body, options, async (chunk) => {
					// A write may take less than all of a chunk; the rest follows.
					let offset = 0;
					while (offset < chunk.byteLength) {
						const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
						offset += bytesWritten;
					}
				});
				await file.close();
				handle = undefined;
			} catch (error) {
				await handle?.close().catch(() => undefined);
				await rm(temporary, { force: true }).catch(() => undefined);
				throw error;
			}
			let discarded = false;
			return {
				...stored,
				async keep(generation) {
					if (discarded) throw new Error("This staged bundle was discarded");
					const final = pathOf(stored.digest, generation);
					await mkdir(blobDir, { recursive: true });
					// Linked, so the staged copy stays for another generation; bytes already there are the same bytes.
					const linked = await link(temporary, final).then(
						() => true,
						(error: unknown) => {
							if ((error as { code?: unknown } | null)?.code === "EEXIST") return true;
							return false;
						},
					);
					if (linked) return;
					// A filesystem without hard links: a copy, renamed into place whole.
					const copy = join(tmpDir, randomUUID());
					try {
						await copyFile(temporary, copy);
						await rename(copy, final);
					} catch (error) {
						await rm(copy, { force: true }).catch(() => undefined);
						throw error;
					}
				},
				async discard() {
					discarded = true;
					await rm(temporary, { force: true });
				},
			} satisfies StagedBlob;
		},
		async open(digest, generation) {
			const path = pathOf(digest, generation);
			const info = await stat(path).catch((error: unknown) => {
				if (isMissing(error)) return undefined;
				throw error;
			});
			if (info === undefined || !info.isFile()) return undefined;
			const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
			return { sizeBytes: info.size, body } satisfies StoredBlob;
		},
		async delete(digest, generation) {
			await unlink(pathOf(digest, generation)).catch((error: unknown) => {
				if (!isMissing(error)) throw error;
			});
		},
	};
}
