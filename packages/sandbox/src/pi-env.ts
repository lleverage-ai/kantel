/**
 * Pi Durable's `ExecutionEnv` for one Kantel session, over the `Sandboxes` and `Workspaces` contracts (issue #10).
 * Ported from the Cloudflare spike's `KantelEnv` and generalised to depend only on the contracts.
 *
 * Design notes:
 *
 * - One environment per session. Its `id` is `kantel:<workspaceId>`: environments with equal ids see the same files at
 *   the same paths, which holds for every session on one workspace.
 * - Paths. The workspace appears at `root` (`/workspace` by default) and relative paths resolve against `cwd` (the root
 *   by default). Absolute paths under a mount point (such as `/project/...`) read the mount. Anything else is outside
 *   the environment and fails with `permission_denied`. Mount points come from the workspace record, read once.
 * - Reads go to `Workspaces` at head. A binary or text-line reader reads the whole file when it opens (the contract
 *   reads whole files), so it keeps reading what it opened even after a rename. `mtimeMs` is always 0: the contract
 *   records versions, not times. There are no symbolic links, so `canonicalPath` is `absolutePath` (it does not check
 *   that the path exists) and `noFollow` changes nothing. A read, `fileInfo` or listing below a file fails with
 *   `not_directory`, and `exists` reports false there.
 * - Writes. Every write, append, truncate, rename and remove is one commit on the head. When another writer moved the
 *   head first, the change is derived again from the new head and committed again (a few attempts), so an append or a
 *   truncate applies to exactly what it read; a whole-file write replaces whatever the head has, last writer wins.
 *   A rename is one commit (put plus delete; a directory moves every file below it). As with rename(2), a file
 *   replaces a file, but a directory replaces only a missing path or an empty directory: a destination that is a file
 *   or a non-empty directory is `invalid` (Pi's `FileErrorCode` has no `already_exists`), as is one below the source;
 *   a file onto a directory is `is_directory`.
 * - Mounts are readable and never writable. A write under a mount point is still sent to `Workspaces.commit`, which
 *   refuses it (and audits the refusal); `refused` becomes `permission_denied` and the source is unchanged.
 *   `createDir` under a mount fails with `permission_denied` directly, since there is nothing to commit.
 * - Directories. A workspace stores files, and a directory is in it while a file below it is. The environment adds
 *   the directories `createDir` and `createTempDir` made, with their ancestors, which it keeps in memory for its
 *   lifetime: they exist, are (empty, or merged with what the workspace lists) directories to `fileInfo`, `listDir` and
 *   `openDirReader`, cannot be written as files, and go away when `remove` removes them or `renameFile` moves them.
 *   Nothing is committed for them, so the sandboxes, other environments and later sessions do not see an empty one;
 *   once a file is below one, the workspace has it anyway. `createDir`, `createTempDir` and a rename of a directory
 *   refuse a destination that is a file or has a file as an ancestor (`not_directory`); `createDir`'s `recursive` flag
 *   is ignored (missing parents are always made). Another writer may commit a file where a directory was made here:
 *   before answering from the directories made here, the environment checks that no ancestor is a file at head, and
 *   if one is, the file wins: the directories made at and below it are forgotten and the path is `not_directory`.
 *   Removing a path forgets the directories made at and below it, whatever was removed. Removing a directory
 *   recursively deletes every file below it in one commit.
 * - Errors. `KantelError` codes map to `FileError` codes: `not_found` to `not_found`, `refused` and `forbidden` to
 *   `permission_denied`, `invalid` to `invalid`, `aborted` to `aborted`, anything else to `unknown`. An `invalid` or
 *   `not_found` at a path that is a directory (one made here, for `not_found`), or that has a file as an ancestor,
 *   becomes `is_directory` or `not_directory`.
 * - Shell. `exec` calls `Sandboxes.run` with tool `bash`, so the contract's tool-to-tier table picks the isolate or the
 *   container. `cwd` resolves like any path and must be inside the workspace (the contract's `cwd` is relative to the
 *   root); `env` is passed through and `inheritEnv` is ignored (a sandbox has its own environment). `timeout`
 *   (seconds) becomes `request.timeoutMs`, and the environment also stops waiting at that deadline and reports
 *   `timeout`. Aborting the context reports `aborted` at once, and `cleanup` does the same for every command still
 *   running (later commands run as usual). In each case the call context's `signal` is aborted so a sandbox that
 *   honours it stops the command; one that does not may still finish it (and the isolate commits what it wrote).
 *   Leases end with the session (`Sandboxes.releaseSession`), not with `cleanup`.
 * - Shell output arrives when the command finishes: stdout then stderr, one chunk each with its stream, so the two
 *   streams are not interleaved. `window` is ignored, so every chunk is delivered. When the sandbox truncated the
 *   output (`ExecResult.truncated`; `ShellExecResult` has no field for it), a last stderr chunk holds the line
 *   `[output truncated by the sandbox]`. With `spill`, output over either threshold (UTF-8 bytes of the combined text,
 *   or its lines, counting an unterminated last one) is written, stdout then stderr then that line, to a new
 *   `<root>/.tmp/pi-output-<uuid>.log` in one commit, whose absolute path is the result's `spillPath`; when that write
 *   fails, the command's result is an `unknown` error. The spill file holds the complete output only when the sandbox
 *   did not truncate it. When the sandbox truncated the output, the spill file holds only what the sandbox returned,
 *   with the marker, and is not complete; the marker is then also its first line, so a reader of the file sees it at
 *   once. An argv command is a `spawn_error`, with its output not delivered (so a caller can try another form), only
 *   when its program was not found: it exits with 127, prints nothing to stdout, and its stderr is exactly one line
 *   saying `argv[0]` was not found (`sh: <argv0>: command not found`, `bash: <argv0>: command not found`,
 *   `bash: line 1: <argv0>: command not found` or `<argv0>: command not found`). Any other 127, such as a script whose
 *   last nested command is missing, is an ordinary exit code with its output, since the program started and may have
 *   had side effects. A string command's 127 is always an ordinary exit code. `onExec` (and `onOutput`) failures are
 *   `callback_error`.
 * - Temporary files live in the workspace under `<root>/.tmp/`: `createTempFile` commits an empty file there and
 *   `createTempDir` makes a fresh directory there (in this environment only, as above). Files are committed like any
 *   file, so both tiers and `git status` see them; a host that seeds a repository may want `.tmp/` ignored.
 * - Not supported: `watch` (no change feed in the contract) fails with `not_supported`, and the optional `listFiles` is
 *   not implemented, so callers walk with `listDir`.
 */
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileWatcher,
	LineScanner,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellSpillOptions,
	type TextLineReader,
} from "@earendil-works/pi-durable/env";
import {
	type CallContext,
	type ExecRequest,
	type ExecResult,
	type FileEntry,
	isKantelError,
	KantelError,
	type Mount,
	type Sandboxes,
	type SandboxTier,
	type SessionId,
	type WorkspaceId,
	type Workspaces,
	type WorkspaceVersion,
} from "@kantel/contracts";
import { isUnderMount } from "@kantel/workspace";
import type { ModedChange, ModedFileEntry } from "@kantel/workspace/tree";
import { queueWorkspaceCommit } from "./commit-queue.ts";

