/**
 * A git source's recent history as a `.git` directory, over `fetch` alone, so a Worker can seed it next to the tree
 * (#21). One protocol v2 `fetch` asks GitHub for `history` commits (`deepen`) without their blobs (`filter blob:none`):
 * the files are already in the workspace from the tarball. The pack is indexed here (isomorphic-git's `indexPack`, in
 * memory) and written with the refs, a `shallow` file and an index of the commit's tree, so the result is the `.git`
 * of `git clone --depth N --filter=blob:none`: isomorphic-git reads its log and trees in the isolate tier, and git
 * itself can use it in a container (the remote is a promisor, so a missing blob is fetched when one is needed).
 *
 * No token is sent and none is written: pass the vault's egress `fetch` for a private repository.
 */
import { HarbourError, type SeedFile } from "@harbour/contracts";
import git from "isomorphic-git";
import { createGitRefLister, type GitRefLister } from "./git-refs.ts";
import { gitHubRepo } from "./github-repo.ts";

export interface GitHistoryOptions {
	/** The egress `fetch`; the global one when absent. */
	readonly fetch?: typeof fetch;
	/** Default `https://github.com`. */
	readonly gitBase?: string;
	/** Finds which branch, if any, the source's ref names; by default `ls-refs` over the same `fetch`. */
	readonly refs?: GitRefLister;
	/** The largest pack read. Default 256 MiB. */
	readonly maxBytes?: number;
}

export interface GitHistorySource {
	/** `owner/name` or a github.com URL. */
	readonly repo: string;
	/** The ref the seed asked for: a branch makes `HEAD` that branch, anything else leaves it detached. */
	readonly ref: string;
	/** The full commit ID the ref resolved to. */
	readonly commit: string;
	/** Commits of history, the commit included. */
	readonly depth: number;
}

/** The default number of commits, as `GitSeedSource.history` documents. */
export const DEFAULT_HISTORY = 50;

const COMMIT = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One pkt-line: four hex digits of length (counting themselves), then the payload. */
function pktLine(text: string): string {
	return `${(encoder.encode(text).length + 4).toString(16).padStart(4, "0")}${text}`;
}

/** The protocol v2 `fetch` request for `commit` and the `depth - 1` commits behind it, without blobs. */
export function shallowFetchRequest(commit: string, depth: number): string {
	return [
		pktLine("command=fetch\n"),
		pktLine("agent=harbour\n"),
		"0001",
		pktLine("no-progress\n"),
		pktLine("ofs-delta\n"),
		pktLine(`deepen ${depth}\n`),
		pktLine("filter blob:none\n"),
		pktLine(`want ${commit}\n`),
		pktLine("done\n"),
		"0000",
	].join("");
}

/**
 * A v2 `fetch` reply: the shallow commits from `shallow-info`, and the pack, from band 1 of the `packfile` section.
 * Band 3, an `ERR` line or a reply that ends early is `unavailable`.
 */
export function parseFetchReply(bytes: Uint8Array): { shallow: string[]; pack: Uint8Array } {
	const shallow: string[] = [];
	const chunks: Uint8Array[] = [];
	let section: string | undefined;
	let offset = 0;
	for (;;) {
		if (offset + 4 > bytes.length) throw new HarbourError("unavailable", "the git server's fetch reply has no end");
		const digits = decoder.decode(bytes.subarray(offset, offset + 4));
		if (!/^[0-9a-f]{4}$/.test(digits)) throw new HarbourError("unavailable", "the git server sent a malformed reply");
		const length = Number.parseInt(digits, 16);
		if (length === 0) break;
		if (length < 4) {
			// A delimiter (0001) ends a section; response-end (0002) the reply.
			offset += 4;
			section = undefined;
			if (length === 2) break;
			continue;
		}
		if (offset + length > bytes.length) throw new HarbourError("unavailable", "the git server sent a truncated reply");
		const payload = bytes.subarray(offset + 4, offset + length);
		offset += length;
		if (section === "packfile") {
			const band = payload[0];
			if (band === 1) chunks.push(payload.subarray(1));
			else if (band === 3) {
				throw new HarbourError("unavailable", `the git server refused: ${decoder.decode(payload.subarray(1)).trim()}`);
			}
			continue;
		}
		const line = decoder.decode(payload).replace(/\n$/, "");
		if (line.startsWith("ERR ")) throw new HarbourError("unavailable", `the git server refused: ${line.slice(4)}`);
		if (section === undefined) section = line;
		else if (section === "shallow-info" && line.startsWith("shallow ")) shallow.push(line.slice(8));
	}
	const pack = concat(chunks);
	if (pack.length < 32 || decoder.decode(pack.subarray(0, 4)) !== "PACK") {
		throw new HarbourError("unavailable", "the git server sent no pack");
	}
	return { shallow, pack };
}

