/**
 * A `GitFetcher` for GitHub repositories over `fetch` alone, so it runs in a Worker as well as on a node: it resolves
 * the ref to a commit with the REST API, then reads the commit's tarball. Pass the vault's egress `fetch`, which adds
 * the credentials; the spec never carries them.
 *
 * The tarball holds the tree without history or `.git`. Symlinks and submodules are left out (`skipped` counts them).
 */
import { type GitFetcher, type GitSeedSource, type GitTree, HarbourError, type SeedFile } from "@harbour/contracts";

export interface GitHubTarballFetcherOptions {
	/** The egress `fetch`; the global one when absent. */
	readonly fetch?: typeof fetch;
	/** Default `https://api.github.com`. */
	readonly apiBase?: string;
	/** Default `https://codeload.github.com`. */
	readonly codeloadBase?: string;
	/** The largest tarball read, uncompressed. Default 512 MiB. */
	readonly maxBytes?: number;
	/** The most files a tree may have. Default 100,000. */
	readonly maxFiles?: number;
}

/** Entries the last fetch left out, by kind; for tests and reports. */
export interface GitHubTarballFetcher extends GitFetcher {
	readonly skipped: { symlinks: number; other: number };
}

const COMMIT = /^[0-9a-f]{40}$/;

/** `owner/name`, or a github.com URL, as `[owner, name]`; anything else is not this fetcher's. */
export function gitHubRepo(repo: string): [string, string] {
	const match =
		/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo) ??
		/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo);
	if (match === null || /^\.+$/.test(match[1]!) || /^\.+$/.test(match[2]!)) {
		throw new HarbourError("not_supported", `the GitHub fetcher cannot fetch ${repo}`, { repo });
	}
	return [match[1]!, match[2]!];
}

export function createGitHubTarballFetcher(options: GitHubTarballFetcherOptions = {}): GitHubTarballFetcher {
	const send = options.fetch ?? globalThis.fetch.bind(globalThis);
	const api = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
	const codeload = (options.codeloadBase ?? "https://codeload.github.com").replace(/\/+$/, "");
	const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
	const maxFiles = options.maxFiles ?? 100_000;
	const skipped = { symlinks: 0, other: 0 };

	async function resolve(owner: string, name: string, source: GitSeedSource): Promise<string> {
		if (source.commit !== undefined) {
			if (!COMMIT.test(source.commit)) throw new HarbourError("invalid", `bad commit ${source.commit}`);
			return source.commit;
		}
		if (COMMIT.test(source.ref)) return source.ref;
		const response = await send(`${api}/repos/${owner}/${name}/commits/${encodeURIComponent(source.ref)}`, {
			headers: { accept: "application/vnd.github.sha", "user-agent": "harbour-workspace" },
		});
		if (response.status === 404 || response.status === 422) {
			await response.body?.cancel();
			throw new HarbourError("not_found", `${source.repo} has no ref ${source.ref}`, { repo: source.repo });
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new HarbourError("unavailable", `resolving ${source.ref} in ${source.repo} failed with ${response.status}`);
		}
		const commit = (await response.text()).trim();
		if (!COMMIT.test(commit)) throw new HarbourError("unavailable", `GitHub returned a bad commit for ${source.ref}`);
		return commit;
	}

	return {
		skipped,
		method: "clone",
		async resolve(_ctx, source) {
			const [owner, name] = gitHubRepo(source.repo);
			return resolve(owner, name, source);
		},
		async fetch(_ctx, source): Promise<GitTree> {
			const [owner, name] = gitHubRepo(source.repo);
			const commit = await resolve(owner, name, source);
			const response = await send(`${codeload}/${owner}/${name}/tar.gz/${commit}`, {
				headers: { "user-agent": "harbour-workspace" },
			});
			if (!response.ok || response.body === null) {
				await response.body?.cancel();
				throw new HarbourError("unavailable", `the tarball of ${source.repo}@${commit} failed with ${response.status}`);
			}
			const tar = await readAll(response.body.pipeThrough(new DecompressionStream("gzip")), maxBytes);
			skipped.symlinks = 0;
			skipped.other = 0;
			const files: SeedFile[] = [];
			for (const file of parseTar(tar, skipped)) {
				const path = stripTopDirectory(file.path);
				if (path === "") continue;
				if (files.length === maxFiles) {
					throw new HarbourError("exhausted", `${source.repo} has more than ${maxFiles} files`);
				}
				files.push({ ...file, path });
			}
			return { commit, files };
		},
	};
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		total += chunk.byteLength;
		if (total > maxBytes) throw new HarbourError("exhausted", `the tarball is larger than ${maxBytes} bytes`);
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

/** GitHub's tarballs put everything under `<owner>-<name>-<sha>/`. */
function stripTopDirectory(path: string): string {
	const slash = path.indexOf("/");
	return slash < 0 ? "" : path.slice(slash + 1);
}

const decoder = new TextDecoder();

function field(block: Uint8Array, start: number, length: number): string {
	const slice = block.subarray(start, start + length);
	const end = slice.indexOf(0);
	return decoder.decode(end < 0 ? slice : slice.subarray(0, end));
}

function octal(block: Uint8Array, start: number, length: number): number {
	const text = field(block, start, length).trim();
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) throw new HarbourError("unavailable", "the tarball has a malformed header");
	return Number.parseInt(text, 8);
}

