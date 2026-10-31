/**
 * The mirror cache: warm bare git mirrors on a node, and the two ways a session gets a checkout off one, as they were
 * measured:
 *
 * - `reference` (default): `git clone --no-checkout --reference <mirror>`, blobless and cone-sparse when the source
 *   names `sparse`, then a detached checkout. The clone borrows every object from the mirror through alternates, so it
 *   needs only read access to the mirror; n8n's three-package cone was ready in 1.53 s self-hosted this way.
 * - `worktree`: `git worktree add --detach` in the mirror itself, the fastest (0.42 s for one repository measured), for a
 *   process that may write the mirror's admin directory. Release it with `release`.
 *
 * Every checkout has `core.checkStat=minimal` and `core.trustctime=false`, so a tree restored from bytes later is not
 * rehashed on first status, and its `origin` points at the real remote, so a push from the container tier goes
 * upstream through the host's egress.
 *
 * Fills (the first clone and every fetch) are single-flight per repository and bounded across repositories, and a
 * mirror fetched less than `freshForMs` ago is not fetched again unless a commit asked for is missing from it.
 * `createMirrorGitFetcher` is the `GitFetcher` that seeds workspace files off the mirror (method `mirror`);
 * `startMirrorWarmer` keeps a set of mirrors fetched on an interval.
 *
 * Node-only: it runs the `git` binary. Credentials never pass through here: give git an egress proxy or credential
 * helper through `env`, as the vault's forward proxy does; a remote URL with credentials in it is refused.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	type CallContext,
	type Clock,
	type GitFetcher,
	KantelError,
	type SeedFile,
	systemClock,
} from "@kantel/contracts";
import { parseTar } from "@kantel/workspace/git-tarball";

export interface GitMirrorCacheOptions {
	/** The directory the bare mirrors live in, on node-local disk. */
	readonly root: string;
	/**
	 * The remote URL of a source's `repo`. Default: `owner/name` is `https://github.com/owner/name.git`, and an
	 * `https:` URL is used as given. Return a URL without credentials.
	 */
	readonly remoteUrl?: (repo: string) => string;
	/** The git binary. Default `git`. */
	readonly git?: string;
	/** Extra environment for git, such as an egress proxy (`HTTPS_PROXY`). */
	readonly env?: Readonly<Record<string, string>>;
	/** Fills running at once across repositories. Default 2. */
	readonly maxConcurrentFills?: number;
	/** A mirror fetched this recently is not fetched again for a ref it can already resolve. Default 30 s. */
	readonly freshForMs?: number;
	/** The longest one git command may run. Default 10 minutes. */
	readonly commandTimeoutMs?: number;
	/** The largest tree `tree` reads, as a tar stream. Default 512 MiB. */
	readonly maxTreeBytes?: number;
	readonly clock?: Clock;
}

export type CheckoutMode = "reference" | "worktree";

export interface CheckoutRequest {
	readonly repo: string;
	/** A full commit ID, as `resolve` returns. */
	readonly commit: string;
	/** An absolute directory that does not exist yet (or is empty). */
	readonly dest: string;
	/** Cone-mode sparse checkout directories; the whole tree when absent. */
	readonly sparse?: readonly string[];
	readonly mode?: CheckoutMode;
}

export interface CheckoutResult {
	readonly dest: string;
	readonly commit: string;
	readonly mode: CheckoutMode;
	/** Milliseconds per phase: `clone` (or `worktree`), `sparse`, `checkout`. */
	readonly timings: { readonly [phase: string]: number };
}

export interface SyncResult {
	readonly path: string;
	/** Whether this call cloned or fetched, rather than finding the mirror fresh. */
	readonly fetched: boolean;
}

export interface MirrorStats {
	/** Clones and fetches run. */
	readonly fills: number;
	/** The most fills that ran at once. */
	readonly maxInFlight: number;
}

