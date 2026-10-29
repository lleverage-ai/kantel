/**
 * Reading a Git repository at one commit, for the Sal adapters: the files under a path, as bytes. Uses the `git`
 * binary; nothing is checked out or written, so a pinned commit reads the same whatever the working tree holds.
 * Writing (`commitFiles`) makes a commit on a branch the same way, from objects alone, never through a checkout.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitFile {
	/** Repository-relative, `/`-separated. */
	readonly path: string;
	readonly bytes: Uint8Array;
	/** The path of the file this one is, when it is reached through a symlink (Pi skips a file it has loaded once). */
	readonly real?: string;
}

export interface TreeProblem {
	readonly path: string;
	readonly reason: string;
}

/** The full commit SHA `ref` names. Throws when it names none. */
export function resolveCommit(repo: string, ref: string): string {
	return execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
		encoding: "utf8",
	}).trim();
}

interface TreeEntry {
	readonly mode: string;
	readonly type: string;
	readonly object: string;
	readonly path: string;
}

function listTree(repo: string, commit: string, paths: readonly string[]): TreeEntry[] {
	const listing = execFileSync("git", ["-C", repo, "ls-tree", "-r", "-z", "--full-tree", commit, "--", ...paths], {
		maxBuffer: 256 * 1024 * 1024,
	});
	return listing
		.toString("utf8")
		.split("\0")
		.filter((line) => line !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			const [mode, type, object] = line.slice(0, tab).split(" ") as [string, string, string];
			return { mode, type, object, path: line.slice(tab + 1) };
		});
}

/** The blobs `objects` name, in order, through one `git cat-file --batch`. */
function readBlobs(repo: string, objects: readonly string[]): Uint8Array[] {
	if (objects.length === 0) return [];
	const batch = spawnSync("git", ["-C", repo, "cat-file", "--batch"], {
		input: `${objects.join("\n")}\n`,
		maxBuffer: 1024 * 1024 * 1024,
	});
	if (batch.status !== 0) throw new Error(`git cat-file failed: ${batch.stderr.toString("utf8")}`);
	const output = batch.stdout;
	const blobs: Uint8Array[] = [];
	let offset = 0;
	for (const object of objects) {
		const newline = output.indexOf(0x0a, offset);
		const header = output.subarray(offset, newline).toString("utf8").split(" ");
		if (header[1] !== "blob") throw new Error(`git cat-file: ${object} is not a blob`);
		const size = Number(header[2]);
		const start = newline + 1;
		blobs.push(new Uint8Array(output.subarray(start, start + size)));
		offset = start + size + 1;
	}
	return blobs;
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const under = (path: string, root: string) => root === "" || path === root || path.startsWith(`${root}/`);
/** More paths than this through symlinks (files and links alike) is not a skill source; the rest are left out. */
const MAX_LINKED_PATHS = 100_000;
/** Linux's limit on symlinks followed in one path lookup (`MAXSYMLINKS`): past it a checkout's file cannot be opened. */
const MAX_LINKS_ON_A_PATH = 40;

/** The paths of `sorted` below directory `dir`, found by binary search. */
function below(sorted: readonly string[], dir: string): string[] {
	const prefix = `${dir}/`;
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (sorted[mid]! < prefix) low = mid + 1;
		else high = mid;
	}
	const out: string[] = [];
	for (let index = low; index < sorted.length && sorted[index]!.startsWith(prefix); index++) out.push(sorted[index]!);
	return out;
}

/** A root path as given (`.`, `./x`, `x/`, `.pi/skills`) as a repository path: `""` for the whole tree. */
export function rootPath(path: string): string {
	let out = path;
	while (out.startsWith("./")) out = out.slice(2);
	out = out.replace(/\/+$/, "");
	return out === "." ? "" : out;
}

/**
 * The repository path a path names once every symlink on the way is followed, as a checkout would resolve it; undefined
 * when it leaves the repository, is absolute or loops.
 */
