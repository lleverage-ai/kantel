/**
 * Git reads in the isolate tier: a `git` program for the isolate shell that answers read-only subcommands
 * with isomorphic-git over the shell's own filesystem, so `.git` is read lazily from the workspace like any other
 * file. Writes and pushes (`commit`, `push`, `checkout`, ...) run in the container tier: here they fail with a message
 * that says so, and `ISOLATE_GIT_ROUTE` sends only the read subcommands of a single git command to the isolate.
 *
 * A workspace has a `.git` once a container-tier clone or checkout has been committed into it, or a git seed wrote its
 * recent history as a shallow, blobless `.git` (`@kantel/workspace/git-history`), as Cloudflare's does. Without one, every subcommand fails as real git does outside a repository.
 *
 * Supported: `status` (long, `-s`/`--short`, `--porcelain`), `log` (`-n N`, `-N`, `--max-count=N`, `--oneline`),
 * `rev-parse` (`HEAD` or a ref, `--short`, `--abbrev-ref HEAD`, `--show-toplevel`, `--is-inside-work-tree`,
 * `--git-dir`), `branch` (list, `--show-current`), `ls-files`, `show <rev>` (the commit and its diff against its first
 * parent; a merge's header only, as git shows a clean merge) and `show <rev>:<path>`, `diff` (two revisions, a revision
 * and the working tree, the index and the working tree, `--cached`; `-- <paths>`), both with `--stat`, `--name-only`,
 * `--name-status` and (`show`) `-s`, `cat-file` (`-p`, `-t`, `-s`, `-e`), `remote` (`-v`, `get-url <name>`),
 * `config --get <key>`. A seeded `.git` is blobless beyond recent diffs: a patch that needs a blob it lacks says so.
 */
import { DEFAULT_TIER_ROUTES, type TierRoute } from "@kantel/contracts";
import { structuredPatch } from "diff";
import git, { type ReadCommitResult, STAGE, TREE, type Walker, type WalkerEntry, WORKDIR } from "isomorphic-git";
import type { CustomCommand, IFileSystem } from "just-bash/browser";

/** The git subcommands the isolate answers. */
export const ISOLATE_GIT_READS = [
	"status",
	"log",
	"diff",
	"rev-parse",
	"branch",
	"ls-files",
	"show",
	"cat-file",
	"remote",
	"config",
] as const;

/**
 * The route that sends a single `git` read to the isolate: the subcommands that have no write form. `branch`, `remote`
 * and `config` still go to the container, where their write forms work; the isolate answers their read forms when a
 * script there calls them.
 */
export const ISOLATE_GIT_ROUTE: TierRoute = {
	tool: "bash",
	programs: ["git"],
	subcommands: ["status", "log", "diff", "rev-parse", "ls-files", "show", "cat-file"],
	tier: "isolate",
};

/** The default table with git reads in the isolate, for a host that installs `createIsolateGitCommand`. */
export const ISOLATE_GIT_ROUTES: readonly TierRoute[] = [ISOLATE_GIT_ROUTE, ...DEFAULT_TIER_ROUTES];

/** Subcommands with a read-only form here whose other forms write: only the forms listed above are served. */
const WRITE_FORMS: { readonly [subcommand: string]: (args: readonly string[]) => boolean } = {
	branch: (args) => args.some((arg) => !["--show-current", "--list", "-l", "-a", "--all", "-r"].includes(arg)),
	remote: (args) => args.length > 0 && !(args[0] === "-v" || args[0] === "get-url" || args[0] === "show"),
	config: (args) => args[0] !== "--get" && !(args.length === 1 && !args[0]?.startsWith("-")),
};

type Result = { stdout: string; stderr: string; exitCode: number };
const ok = (stdout: string): Result => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 128): Result => ({ stdout: "", stderr, exitCode });