/** pax extended header records, `<length> <key>=<value>\n`, where the length counts bytes of the whole record. */
function paxRecords(data: Uint8Array): Map<string, string> {
	const records = new Map<string, string>();
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		const digits = space < 0 ? "" : decoder.decode(data.subarray(offset, space));
		const length = Number(digits);
		if (!/^[0-9]+$/.test(digits) || length <= space - offset + 1 || offset + length > data.length) {
			throw new HarbourError("unavailable", "the tarball has a malformed pax header");
		}
		if (data[offset + length - 1] !== 0x0a)
			throw new HarbourError("unavailable", "the tarball has a malformed pax header");
		const record = data.subarray(space + 1, offset + length - 1);
		const equals = record.indexOf(0x3d);
		if (equals > 0)
			records.set(decoder.decode(record.subarray(0, equals)), decoder.decode(record.subarray(equals + 1)));
		offset += length;
	}
	return records;
}

/**
 * The regular files of a ustar/pax tarball, with their modes. An archive that ends before its end-of-archive block,
 * mid-header or mid-body, is `unavailable`: a partial tree never seeds a workspace.
 */
export function* parseTar(tar: Uint8Array, skipped = { symlinks: 0, other: 0 }): Generator<SeedFile> {
	let offset = 0;
	let longName: string | undefined;
	for (;;) {
		if (offset + 512 > tar.length) throw new HarbourError("unavailable", "the tarball is truncated");
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) return;
		let sum = 0;
		for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
		if (sum !== octal(header, 148, 8)) throw new HarbourError("unavailable", "the tarball has a bad header checksum");
		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] ?? 0);
		const dataStart = offset + 512;
		if (dataStart + Math.ceil(size / 512) * 512 > tar.length) {
			throw new HarbourError("unavailable", "the tarball is truncated");
		}
		const data = tar.subarray(dataStart, dataStart + size);
		offset = dataStart + Math.ceil(size / 512) * 512;
		if (type === "x") {
			longName = paxRecords(data).get("path") ?? longName;
			continue;
		}
		if (type === "L") {
			longName = field(data, 0, data.length);
			continue;
		}
		if (type === "g") continue;
		const prefix = decoder.decode(header.subarray(257, 262)) === "ustar" ? field(header, 345, 155) : "";
		const name = longName ?? (prefix === "" ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`);
		longName = undefined;
		if (type === "0" || type === "\0") {
			const mode = octal(header, 100, 8) & 0o7777;
			yield { path: name, content: data.slice(), ...((mode & 0o111) !== 0 ? { mode: 0o755 } : {}) };
		} else if (type === "2") {
			skipped.symlinks++;
		} else if (type !== "5") {
			skipped.other++;
		}
	}
}
