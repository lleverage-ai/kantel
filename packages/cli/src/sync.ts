/**
 * `kantel sync <id> --git`: brings a git checkout in a microVM to this working tree by sending one patch against the
 * commit the checkout started from, rather than every file as `kantel push` does (#726). The sandbox's clone, its
 * `node_modules` and its build caches stay; only the difference goes over.
 *
 * Here, in a copy of the index (yours is never touched): `git add -u` and the new files `.gitignore` doesn't leave
 * out, then `git write-tree` names the tree the sandbox must end with, and `git diff-tree --binary <base> <tree>` is
 * the patch. There, in one command: `git reset --hard <base>`, `git clean -fd` (ignored files stay), `git apply
 * --index` and `git write-tree`, which must name the same tree, or sync fails.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, realpath, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, posix, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { KantelApiError, type KantelClient, type Sandbox } from "@kantel/api/sdk";
import { CliError } from "./errors.ts";
import { excludedUnder, PART, rootContexts, type Skipped, within } from "./transfer.ts";

/** The snapshot label that names a checkout's base commit, as the saved-snapshots guide suggests. */
export const BASE_LABEL = "git.base";
/** The file in a checkout that records its base commit, where its HEAD may have moved on (Lleverage's checks). */
export const BASE_FILE = ".kantel-base-sha";
/** How many patch parts go up at once. */
const CONCURRENCY = 6;
/** The sandbox side's time limit: a reset of a big checkout with a stale index reads every file. */
const APPLY_TIMEOUT_MS = 600_000;

const quote = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);
const short = (commit: string): string => commit.slice(0, 10);

interface GitRun {
	readonly code: number;
	readonly stdout: Buffer;
	readonly stderr: string;
}