export function createIsolateGitCommand(): CustomCommand {
	return {
		name: "git",
		async execute(args: string[], ctx: { fs: IFileSystem; cwd: string }): Promise<Result> {
			const [subcommand, ...rest] = args;
			if (subcommand === undefined) return fail("usage: git <command> [<args>]\n", 1);
			if (subcommand === "--version" || subcommand === "version") return ok("git version isomorphic-git\n");
			if (!(ISOLATE_GIT_READS as readonly string[]).includes(subcommand) || WRITE_FORMS[subcommand]?.(rest)) {
				return fail(
					`git ${subcommand} is not available in the isolate tier: writes and pushes run in the container tier\n`,
					1,
				);
			}
			const fs = isomorphicFs(ctx.fs);
			const dir = await findRoot(ctx.fs, ctx.cwd);
			if (dir === undefined) {
				return fail("fatal: not a git repository (or any of the parent directories): .git\n");
			}
			try {
				return await run(subcommand, rest, { fs, dir, cwd: ctx.cwd });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return fail(`fatal: ${message}\n`);
			}
		},
	} as CustomCommand;
}

interface Repo {
	readonly fs: ReturnType<typeof isomorphicFs>;
	readonly dir: string;
	readonly cwd: string;
}

async function run(subcommand: string, args: readonly string[], repo: Repo): Promise<Result> {
	const { fs, dir } = repo;
	switch (subcommand) {
		case "status":
			return status(repo, args);
		case "log": {
			let depth: number | undefined;
			let oneline = false;
			let ref = "HEAD";
			for (let index = 0; index < args.length; index++) {
				const arg = args[index] as string;
				if (arg === "--oneline") oneline = true;
				else if (arg === "-n") depth = Number(args[++index]);
				else if (arg.startsWith("--max-count=")) depth = Number(arg.slice(12));
				else if (/^-\d+$/.test(arg)) depth = Number(arg.slice(1));
				else if (!arg.startsWith("-")) ref = arg;
				else return fail(`git log: ${arg} is not supported in the isolate tier\n`, 129);
			}
			if (depth !== undefined && !(Number.isInteger(depth) && depth >= 0)) return fail("fatal: bad count\n");
			const commits = await git.log({ fs, dir, ref: await resolveRef(repo, ref), ...(depth ? { depth } : {}) });
			return ok(
				commits
					.map((entry) => (oneline ? `${entry.oid.slice(0, 7)} ${firstLine(entry)}\n` : longLog(entry)))
					.join(oneline ? "" : "\n"),
			);
		}
		case "rev-parse": {
			const out: string[] = [];
			let short = false;
			let abbrev = false;
			for (const arg of args) {
				if (arg === "--short") short = true;
				else if (arg === "--abbrev-ref") abbrev = true;
				else if (arg === "--show-toplevel") out.push(dir);
				else if (arg === "--is-inside-work-tree") out.push("true");
				else if (arg === "--git-dir") out.push(`${dir}/.git`);
				else if (abbrev) out.push((await git.currentBranch({ fs, dir })) ?? "HEAD");
				else {
					const oid = await resolveRef(repo, arg);
					out.push(short ? oid.slice(0, 7) : oid);
				}
			}
			return ok(out.map((line) => `${line}\n`).join(""));
		}
		case "branch": {
			const current = await git.currentBranch({ fs, dir });
			if (args.includes("--show-current")) return ok(current === undefined ? "" : `${current}\n`);
			const branches = await git.listBranches({ fs, dir });
			const lines = branches.map((name) => `${name === current ? "*" : " "} ${name}\n`);
			if (current === undefined)
				lines.unshift(`* (HEAD detached at ${(await resolveRef(repo, "HEAD")).slice(0, 7)})\n`);
			return ok(lines.join(""));
		}
		case "ls-files":
			return ok((await git.listFiles({ fs, dir })).map((path) => `${path}\n`).join(""));
		case "show": {
			const target = args.find((arg) => !arg.startsWith("-")) ?? "HEAD";
			const colon = target.indexOf(":");
			if (colon >= 0) {
				const oid = await resolveRef(repo, target.slice(0, colon) || "HEAD");
				const { blob } = await git.readBlob({ fs, dir, oid, filepath: target.slice(colon + 1) });
				return ok(new TextDecoder().decode(blob));
			}
			const format = diffFormat(args);
			if (typeof format !== "string") return format;
			const oid = await resolveRef(repo, target);
			const commit = await git.readCommit({ fs, dir, oid });
			const parents = commit.commit.parent;
			if (format === "none" || parents.length > 1) return ok(longLog(commit));
			const parent = parents[0];
			if (parent !== undefined && !(await hasObject(repo, parent))) {
				return ok(`${longLog(commit)}\n(its parent is past this shallow clone's history, so there is no diff)\n`);
			}
			const changes = await diffWalk(repo, [
				parent === undefined ? undefined : TREE({ ref: parent }),
				TREE({ ref: oid }),
			]);
			const body = await renderDiff(repo, changes, format);
			return ok(body === "" ? longLog(commit) : `${longLog(commit)}\n${body}`);
		}
		case "diff":
			return diff(repo, args);
		case "cat-file": {
			const [flag, spec] = args;
			if (spec === undefined || !["-p", "-t", "-s", "-e"].includes(flag ?? "")) {
				return fail("usage: git cat-file (-p | -t | -s | -e) <object>\n", 129);
			}
			let object: Awaited<ReturnType<typeof git.readObject>>;
			try {
				object = await git.readObject({ fs, dir, oid: await resolveRef(repo, spec), format: "content" });
			} catch {
				return flag === "-e" ? fail("", 1) : fail(`fatal: Not a valid object name ${spec}\n`);
			}
			const bytes = object.object as Uint8Array;
			if (flag === "-e") return ok("");
			if (flag === "-t") return ok(`${object.type}\n`);
			if (flag === "-s") return ok(`${bytes.byteLength}\n`);
			if (object.type === "tree") {
				const tree = await git.readTree({ fs, dir, oid: object.oid });
				return ok(tree.tree.map((entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.path}\n`).join(""));
			}
			return ok(new TextDecoder().decode(bytes));
		}
		case "remote": {
			const remotes = await git.listRemotes({ fs, dir });
			if (args[0] === "get-url") {
				const found = remotes.find((remote) => remote.remote === args[1]);
				return found === undefined ? fail(`error: No such remote '${args[1]}'\n`, 2) : ok(`${found.url}\n`);
			}
			if (args[0] === "-v") {
				return ok(remotes.map(({ remote, url }) => `${remote}\t${url} (fetch)\n${remote}\t${url} (push)\n`).join(""));
			}
			return ok(remotes.map(({ remote }) => `${remote}\n`).join(""));
		}
		case "config": {
			const key = args[0] === "--get" ? args[1] : args[0];
			if (key === undefined) return fail("error: key does not contain a section\n", 2);
			const value = await git.getConfig({ fs, dir, path: key });
			return value === undefined ? fail("", 1) : ok(`${String(value)}\n`);
		}
		default:
			return fail(`git ${subcommand} is not available in the isolate tier\n`, 1);
	}
}

async function status(repo: Repo, args: readonly string[]): Promise<Result> {
	const { fs, dir } = repo;
	const short = args.some((arg) => arg === "-s" || arg === "--short" || arg.startsWith("--porcelain"));
	// [path, HEAD, workdir, stage]: 0 absent, 1 present (identical to HEAD), 2 changed (or added), 3 differs from both.
	const matrix = await git.statusMatrix({ fs, dir });
	const lines: { readonly x: string; readonly y: string; readonly path: string }[] = [];
	for (const [path, head, workdir, stage] of matrix) {
		const x = stage === head ? " " : head === 0 ? "A" : stage === 0 ? "D" : "M";
		let y = " ";
		if (workdir === 0 && stage !== 0) y = "D";
		else if (head === 0 && stage === 0 && workdir === 2) {
			lines.push({ x: "?", y: "?", path });
			continue;
		} else if (workdir !== stage && !(head === 1 && workdir === 1 && stage === 1)) y = "M";
		if (x === " " && y === " ") continue;
		lines.push({ x, y, path });
	}
	if (short) {
		// As git prints them: tracked changes first, then untracked files.
		const ordered = [...lines.filter((line) => line.x !== "?"), ...lines.filter((line) => line.x === "?")];
		return ok(ordered.map((line) => `${line.x}${line.y} ${line.path}\n`).join(""));
	}
	const branch = await git.currentBranch({ fs, dir });
	const out = [branch === undefined ? "HEAD detached\n" : `On branch ${branch}\n`];
	const staged = lines.filter((line) => line.x !== " " && line.x !== "?");
	const unstaged = lines.filter((line) => line.y !== " " && line.y !== "?");
	const untracked = lines.filter((line) => line.x === "?");
	const names: { readonly [code: string]: string } = { M: "modified", A: "new file", D: "deleted" };
	if (staged.length > 0) {
		out.push("Changes to be committed:\n", ...staged.map((line) => `\t${names[line.x]}:   ${line.path}\n`), "\n");
	}
	if (unstaged.length > 0) {
		out.push(
			"Changes not staged for commit:\n",
			...unstaged.map((line) => `\t${names[line.y]}:   ${line.path}\n`),
			"\n",
		);
	}
	if (untracked.length > 0) out.push("Untracked files:\n", ...untracked.map((line) => `\t${line.path}\n`), "\n");
	if (lines.length === 0) out.push("nothing to commit, working tree clean\n");
	return ok(out.join(""));
}

type DiffFormat = "patch" | "stat" | "name-only" | "name-status" | "none";

/** The output `--stat`, `--name-only`, `--name-status` or `-s` asks for; a usage error for another option. */
function diffFormat(args: readonly string[]): DiffFormat | Result {
	let format: DiffFormat = "patch";
	for (const arg of args) {
		if (arg === "--") break;
		if (!arg.startsWith("-")) continue;
		if (arg === "--stat") format = "stat";
		else if (arg === "--name-only") format = "name-only";
		else if (arg === "--name-status") format = "name-status";
		else if (arg === "-s" || arg === "--no-patch") format = "none";
		else if (arg === "-p" || arg === "--patch" || arg === "--cached" || arg === "--staged") continue;
		else return fail(`git: ${arg} is not supported in the isolate tier\n`, 129);
	}
	return format;
}

/** `git diff`: two revisions (`a b` or `a..b`), a revision and the working tree, or the index and the working tree. */
async function diff(repo: Repo, args: readonly string[]): Promise<Result> {
	const format = diffFormat(args);
	if (typeof format !== "string") return format;
	const separator = args.indexOf("--");
	const before = separator < 0 ? args : args.slice(0, separator);
	const paths = separator < 0 ? [] : args.slice(separator + 1).map((path) => path.replace(/^\.\/|\/+$/g, ""));
	const cached = before.includes("--cached") || before.includes("--staged");
	const revs = before
		.filter((arg) => !arg.startsWith("-"))
		.flatMap((arg) => {
			const range = /^(.*?)\.\.(.*)$/.exec(arg);
			return range === null ? [arg] : [range[1] || "HEAD", range[2] || "HEAD"];
		});
	if (revs.length > 2) return fail("usage: git diff [<commit> [<commit>]] [-- <path>...]\n", 129);
	const trees = await Promise.all(revs.map(async (rev) => TREE({ ref: await resolveRef(repo, rev) })));
	let walkers: (Walker | undefined)[];
	if (trees.length === 2) walkers = trees;
	else if (cached) walkers = [trees[0] ?? TREE({ ref: "HEAD" }), STAGE()];
	else walkers = [trees[0] ?? STAGE(), WORKDIR()];
	const changes = (await diffWalk(repo, walkers, trees.length < 2 && !cached)).filter(
		(change) => paths.length === 0 || paths.some((path) => change.path === path || change.path.startsWith(`${path}/`)),
	);
	return ok(await renderDiff(repo, changes, format));
}

/** One side of a changed file: its blob ID and mode, and its content when it's in the working tree. */
interface Side {
	readonly oid: string;
	readonly mode: number;
	readonly content?: Uint8Array;
}

interface Change {
	readonly path: string;
	readonly before?: Side;
	readonly after?: Side;
}

/**
 * The files that differ between two walkers, in path order. With `worktree`, the right is the working tree, where only
 * files the left (or the index) tracks count, as `git diff` leaves untracked files out.
 */
async function diffWalk(repo: Repo, walkers: readonly (Walker | undefined)[], worktree = false): Promise<Change[]> {
	const [left, right] = walkers;
	const trees = [left ?? TREE({ ref: EMPTY_TREE }), right as Walker, ...(worktree ? [STAGE()] : [])];
	const side = async (entry: WalkerEntry | null, content: boolean): Promise<Side | undefined> => {
		if (entry === null || (await entry.type()) !== "blob") return undefined;
		const oid = await entry.oid();
		const mode = await entry.mode();
		return content ? { oid, mode, content: (await entry.content()) as Uint8Array } : { oid, mode };
	};
	const changes = (await git.walk({
		fs: repo.fs,
		dir: repo.dir,
		trees,
		async map(path, [a, b, stage]) {
			if (path === ".") return undefined;
			const [left, right] = await Promise.all([a?.type(), b?.type()]);
			const tracked = (a !== null && a !== undefined) || (stage !== null && stage !== undefined);
			if (left !== "blob" && right !== "blob") {
				// A directory: not walked into when it's untracked, or the same tree on both sides.
				if (worktree && !tracked) return null;
				if (left === "tree" && right === "tree" && !worktree) {
					const [before, after] = await Promise.all([a?.oid(), b?.oid()]);
					if (before !== undefined && before === after) return null;
				}
				return undefined;
			}
			if (worktree && !tracked) return undefined;
			const before = await side(a ?? null, false);
			const after = await side(b ?? null, worktree);
			if (before?.oid === after?.oid && before?.mode === after?.mode) return undefined;
			return { path, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
		},
	})) as (Change | undefined)[];
	return changes.filter((change): change is Change => change !== undefined);
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function hasObject(repo: Repo, oid: string): Promise<boolean> {
	try {
		await git.readObject({ fs: repo.fs, dir: repo.dir, oid, format: "deflated" });
		return true;
	} catch {
		return false;
	}
}

/** A side's content, or `undefined` when the blobless clone doesn't have it. */
async function contentOf(repo: Repo, side: Side | undefined): Promise<Uint8Array | null | undefined> {
	if (side === undefined) return null;
	if (side.content !== undefined) return side.content;
	try {
		return (await git.readBlob({ fs: repo.fs, dir: repo.dir, oid: side.oid })).blob;
	} catch {
		return undefined;
	}
}

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);
const modeText = (mode: number) => (mode === 0o40000 ? "40000" : mode.toString(8).padStart(6, "0"));
const abbrev = (oid: string | undefined) => (oid ?? "0".repeat(40)).slice(0, 7);

async function renderDiff(repo: Repo, changes: readonly Change[], format: DiffFormat): Promise<string> {
	if (format === "none" || changes.length === 0) return "";
	if (format === "name-only") return changes.map((change) => `${change.path}\n`).join("");
	if (format === "name-status") {
		return changes
			.map(
				(change) => `${change.before === undefined ? "A" : change.after === undefined ? "D" : "M"}\t${change.path}\n`,
			)
			.join("");
	}
	const decoder = new TextDecoder();
	const out: string[] = [];
	const stats: { path: string; added: number; removed: number; binary?: string; missing?: boolean }[] = [];
	for (const change of changes) {
		const { path, before, after } = change;
		const [old, now] = await Promise.all([contentOf(repo, before), contentOf(repo, after)]);
		const header = [`diff --git a/${path} b/${path}\n`];
		if (before === undefined) header.push(`new file mode ${modeText(after?.mode ?? 0o100644)}\n`);
		else if (after === undefined) header.push(`deleted file mode ${modeText(before.mode)}\n`);
		else if (before.mode !== after.mode) {
			header.push(`old mode ${modeText(before.mode)}\n`, `new mode ${modeText(after.mode)}\n`);
		}
		if (before?.oid !== after?.oid) {
			const same = before !== undefined && after !== undefined && before.mode === after.mode;
			header.push(`index ${abbrev(before?.oid)}..${abbrev(after?.oid)}${same ? ` ${modeText(after.mode)}` : ""}\n`);
		}
		if (old === undefined || now === undefined) {
			stats.push({ path, added: 0, removed: 0, missing: true });
			out.push(
				...header,
				`(${path} as of ${old === undefined ? "before" : "after"} this change isn't in this shallow, blobless clone, which holds only recent diffs: run the diff in the container tier)\n`,
			);
			continue;
		}
		if (before?.oid === after?.oid) {
			stats.push({ path, added: 0, removed: 0 });
			out.push(...header);
			continue;
		}
		if ((old !== null && isBinary(old)) || (now !== null && isBinary(now))) {
			stats.push({
				path,
				added: 0,
				removed: 0,
				binary: `Bin ${old?.byteLength ?? 0} -> ${now?.byteLength ?? 0} bytes`,
			});
			out.push(
				...header,
				`Binary files ${old === null ? "/dev/null" : `a/${path}`} and ${now === null ? "/dev/null" : `b/${path}`} differ\n`,
			);
			continue;
		}
		const oldText = old === null ? "" : decoder.decode(old);
		const newText = now === null ? "" : decoder.decode(now);
		const patch = structuredPatch(`a/${path}`, `b/${path}`, oldText, newText, "", "", { context: 3 });
		const oldLines = oldText.split("\n");
		let added = 0;
		let removed = 0;
		const hunks: string[] = [];
		for (const hunk of patch.hunks) {
			// As git writes them: no count when it's 1, and an empty side starts at the line before.
			const range = (start: number, count: number) =>
				count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;
			const func = funcname(oldLines, hunk.oldStart - 1);
			hunks.push(
				`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@${func === "" ? "" : ` ${func}`}\n`,
			);
			for (const line of hunk.lines) {
				if (line.startsWith("+")) added++;
				else if (line.startsWith("-")) removed++;
				hunks.push(`${line}\n`);
			}
		}
		stats.push({ path, added, removed });
		out.push(
			...header,
			`--- ${old === null ? "/dev/null" : `a/${path}`}\n`,
			`+++ ${now === null ? "/dev/null" : `b/${path}`}\n`,
			...hunks,
		);
	}
	return format === "stat" ? renderStat(stats) : out.join("");
}

/**
 * git's default hunk header context: the nearest line before the hunk (in the old file) that starts with a letter, `_`
 * or `$`, cut to 80 bytes, without trailing whitespace.
 */
function funcname(lines: readonly string[], before: number): string {
	for (let index = before - 1; index >= 0; index--) {
		const line = lines[index] as string;
		if (/^[A-Za-z_$]/.test(line)) return line.slice(0, 80).replace(/\s+$/, "");
	}
	return "";
}

function renderStat(
	stats: readonly { path: string; added: number; removed: number; binary?: string; missing?: boolean }[],
): string {
	if (stats.length === 0) return "";
	const width = Math.max(...stats.map((stat) => stat.path.length));
	const counts = stats.map((stat) => stat.binary ?? (stat.missing ? "?" : String(stat.added + stat.removed)));
	const countWidth = Math.max(...counts.map((count) => (count.startsWith("Bin") ? 0 : count.length)));
	const most = Math.max(...stats.map((stat) => stat.added + stat.removed));
	const room = Math.max(10, 80 - width - countWidth - 4);
	const scale = (n: number) => (most <= room ? n : Math.max(n > 0 ? 1 : 0, Math.round((n * room) / most)));
	const lines = stats.map((stat, index) => {
		const count = counts[index] as string;
		const graph = stat.binary === undefined ? `${"+".repeat(scale(stat.added))}${"-".repeat(scale(stat.removed))}` : "";
		const shown = count.startsWith("Bin") ? count : count.padStart(countWidth);
		return ` ${stat.path.padEnd(width)} | ${shown}${graph === "" ? "" : ` ${graph}`}\n`;
	});
	const added = stats.reduce((total, stat) => total + stat.added, 0);
	const removed = stats.reduce((total, stat) => total + stat.removed, 0);
	const summary = [`${stats.length} file${stats.length === 1 ? "" : "s"} changed`];
	if (added > 0) summary.push(`${added} insertion${added === 1 ? "" : "s"}(+)`);
	if (removed > 0) summary.push(`${removed} deletion${removed === 1 ? "" : "s"}(-)`);
	return `${lines.join("")} ${summary.join(", ")}\n`;
}

async function dropped(): Promise<void> {}

async function resolveRef(repo: Repo, ref: string): Promise<string> {
	const colon = ref.indexOf(":");
	if (colon >= 0) {
		// `<rev>:<path>`: the object at that path in the revision's tree.
		const oid = await resolveRef(repo, ref.slice(0, colon) || "HEAD");
		const filepath = ref.slice(colon + 1).replace(/^\/+|\/+$/g, "");
		if (filepath === "") return (await git.readCommit({ fs: repo.fs, dir: repo.dir, oid })).commit.tree;
		return (await git.readObject({ fs: repo.fs, dir: repo.dir, oid, filepath, format: "deflated" })).oid;
	}
	if (/^[0-9a-f]{40}$/.test(ref)) return ref;
	if (/^[0-9a-f]{4,39}$/.test(ref)) {
		try {
			return await git.expandOid({ fs: repo.fs, dir: repo.dir, oid: ref });
		} catch {
			// Not an abbreviated object: try it as a ref.
		}
	}
	const parent = /^(.+?)((?:[~^]\d*)+)$/.exec(ref);
	if (parent !== null) {
		let oid = await resolveRef(repo, parent[1] as string);
		for (const step of (parent[2] as string).match(/[~^]\d*/g) ?? []) {
			const count = step.length > 1 ? Number(step.slice(1)) : 1;
			for (let index = 0; index < (step[0] === "~" ? count : 1); index++) {
				const { commit } = await git.readCommit({ fs: repo.fs, dir: repo.dir, oid });
				const next = commit.parent[step[0] === "^" ? count - 1 : 0];
				if (next === undefined) throw new Error(`ambiguous argument '${ref}': unknown revision`);
				oid = next;
			}
		}
		return oid;
	}
	try {
		return await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref });
	} catch {
		throw new Error(`ambiguous argument '${ref}': unknown revision or path not in the working tree.`);
	}
}

function firstLine(entry: ReadCommitResult): string {
	return entry.commit.message.split("\n")[0] ?? "";
}

function longLog(entry: ReadCommitResult): string {
	const { author, message, parent } = entry.commit;
	const date = gitDate(author.timestamp, author.timezoneOffset);
	const body = message
		.replace(/\n+$/, "")
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
	const merge = parent.length > 1 ? `Merge: ${parent.map((oid) => oid.slice(0, 7)).join(" ")}\n` : "";
	return `commit ${entry.oid}\n${merge}Author: ${author.name} <${author.email}>\nDate:   ${date}\n\n${body}\n`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** git's default date, in the author's own time zone: `Thu Oct 1 00:00:00 2026 +0000`. */
export function gitDate(timestamp: number, timezoneOffset: number): string {
	// isomorphic-git's offset is minutes west of UTC, as `Date#getTimezoneOffset` has it.
	const east = -timezoneOffset;
	const local = new Date((timestamp + east * 60) * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
	const zone = `${east < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(east) / 60))}${pad(Math.abs(east) % 60)}`;
	return `${DAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()} ${time} ${local.getUTCFullYear()} ${zone}`;
}

/** The nearest directory at or above `cwd` that holds a `.git` directory. */
async function findRoot(fs: IFileSystem, cwd: string): Promise<string | undefined> {
	let dir = cwd.replace(/\/+$/, "") || "/";
	for (;;) {
		try {
			if ((await fs.stat(`${dir === "/" ? "" : dir}/.git`)).isDirectory) return dir;
		} catch {
			// Not here: look further up.
		}
		if (dir === "/") return undefined;
		dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
	}
}

/**
 * The shell's filesystem as the `fs` isomorphic-git takes, with Node-style error codes, read-only: every write is
 * dropped. isomorphic-git refreshes the index's cached stats while it computes a status; that refresh must not become a
 * workspace change, and these commands write nothing else.
 */
export function isomorphicFs(fs: IFileSystem) {
	const coded = async <T>(work: () => Promise<T>): Promise<T> => {
		try {
			return await work();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = /^(E[A-Z]+)\b/.exec(message)?.[1] ?? (/no such file|not found/i.test(message) ? "ENOENT" : "EIO");
			throw Object.assign(new Error(message), { code });
		}
	};
	const stat = (lstat: boolean) => async (path: string) => {
		const found = await coded(() => (lstat ? fs.lstat(path) : fs.stat(path)));
		const mtimeMs = found.mtime.getTime();
		const type = found.isDirectory ? 0o040000 : found.isSymbolicLink ? 0o120000 : 0o100000;
		return {
			isFile: () => found.isFile,
			isDirectory: () => found.isDirectory,
			isSymbolicLink: () => found.isSymbolicLink,
			mode: type | (found.mode & 0o7777),
			size: found.size,
			mtimeMs,
			ctimeMs: mtimeMs,
			ino: Number(found.ino ?? 0),
			dev: Number(found.dev ?? 0),
			uid: 0,
			gid: 0,
		};
	};
	return {
		promises: {
			async readFile(path: string, options?: { encoding?: string } | string) {
				const encoding = typeof options === "string" ? options : options?.encoding;
				if (encoding === "utf8" || encoding === "utf-8") return coded(() => fs.readFile(path, "utf8"));
				return coded(() => fs.readFileBuffer(path));
			},
			readdir: (path: string) => coded(() => fs.readdir(path)),
			stat: stat(false),
			lstat: stat(true),
			readlink: (path: string) => coded(() => fs.readlink(path)),
			writeFile: dropped,
			unlink: dropped,
			mkdir: dropped,
			rmdir: dropped,
			symlink: dropped,
			chmod: dropped,
		},
	};
}
