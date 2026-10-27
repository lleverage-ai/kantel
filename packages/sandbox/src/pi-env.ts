/**
 * Pi Durable's `ExecutionEnv` for one Harbour session, over the `Sandboxes` and `Workspaces` contracts (issue #10).
 * Ported from the Cloudflare spike's `HarbourEnv` and generalised to depend only on the contracts.
 *
 * Design notes:
 *
 * - One environment per session. Its `id` is `harbour:<workspaceId>`: environments with equal ids see the same files at
 *   the same paths, which holds for every session on one workspace.
 * - Paths. The workspace appears at `root` (`/workspace` by default) and relative paths resolve against `cwd` (the root
 *   by default). Absolute paths under a mount point (such as `/project/...`) read the mount. Anything else is outside
 *   the environment and fails with `permission_denied`. Mount points come from the workspace record, read once.
 * - Reads go to `Workspaces` at head. A binary or text-line reader reads the whole file when it opens (the contract
 *   reads whole files), so it keeps reading what it opened even after a rename. `mtimeMs` is always 0: the contract
 *   records versions, not times. There are no symbolic links, so `canonicalPath` is `absolutePath` (it does not check
 *   that the path exists) and `noFollow` changes nothing.
 * - Writes. Every write, append, truncate, rename and remove is one commit on the head. When another writer moved the
 *   head first, the change is derived again from the new head and committed again (a few attempts), so an append or a
 *   truncate applies to exactly what it read; a whole-file write replaces whatever the head has, last writer wins.
 *   A rename is one commit (put plus delete; a directory moves every file below it).
 * - Mounts are readable and never writable. A write under a mount point is still sent to `Workspaces.commit`, which
 *   refuses it (and audits the refusal); `refused` becomes `permission_denied` and the source is unchanged.
 *   `createDir` under a mount fails with `permission_denied` directly, since there is nothing to commit.
 * - Directories are implicit in a workspace: they exist while a file below them does. `createDir` succeeds for any
 *   path that is not a file and has no file as an ancestor, but creates nothing, so an empty directory does not exist
 *   (its `recursive` flag is ignored). Removing a directory recursively deletes every file below it in one commit.
 * - Errors. `HarbourError` codes map to `FileError` codes: `not_found` to `not_found`, `refused` and `forbidden` to
 *   `permission_denied`, `invalid` to `invalid`, `aborted` to `aborted`, anything else to `unknown`. An `invalid`
 *   from a path that is a directory, or that has a file as an ancestor, becomes `is_directory` or `not_directory`.
 * - Shell. `exec` calls `Sandboxes.run` with tool `bash`, so the contract's tool-to-tier table picks the isolate or the
 *   container. `cwd` resolves like any path and must be inside the workspace (the contract's `cwd` is relative to the
 *   root); `env` is passed through and `inheritEnv` is ignored (a sandbox has its own environment). `timeout`
 *   (seconds) becomes `request.timeoutMs`, and the environment also stops waiting at that deadline and reports
 *   `timeout`. Aborting the context reports `aborted` at once. Either way the call context's `signal` is aborted so a
 *   sandbox that honours it stops the command; one that does not may still finish it (and the isolate commits what it
 *   wrote). Output arrives when the command finishes: stdout then stderr, one chunk each with its stream, so the two
 *   streams are not interleaved. `window` and `spill` are ignored: the output is what the sandbox returned (which may be
 *   truncated by the sandbox) and there is never a `spillPath`. `onExec` (and `onOutput`) failures are
 *   `callback_error`. `cleanup` stops nothing: a session's leases end with the session (`Sandboxes.releaseSession`).
 * - Temporary files live in the workspace under `<root>/.tmp/`: `createTempFile` commits an empty file there and
 *   `createTempDir` returns a fresh path there (it exists once something is written in it). They are committed like any
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
	type TextLineReader,
} from "@earendil-works/pi-durable/env";
import {
	type CallContext,
	type ExecRequest,
	type ExecResult,
	type FileEntry,
	isHarbourError,
	type Mount,
	type Sandboxes,
	type SandboxTier,
	type SessionId,
	type WorkspaceId,
	type Workspaces,
	type WorkspaceVersion,
} from "@harbour/contracts";
import { isUnderMount } from "@harbour/workspace";
import type { ModedChange, ModedFileEntry } from "@harbour/workspace/tree";

/** Chord's invocation context, as Pi Durable's environment methods take it. */
type Context = Parameters<ExecutionEnv["exec"]>[2];