/**
 * The `.git` files for `source`, paths relative to the repository root (`.git/HEAD`, ...). `not_found` when there is no
 * such repository (or it is private and unreachable).
 */
export async function fetchGitHistory(options: GitHistoryOptions, source: GitHistorySource): Promise<SeedFile[]> {
	const send = options.fetch ?? globalThis.fetch.bind(globalThis);
	const base = (options.gitBase ?? "https://github.com").replace(/\/+$/, "");
	const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
	const refs = options.refs ?? createGitRefLister({ fetch: send, gitBase: base });
	const [owner, name] = gitHubRepo(source.repo);
	if (!COMMIT.test(source.commit)) throw new HarbourError("invalid", `bad commit ${source.commit}`);
	if (!Number.isInteger(source.depth) || source.depth < 1) {
		throw new HarbourError("invalid", `history must be a whole number of commits, at least 1`);
	}

	const [reply, branch] = await Promise.all([
		(async () => {
			const response = await send(`${base}/${owner}/${name}.git/git-upload-pack`, {
				method: "POST",
				headers: {
					"content-type": "application/x-git-upload-pack-request",
					accept: "application/x-git-upload-pack-result",
					"git-protocol": "version=2",
					"user-agent": "harbour-workspace",
				},
				body: shallowFetchRequest(source.commit, source.depth),
			});
			if (response.status === 401 || response.status === 403 || response.status === 404) {
				await response.body?.cancel();
				throw new HarbourError("not_found", `no repository ${owner}/${name} that Harbour can read`, {
					repo: `${owner}/${name}`,
				});
			}
			if (!response.ok || response.body === null) {
				await response.body?.cancel();
				throw new HarbourError(
					"unavailable",
					`fetching the history of ${owner}/${name} failed with ${response.status}`,
				);
			}
			return parseFetchReply(await readAll(response.body, maxBytes));
		})(),
		branchOf(refs, `${owner}/${name}`, source),
	]);
	return gitDirectory({
		url: `${base}/${owner}/${name}.git`,
		commit: source.commit,
		...(branch === undefined ? {} : { branch }),
		shallow: reply.shallow,
		pack: reply.pack,
	});
}

/** The branch `source.ref` names when it is one and still points at `source.commit`. */
async function branchOf(refs: GitRefLister, repo: string, source: GitHistorySource): Promise<string | undefined> {
	const ref = source.ref.startsWith("refs/heads/") ? source.ref.slice("refs/heads/".length) : source.ref;
	if (ref === "" || ref === "HEAD" || ref.startsWith("refs/") || COMMIT.test(ref)) return undefined;
	// A tag of the same name wins, as it does when the ref is resolved: then HEAD is detached.
	const [asBranch, asTag] = await Promise.all(
		[`refs/heads/${ref}`, `refs/tags/${ref}`].map((full) => refs.resolve(repo, full).catch(() => undefined)),
	);
	return asBranch === source.commit && asTag === undefined ? ref : undefined;
}