/** Chord's invocation context, as Pi Durable's environment methods take it. */
type Context = Parameters<ExecutionEnv["exec"]>[2];

export const DEFAULT_ROOT = "/workspace";
/** Commits tried before a write gives up on a head that keeps moving. */
const COMMIT_ATTEMPTS = 5;
/** Entries asked for per `Workspaces.list` page; implementations cap it. */
const LIST_PAGE = 1000;
/** Where temporary files and directories go, relative to the root. */
const TEMP_DIR = ".tmp";
/** The line that ends output the sandbox truncated. */
const TRUNCATED_LINE = "[output truncated by the sandbox]";

/** What one shell command did, for the host's records. */
export interface SandboxExecRecord {
	readonly command: string | readonly string[];
	/** Relative to the workspace root; `""` is the root. */
	readonly cwd: string;
	readonly tier: SandboxTier;
	readonly leaseId: string;
	readonly exitCode: number;
	/** The workspace head after the command. */
	readonly workspaceVersion: WorkspaceVersion;
	readonly durationMs: number;
	readonly truncated: boolean;
}

export interface SandboxExecutionEnvOptions {
	readonly ctx: CallContext;
	readonly sessionId: SessionId;
	readonly workspaceId: WorkspaceId;
	readonly sandboxes: Sandboxes;
	readonly workspaces: Workspaces;
	/** Where the workspace appears; `/workspace` when absent. An absolute path. */
	readonly root?: string;
	/** Called after every command the sandbox ran, before its output is delivered. */
	readonly onExec?: (record: SandboxExecRecord) => void | Promise<void>;
	/**
	 * The largest file, in bytes, the environment reads or writes. A read of a larger file is refused before its body is
	 * fetched (`Workspaces.read`'s `maxBytes`), and a write, append or truncate that would leave a larger file commits
	 * nothing; both fail with `invalid`. Absent: no limit of its own. Commands in the sandbox are bounded by the sandbox.
	 */
	readonly maxFileBytes?: number;
}

/** The Pi Durable `ExecutionEnv` of one session over its sandboxes and workspace. */
export function createSandboxExecutionEnv(options: SandboxExecutionEnvOptions): ExecutionEnv {
	return new SandboxExecutionEnv(options);
}

/** A resolved path: inside the workspace (relative, `""` for the root) or under a mount point (absolute). */
type Location =
	| { readonly kind: "workspace"; readonly path: string }
	| { readonly kind: "mount"; readonly path: string };

/** What is at a location; `not_directory` when an ancestor is a file. */
type Shape = "file" | "directory" | "missing" | "not_directory";

/**
 * What a rename finds at a location: `empty` is a directory made here with nothing below it, `not_directory` a path
 * with a file as an ancestor.
 */
type Found =
	| { readonly kind: "file"; readonly entry: ModedFileEntry }
	| { readonly kind: "directory" | "empty" | "missing" | "not_directory" };

class SandboxExecutionEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;

	readonly #ctx: CallContext;
	readonly #sessionId: SessionId;
	readonly #workspaceId: WorkspaceId;
	readonly #sandboxes: Sandboxes;
	readonly #workspaces: Workspaces;
	readonly #root: string;
	readonly #onExec: ((record: SandboxExecRecord) => void | Promise<void>) | undefined;
	readonly #maxFileBytes: number | undefined;
	#mounts: Promise<readonly Mount[]> | undefined;
	/** Directories made here, which may hold no file: workspace paths, each with its ancestors. */
	readonly #directories = new Set<string>();
	/** One controller per command still running, for `cleanup`. */
	readonly #running = new Set<AbortController>();

	constructor(options: SandboxExecutionEnvOptions) {
		const root = options.root ?? DEFAULT_ROOT;
		if (!root.startsWith("/")) throw new Error(`the root must be an absolute path, not ${root}`);
		this.#root = normalizeAbsolute(root);
		this.#ctx = options.ctx;
		this.#sessionId = options.sessionId;
		this.#workspaceId = options.workspaceId;
		this.#sandboxes = options.sandboxes;
		this.#workspaces = options.workspaces;
		this.#onExec = options.onExec;
		const max = options.maxFileBytes;
		if (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) {
			throw new Error(`maxFileBytes must be a size in bytes, not ${max}`);
		}
		this.#maxFileBytes = max;
		this.id = `kantel:${options.workspaceId}`;
		this.cwd = this.#root;
	}

	// ---- paths -------------------------------------------------------------------------------------------------------

	/** The workspace's mount points, read once. */
	#mountPoints(): Promise<readonly Mount[]> {
		if (this.#mounts === undefined) {
			const loading = this.#workspaces.get(this.#ctx, this.#workspaceId).then((record) => record.mounts);
			this.#mounts = loading;
			// A failed lookup is not cached, so the next call asks again.
			loading.catch(() => {
				if (this.#mounts === loading) this.#mounts = undefined;
			});
		}
		return this.#mounts;
	}

	/** Resolves `path` against `cwd`; anything outside the root that is under no mount point is `permission_denied`. */
	async #locate(path: string): Promise<Result<Location, FileError>> {
		const base = this.cwd.startsWith("/") ? this.cwd : `${this.#root}/${this.cwd}`;
		const clean = normalizeAbsolute(path.startsWith("/") ? path : `${base}/${path}`);
		let mounts: readonly Mount[];
		try {
			mounts = await this.#mountPoints();
		} catch (error) {
			return err(toFileError(error, path));
		}
		if (isUnderMount(clean, mounts)) return ok({ kind: "mount", path: clean });
		if (this.#root === "/") return ok({ kind: "workspace", path: clean.slice(1) });
		if (clean === this.#root) return ok({ kind: "workspace", path: "" });
		if (clean.startsWith(`${this.#root}/`)) return ok({ kind: "workspace", path: clean.slice(this.#root.length + 1) });
		return err(new FileError("permission_denied", `${path} is outside ${this.#root} and every mount`, path));
	}

	/** The absolute path a location shows as. */
	#display(location: Location): string {
		if (location.kind === "mount") return location.path;
		if (location.path === "") return this.#root;
		return this.#root === "/" ? `/${location.path}` : `${this.#root}/${location.path}`;
	}

	/** The call context for one operation: the session's, cancelled also by the operation's context. */
	#call(context: Context): CallContext {
		const signal = context.abortSignal;
		if (signal === undefined) return this.#ctx;
		const outer = this.#ctx.signal;
		return { ...this.#ctx, signal: outer === undefined ? signal : AbortSignal.any([outer, signal]) };
	}

	/** Checks the context is live and resolves `path`. */
	async #begin(path: string, context: Context): Promise<Result<{ location: Location; call: CallContext }, FileError>> {
		if (context.abortSignal?.aborted === true) return err(new FileError("aborted", "aborted", path));
		const location = await this.#locate(path);
		if (!location.ok) return location;
		return ok({ location: location.value, call: this.#call(context) });
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		const location = await this.#locate(path);
		return location.ok ? ok(this.#display(location.value)) : location;
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.absolutePath(path, context);
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(joinPosix(parts));
	}

	// ---- directories made here ------------------------------------------------------------------------------------

	/** Records a directory made here, with its ancestors. */
	#remember(path: string): void {
		const segments = path.split("/");
		for (let depth = 1; depth <= segments.length; depth++) this.#directories.add(segments.slice(0, depth).join("/"));
	}

	/** Forgets the directories made here at or below `path`. */
	#forget(path: string): void {
		for (const directory of [...this.#directories]) {
			if (directory === path || directory.startsWith(`${path}/`)) this.#directories.delete(directory);
		}
	}

	/** Moves the directories made here at or below `from` to `to`. */
	#move(from: string, to: string): void {
		for (const directory of [...this.#directories]) {
			if (directory !== from && !directory.startsWith(`${from}/`)) continue;
			this.#directories.delete(directory);
			this.#remember(`${to}${directory.slice(from.length)}`);
		}
	}

	/** Whether a location is a directory made here (the workspace may have something there too). */
	#isMade(location: Location): boolean {
		return location.kind === "workspace" && location.path !== "" && this.#directories.has(location.path);
	}

	/** The directories made here directly in a directory, by path. */
	#madeChildren(location: Location): string[] {
		if (location.kind !== "workspace") return [];
		const prefix = location.path === "" ? "" : `${location.path}/`;
		const children: string[] = [];
		for (const directory of this.#directories) {
			if (directory.length > prefix.length && directory.startsWith(prefix) && !directory.includes("/", prefix.length)) {
				children.push(directory);
			}
		}
		return children.sort();
	}

	#directoryInfo(location: Location): FileInfo {
		const path = this.#display(location);
		return { name: basename(path), path, kind: "directory", size: 0, mtimeMs: 0 };
	}

	/** The directories made here directly in a directory that are not among `listed`. */
	#madeEntries(location: Location, listed: ReadonlySet<string>): FileInfo[] {
		return this.#madeChildren(location)
			.map((path) => this.#directoryInfo({ kind: "workspace", path }))
			.filter((info) => !listed.has(info.name));
	}

	/**
	 * Checks that the directory made here at `location`, which the workspace reported missing (the error `missing`), is
	 * still one: `not_directory` when an ancestor is now a file at head, whose directories made here are then forgotten.
	 */
	async #madeDirectory(
		call: CallContext,
		location: Location,
		path: string,
		missing: unknown,
	): Promise<Result<void, FileError>> {
		let shape: Exclude<Shape, "file">;
		try {
			shape = await this.#shapeOfMissing(call, location);
		} catch (error) {
			return err(toFileError(error, path));
		}
		if (shape === "directory") return ok(undefined);
		if (shape === "not_directory") {
			return err(new FileError("not_directory", `not a directory: ${path}`, path, asError(missing)));
		}
		return err(toFileError(missing, path));
	}

	/** `is_directory` when `location` is a directory made here rather than a file in the workspace. */
	async #directoryInTheWay(call: CallContext, location: Location, path: string): Promise<FileError | undefined> {
		if (!this.#isMade(location) || (await this.#shape(call, location)) !== "directory") return undefined;
		return new FileError("is_directory", `is a directory: ${path}`, path);
	}

	// ---- reads -------------------------------------------------------------------------------------------------------

	async #read(call: CallContext, location: Location, version?: WorkspaceVersion): Promise<Uint8Array> {
		const max = this.#maxFileBytes;
		const options = {
			...(location.kind === "workspace" && version !== undefined ? { version } : {}),
			...(max === undefined ? {} : { maxBytes: max }),
		};
		const { content } = await this.#workspaces.read(call, this.#workspaceId, location.path, options);
		// An implementation that does not know `maxBytes` still never hands a larger file on.
		if (max !== undefined && content.byteLength > max) throw tooLarge(location.path, content.byteLength, max);
		return content;
	}

	/** Refuses (`invalid`) content of `bytes` at `path` when it is over `maxFileBytes`; otherwise nothing. */
	#checkSize(path: string, bytes: number): FileError | undefined {
		const max = this.#maxFileBytes;
		if (max === undefined || bytes <= max) return undefined;
		return toFileError(tooLarge(path, bytes, max), path);
	}

	async #stat(call: CallContext, location: Location, version?: WorkspaceVersion): Promise<FileEntry> {
		const options = location.kind === "workspace" && version !== undefined ? { version } : undefined;
		return this.#workspaces.stat(call, this.#workspaceId, location.path, options);
	}

	/** Every entry in a directory (or below it, when recursive), paging through `Workspaces.list`. */
	async #listAll(
		call: CallContext,
		location: Location,
		options: { readonly recursive?: boolean; readonly version?: WorkspaceVersion } = {},
	): Promise<FileEntry[]> {
		const entries: FileEntry[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.#workspaces.list(call, this.#workspaceId, {
				limit: LIST_PAGE,
				...(location.path === "" ? {} : { path: location.path }),
				...(options.recursive === true ? { recursive: true } : {}),
				...(location.kind === "workspace" && options.version !== undefined ? { version: options.version } : {}),
				...(cursor === undefined ? {} : { cursor }),
			});
			entries.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return entries;
	}

	async #bytes(path: string, context: Context): Promise<Result<{ bytes: Uint8Array; location: Location }, FileError>> {
		const start = await this.#begin(path, context);
		if (!start.ok) return start;
		const { location, call } = start.value;
		if (isRoot(location)) return err(new FileError("is_directory", `is a directory: ${path}`, path));
		try {
			return ok({ bytes: await this.#read(call, location), location });
		} catch (error) {
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const read = await this.#bytes(path, context);
		return read.ok ? ok(read.value.bytes) : read;
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const read = await this.#bytes(path, context);
		return read.ok ? ok(new TextDecoder().decode(read.value.bytes)) : read;
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split("\n");
		// A final newline ends the last line rather than starting an empty one, as a line reader sees it.
		if (lines.at(-1) === "") lines.pop();
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		return ok(textLineReader(text.value, path));
	}

	async openBinaryReader(
		path: string,
		_options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const read = await this.#bytes(path, context);
		if (!read.ok) return read;
		const { bytes, location } = read.value;
		const absolute = this.#display(location);
		return ok(
			binaryReader(bytes, {
				name: basename(absolute),
				path: absolute,
				kind: "file",
				size: bytes.byteLength,
				mtimeMs: 0,
			}),
		);
	}

	#info(entry: FileEntry): FileInfo {
		const path = entry.path.startsWith("/") ? entry.path : this.#display({ kind: "workspace", path: entry.path });
		return { name: basename(path), path, kind: entry.kind, size: entry.size, mtimeMs: 0 };
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const start = await this.#begin(path, context);
		if (!start.ok) return start;
		const { location, call } = start.value;
		if (isRoot(location)) {
			return ok({ name: basename(this.#root), path: this.#root, kind: "directory", size: 0, mtimeMs: 0 });
		}
		try {
			return ok(this.#info(await this.#stat(call, location)));
		} catch (error) {
			if (!isKantelError(error, "not_found") || !this.#isMade(location)) {
				return err(await this.#fileError(error, location, path, call));
			}
			const made = await this.#madeDirectory(call, location, path, error);
			return made.ok ? ok(this.#directoryInfo(location)) : made;
		}
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const found = await this.fileInfo(path, context);
		if (found.ok) return ok(true);
		// Nothing is below a file either.
		return found.error.code === "not_found" || found.error.code === "not_directory" ? ok(false) : found;
	}

	/** Resolves a directory to list: `not_found` when missing and `not_directory` for a file. */
	async #directory(
		path: string,
		context: Context,
	): Promise<Result<{ location: Location; call: CallContext }, FileError>> {
		const start = await this.#begin(path, context);
		if (!start.ok) return start;
		const { location, call } = start.value;
		if (isRoot(location)) return start;
		try {
			const entry = await this.#stat(call, location);
			if (entry.kind !== "directory") return err(new FileError("not_directory", `not a directory: ${path}`, path));
			return start;
		} catch (error) {
			if (!isKantelError(error, "not_found") || !this.#isMade(location)) {
				return err(await this.#fileError(error, location, path, call));
			}
			const made = await this.#madeDirectory(call, location, path, error);
			return made.ok ? start : made;
		}
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const directory = await this.#directory(path, context);
		if (!directory.ok) return directory;
		const { location, call } = directory.value;
		let entries: FileInfo[] = [];
		try {
			entries = (await this.#listAll(call, location)).map((entry) => this.#info(entry));
		} catch (error) {
			// A directory made here may have no file below it.
			if (!isKantelError(error, "not_found")) return err(await this.#fileError(error, location, path, call));
		}
		const made = this.#madeEntries(location, new Set(entries.map((entry) => entry.name)));
		if (made.length === 0) return ok(entries);
		return ok([...entries, ...made].sort((left, right) => compare(left.name, right.name)));
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const directory = await this.#directory(path, context);
		if (!directory.ok) return directory;
		const { location } = directory.value;
		let cursor: string | undefined;
		// Whether the workspace's entries are all listed; the directories made here come after them.
		let listed = false;
		const names = new Set<string>();
		let made: FileInfo[] | undefined;
		let closed = false;
		const reader: DirReader = {
			next: async (maxEntries, nextContext) => {
				if (nextContext.abortSignal?.aborted === true) return err(new FileError("aborted", "aborted", path));
				if (closed) return err(new FileError("invalid", "Directory reader is closed", path));
				if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
					return err(new FileError("invalid", "maxEntries must be a positive safe integer", path));
				}
				const entries: FileInfo[] = [];
				if (!listed) {
					const call = this.#call(nextContext);
					try {
						// Each page lists the head, so entries removed since the reader opened are skipped.
						const page = await this.#workspaces.list(call, this.#workspaceId, {
							limit: Math.min(maxEntries, LIST_PAGE),
							...(location.path === "" ? {} : { path: location.path }),
							...(cursor === undefined ? {} : { cursor }),
						});
						cursor = page.nextCursor;
						listed = cursor === undefined;
						for (const entry of page.items) {
							const info = this.#info(entry);
							names.add(info.name);
							entries.push(info);
						}
					} catch (error) {
						// No file is below the directory (any more): only directories made here are left to list.
						if (!isKantelError(error, "not_found")) return err(await this.#fileError(error, location, path, call));
						listed = true;
					}
					if (!listed) return ok({ entries, done: false });
				}
				made ??= this.#madeEntries(location, names);
				entries.push(...made.splice(0, maxEntries - entries.length));
				return ok({ entries, done: made.length === 0 });
			},
			close: async () => {
				closed = true;
			},
		};
		return ok(reader);
	}

	// ---- writes ------------------------------------------------------------------------------------------------------

	/**
	 * Commits the changes `build` derives from the head. If another writer moved the head first, `build` runs again on
	 * the new head, so a change computed from what it read (an append) never overwrites a write it did not see. No
	 * changes: nothing is committed. Commits to the workspace from this process take turns (`commit-queue.ts`), so many
	 * writes at once (a code mode script's `Promise.all`) retry only for writers elsewhere.
	 */
	async #commit(
		call: CallContext,
		build: (head: WorkspaceVersion) => Promise<readonly ModedChange[]> | readonly ModedChange[],
		message: string,
	): Promise<void> {
		return queueWorkspaceCommit(this.#workspaceId, () => this.#commitNow(call, build, message));
	}

	async #commitNow(
		call: CallContext,
		build: (head: WorkspaceVersion) => Promise<readonly ModedChange[]> | readonly ModedChange[],
		message: string,
	): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			const { head } = await this.#workspaces.get(call, this.#workspaceId);
			const changes = await build(head);
			if (changes.length === 0) return;
			try {
				await this.#workspaces.commit(call, this.#workspaceId, {
					baseVersion: head,
					changes,
					writer: { sessionId: this.#sessionId },
					message,
				});
				return;
			} catch (error) {
				if (!isKantelError(error, "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
			}
		}
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const start = await this.#begin(path, context);
		if (!start.ok) return start;
		const { location, call } = start.value;
		if (isRoot(location)) return err(new FileError("is_directory", "cannot write the workspace root", path));
		const bytes = typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
		const over = this.#checkSize(path, bytes);
		if (over !== undefined) return err(over);
		try {
			const inTheWay = await this.#directoryInTheWay(call, location, path);
			if (inTheWay !== undefined) return err(inTheWay);
			// A whole-file write replaces whatever the head has, as on a local disk: last writer wins.
			await this.#commit(call, () => [{ op: "put", path: location.path, content }], `write ${location.path}`);
			return ok(undefined);
		} catch (error) {
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const start = await this.#begin(path, context);
		if (!start.ok) return start;
		const { location, call } = start.value;
		if (isRoot(location)) return err(new FileError("is_directory", "cannot write the workspace root", path));
		const add = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const over = this.#checkSize(path, add.byteLength);
		if (over !== undefined) return err(over);
		try {
			const inTheWay = await this.#directoryInTheWay(call, location, path);
			if (inTheWay !== undefined) return err(inTheWay);
			await this.#commit(
				call,
				async (head) => {
					// Read at the version the commit is based on, so the append applies to exactly what it read.
					let before: Uint8Array = new Uint8Array();
					try {
						before = await this.#read(call, location, head);
					} catch (error) {
						if (!isKantelError(error, "not_found")) throw error;
					}
					const max = this.#maxFileBytes;
					const size = before.byteLength + add.byteLength;
					if (max !== undefined && size > max) throw tooLarge(location.path, size, max);
					return [{ op: "put", path: location.path, content: concat(before, add) }];
				},
				`append ${location.path}`,
			);
			return ok(undefined);
		} catch (error) {
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const start = await this.#begin(path, context);
		if (!start.ok) return start;
		const { location, call } = start.value;
		if (!Number.isSafeInteger(size) || size < 0) {
			return err(new FileError("invalid", "File size must be a non-negative safe integer", path));
		}
		if (isRoot(location)) return err(new FileError("is_directory", "cannot truncate the workspace root", path));
		const over = this.#checkSize(path, size);
		if (over !== undefined) return err(over);
		try {
			await this.#commit(
				call,
				async (head) => {
					const before = await this.#read(call, location, head);
					// Extending pads with zero bytes, as truncate(2) does.
					const after = new Uint8Array(size);
					after.set(before.subarray(0, size));
					return [{ op: "put", path: location.path, content: after }];
				},
				`truncate ${location.path}`,
			);
			return ok(undefined);
		} catch (error) {
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		// Every write is already a commit; there is nothing to flush.
		const start = await this.#begin(path, context);
		return start.ok ? ok(undefined) : start;
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = await this.#begin(sourcePath, context);
		if (!source.ok) return source;
		const destination = await this.#locate(destinationPath);
		if (!destination.ok) return destination;
		const from = source.value.location;
		const to = destination.value;
		const call = source.value.call;
		if (isRoot(from)) return err(new FileError("permission_denied", "cannot move the workspace root", sourcePath));
		if (isRoot(to)) return err(new FileError("is_directory", "cannot replace the workspace root", destinationPath));
		const missing = () => new FileError("not_found", `no such file or directory: ${sourcePath}`, sourcePath);
		try {
			if (from.kind === to.kind && from.path === to.path) {
				// Renaming a path onto itself changes nothing, but the path must exist.
				const shape = await this.#shape(call, from);
				if (shape === "missing") return err(missing());
				if (shape === "not_directory") {
					return err(new FileError("not_directory", `not a directory: ${sourcePath}`, sourcePath));
				}
				return ok(undefined);
			}
			if (from.kind === to.kind && to.path.startsWith(`${from.path}/`)) {
				return err(new FileError("invalid", `cannot move ${sourcePath} into itself`, destinationPath));
			}
			const moving = { directory: false };
			await this.#commit(
				call,
				async (head) => {
					const origin = await this.#found(call, from, head);
					if (origin.kind === "missing") throw missing();
					if (origin.kind === "not_directory") {
						throw new FileError("not_directory", `not a directory: ${sourcePath}`, sourcePath);
					}
					const target = await this.#found(call, to, head);
					// Nothing can be put below a file, and a directory made there would be impossible.
					if (target.kind === "not_directory") {
						throw new FileError("not_directory", `not a directory: ${destinationPath}`, destinationPath);
					}
					let moved: ModedFileEntry[] = [];
					if (origin.kind === "file") {
						// A file replaces a file, as rename(2) does, but not a directory.
						if (target.kind !== "missing" && target.kind !== "file") {
							throw new FileError("is_directory", `is a directory: ${destinationPath}`, destinationPath);
						}
						moving.directory = false;
						moved = [origin.entry];
					} else {
						// A directory replaces only a missing path or an empty directory, so it never merges into another.
						if (target.kind === "file") {
							throw new FileError("invalid", `a directory cannot replace a file: ${destinationPath}`, destinationPath);
						}
						if (target.kind === "directory") {
							throw new FileError("invalid", `directory not empty: ${destinationPath}`, destinationPath);
						}
						moving.directory = true;
						try {
							moved = (await this.#listAll(call, from, { recursive: true, version: head })).filter(
								(candidate) => candidate.kind === "file",
							);
						} catch (error) {
							// A directory made here may have no file below it.
							if (!isKantelError(error, "not_found")) throw error;
						}
						if (moved.length === 0 && to.kind === "mount") {
							// Nothing to commit, so no commit can refuse it.
							throw new FileError("permission_denied", `mounts are read-only: ${destinationPath}`, destinationPath);
						}
					}
					const changes: ModedChange[] = [];
					for (const file of moved) {
						const below = file.path === from.path ? "" : file.path.slice(from.path.length);
						const content = await this.#read(call, { ...from, path: file.path }, head);
						changes.push({
							op: "put",
							path: `${to.path}${below}`,
							content,
							...(file.mode === undefined ? {} : { mode: file.mode }),
						});
						changes.push({ op: "delete", path: file.path });
					}
					return changes;
				},
				`rename ${from.path} to ${to.path}`,
			);
			if (moving.directory && from.kind === "workspace" && to.kind === "workspace") this.#move(from.path, to.path);
			// Nothing made here outlives a file moved away from its path.
			else if (from.kind === "workspace") this.#forget(from.path);
			return ok(undefined);
		} catch (error) {
			if (error instanceof FileError) return err(error);
			if (isKantelError(error, "not_found")) return err(toFileError(error, sourcePath));
			return err(await this.#fileError(error, to, destinationPath, call));
		}
	}

	/** What is at a location at `version`, counting the directories made here, for a rename. */
	async #found(call: CallContext, location: Location, version: WorkspaceVersion): Promise<Found> {
		try {
			const entry: ModedFileEntry = await this.#stat(call, location, version);
			// A file there (another writer may have committed it) wins over directories made here at or below it.
			if (entry.kind === "file" && location.kind === "workspace") this.#forget(location.path);
			// A directory in the workspace has a file below it, so it is never empty.
			return entry.kind === "file" ? { kind: "file", entry } : { kind: "directory" };
		} catch (error) {
			if (!isKantelError(error, "not_found")) throw error;
		}
		const shape = await this.#shapeOfMissing(call, location, version);
		if (shape !== "directory") return { kind: shape };
		return this.#madeChildren(location).length === 0 ? { kind: "empty" } : { kind: "directory" };
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const start = await this.#begin(path, context);
		if (!start.ok) return start;
		const { location, call } = start.value;
		if (isRoot(location)) return err(new FileError("permission_denied", "cannot remove the workspace root", path));
		try {
			let found: FileEntry["kind"] | undefined;
			try {
				found = (await this.#stat(call, location)).kind;
			} catch (error) {
				if (!isKantelError(error, "not_found")) throw error;
			}
			if (found === undefined) {
				// A directory made here, unless a file has since been committed at one of its ancestors.
				const shape = await this.#shapeOfMissing(call, location);
				if (shape !== "directory") {
					if (options?.force === true) return ok(undefined);
					return err(
						shape === "not_directory"
							? new FileError("not_directory", `not a directory: ${path}`, path)
							: new FileError("not_found", `no such file: ${path}`, path),
					);
				}
				found = "directory";
			}
			const kind = found;
			if (kind === "directory" && options?.recursive !== true) {
				return err(new FileError("is_directory", `is a directory: ${path}`, path));
			}
			await this.#commit(
				call,
				async (head) => {
					if (kind === "file") return [{ op: "delete", path: location.path }];
					let below: FileEntry[] = [];
					try {
						below = await this.#listAll(call, location, { recursive: true, version: head });
					} catch (error) {
						// A directory made here may have no file below it: nothing to commit.
						if (!isKantelError(error, "not_found")) throw error;
					}
					return below
						.filter((candidate) => candidate.kind === "file")
						.map((candidate): ModedChange => ({ op: "delete", path: candidate.path }));
				},
				`remove ${location.path}`,
			);
			// Whatever was removed, no directory made here is left at or below it.
			if (location.kind === "workspace") this.#forget(location.path);
			return ok(undefined);
		} catch (error) {
			if (options?.force === true && isKantelError(error, "not_found")) return ok(undefined);
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async createDir(
		path: string,
		_options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const start = await this.#begin(path, context);
		if (!start.ok) return start;
		const { location, call } = start.value;
		if (location.kind === "mount") {
			return err(new FileError("permission_denied", `mounts are read-only: ${path}`, path));
		}
		// Succeed unless the path, or one of its ancestors, is a file; the directory is kept here, not committed.
		if (isRoot(location)) return ok(undefined);
		try {
			const shape = await this.#shape(call, location);
			if (shape === "file" || shape === "not_directory") {
				return err(new FileError("not_directory", `a file is in the way: ${path}`, path));
			}
			this.#remember(location.path);
			return ok(undefined);
		} catch (error) {
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		if (context.abortSignal?.aborted === true) return err(new FileError("aborted", "aborted"));
		const name = tempName(prefix ?? "tmp-", "");
		if (name.includes("/")) return err(new FileError("invalid", "a temporary directory prefix must not contain /"));
		// Kept here, not committed, like any directory made by `createDir`.
		const path = `${TEMP_DIR}/${name}`;
		const absolute = this.#display({ kind: "workspace", path });
		try {
			// A directory below a file would be impossible.
			if ((await this.#fileAncestor(this.#call(context), path)) !== undefined) {
				return err(new FileError("not_directory", `a file is in the way: ${absolute}`, absolute));
			}
		} catch (error) {
			return err(toFileError(error, absolute));
		}
		this.#remember(path);
		return ok(absolute);
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const name = tempName(options?.prefix ?? "", options?.suffix ?? "");
		if (name.includes("/"))
			return err(new FileError("invalid", "a temporary file prefix or suffix must not contain /"));
		const path = this.#display({ kind: "workspace", path: `${TEMP_DIR}/${name}` });
		const written = await this.writeFile(path, new Uint8Array(), context);
		return written.ok ? ok(path) : written;
	}

	async watch(): Promise<Result<FileWatcher, FileError>> {
		return err(new FileError("not_supported", "watch is not supported by Kantel workspaces", this.#root));
	}

	// ---- errors ------------------------------------------------------------------------------------------------------

	/**
	 * What is at a location: a file, a directory (in the workspace or made here), missing, or `not_directory` when an
	 * ancestor is a file. Errors other than `not_found` propagate.
	 */
	async #shape(call: CallContext, location: Location): Promise<Shape> {
		if (isRoot(location)) return "directory";
		try {
			return (await this.#stat(call, location)).kind;
		} catch (error) {
			if (!isKantelError(error, "not_found")) throw error;
		}
		return this.#shapeOfMissing(call, location);
	}

	/**
	 * What is at a location the workspace does not have (at `version`, head when absent): a directory made here, missing,
	 * or `not_directory` when an ancestor is a file. Another writer may have committed that file after a directory was
	 * made below it: the file wins, and the directories made at and below it are forgotten.
	 */
	async #shapeOfMissing(
		call: CallContext,
		location: Location,
		version?: WorkspaceVersion,
	): Promise<Exclude<Shape, "file">> {
		if (location.kind !== "workspace") return "missing";
		const file = await this.#fileAncestor(call, location.path, version);
		if (file !== undefined) {
			this.#forget(file);
			return "not_directory";
		}
		return this.#isMade(location) ? "directory" : "missing";
	}

	/** The shallowest ancestor of a workspace path that is a file at `version` (head when absent), if any. */
	async #fileAncestor(call: CallContext, path: string, version?: WorkspaceVersion): Promise<string | undefined> {
		const segments = path.split("/");
		for (let depth = 1; depth < segments.length; depth++) {
			const ancestor = segments.slice(0, depth).join("/");
			try {
				if ((await this.#stat(call, { kind: "workspace", path: ancestor }, version)).kind === "file") return ancestor;
			} catch (error) {
				if (!isKantelError(error, "not_found")) throw error;
				// Nothing is below a missing path in the workspace.
				return undefined;
			}
		}
		return undefined;
	}

	/**
	 * Maps an error to a `FileError`, telling an `invalid` or `not_found` directory or file-in-the-way apart from a bad
	 * or missing path.
	 */
	async #fileError(error: unknown, location: Location, path: string, call: CallContext): Promise<FileError> {
		if (isTooLarge(error)) return toFileError(error, path);
		const missing = isKantelError(error, "not_found");
		if (missing || isKantelError(error, "invalid")) {
			let shape: Shape | undefined;
			try {
				// The workspace has nothing at a path it reported missing, so only its ancestors are asked.
				shape = missing ? await this.#shapeOfMissing(call, location) : await this.#shape(call, location);
			} catch {
				// Keep the original error.
			}
			const cause = asError(error);
			if (shape === "directory") return new FileError("is_directory", `is a directory: ${path}`, path, cause);
			if (shape === "not_directory") return new FileError("not_directory", `not a directory: ${path}`, path, cause);
		}
		return toFileError(error, path);
	}

	// ---- shell -------------------------------------------------------------------------------------------------------

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted === true) return err(new ExecutionError("aborted", "aborted"));
		if (typeof command !== "string" && command.length === 0) {
			return err(new ExecutionError("spawn_error", "an argv command needs a program"));
		}
		let timeoutMs: number | undefined;
		if (options?.timeout !== undefined) {
			if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
				return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
			}
			timeoutMs = Math.ceil(options.timeout * 1000);
		}
		// Aborted when this call is aborted or times out, or by `cleanup`; the sandbox sees its signal.
		const controller = new AbortController();
		this.#running.add(controller);
		try {
			return await this.#run(command, options, timeoutMs, controller, context);
		} finally {
			this.#running.delete(controller);
		}
	}

	async #run(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		timeoutMs: number | undefined,
		controller: AbortController,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		const where = await this.#locate(options?.cwd ?? this.cwd);
		if (!where.ok) return err(new ExecutionError("spawn_error", where.error.message, where.error));
		if (where.value.kind !== "workspace") {
			return err(new ExecutionError("spawn_error", `the working directory must be in ${this.#root}`));
		}
		const cwd = where.value.path;
		const request: ExecRequest = {
			command,
			...(cwd === "" ? {} : { cwd }),
			...(options?.env === undefined ? {} : { env: options.env }),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		};
		// Checked again: the signal, or `cleanup`, may have fired while the working directory was being resolved.
		if (isAborted(signal) || isAborted(controller.signal)) return err(new ExecutionError("aborted", "aborted"));

		const outer = this.#ctx.signal;
		const call: CallContext = {
			...this.#ctx,
			signal: outer === undefined ? controller.signal : AbortSignal.any([outer, controller.signal]),
		};
		const outcome = await race(
			this.#sandboxes.run(call, {
				sessionId: this.#sessionId,
				workspaceId: this.#workspaceId,
				tool: "bash",
				request,
			}),
			// `cleanup` stops the wait as an abort of the context does.
			signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
			timeoutMs,
		);
		if (outcome.kind === "aborted") {
			controller.abort();
			return err(new ExecutionError("aborted", "aborted"));
		}
		if (outcome.kind === "timeout") {
			controller.abort();
			return err(new ExecutionError("timeout", `timeout:${options?.timeout}`));
		}
		if (outcome.kind === "failed") return err(executionError(outcome.error));

		const result = outcome.value;
		try {
			await this.#onExec?.(execRecord(command, cwd, result));
		} catch (error) {
			return err(new ExecutionError("callback_error", errorMessage(error), asError(error)));
		}
		if (typeof command !== "string") {
			// Only the sandbox's "command not found" for the program itself: it did not start, so there is no output to
			// deliver and a caller may safely try another form. Any other 127 came from a program that ran.
			const notFound = programNotFound(command[0] ?? "", result);
			if (notFound !== undefined) return err(new ExecutionError("spawn_error", notFound));
		}
		const chunks = outputChunks(result);
		try {
			for (const chunk of chunks) options?.onOutput?.(chunk.text, context, { stream: chunk.stream });
		} catch (error) {
			return err(new ExecutionError("callback_error", errorMessage(error), asError(error)));
		}
		const spill = options?.spill;
		const output = chunks.map((chunk) => chunk.text).join("");
		if (spill === undefined || !exceedsSpill(output, spill)) return ok({ exitCode: result.exitCode });
		// Truncated output cannot be complete in the file either, so the file says so on its first line too.
		const spilled = await this.#spill(result.truncated === true ? `${TRUNCATED_LINE}\n${output}` : output, context);
		return spilled.ok ? ok({ exitCode: result.exitCode, spillPath: spilled.value }) : spilled;
	}

	/**
	 * Writes a command's output to a new file under `.tmp/` in one commit; its absolute path. The output is complete
	 * unless the sandbox truncated it, which the caller marks.
	 */
	async #spill(output: string, context: Context): Promise<Result<string, ExecutionError>> {
		const path = this.#display({ kind: "workspace", path: `${TEMP_DIR}/${tempName("pi-output-", ".log")}` });
		const written = await this.writeFile(path, output, context);
		if (written.ok) return ok(path);
		if (written.error.code === "aborted") return err(new ExecutionError("aborted", "aborted", written.error));
		const message = `Failed to preserve complete shell output: ${written.error.message}`;
		return err(new ExecutionError("unknown", message, written.error));
	}

	async cleanup(_context: Context): Promise<void> {
		// Every command still running stops at once (its sandbox call's signal aborts); later commands run as usual.
		// A session's leases end with the session (`Sandboxes.releaseSession`).
		for (const controller of this.#running) controller.abort();
		this.#running.clear();
	}
}

// ---- readers ---------------------------------------------------------------------------------------------------------

/** Positional reads over a file's bytes as they were when it was opened. */
function binaryReader(data: Uint8Array, info: FileInfo): BinaryReader {
	const path = info.path;
	let closed = false;
	const check = (context: Context): Result<never, FileError> | undefined => {
		if (context.abortSignal?.aborted === true) return err(new FileError("aborted", "aborted", path));
		if (closed) return err(new FileError("invalid", "Binary reader is closed", path));
		return undefined;
	};
	return {
		info: async (context) => check(context) ?? ok({ ...info }),
		read: async (offset, length, context) => {
			const refused = check(context);
			if (refused !== undefined) return refused;
			if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
				return err(new FileError("invalid", "Offset and length must be non-negative safe integers", path));
			}
			return ok(data.slice(offset, offset + length));
		},
		scanLines: async (options, context) => {
			const refused = check(context);
			if (refused !== undefined) return refused;
			let scanner: LineScanner;
			try {
				scanner = new LineScanner(options.startLine, options.endLine);
			} catch {
				return err(new FileError("invalid", "Invalid line range", path));
			}
			scanner.push(data);
			return ok(scanner.finish());
		},
		close: async () => {
			closed = true;
		},
	};
}

/** Lines of a decoded file, split at LF, each reporting whether a newline ended it. */
function textLineReader(text: string, path: string): TextLineReader {
	let position = 0;
	let closed = false;
	return {
		readLine: async (context) => {
			if (context.abortSignal?.aborted === true) return err(new FileError("aborted", "aborted", path));
			if (closed) return err(new FileError("invalid", "Text line reader is closed", path));
			if (position >= text.length) return ok(undefined);
			const newline = text.indexOf("\n", position);
			if (newline < 0) {
				const line = text.slice(position);
				position = text.length;
				return ok({ text: line, terminated: false });
			}
			const line = text.slice(position, newline);
			position = newline + 1;
			return ok({ text: line, terminated: true });
		},
		close: async () => {
			closed = true;
		},
	};
}

// ---- helpers ---------------------------------------------------------------------------------------------------------

type Raced<T> =
	| { readonly kind: "done"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "aborted" }
	| { readonly kind: "timeout" };

/** Read through a call so a check after an `await` is not narrowed away by an earlier one. */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** Waits for `work`, an abort of `signal`, or `timeoutMs`, whichever comes first. */
function race<T>(work: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<Raced<T>> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		function finish(outcome: Raced<T>): void {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		}
		function onAbort(): void {
			finish({ kind: "aborted" });
		}
		work.then(
			(value) => finish({ kind: "done", value }),
			(error: unknown) => finish({ kind: "failed", error }),
		);
		if (signal?.aborted === true) {
			finish({ kind: "aborted" });
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs !== undefined) timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
	});
}