export interface GitMirrorCache {
	/** Where the mirror of `repo` lives (it may not exist yet). */
	path(repo: string): string;
	/** Clones the mirror when absent, else fetches it unless it is fresh (or `force`). */
	sync(ctx: CallContext, repo: string, options?: { readonly force?: boolean }): Promise<SyncResult>;
	/** A branch, tag or commit as a full commit ID; fetches when the mirror lacks it. `not_found` when no ref matches. */
	resolve(ctx: CallContext, repo: string, ref: string): Promise<string>;
	/** A checkout of `commit` at `dest`, off the mirror. */
	checkout(ctx: CallContext, request: CheckoutRequest): Promise<CheckoutResult>;
	/** Removes a checkout made with `worktree` mode (and any other directory), pruning the mirror's worktree list. */
	release(ctx: CallContext, repo: string, dest: string): Promise<void>;
	/** The files of `commit`'s tree, read with `git archive` from the mirror. Symlinks and submodules are left out. */
	tree(ctx: CallContext, repo: string, commit: string): Promise<SeedFile[]>;
	stats(): MirrorStats;
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Branch and tag names a caller may ask for: no leading dash, no `..`, no revision syntax. */
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;

export function createGitMirrorCache(options: GitMirrorCacheOptions): GitMirrorCache {
	const root = resolve(options.root);
	const git = options.git ?? "git";
	const clock = options.clock ?? systemClock;
	const freshForMs = options.freshForMs ?? 30_000;
	const timeoutMs = options.commandTimeoutMs ?? 10 * 60_000;
	const maxTreeBytes = options.maxTreeBytes ?? 512 * 1024 * 1024;
	const remoteUrl = options.remoteUrl ?? defaultRemoteUrl;
	const limit = semaphore(Math.max(1, options.maxConcurrentFills ?? 2));
	const inflight = new Map<string, Promise<SyncResult>>();
	const fetchedAt = new Map<string, number>();
	const counters = { fills: 0, inFlight: 0, maxInFlight: 0 };
	const env = { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", LC_ALL: "C" };

	const run = (args: readonly string[], ctx: CallContext, extra: { cwd?: string; maxBytes?: number } = {}) =>
		runGit(git, args, { env, timeoutMs, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }), ...extra });