function canonical(path: string, links: ReadonlyMap<string, string>, hops = 0): string | undefined {
	const segments = path.split("/");
	const out: string[] = [];
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index]!;
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (out.length === 0) return undefined;
			out.pop();
			continue;
		}
		out.push(segment);
		const target = links.get(out.join("/"));
		if (target === undefined) continue;
		if (hops >= 40 || target.startsWith("/")) return undefined;
		const rest = segments.slice(index + 1);
		return canonical([...out.slice(0, -1), target, ...rest].join("/"), links, hops + 1);
	}
	return out.join("/");
}

/**
 * Every file under `paths` at `commit`, sorted by path, with symlinks followed as a checkout would: a link to a file
 * reads as that file, a link to a directory as the files under it. A link that leaves the repository, dangles or loops
 * is left out and reported; so are submodules.
 */
export function readTree(
	repo: string,
	commit: string,
	paths: readonly string[],
): { readonly files: GitFile[]; readonly problems: TreeProblem[] } {
	const roots = paths.map(rootPath);
	const inScope = (path: string) => roots.some((root) => under(path, root));
	const problems: TreeProblem[] = [];
	const scoped = listTree(repo, commit, roots.includes("") ? [] : roots);
	const linked = scoped.some((entry) => entry.mode === "120000");
	// A link can point anywhere in the repository, so resolving one needs the whole tree.
	const entries = linked ? listTree(repo, commit, []) : scoped;
	const regular = new Map<string, string>();
	const linkEntries: TreeEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755"))
			regular.set(entry.path, entry.object);
		else if (entry.mode === "120000") linkEntries.push(entry);
		else if (inScope(entry.path)) problems.push({ path: entry.path, reason: `a ${entry.type}, not a file` });
	}
	const decoder = new TextDecoder();
	const linkBlobs = readBlobs(
		repo,
		linkEntries.map((entry) => entry.object),
	);
	const links = new Map(linkEntries.map((entry, index) => [entry.path, decoder.decode(linkBlobs[index])]));

	// Virtual path -> the regular file it reads.
	const files = new Map<string, string>();
	for (const path of regular.keys()) if (inScope(path)) files.set(path, path);
	// Each queued link carries the links followed to reach it, by their place in the tree. A target holding one of them
	// would reach it again, endlessly: that is a loop, however the path to it was spelt.
	const queue: ({ virtual: string; real: string; chain: readonly string[] } | undefined)[] = linkEntries
		.map((entry) => entry.path)
		.filter(inScope)
		.map((path) => ({ virtual: path, real: path, chain: [] }));
	const regularPaths = [...regular.keys()].sort();
	const linkPaths = [...links.keys()].sort();
	// Every path a link adds counts, nested links included, so links to links to links cannot grow without bound.
	let linkedPaths = 0;
	for (let next = 0; next < queue.length; next++) {
		const { virtual: link, real, chain } = queue[next]!;
		queue[next] = undefined;
		const target = canonical(real, links);
		if (target === undefined) {
			problems.push({ path: link, reason: "a symlink that leaves the repository or loops" });
			continue;
		}
		if (chain.length >= MAX_LINKS_ON_A_PATH) {
			// A checkout could not open the file either: the system follows no more links in one path.
			problems.push({ path: link, reason: `more than ${MAX_LINKS_ON_A_PATH} symlinks on the way` });
			continue;
		}
		const followed = [...chain, real];
		if (followed.some((path) => under(path, target))) {
			problems.push({
				path: link,
				reason: `a symlink to ${target === "" ? "the repository root" : target}, which leads back to it`,
			});
			continue;
		}
		if (regular.has(target)) {
			files.set(link, target);
			continue;
		}
		const inside = below(regularPaths, target);
		const nested = below(linkPaths, target);
		if (inside.length === 0 && nested.length === 0) {
			problems.push({ path: link, reason: `a symlink to ${target}, which is not in the commit` });
			continue;
		}
		linkedPaths += inside.length + nested.length;
		if (linkedPaths > MAX_LINKED_PATHS) {
			problems.push({ path: link, reason: `more than ${MAX_LINKED_PATHS} paths through symlinks` });
			break;
		}
		for (const path of inside) files.set(`${link}${path.slice(target.length)}`, path);
		for (const path of nested) {
			queue.push({ virtual: `${link}${path.slice(target.length)}`, real: path, chain: followed });
		}
	}
	const ordered = [...files.entries()].map(([path, real]) => ({ path, real })).sort(byPath);
	const blobs = readBlobs(
		repo,
		ordered.map((file) => regular.get(file.real)!),
	);
	return {
		files: ordered.map((file, index) => ({
			path: file.path,
			bytes: blobs[index]!,
			...(file.real === file.path ? {} : { real: file.real }),
		})),
		problems: problems.sort(byPath),
	};
}