function execRecord(command: string | readonly string[], cwd: string, result: ExecResult): SandboxExecRecord {
	return {
		command,
		cwd,
		tier: result.tier,
		leaseId: result.leaseId,
		exitCode: result.exitCode,
		workspaceVersion: result.workspaceVersion,
		durationMs: result.durationMs,
		truncated: result.truncated === true,
	};
}

interface OutputChunk {
	readonly text: string;
	readonly stream: "stdout" | "stderr";
}

/** A command's output as delivered: stdout, stderr, then a line saying the sandbox truncated it, if it did. */
function outputChunks(result: ExecResult): OutputChunk[] {
	const chunks: OutputChunk[] = [];
	if (result.stdout !== "") chunks.push({ text: result.stdout, stream: "stdout" });
	if (result.stderr !== "") chunks.push({ text: result.stderr, stream: "stderr" });
	if (result.truncated === true) {
		const last = chunks.at(-1)?.text ?? "";
		const start = last === "" || last.endsWith("\n") ? "" : "\n";
		chunks.push({ text: `${start}${TRUNCATED_LINE}\n`, stream: "stderr" });
	}
	return chunks;
}

/**
 * The `spawn_error` message when an argv command's program was not found: exit code 127, nothing on stdout, and
 * exactly one line on stderr saying, in a shape the sandboxes produce, that `program` was not found. Otherwise
 * undefined, as for a program that started and then exited with 127.
 */