export const DEFAULT_ROOT = "/workspace";
/** Commits tried before a write gives up on a head that keeps moving. */
const COMMIT_ATTEMPTS = 5;
/** Entries asked for per `Workspaces.list` page; implementations cap it. */
const LIST_PAGE = 1000;
/** Where temporary files and directories go, relative to the root. */
const TEMP_DIR = ".tmp";

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
	#mounts: Promise<readonly Mount[]> | undefined;

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
		this.id = `harbour:${options.workspaceId}`;
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

	// ---- reads -------------------------------------------------------------------------------------------------------

	async #read(call: CallContext, location: Location, version?: WorkspaceVersion): Promise<Uint8Array> {
		const options = location.kind === "workspace" && version !== undefined ? { version } : undefined;
		return (await this.#workspaces.read(call, this.#workspaceId, location.path, options)).content;
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
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const found = await this.fileInfo(path, context);
		if (found.ok) return ok(true);
		return found.error.code === "not_found" ? ok(false) : found;
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
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const directory = await this.#directory(path, context);
		if (!directory.ok) return directory;
		const { location, call } = directory.value;
		try {
			return ok((await this.#listAll(call, location)).map((entry) => this.#info(entry)));
		} catch (error) {
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const directory = await this.#directory(path, context);
		if (!directory.ok) return directory;
		const { location } = directory.value;
		let cursor: string | undefined;
		let done = false;
		let closed = false;
		const reader: DirReader = {
			next: async (maxEntries, nextContext) => {
				if (nextContext.abortSignal?.aborted === true) return err(new FileError("aborted", "aborted", path));
				if (closed) return err(new FileError("invalid", "Directory reader is closed", path));
				if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
					return err(new FileError("invalid", "maxEntries must be a positive safe integer", path));
				}
				if (done) return ok({ entries: [], done: true });
				const call = this.#call(nextContext);
				try {
					// Each page lists the head, so entries removed since the reader opened are skipped.
					const page = await this.#workspaces.list(call, this.#workspaceId, {
						limit: Math.min(maxEntries, LIST_PAGE),
						...(location.path === "" ? {} : { path: location.path }),
						...(cursor === undefined ? {} : { cursor }),
					});
					cursor = page.nextCursor;
					done = cursor === undefined;
					return ok({ entries: page.items.map((entry) => this.#info(entry)), done });
				} catch (error) {
					// The directory went away with its last file: nothing is left to list.
					if (isHarbourError(error, "not_found")) {
						done = true;
						return ok({ entries: [], done: true });
					}
					return err(await this.#fileError(error, location, path, call));
				}
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
	 * changes: nothing is committed.
	 */
	async #commit(
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
				if (!isHarbourError(error, "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
			}
		}
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const start = await this.#begin(path, context);
		if (!start.ok) return start;
		const { location, call } = start.value;
		if (isRoot(location)) return err(new FileError("is_directory", "cannot write the workspace root", path));
		try {
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
		try {
			await this.#commit(
				call,
				async (head) => {
					// Read at the version the commit is based on, so the append applies to exactly what it read.
					let before: Uint8Array = new Uint8Array();
					try {
						before = await this.#read(call, location, head);
					} catch (error) {
						if (!isHarbourError(error, "not_found")) throw error;
					}
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
		try {
			if (from.kind === to.kind && from.path === to.path) {
				// Renaming a path onto itself changes nothing, but the path must exist.
				await this.#stat(call, from);
				return ok(undefined);
			}
			if (from.kind === to.kind && to.path.startsWith(`${from.path}/`)) {
				return err(new FileError("invalid", `cannot move ${sourcePath} into itself`, destinationPath));
			}
			await this.#commit(
				call,
				async (head) => {
					const entry: ModedFileEntry = await this.#stat(call, from, head);
					const moved: ModedFileEntry[] =
						entry.kind === "file"
							? [entry]
							: (await this.#listAll(call, from, { recursive: true, version: head })).filter(
									(candidate) => candidate.kind === "file",
								);
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
			return ok(undefined);
		} catch (error) {
			if (isHarbourError(error, "not_found")) return err(toFileError(error, sourcePath));
			return err(await this.#fileError(error, to, destinationPath, call));
		}
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
			let entry: FileEntry | undefined;
			try {
				entry = await this.#stat(call, location);
			} catch (error) {
				if (!isHarbourError(error, "not_found")) throw error;
			}
			if (entry === undefined) {
				return options?.force === true ? ok(undefined) : err(new FileError("not_found", `no such file: ${path}`, path));
			}
			const kind = entry.kind;
			if (kind === "directory" && options?.recursive !== true) {
				return err(new FileError("is_directory", `is a directory: ${path}`, path));
			}
			await this.#commit(
				call,
				async (head) => {
					if (kind === "file") return [{ op: "delete", path: location.path }];
					const below = await this.#listAll(call, location, { recursive: true, version: head });
					return below
						.filter((candidate) => candidate.kind === "file")
						.map((candidate): ModedChange => ({ op: "delete", path: candidate.path }));
				},
				`remove ${location.path}`,
			);
			return ok(undefined);
		} catch (error) {
			if (options?.force === true && isHarbourError(error, "not_found")) return ok(undefined);
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
		// Directories are implicit: succeed unless the path, or one of its ancestors, is a file.
		if (isRoot(location)) return ok(undefined);
		try {
			const shape = await this.#shape(call, location);
			if (shape === "file" || shape === "not_directory") {
				return err(new FileError("not_directory", `a file is in the way: ${path}`, path));
			}
			return ok(undefined);
		} catch (error) {
			return err(await this.#fileError(error, location, path, call));
		}
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		if (context.abortSignal?.aborted === true) return err(new FileError("aborted", "aborted"));
		const name = `${prefix ?? "tmp-"}${crypto.randomUUID()}`;
		if (name.includes("/")) return err(new FileError("invalid", "a temporary directory prefix must not contain /"));
		// Directories are implicit, so the directory exists once something is written in it.
		return ok(this.#display({ kind: "workspace", path: `${TEMP_DIR}/${name}` }));
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const name = `${options?.prefix ?? ""}${crypto.randomUUID()}${options?.suffix ?? ""}`;
		if (name.includes("/"))
			return err(new FileError("invalid", "a temporary file prefix or suffix must not contain /"));
		const path = this.#display({ kind: "workspace", path: `${TEMP_DIR}/${name}` });
		const written = await this.writeFile(path, new Uint8Array(), context);
		return written.ok ? ok(path) : written;
	}

	async watch(): Promise<Result<FileWatcher, FileError>> {
		return err(new FileError("not_supported", "watch is not supported by Harbour workspaces", this.#root));
	}

	// ---- errors ------------------------------------------------------------------------------------------------------

	/**
	 * What is at a location: a file, a directory, missing, or `not_directory` when an ancestor is a file. Errors other
	 * than `not_found` propagate.
	 */
	async #shape(call: CallContext, location: Location): Promise<Shape> {
		if (isRoot(location)) return "directory";
		try {
			return (await this.#stat(call, location)).kind;
		} catch (error) {
			if (!isHarbourError(error, "not_found")) throw error;
		}
		if (location.kind === "workspace") {
			const segments = location.path.split("/");
			for (let depth = 1; depth < segments.length; depth++) {
				try {
					const ancestor = await this.#stat(call, { kind: "workspace", path: segments.slice(0, depth).join("/") });
					if (ancestor.kind === "file") return "not_directory";
				} catch (error) {
					if (!isHarbourError(error, "not_found")) throw error;
					break;
				}
			}
		}
		return "missing";
	}

	/** Maps an error to a `FileError`, telling an `invalid` directory or file-in-the-way apart from a bad path. */
	async #fileError(error: unknown, location: Location, path: string, call: CallContext): Promise<FileError> {
		if (isHarbourError(error, "invalid")) {
			let shape: Shape | undefined;
			try {
				shape = await this.#shape(call, location);
			} catch {
				// Keep the original error.
			}
			if (shape === "directory") return new FileError("is_directory", `is a directory: ${path}`, path, error);
			if (shape === "not_directory") return new FileError("not_directory", `not a directory: ${path}`, path, error);
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
		// Checked again: the signal may have fired while the working directory was being resolved.
		if (isAborted(signal)) return err(new ExecutionError("aborted", "aborted"));

		// The sandbox sees a signal that aborts when this call is aborted or times out.
		const controller = new AbortController();
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
			signal,
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
		try {
			if (result.stdout !== "") options?.onOutput?.(result.stdout, context, { stream: "stdout" });
			if (result.stderr !== "") options?.onOutput?.(result.stderr, context, { stream: "stderr" });
		} catch (error) {
			return err(new ExecutionError("callback_error", errorMessage(error), asError(error)));
		}
		return ok({ exitCode: result.exitCode });
	}

	async cleanup(_context: Context): Promise<void> {
		// Nothing to stop here: a session's leases end with the session (`Sandboxes.releaseSession`).
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

/** Waits for `work`, an abort of `signal`, or `timeoutMs`, whichever comes first. */
/** Read through a call so a check after an `await` is not narrowed away by an earlier one. */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

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

function executionError(error: unknown): ExecutionError {
	if (isHarbourError(error, "aborted")) return new ExecutionError("aborted", error.message, error);
	if (isHarbourError(error, "unavailable")) return new ExecutionError("shell_unavailable", error.message, error);
	return new ExecutionError("unknown", errorMessage(error), asError(error));
}

function fileErrorCode(error: unknown): FileErrorCode {
	if (!isHarbourError(error)) return "unknown";
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
