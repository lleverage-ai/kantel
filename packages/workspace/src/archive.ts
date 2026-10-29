/**
 * `archive` seed sources (seed spec v1): an `ArchiveFetcher` over `fetch` alone, so it runs in a Worker as well as on a
 * node, and the unpacking the seed does with the bytes. Pass the vault's egress `fetch` when the host needs credentials;
 * the spec never carries them.
 *
 * Archives are tar, or tar compressed with gzip (detected by its magic bytes, not the URL). Regular files keep their
 * executable bit; directories, symlinks and other entries are left out, as in git tarballs.
 */
import { type ArchiveFetcher, type ArchiveSeedSource, HarbourError, type SeedFile } from "@harbour/contracts";
import { parseTar } from "./git-tarball.ts";

export interface HttpArchiveFetcherOptions {
	/** The egress `fetch`; the global one when absent. */
	readonly fetch?: typeof fetch;
	/** The most bytes read from the network. Default 512 MiB. */
	readonly maxBytes?: number;
}

export function createHttpArchiveFetcher(options: HttpArchiveFetcherOptions = {}): ArchiveFetcher {
	const send = options.fetch ?? globalThis.fetch.bind(globalThis);
	const maxBytes = options.maxBytes ?? DEFAULT_ARCHIVE_BYTES;
	return {
		async fetch(ctx, source) {
			const response = await send(source.url, {
				headers: { "user-agent": "harbour-workspace" },
				...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			});
			if (response.status === 404) {
				await response.body?.cancel();
				throw new HarbourError("not_found", `no archive at ${source.url}`);
			}
			if (!response.ok || response.body === null) {
				await response.body?.cancel();
				throw new HarbourError("unavailable", `the archive at ${source.url} failed with ${response.status}`);
			}
			return readAll(response.body, maxBytes, "the archive");
		},
	};
}

export const DEFAULT_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_ARCHIVE_FILES = 100_000;

/**
 * The files of an archive's bytes, with `strip` leading segments dropped (entries that end up empty are skipped).
 * Over `maxBytes` uncompressed or `maxFiles` files is `exhausted`; a truncated or malformed archive is `unavailable`.
 */
export async function unpackArchive(
	bytes: Uint8Array,
	source: Pick<ArchiveSeedSource, "url" | "strip">,
	limits: { readonly maxBytes?: number; readonly maxFiles?: number } = {},
): Promise<SeedFile[]> {
	const maxBytes = limits.maxBytes ?? DEFAULT_ARCHIVE_BYTES;
	const maxFiles = limits.maxFiles ?? DEFAULT_ARCHIVE_FILES;
	const gzipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
	const tar = gzipped
		? await readAll(
				new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip")),
				maxBytes,
				"the archive, uncompressed,",
			).catch((error: unknown) => {
				throw error instanceof HarbourError
					? error
					: new HarbourError("unavailable", `the archive at ${source.url} is not valid gzip`);
			})
		: bytes;
	if (!gzipped && tar.length > maxBytes) {
		throw new HarbourError("exhausted", `the archive is larger than ${maxBytes} bytes`);
	}
	const strip = source.strip ?? 0;
	const files: SeedFile[] = [];
	for (const file of parseTar(tar)) {
		const segments = file.path.split("/").filter((segment) => segment !== "" && segment !== ".");
		const path = segments.slice(strip).join("/");
		if (path === "") continue;
		if (files.length === maxFiles) throw new HarbourError("exhausted", `the archive has more than ${maxFiles} files`);
		files.push({ ...file, path });
	}
	return files;
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number, what: string): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		total += chunk.byteLength;
		if (total > maxBytes) throw new HarbourError("exhausted", `${what} is larger than ${maxBytes} bytes`);
		chunks.push(chunk);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