function programNotFound(program: string, result: ExecResult): string | undefined {
	if (program === "" || result.exitCode !== 127 || result.stdout !== "") return undefined;
	const line = result.stderr.endsWith("\n") ? result.stderr.slice(0, -1) : result.stderr;
	if (line.includes("\n")) return undefined;
	const shape = new RegExp(`^(?:sh: |bash: (?:line 1: )?)?${escapeRegExp(program)}: command not found$`);
	return shape.test(line) ? line : undefined;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether output is over either spill threshold: its UTF-8 bytes, or its lines counting an unterminated last one. */
function exceedsSpill(output: string, spill: ShellSpillOptions): boolean {
	if (new TextEncoder().encode(output).byteLength > spill.afterBytes) return true;
	let lines = output === "" || output.endsWith("\n") ? 0 : 1;
	for (let index = output.indexOf("\n"); index !== -1; index = output.indexOf("\n", index + 1)) lines++;
	return lines > spill.afterLines;
}

function executionError(error: unknown): ExecutionError {
	if (isKantelError(error, "aborted")) return new ExecutionError("aborted", error.message, error);
	if (isKantelError(error, "unavailable")) return new ExecutionError("shell_unavailable", error.message, error);
	return new ExecutionError("unknown", errorMessage(error), asError(error));
}

/** A file over `maxFileBytes`, as `Workspaces.read` refuses one over its `maxBytes`. */
function tooLarge(path: string, bytes: number, maxBytes: number): KantelError {
	return new KantelError("refused", `${path} is ${bytes} bytes, over the ${maxBytes} allowed`, {
		path,
		maxBytes,
		bytes,
	});
}

/** A refusal for size (ours or `Workspaces.read`'s), which is `invalid` rather than `permission_denied`. */
function isTooLarge(error: unknown): boolean {
	return isKantelError(error, "refused") && typeof error.details?.maxBytes === "number";
}

function fileErrorCode(error: unknown): FileErrorCode {
	if (isTooLarge(error)) return "invalid";
	if (!isKantelError(error)) return "unknown";
	switch (error.code) {
		case "not_found":
			return "not_found";
		case "refused":
		case "forbidden":
			return "permission_denied";
		case "invalid":
			return "invalid";
		case "aborted":
			return "aborted";
		default:
			return "unknown";
	}
}

function toFileError(error: unknown, path: string): FileError {
	return new FileError(fileErrorCode(error), errorMessage(error), path, asError(error));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error | undefined {
	return error instanceof Error ? error : undefined;
}

function isRoot(location: Location): boolean {
	return location.kind === "workspace" && location.path === "";
}

/** A fresh temporary file or directory name. */
function tempName(prefix: string, suffix: string): string {
	return `${prefix}${crypto.randomUUID()}${suffix}`;
}

function compare(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
	const joined = new Uint8Array(left.byteLength + right.byteLength);
	joined.set(left);
	joined.set(right, left.byteLength);
	return joined;
}

/** An absolute path with `.`, `..` and repeated slashes resolved; `..` above `/` stays at `/`. */
function normalizeAbsolute(path: string): string {
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join("/")}`;
}

/** Joins path parts like POSIX `path.join`: normalised, absolute when the first part is, `.` when empty. */
function joinPosix(parts: readonly string[]): string {
	const joined = parts.filter((part) => part !== "").join("/");
	if (joined === "") return ".";
	const absolute = joined.startsWith("/");
	const segments: string[] = [];
	for (const segment of joined.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment !== "..") segments.push(segment);
		else if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
		else if (!absolute) segments.push("..");
	}
	const body = segments.join("/");
	if (absolute) return `/${body}`;
	return body === "" ? "." : body;
}
