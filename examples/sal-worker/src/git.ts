/**
 * Reading a Git repository at one commit, for the Sal adapters: the files under a path, as bytes. Uses the `git`
 * binary; nothing is checked out or written, so a pinned commit reads the same whatever the working tree holds.
 */
import { execFileSync, spawnSync } from "node:child_process";

export interface GitFile {
	/** Repository-relative, `/`-separated. */
	readonly path: string;
	readonly bytes: Uint8Array;
}

/** The full commit SHA `ref` names. Throws when it names none. */
export function resolveCommit(repo: string, ref: string): string {
	return execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
		encoding: "utf8",
	}).trim();
}

/** Every regular file under `paths` at `commit`, sorted by path. Symlinks and submodules are left out. */
export function readTree(repo: string, commit: string, paths: readonly string[]): GitFile[] {
	const listing = execFileSync("git", ["-C", repo, "ls-tree", "-r", "-z", "--full-tree", commit, "--", ...paths], {
		maxBuffer: 256 * 1024 * 1024,
	});
	const entries = listing
		.toString("utf8")
		.split("\0")
		.filter((line) => line !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			const [mode, type, object] = line.slice(0, tab).split(" ") as [string, string, string];
			return { mode, type, object, path: line.slice(tab + 1) };
		})
		.filter((entry) => entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755"));
	if (entries.length === 0) return [];
	const batch = spawnSync("git", ["-C", repo, "cat-file", "--batch"], {
		input: `${entries.map((entry) => entry.object).join("\n")}\n`,
		maxBuffer: 1024 * 1024 * 1024,
	});
	if (batch.status !== 0) throw new Error(`git cat-file failed: ${batch.stderr.toString("utf8")}`);
	const output = batch.stdout;
	const files: GitFile[] = [];
	let offset = 0;
	for (const entry of entries) {
		const newline = output.indexOf(0x0a, offset);
		const header = output.subarray(offset, newline).toString("utf8").split(" ");
		const size = Number(header[2]);
		const start = newline + 1;
		files.push({ path: entry.path, bytes: new Uint8Array(output.subarray(start, start + size)) });
		offset = start + size + 1;
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The commit's time, for records that carry none of their own. */
export function commitTime(repo: string, commit: string): number {
	return (
		Number(execFileSync("git", ["-C", repo, "show", "-s", "--format=%ct", commit], { encoding: "utf8" }).trim()) * 1000
	);
}