	function url(repo: string): string {
		const value = remoteUrl(repo);
		if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value)) {
			throw new KantelError("invalid", `the remote URL for ${repo} carries credentials; use the host's egress`);
		}
		return value;
	}

	function path(repo: string): string {
		const slug = repo
			.replace(/^[a-z]+:\/\//i, "")
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^[.-]+/, "")
			.slice(-60);
		const hash = createHash("sha256").update(repo).digest("hex").slice(0, 16);
		return join(root, `${slug || "repo"}-${hash}.git`);
	}

	async function exists(dir: string): Promise<boolean> {
		try {
			return (await stat(join(dir, "HEAD"))).isFile();
		} catch {
			return false;
		}
	}

	async function fill(ctx: CallContext, repo: string, mirror: string): Promise<void> {
		await limit(async () => {
			counters.fills++;
			counters.inFlight++;
			counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
			try {
				if (await exists(mirror)) {
					await run(["-C", mirror, "fetch", "--prune", "--quiet", "origin"], ctx).catch((error: unknown) => {
						throw remoteError(error, repo);
					});
				} else {
					await mkdir(root, { recursive: true });
					const staging = `${mirror}.${crypto.randomUUID()}.tmp`;
					try {
						await run(["clone", "--mirror", "--quiet", "--", url(repo), staging], ctx).catch((error: unknown) => {
							throw remoteError(error, repo);
						});
						// Sparse, blobless clones off the mirror ask for filters and for commits by ID.
						for (const [key, value] of [
							["uploadpack.allowFilter", "true"],
							["uploadpack.allowAnySHA1InWant", "true"],
							["extensions.worktreeConfig", "true"],
						] as const) {
							await run(["-C", staging, "config", key, value], ctx);
						}
						// With per-worktree config, `core.bare` belongs to the mirror alone, or its worktrees would read as bare.
						await run(["-C", staging, "config", "--worktree", "core.bare", "true"], ctx);
						await run(["-C", staging, "config", "--unset", "core.bare"], ctx);
						await rename(staging, mirror).catch(async (error: unknown) => {
							// Another process won the race: its mirror is as good as this one.
							if (!(await exists(mirror))) throw error;
						});
					} finally {
						await rm(staging, { recursive: true, force: true });
					}
				}
				fetchedAt.set(repo, clock.now());
			} finally {
				counters.inFlight--;
			}
		});
	}

	async function sync(ctx: CallContext, repo: string, force = false): Promise<SyncResult> {
		const mirror = path(repo);
		// Checked without awaiting, so two callers racing here share one fill.
		const running = inflight.get(repo);
		if (running !== undefined) return running;
		const last = fetchedAt.get(repo);
		if (!force && last !== undefined && clock.now() - last < freshForMs) return { path: mirror, fetched: false };
		const started = fill(ctx, repo, mirror).then(() => ({ path: mirror, fetched: true }));
		inflight.set(repo, started);
		try {
			return await started;
		} finally {
			inflight.delete(repo);
		}
	}

	async function hasCommit(ctx: CallContext, mirror: string, commit: string): Promise<boolean> {
		try {
			await run(["-C", mirror, "cat-file", "-e", `${commit}^{commit}`], ctx);
			return true;
		} catch {
			return false;
		}
	}

	async function revParse(ctx: CallContext, mirror: string, ref: string): Promise<string | undefined> {
		try {
			const { stdout } = await run(["-C", mirror, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], ctx);
			const commit = stdout.toString("utf8").trim();
			return COMMIT.test(commit) ? commit : undefined;
		} catch {
			return undefined;
		}
	}

	const cache: GitMirrorCache = {
		path,

		sync: (ctx, repo, syncOptions) => sync(ctx, repo, syncOptions?.force === true),

		async resolve(ctx, repo, ref) {
			if (COMMIT.test(ref)) {
				let { path: mirror, fetched } = await sync(ctx, repo);
				if (await hasCommit(ctx, mirror, ref)) return ref;
				if (!fetched) ({ path: mirror } = await sync(ctx, repo, true));
				if (await hasCommit(ctx, mirror, ref)) return ref;
				throw new KantelError("not_found", `${repo} has no commit ${ref}`, { repo });
			}
			if (!REF.test(ref)) throw new KantelError("invalid", `${ref} is not a branch, tag or commit`);
			const first = await sync(ctx, repo);
			const found = await revParse(ctx, first.path, ref);
			if (found !== undefined) return found;
			// A fresh mirror may not have a ref created since its last fetch: fetch once before saying not_found.
			if (!first.fetched) {
				const second = await sync(ctx, repo, true);
				const late = await revParse(ctx, second.path, ref);
				if (late !== undefined) return late;
			}
			throw new KantelError("not_found", `${repo} has no ref ${ref}`, { repo });
		},

		async checkout(ctx, request) {
			if (!COMMIT.test(request.commit)) throw new KantelError("invalid", "checkout needs a full commit ID");
			const dest = resolve(request.dest);
			await requireEmpty(dest);
			const mode = request.mode ?? "reference";
			const sparse = request.sparse?.map(checkSparseDir);
			const mirror = path(request.repo);
			if (!(await hasCommit(ctx, mirror, request.commit))) await cache.resolve(ctx, request.repo, request.commit);
			await mkdir(dirname(dest), { recursive: true });
			const timings: Record<string, number> = {};
			let mark = clock.now();
			const phase = (name: string) => {
				const now = clock.now();
				timings[name] = now - mark;
				mark = now;
			};
			try {
				if (mode === "worktree") {
					await run(
						["-C", mirror, "worktree", "add", "--quiet", "--detach", "--no-checkout", "--", dest, request.commit],
						ctx,
					);
					phase("worktree");
					for (const [key, value] of STAT_CONFIG) await run(["-C", dest, "config", "--worktree", key, value], ctx);
				} else {
					await run(
						[
							"clone",
							"--quiet",
							"--no-checkout",
							...(sparse === undefined ? [] : ["--filter=blob:none", "--sparse"]),
							"--reference",
							mirror,
							"--",
							`file://${mirror}`,
							dest,
						],
						ctx,
					);
					phase("clone");
					for (const [key, value] of STAT_CONFIG) await run(["-C", dest, "config", key, value], ctx);
					await run(["-C", dest, "remote", "set-url", "origin", url(request.repo)], ctx);
				}
				if (sparse !== undefined) {
					await run(["-C", dest, "sparse-checkout", "set", "--cone", "--", ...sparse], ctx);
					phase("sparse");
				}
				await run(["-C", dest, "checkout", "--quiet", "--detach", request.commit], ctx);
				phase("checkout");
			} catch (error) {
				await cache.release(ctx, request.repo, dest).catch(() => undefined);
				throw error instanceof KantelError ? error : new KantelError("unavailable", gitMessage(error));
			}
			return { dest, commit: request.commit, mode, timings };
		},

		async release(ctx, repo, dest) {
			await rm(resolve(dest), { recursive: true, force: true });
			const mirror = path(repo);
			if (await exists(mirror)) await run(["-C", mirror, "worktree", "prune"], ctx).catch(() => undefined);
		},

		async tree(ctx, repo, commit) {
			const resolved = await cache.resolve(ctx, repo, commit);
			const { stdout } = await run(["-C", path(repo), "archive", "--format=tar", resolved], ctx, {
				maxBytes: maxTreeBytes,
			}).catch((error: unknown) => {
				throw error instanceof KantelError ? error : new KantelError("unavailable", gitMessage(error));
			});
			return [...parseTar(new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength))];
		},

		stats: () => ({ fills: counters.fills, maxInFlight: counters.maxInFlight }),
	};
	return cache;
}

/** A `GitFetcher` that seeds workspace files off the mirror cache: method `mirror`, refs resolved before the tree. */
export function createMirrorGitFetcher(cache: GitMirrorCache): GitFetcher {
	return {
		method: "mirror",
		resolve: (ctx, source) => cache.resolve(ctx, source.repo, source.commit ?? source.ref),
		async fetch(ctx, source) {
			const commit = await cache.resolve(ctx, source.repo, source.commit ?? source.ref);
			return { commit, files: await cache.tree(ctx, source.repo, commit) };
		},
	};
}