export interface GitDirectoryInput {
	/** The remote's URL, `origin`. */
	readonly url: string;
	readonly commit: string;
	/** The branch HEAD is on; detached at `commit` when absent. */
	readonly branch?: string;
	/** The shallow boundary commits. */
	readonly shallow: readonly string[];
	/** A blobless pack holding `commit`, its trees and its history down to `shallow`. */
	readonly pack: Uint8Array;
}

/** The `.git` files of a blobless shallow clone of `pack`. */
export async function gitDirectory(input: GitDirectoryInput): Promise<SeedFile[]> {
	const fs = memoryFs();
	const packId = hex(input.pack.subarray(input.pack.length - 20));
	const packPath = `.git/objects/pack/pack-${packId}`;
	fs.files.set(`/${packPath}.pack`, input.pack);
	const cache = {};
	await git.indexPack({ fs, dir: "/", filepath: `${packPath}.pack`, cache });
	const idx = fs.files.get(`/${packPath}.idx`);
	if (idx === undefined) throw new HarbourError("unavailable", "indexing the history's pack failed");

	const entries: IndexEntry[] = [];
	const { commit } = await git.readCommit({ fs, dir: "/", oid: input.commit, cache });
	await walkTree(fs, cache, commit.tree, "", entries);

	const branch = input.branch;
	const head = branch === undefined ? `${input.commit}\n` : `ref: refs/heads/${branch}\n`;
	const config = [
		"[core]",
		"\trepositoryformatversion = 1",
		"\tfilemode = true",
		"\tbare = false",
		"\tlogallrefupdates = true",
		'[remote "origin"]',
		`\turl = ${input.url}`,
		`\tfetch = +refs/heads/${branch ?? "*"}:refs/remotes/origin/${branch ?? "*"}`,
		"\tpromisor = true",
		"\tpartialclonefilter = blob:none",
		...(branch === undefined ? [] : [`[branch "${branch}"]`, "\tremote = origin", `\tmerge = refs/heads/${branch}`]),
		"",
	].join("\n");
	const packedRefs = [
		"# pack-refs with: peeled fully-peeled sorted ",
		...(branch === undefined ? [] : [`${input.commit} refs/remotes/origin/${branch}`]),
		"",
	].join("\n");
	const text = (path: string, content: string): SeedFile => ({ path, content: encoder.encode(content) });
	return [
		text(".git/HEAD", head),
		text(".git/config", config),
		text(".git/description", "Seeded by Harbour: a shallow, blobless clone.\n"),
		text(
			".git/shallow",
			[...input.shallow]
				.sort()
				.map((oid) => `${oid}\n`)
				.join(""),
		),
		text(".git/packed-refs", packedRefs),
		// git takes a directory for a repository only when it has `refs/`; a workspace has no empty directories, and git
		// skips a dotfile among the refs.
		text(
			branch === undefined ? ".git/refs/.keep" : `.git/refs/heads/${branch}`,
			branch === undefined ? "" : `${input.commit}\n`,
		),
		{ path: `${packPath}.pack`, content: input.pack },
		{ path: `${packPath}.idx`, content: idx },
		text(`${packPath}.promisor`, ""),
		{ path: ".git/index", content: await indexFile(entries) },
	];
}

interface IndexEntry {
	readonly path: string;
	readonly oid: string;
	readonly mode: number;
}

type MemoryFs = ReturnType<typeof memoryFs>;

/** Every file of the tree, depth first, as the index lists them. */
async function walkTree(fs: MemoryFs, cache: object, oid: string, prefix: string, out: IndexEntry[]): Promise<void> {
	const { tree } = await git.readTree({ fs, dir: "/", oid, cache });
	for (const entry of tree) {
		const path = `${prefix}${entry.path}`;
		if (entry.type === "tree") await walkTree(fs, cache, entry.oid, `${path}/`, out);
		else out.push({ path, oid: entry.oid, mode: Number.parseInt(entry.mode, 8) });
	}
}