export interface CommitFilesInput {
	/** The branch to commit on, such as `main`; created when `parent` is undefined. */
	readonly branch: string;
	/**
	 * The commit the branch must stand at, which the new commit follows; undefined for a branch that does not exist yet.
	 * When the branch has moved on since, nothing is written and this throws, so a commit never loses another's work.
	 */
	readonly parent: string | undefined;
	/** Files to add or replace, repository-relative and `/`-separated. Every other file stays as it is. */
	readonly files: readonly { readonly path: string; readonly text: string }[];
	readonly message: string;
	readonly author: { readonly name: string; readonly email: string };
}

/**
 * Commits `files` on top of `parent` and moves `branch` to the commit, only if it still stands at `parent`. Builds the
 * tree in a throwaway index, so no working tree or the repository's own index is touched: point it at a bare clone, or
 * at a branch no checkout has out. Returns the new commit, or `parent` when the files change nothing.
 */
export function commitFiles(repo: string, input: CommitFilesInput): string {
	const scratch = mkdtempSync(join(tmpdir(), "harbour-git-index-"));
	const env = {
		...process.env,
		GIT_INDEX_FILE: join(scratch, "index"),
		GIT_AUTHOR_NAME: input.author.name,
		GIT_AUTHOR_EMAIL: input.author.email,
		GIT_COMMITTER_NAME: input.author.name,
		GIT_COMMITTER_EMAIL: input.author.email,
	};
	const git = (args: readonly string[], stdin?: string) => {
		const run = spawnSync("git", ["-C", repo, ...args], { env, input: stdin, maxBuffer: 256 * 1024 * 1024 });
		if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.toString("utf8").trim()}`);
		return run.stdout.toString("utf8").trim();
	};
	try {
		if (input.parent !== undefined) git(["read-tree", input.parent]);
		const entries = input.files.map((file) => {
			if (
				file.path.startsWith("/") ||
				// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character is what this refuses.
				/[\u0000-\u001f\u007f]/.test(file.path) ||
				file.path.split("/").some((part) => part === "" || part === "." || part === "..")
			) {
				throw new Error(`Not a repository path: ${file.path}`);
			}
			return `100644 ${git(["hash-object", "-w", "--stdin"], file.text)}\t${file.path}`;
		});
		// NUL-terminated records, so no path can end one record and start another.
		if (entries.length > 0) git(["update-index", "-z", "--index-info"], `${entries.join("\0")}\0`);
		const tree = git(["write-tree"]);
		if (input.parent !== undefined && git(["rev-parse", `${input.parent}^{tree}`]) === tree) return input.parent;
		const commit = git([
			"commit-tree",
			tree,
			...(input.parent === undefined ? [] : ["-p", input.parent]),
			"-m",
			input.message,
		]);
		// Compare-and-swap: refused when the branch moved since `parent` was read (an empty old value: must not exist).
		git(["update-ref", `refs/heads/${input.branch}`, commit, input.parent ?? ""]);
		return commit;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The commit's time, for records that carry none of their own. */
export function commitTime(repo: string, commit: string): number {
	return (
		Number(execFileSync("git", ["-C", repo, "show", "-s", "--format=%ct", commit], { encoding: "utf8" }).trim()) * 1000
	);
}
