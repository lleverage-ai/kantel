/**
 * Git reads in the isolate tier (M2-BE1): a `git` program for the isolate shell that answers read-only subcommands
 * with isomorphic-git over the shell's own filesystem, so `.git` is read lazily from the workspace like any other
 * file. Writes and pushes (`commit`, `push`, `checkout`, ...) run in the container tier: here they fail with a message
 * that says so, and `ISOLATE_GIT_ROUTE` sends only the read subcommands of a single git command to the isolate.
 *
 * A workspace has a `.git` once a container-tier clone or checkout has been committed into it, or a seed method that
 * keeps history (`lazy`) seeded it. Without one, every subcommand fails as real git does outside a repository.
 *
 * Supported: `status` (long, `-s`/`--short`, `--porcelain`), `log` (`-n N`, `-N`, `--max-count=N`, `--oneline`),
 * `rev-parse` (`HEAD` or a ref, `--short`, `--abbrev-ref HEAD`, `--show-toplevel`, `--is-inside-work-tree`,
 * `--git-dir`), `branch` (list, `--show-current`), `ls-files`, `show <rev>` (the commit, without a diff) and
 * `show <rev>:<path>`, `cat-file` (`-p`, `-t`, `-s`, `-e`), `remote` (`-v`, `get-url <name>`), `config --get <key>`.
 */
import { DEFAULT_TIER_ROUTES, type TierRoute } from "@harbour/contracts";
import git, { type ReadCommitResult } from "isomorphic-git";
import type { CustomCommand, IFileSystem } from "just-bash/browser";

/** The git subcommands the isolate answers. */
export const ISOLATE_GIT_READS = [
	"status",
	"log",
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
	subcommands: ["status", "log", "rev-parse", "ls-files", "show", "cat-file"],
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
			const oid = await resolveRef(repo, target);
			const commit = await git.readCommit({ fs, dir, oid });
			return ok(longLog(commit));
		}
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
	const { author, message } = entry.commit;
	const date = new Date(author.timestamp * 1000).toUTCString();
	const body = message
		.replace(/\n+$/, "")
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
	return `commit ${entry.oid}\nAuthor: ${author.name} <${author.email}>\nDate:   ${date}\n\n${body}\n`;
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