export interface MirrorWarmer {
	/** Fetches every mirror once now; rejections go to `onError`, never out of here. */
	tick(): Promise<void>;
	stop(): void;
}

/**
 * Keeps the mirrors of `repos()` warm: fetches each once now and then every `intervalMs`, one tick at a time (a tick
 * still running when the next is due is skipped). The cache's fill bound applies across repositories.
 */
export function startMirrorWarmer(
	cache: GitMirrorCache,
	options: {
		readonly repos: () => readonly string[] | Promise<readonly string[]>;
		readonly ctx: CallContext;
		readonly intervalMs?: number;
		readonly onError?: (repo: string, error: unknown) => void;
	},
): MirrorWarmer {
	let running: Promise<void> | undefined;
	const tick = (): Promise<void> => {
		running ??= (async () => {
			try {
				const repos = await options.repos();
				await Promise.all(
					repos.map((repo) =>
						cache.sync(options.ctx, repo, { force: true }).then(
							() => undefined,
							(error: unknown) => options.onError?.(repo, error),
						),
					),
				);
			} catch (error) {
				options.onError?.("*", error);
			} finally {
				running = undefined;
			}
		})();
		return running;
	};
	void tick();
	const timer = setInterval(() => void tick(), options.intervalMs ?? 60_000);
	timer.unref?.();
	return { tick, stop: () => clearInterval(timer) };
}

const STAT_CONFIG = [
	["core.checkStat", "minimal"],
	["core.trustctime", "false"],
] as const;

function defaultRemoteUrl(repo: string): string {
	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !/(^|\/)\.+($|\/)/.test(repo)) {
		return `https://github.com/${repo}.git`;
	}
	if (/^https:\/\/[^@\s]+$/.test(repo)) return repo;
	throw new KantelError("not_supported", `the mirror cache cannot fetch ${repo}`, { repo });
}

function checkSparseDir(dir: string): string {
	const trimmed = dir.replace(/\/+$/, "");
	if (
		trimmed === "" ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("-") ||
		trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new KantelError("invalid", `${dir} is not a sparse directory`);
	}
	return trimmed;
}

async function requireEmpty(dest: string): Promise<void> {
	try {
		if ((await readdir(dest)).length > 0) throw new KantelError("conflict", `${dest} is not empty`);
	} catch (error) {
		if (error instanceof KantelError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** A failed fetch or clone as a code: a repository that is not there is `not_found`, anything else `unavailable`. */
function remoteError(error: unknown, repo: string): KantelError {
	if (error instanceof KantelError) return error;
	const message = gitMessage(error);
	if (/not found|does not exist|does not appear to be a git repository|could not read Username/i.test(message)) {
		return new KantelError("not_found", `${repo} could not be found`, { repo });
	}
	return new KantelError("unavailable", `fetching ${repo} failed: ${message}`, { repo });
}

function gitMessage(error: unknown): string {
	const text = error instanceof GitCommandError ? error.stderr.trim() || error.message : String(error);
	// Never echo a URL's userinfo, should a remote ever carry one.
	return text.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1").slice(0, 500);
}

class GitCommandError extends Error {
	readonly stderr: string;
	constructor(message: string, stderr: string) {
		super(message);
		this.stderr = stderr;
	}
}

function runGit(
	git: string,
	args: readonly string[],
	options: {
		readonly env: NodeJS.ProcessEnv;
		readonly timeoutMs: number;
		readonly signal?: AbortSignal;
		readonly cwd?: string;
		readonly maxBytes?: number;
	},
): Promise<{ stdout: Buffer; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		if (options.signal?.aborted === true) {
			reject(new KantelError("aborted", "the git command was cancelled"));
			return;
		}
		const child = spawn(git, args, {
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		});
		const out: Buffer[] = [];
		let size = 0;
		let stderr = "";
		let failure: KantelError | undefined;
		const stop = (error: KantelError) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(
			() => stop(new KantelError("unavailable", `git ${args[0] === "-C" ? args[2] : args[0]} timed out`)),
			options.timeoutMs,
		);
		const onAbort = () => stop(new KantelError("aborted", "the git command was cancelled"));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (options.maxBytes !== undefined && size > options.maxBytes) {
				stop(new KantelError("exhausted", `the tree is larger than ${options.maxBytes} bytes`));
				return;
			}
			out.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 8192) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => stop(new KantelError("unavailable", `git could not start: ${error.message}`)));
		child.on("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (failure !== undefined) reject(failure);
			else if (code !== 0) reject(new GitCommandError(`git exited with ${code}`, stderr));
			else resolvePromise({ stdout: Buffer.concat(out), stderr });
		});
	});
}

function semaphore(max: number): <T>(work: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (work) => {
		if (active >= max) await new Promise<void>((wake) => waiting.push(wake));
		active++;
		try {
			return await work();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}