/**
 * A version 2 index of `entries`, sorted by path as git sorts them. The stat fields are zero, so git and isomorphic-git
 * hash a file the first time they compare it, and find it unchanged when it matches the commit.
 */
async function indexFile(entries: readonly IndexEntry[]): Promise<Uint8Array> {
	const sorted = entries
		.map((entry) => ({ ...entry, name: encoder.encode(entry.path) }))
		.sort((left, right) => compareBytes(left.name, right.name));
	const parts: Uint8Array[] = [];
	const header = new Uint8Array(12);
	header.set(encoder.encode("DIRC"), 0);
	const view = new DataView(header.buffer);
	view.setUint32(4, 2);
	view.setUint32(8, sorted.length);
	parts.push(header);
	for (const entry of sorted) {
		// 62 bytes of fixed fields, the name, then 1 to 8 NULs to a multiple of 8.
		const length = Math.ceil((62 + entry.name.length + 1) / 8) * 8;
		const bytes = new Uint8Array(length);
		const fields = new DataView(bytes.buffer);
		fields.setUint32(24, entry.mode);
		for (let index = 0; index < 20; index++) {
			bytes[40 + index] = Number.parseInt(entry.oid.slice(index * 2, index * 2 + 2), 16);
		}
		fields.setUint16(60, Math.min(entry.name.length, 0xfff));
		bytes.set(entry.name, 62);
		parts.push(bytes);
	}
	const body = concat(parts);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
	return concat([body, digest]);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		if (left[index] !== right[index]) return (left[index] as number) - (right[index] as number);
	}
	return left.length - right.length;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		total += chunk.byteLength;
		if (total > maxBytes) throw new HarbourError("exhausted", `the history's pack is larger than ${maxBytes} bytes`);
		chunks.push(chunk);
	}
	return concat(chunks);
}

/** Just enough of a filesystem, in memory, for isomorphic-git to index a pack and read objects from it. */
function memoryFs() {
	const files = new Map<string, Uint8Array>();
	const missing = (path: string) => Object.assign(new Error(`ENOENT: no such file, ${path}`), { code: "ENOENT" });
	const isDirectory = (path: string) => {
		const prefix = path === "/" ? "/" : `${path.replace(/\/+$/, "")}/`;
		for (const key of files.keys()) if (key.startsWith(prefix)) return true;
		return false;
	};
	const stat = async (path: string) => {
		const file = files.get(path);
		if (file === undefined && !isDirectory(path)) throw missing(path);
		const directory = file === undefined;
		return {
			isFile: () => !directory,
			isDirectory: () => directory,
			isSymbolicLink: () => false,
			mode: directory ? 0o040755 : 0o100644,
			size: file?.byteLength ?? 0,
			mtimeMs: 0,
			ctimeMs: 0,
			ino: 0,
			dev: 0,
			uid: 0,
			gid: 0,
		};
	};
	return {
		files,
		promises: {
			async readFile(path: string, options?: { encoding?: string } | string) {
				const file = files.get(path);
				if (file === undefined) throw missing(path);
				const encoding = typeof options === "string" ? options : options?.encoding;
				return encoding === "utf8" || encoding === "utf-8" ? decoder.decode(file) : file;
			},
			async writeFile(path: string, data: Uint8Array | string) {
				files.set(path, typeof data === "string" ? encoder.encode(data) : new Uint8Array(data));
			},
			async readdir(path: string) {
				if (!isDirectory(path)) throw missing(path);
				const prefix = path === "/" ? "/" : `${path.replace(/\/+$/, "")}/`;
				const names = new Set<string>();
				for (const key of files.keys()) {
					if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0] as string);
				}
				return [...names];
			},
			stat,
			lstat: stat,
			async mkdir() {},
			async rmdir() {},
			async unlink(path: string) {
				files.delete(path);
			},
			async readlink(path: string): Promise<string> {
				throw missing(path);
			},
			async symlink() {},
			async chmod() {},
		},
	};
}