/** Runs git in `cwd`, with `env` added and `input` on its stdin. */
function git(
	cwd: string,
	args: readonly string[],
	options: { readonly env?: Readonly<Record<string, string>>; readonly input?: string } = {},
): Promise<GitRun> {
	return new Promise((done, fail) => {
		const child = spawn("git", args, {
			cwd,
			env: { ...process.env, ...options.env },
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
		child.once("error", (error) =>
			fail(new CliError(`couldn't run git (${error.message}): kantel sync --git needs git on your PATH`)),
		);
		child.once("close", (code) =>
			done({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8").trim() }),
		);
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

/** git's stdout, or a CliError with its stderr. */
async function gitOut(
	cwd: string,
	args: readonly string[],
	options: { readonly env?: Readonly<Record<string, string>>; readonly input?: string } = {},
): Promise<Buffer> {
	const result = await git(cwd, args, options);
	if (result.code !== 0) {
		throw new CliError(`git ${args[0]} failed in ${cwd}: ${result.stderr || `it exited ${result.code}`}`);
	}
	return result.stdout;
}

const lines0 = (out: Buffer): string[] => out.toString("utf8").split("\0").filter(Boolean);

/** The top of the working tree `dir` is in; a CliError outside one. */
export async function repositoryTop(dir: string): Promise<string> {
	const result = await git(dir, ["rev-parse", "--show-toplevel"]);
	const top = result.stdout.toString("utf8").trim();
	if (result.code !== 0 || top === "") {
		throw new CliError(
			`${dir} isn't in a git working tree: sync --git sends a patch of one; kantel push copies any directory`,
		);
	}
	return resolve(top);
}

/** Where a base commit came from, as sync names it. */
export type BaseSource = "flag" | "file" | "label" | "head";

export interface Base {
	/** As recorded: a commit, maybe abbreviated. */
	readonly commit: string;
	readonly source: BaseSource;
	/** In words, for messages: `its .kantel-base-sha`, `the git.base label on lleverage-checks-warm`. */
	readonly from: string;
}

/** What the sandbox says about its checkout. */
export interface Checkout {
	/** The checkout's top in the sandbox. */
	readonly top: string;
	/** Its HEAD, if it has a commit checked out. */
	readonly head?: string;
	/** What its `.kantel-base-sha` holds. */
	readonly recorded?: string;
}

/**
 * The commit to sync against: `--base`, else the checkout's `.kantel-base-sha` (its own record, where its HEAD has
 * moved on), else the `git.base` label on the snapshot the sandbox was made from, else the checkout's HEAD.
 */
export function chooseBase(options: {
	readonly flag?: string;
	readonly checkout: Checkout;
	readonly label?: { readonly commit: string; readonly snapshot: string };
	readonly sandboxId: string;
}): Base {
	const { flag, checkout, label } = options;
	if (flag !== undefined && flag !== "") return { commit: flag, source: "flag", from: "--base" };
	if (checkout.recorded !== undefined && checkout.recorded !== "") {
		return { commit: checkout.recorded, source: "file", from: `its ${BASE_FILE}` };
	}
	if (label !== undefined && label.commit !== "") {
		return { commit: label.commit, source: "label", from: `the ${BASE_LABEL} label on ${label.snapshot}` };
	}
	if (checkout.head !== undefined && checkout.head !== "")
		return { commit: checkout.head, source: "head", from: "its HEAD" };
	throw new CliError(
		`${checkout.top} in ${options.sandboxId} has no base commit recorded: no ${BASE_FILE} in it, no ${BASE_LABEL} ` +
			"label on the snapshot the sandbox was made from, and no commit checked out. Give one with --base <commit>, " +
			"or copy the whole tree with kantel push",
	);
}

/** `base` as a full commit ID in the repository at `top`; a CliError when it isn't there. */
export async function resolveLocalBase(top: string, base: Base): Promise<string> {
	const result = await git(top, ["rev-parse", "--verify", "--quiet", `${base.commit}^{commit}`]);
	const commit = result.stdout.toString("utf8").trim();
	if (result.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
		const fetch = /^[0-9a-f]{40}$/.test(base.commit) ? `git fetch origin ${base.commit}` : "git fetch origin";
		throw new CliError(
			`the base commit ${base.commit} (${base.from}) isn't in your repository at ${top}: fetch it (${fetch}) ` +
				"and sync again, give another with --base, or copy the whole tree with kantel push",
		);
	}
	return commit;
}

export interface LocalPatch {
	/** The base, in full. */
	readonly base: string;
	/** The tree the sandbox's index must end with: this working tree, less anything left out. */
	readonly tree: string;
	/** A binary-safe patch from the base to that tree; empty when they're the same. */
	readonly patch: Buffer;
	/** How many paths differ from the base. */
	readonly files: number;
	/** What was left out, and why. */
	readonly skipped: Skipped[];
}

/**
 * The patch from `base` to the working tree at `top`: tracked changes (deletions and mode changes included) and the
 * new files `.gitignore` doesn't leave out, staged in a copy of the index so yours stays as it is. With
 * `defaultExcludes`, the files push leaves out stay at the base's version: credentials, and untracked agents'
 * sign-ins, `.npmrc` and `.env` files, classified under `contexts` as push does ({@link rootContexts}). Files in
 * `keep` (absolute directories, such as Kantel's config) stay at the base's version whatever the excludes. A
 * repository of its own inside the tree isn't sent.
 */
/** `path` as one entry of GIT_ALTERNATE_OBJECT_DIRECTORIES, which git C-quotes when it holds the separator. */
function alternate(path: string): string {
	return path.includes(delimiter) || path.startsWith('"') ? JSON.stringify(path) : path;
}

export async function buildPatch(
	top: string,
	base: string,
	options: {
		readonly defaultExcludes: boolean;
		readonly keep?: readonly string[];
		/** What leads to `top`; default its own name, as a repository's top is named. */
		readonly contexts?: readonly string[];
	},
): Promise<LocalPatch> {
	const scratch = await mkdtemp(join(tmpdir(), "kantel-sync-"));
	const index = join(scratch, "index");
	try {
		const gitPath = async (name: string): Promise<string> =>
			resolve(top, (await gitOut(top, ["rev-parse", "--git-path", name])).toString("utf8").trim());
		const own = await gitPath("index");
		// The blobs and trees it writes go to its own object directory, which only this user can read and which goes
		// with it, so a credential it leaves out isn't kept in the repository's; the repository's are read through it.
		const objects = join(scratch, "objects");
		await mkdir(objects);
		const env = {
			GIT_INDEX_FILE: index,
			GIT_OBJECT_DIRECTORY: objects,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate(await gitPath("objects")),
			GIT_LITERAL_PATHSPECS: "1",
			GIT_OPTIONAL_LOCKS: "0",
		};
		const times = await stat(own).catch(() => undefined);
		if (times === undefined) {
			await gitOut(top, ["read-tree", base], { env }); // A repository with no index yet.
		} else {
			// A copy keeps the index's file stats, so `add -u` reads only the files that changed. It keeps the index's
			// time too, or a file changed in the second the index was written, at the same size, would look unchanged:
			// git tells those "racily clean" entries by comparing them with the index file's own time.
			await copyFile(own, index);
			await utimes(index, times.atime, times.mtime);
		}
		await gitOut(top, ["add", "-u"], { env });
		const skipped = new Map<string, Skipped>();
		const untracked: string[] = [];
		for (const path of lines0(await gitOut(top, ["ls-files", "-z", "--others", "--exclude-standard"], { env }))) {
			// A repository inside the tree is listed as its directory: git would add it as a link to a commit.
			if (path.endsWith("/")) skipped.set(path, { path: path.slice(0, -1), why: "a git repository of its own" });
			else untracked.push(path);
		}
		if (untracked.length > 0) {
			await gitOut(top, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
				env,
				input: `${untracked.join("\0")}\0`,
			});
		}
		let tree = (await gitOut(top, ["write-tree"], { env })).toString("utf8").trim();
		const changedIn = async (to: string): Promise<string[]> =>
			lines0(await gitOut(top, ["diff-tree", "-r", "--no-renames", "-z", "--name-only", base, to], { env }));
		let changed = await changedIn(tree);
		const contexts = options.contexts ?? (await rootContexts(top, top));
		// The kept directories as paths in the repository, from where they resolve: `.config/kantel`.
		const realTop = await realpath(top);
		const kept: string[] = [];
		for (const directory of options.keep ?? []) {
			const real = await realpath(directory).catch(() => resolve(directory));
			if (within(real, realTop)) kept.push(relative(realTop, real).split(sep).join("/"));
		}
		const keptBy = (path: string): string | undefined =>
			kept.find((directory) => directory === "" || path === directory || path.startsWith(`${directory}/`));
		const fresh = new Set(untracked);
		const back: string[] = [];
		for (const path of changed) {
			const directory = keptBy(path);
			const found =
				directory !== undefined
					? { path: directory || path, why: "Kantel's config, with your API key" }
					: options.defaultExcludes
						? excludedUnder(contexts, path, !fresh.has(path))
						: undefined;
			if (found === undefined) continue;
			back.push(path);
			skipped.set(found.path, found);
		}
		if (back.length > 0) {
			// Back to the base's version, or out of the index where the base has none.
			await gitOut(top, ["reset", "-q", base, "--pathspec-from-file=-", "--pathspec-file-nul"], {
				env,
				input: `${back.join("\0")}\0`,
			});
			tree = (await gitOut(top, ["write-tree"], { env })).toString("utf8").trim();
			changed = await changedIn(tree);
		}
		const patch =
			changed.length === 0
				? Buffer.alloc(0)
				: await gitOut(
						top,
						[
							"diff-tree",
							"-r",
							"-p",
							"--binary",
							"--full-index",
							"--unified=3",
							"-M",
							"--no-color",
							"--no-ext-diff",
							"--no-textconv",
							"--src-prefix=a/",
							"--dst-prefix=b/",
							base,
							tree,
						],
						{ env },
					);
		return {
			base,
			tree,
			patch,
			files: changed.length,
			skipped: [...skipped.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** What a command in the sandbox printed, or a CliError when it failed for a reason sync has no words for. */
async function remote(
	client: KantelClient,
	sandboxId: string,
	command: string,
	timeoutMs: number,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
	const result = await client.runCommand(sandboxId, { command, timeoutMs });
	if (result.state !== "exited" || result.exitCode === undefined) {
		throw new CliError(`a command in ${sandboxId} ended ${result.state}: ${result.stderr.trim() || "no output"}`);
	}
	return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr.trim() };
}

/** The checkout at `path` in the sandbox (absolute): its top, HEAD and recorded base. */
export async function probeCheckout(client: KantelClient, sandboxId: string, path: string): Promise<Checkout> {
	const command =
		`cd ${quote(path)} 2>/dev/null || { echo missing; exit 0; }; ` +
		"top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo not-git; exit 0; }; " +
		'echo "top=$top"; echo "head=$(git rev-parse -q --verify HEAD 2>/dev/null)"; ' +
		`echo "recorded=$(head -c 200 "$top"/${BASE_FILE} 2>/dev/null | tr -d '[:space:]')"; ` +
		"command -v gzip >/dev/null && echo gzip=yes; command -v flock >/dev/null && echo flock=yes; true";
	const { exitCode, stdout, stderr } = await remote(client, sandboxId, command, 60_000);
	if (exitCode !== 0) throw new CliError(`couldn't look at ${path} in ${sandboxId}: ${stderr || `exit ${exitCode}`}`);
	const first = stdout.trim().split("\n")[0];
	if (first === "missing") {
		throw new CliError(
			`${path} isn't in ${sandboxId}: sync --git needs a clone of this repository there (--to names another ` +
				"path); kantel push copies the whole tree",
		);
	}
	if (first === "not-git") {
		throw new CliError(
			`${path} in ${sandboxId} isn't a git checkout: sync --git needs a clone of this repository there; kantel ` +
				"push copies the whole tree",
		);
	}
	const values = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
	}
	if (values.get("gzip") !== "yes") throw new CliError(`${sandboxId} has no gzip, which sync --git needs`);
	if (values.get("flock") !== "yes") {
		throw new CliError(
			`${sandboxId} has no flock, which sync --git needs so two syncs into one checkout take turns: install ` +
				"util-linux there (apt-get install util-linux)",
		);
	}
	const top = values.get("top") || path;
	return { top, head: values.get("head") || undefined, recorded: values.get("recorded") || undefined };
}

/**
 * The `git.base` label on the snapshot `sandbox` was made from, if it has one. A snapshot that's gone, or a key that
 * can't read snapshots, has none to give.
 */
export async function labelledBase(
	client: KantelClient,
	sandbox: Sandbox | undefined,
): Promise<{ readonly commit: string; readonly snapshot: string } | undefined> {
	const id = sandbox?.source?.snapshotId;
	if (id === undefined) return undefined;
	try {
		const snapshot = await client.getSnapshot(id);
		const commit = snapshot.labels?.[BASE_LABEL]?.trim();
		return commit === undefined || commit === "" ? undefined : { commit, snapshot: snapshot.name ?? snapshot.id };
	} catch (error) {
		if (error instanceof KantelApiError && (error.code === "not_found" || error.code === "forbidden")) return undefined;
		throw error;
	}
}

/** Exit codes of the sandbox side, each a failure sync explains. */
const EXIT = { noBase: 41, reset: 42, apply: 43, tree: 44, worktree: 45, busy: 46, noLock: 47 } as const;

/** How long the sandbox side waits for another sync into the same checkout to finish, in seconds. */
const LOCK_WAIT_S = 300;

/**
 * The sandbox side: one command that cleans, resets, applies and checks the tree. It holds a lock in the checkout's
 * git directory throughout, with flock, so two syncs into one checkout take turns; the lock goes when the command
 * ends, however it ends. Without flock it changes nothing.
 */
export function applyScript(options: {
	readonly top: string;
	readonly base: string;
	readonly tree: string;
	/** The patch's parts' glob, or undefined when there is no patch. */
	readonly parts?: string;
	readonly patch: string;
}): string {
	const { top, base, tree, parts, patch } = options;
	const cleanUp = parts === undefined ? "" : `rm -f ${parts} ${quote(patch)}; `;
	const apply =
		parts === undefined
			? ""
			: `cat ${parts} | gzip -dc > ${quote(patch)} && git apply --index --whitespace=nowarn ${quote(patch)} || ` +
				`{ ${cleanUp}exit ${EXIT.apply}; }; ${cleanUp}`;
	return (
		`cd ${quote(top)} || exit 1; ` +
		`lock=$(git rev-parse --git-path kantel-sync.lock) && exec 9>"$lock" || exit 1; ` +
		`command -v flock >/dev/null || { ${cleanUp}exit ${EXIT.noLock}; }; ` +
		`flock -w ${LOCK_WAIT_S} 9 || { ${cleanUp}exit ${EXIT.busy}; }; ` +
		`git cat-file -e ${base}^{commit} 2>/dev/null || { ${cleanUp}exit ${EXIT.noBase}; }; ` +
		// Clean first, by the ignore rules the checkout has now: after the reset the base's would count, and a file
		// ignored by a rule added since would go. A fork's files have new inodes, so reset reads them all again.
		`git clean -fdq -e /${BASE_FILE} && git reset -q --hard ${base} || { ${cleanUp}exit ${EXIT.reset}; }; ` +
		apply +
		`t=$(git write-tree) || exit ${EXIT.tree}; echo "tree=$t"; ` +
		`[ "$t" = ${tree} ] || { git status --short | head -20 >&2; exit ${EXIT.tree}; }; ` +
		`git diff --quiet || { git diff --stat | tail -20 >&2; exit ${EXIT.worktree}; }`
	);
}

/**
 * Sends `content` to the sandbox in parts under `prefix`, a few at a time; answers how many. After a part fails no
 * more start, and every one under way lands or fails before it throws, so a clean-up after it removes the lot.
 */
export async function sendParts(
	client: KantelClient,
	sandboxId: string,
	prefix: string,
	content: Buffer,
): Promise<number> {
	const parts: Buffer[] = [];
	for (let offset = 0; offset < content.length; offset += PART) parts.push(content.subarray(offset, offset + PART));
	let next = 0;
	let failure: { readonly error: unknown } | undefined;
	const runners = Array.from({ length: Math.min(CONCURRENCY, parts.length) }, async () => {
		while (failure === undefined && next < parts.length) {
			const at = next++;
			try {
				await client.writeFile(sandboxId, {
					path: `${prefix}-${String(at).padStart(6, "0")}`,
					content: (parts[at] as Buffer).toString("base64"),
					encoding: "base64",
				});
			} catch (error) {
				failure ??= { error };
			}
		}
	});
	await Promise.all(runners);
	if (failure !== undefined) throw failure.error;
	return parts.length;
}

export interface Synced {
	readonly sandboxId: string;
	/** The checkout in the sandbox. */
	readonly path: string;
	readonly base: string;
	readonly baseSource: BaseSource;
	/** The tree both sides have now. */
	readonly tree: string;
	readonly files: number;
	readonly patchBytes: number;
	/** The gzipped patch, as it went over. */
	readonly sentBytes: number;
	readonly skipped: Skipped[];
	readonly timings: {
		/** Looking at the sandbox and its snapshot. */
		readonly probeMs: number;
		/** Making the patch here. */
		readonly patchMs: number;
		readonly uploadMs: number;
		/** Reset, clean, apply and the tree check in the sandbox. */
		readonly applyMs: number;
		readonly totalMs: number;
	};
}

/**
 * Brings the checkout at `to` in the sandbox (absolute) to the working tree `top` is the top of, through a patch
 * against its base, and proves the two trees match.
 */
export async function syncGit(
	client: KantelClient,
	sandboxId: string,
	options: {
		readonly top: string;
		readonly to: string;
		readonly base?: string;
		readonly defaultExcludes: boolean;
		/** Directories whose files stay at the base's version whatever the excludes, such as Kantel's config. */
		readonly keep?: readonly string[];
		readonly contexts?: readonly string[];
		readonly now?: () => number;
	},
): Promise<Synced> {
	const now = options.now ?? (() => performance.now());
	const started = now();
	const sandboxOf = async (): Promise<Sandbox | undefined> => {
		try {
			return await client.getSandbox(sandboxId);
		} catch (error) {
			// A key that may run commands but not read the sandbox still syncs, with no label to go on.
			if (error instanceof KantelApiError && error.code === "forbidden") return undefined;
			throw error;
		}
	};
	// Both at once; an isolate is refused before what its probe says, which is no shell.
	const probing = probeCheckout(client, sandboxId, options.to);
	probing.catch(() => undefined);
	const sandbox = await sandboxOf();
	if (sandbox !== undefined && sandbox.type !== "microvm") {
		throw new CliError(`${sandboxId} is an isolate: sync --git needs a microVM, with git`);
	}
	const checkout = await probing;
	const label =
		options.base === undefined && checkout.recorded === undefined ? await labelledBase(client, sandbox) : undefined;
	const chosen = chooseBase({ flag: options.base, checkout, label, sandboxId });
	const probed = now();
	const base = await resolveLocalBase(options.top, chosen);
	const local = await buildPatch(options.top, base, {
		defaultExcludes: options.defaultExcludes,
		keep: options.keep,
		contexts: options.contexts,
	});
	const patched = now();
	const id = randomBytes(6).toString("hex");
	const prefix = `/tmp/.kantel-sync-${id}`;
	const parts = `${prefix}-*`;
	const gz = local.patch.length === 0 ? Buffer.alloc(0) : gzipSync(local.patch, { level: 6 });
	let uploaded = now();
	let result: Awaited<ReturnType<typeof remote>>;
	try {
		if (gz.length > 0) await sendParts(client, sandboxId, prefix, gz);
		uploaded = now();
		result = await remote(
			client,
			sandboxId,
			applyScript({
				top: checkout.top,
				base,
				tree: local.tree,
				parts: gz.length > 0 ? parts : undefined,
				patch: `${prefix}.patch`,
			}),
			APPLY_TIMEOUT_MS,
		);
	} catch (error) {
		if (gz.length > 0) {
			await client
				.runCommand(sandboxId, { command: `rm -f ${parts} ${prefix}.patch; true`, timeoutMs: 30_000 })
				.catch(() => undefined);
		}
		throw error;
	}
	const applied = now();
	const where = `${checkout.top} in ${sandboxId}`;
	const why = result.stderr === "" ? "" : `: ${result.stderr}`;
	switch (result.exitCode) {
		case 0:
			break;
		case EXIT.noBase:
			throw new CliError(
				`the base commit ${short(base)} (${chosen.from}) isn't in ${where}: fetch it there, give another with ` +
					"--base, or copy the whole tree with kantel push",
			);
		case EXIT.reset:
			throw new CliError(`couldn't reset ${where} to ${short(base)}${why}`);
		case EXIT.noLock:
			throw new CliError(`${sandboxId} has no flock, which sync --git needs: install util-linux there`);
		case EXIT.busy:
			throw new CliError(
				`another sync into ${where} has been running for ${LOCK_WAIT_S / 60} minutes: try again once it ends`,
			);
		case EXIT.apply:
			throw new CliError(`the patch didn't apply to ${where}${why}. It's left at ${short(base)}, with nothing applied`);
		case EXIT.tree: {
			const theirs = /tree=([0-9a-f]+)/.exec(result.stdout)?.[1] ?? "unknown";
			throw new CliError(
				`after the patch ${where} has tree ${short(theirs)}, not this working tree's ${short(local.tree)}${why}`,
			);
		}
		case EXIT.worktree:
			throw new CliError(`after the patch the files in ${where} don't match its index${why}`);
		default:
			throw new CliError(`a command in ${sandboxId} failed${why || ` with exit ${result.exitCode}`}`);
	}
	return {
		sandboxId,
		path: checkout.top,
		base,
		baseSource: chosen.source,
		tree: local.tree,
		files: local.files,
		patchBytes: local.patch.length,
		sentBytes: gz.length,
		skipped: local.skipped,
		timings: {
			probeMs: Math.round(probed - started),
			patchMs: Math.round(patched - probed),
			uploadMs: Math.round(uploaded - patched),
			applyMs: Math.round(applied - uploaded),
			totalMs: Math.round(applied - started),
		},
	};
}

/** Where sync puts a checkout by default, as push does a directory: `/home/user/<the repository's name>`. */
export const defaultCheckout = (top: string): string =>
	posix.join("/home/user", posix.basename(top.split("\\").join("/")));

/** A `--to` path as the sandbox's shell takes it: relative ones under the sandbox user's home. */
export const checkoutPath = (to: string): string =>
	posix.resolve("/home/user", to === "~" ? "." : to.startsWith("~/") ? to.slice(2) : to);
