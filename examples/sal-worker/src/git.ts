/**
 * Reading a Git repository at one commit, for the Sal adapters: the files under a path, as bytes. Uses the `git`
 * binary; nothing is checked out or written, so a pinned commit reads the same whatever the working tree holds.
 */
import { execFileSync, spawnSync } from "node:child_process";

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
/** Paths deeper than this are a symlink loop, not a skill. */
const MAX_DEPTH = 32;

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
	const roots = paths.map((path) => path.replace(/^\.\/?/, "").replace(/\/+$/, ""));
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
	const queue = linkEntries.map((entry) => entry.path).filter(inScope);
	const regularPaths = [...regular.keys()];
	const linkPaths = [...links.keys()];
	while (queue.length > 0) {
		const link = queue.shift()!;
		const target = canonical(link, links);
		if (target === undefined) {
			problems.push({ path: link, reason: "a symlink that leaves the repository or loops" });
			continue;
		}
		if (target === "" || under(link, target)) {
			problems.push({
				path: link,
				reason: `a symlink to ${target === "" ? "the repository root" : target}, which holds it`,
			});
			continue;
		}
		if (regular.has(target)) {
			files.set(link, target);
			continue;
		}
		const inside = regularPaths.filter((path) => path.startsWith(`${target}/`));
		const nested = linkPaths.filter((path) => path.startsWith(`${target}/`));
		if (inside.length === 0 && nested.length === 0) {
			problems.push({ path: link, reason: `a symlink to ${target}, which is not in the commit` });
			continue;
		}
		for (const path of inside) {
			const virtual = `${link}${path.slice(target.length)}`;
			if (virtual.split("/").length > MAX_DEPTH) {
				problems.push({ path: link, reason: "a symlink that loops" });
				break;
			}
			files.set(virtual, path);
		}
		for (const path of nested) {
			const virtual = `${link}${path.slice(target.length)}`;
			if (virtual.split("/").length > MAX_DEPTH) continue;
			queue.push(virtual);
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

/** The commit's time, for records that carry none of their own. */
export function commitTime(repo: string, commit: string): number {
	return (
		Number(execFileSync("git", ["-C", repo, "show", "-s", "--format=%ct", commit], { encoding: "utf8" }).trim()) * 1000
	);
}
