/**
 * The isolate tier's shell: just-bash over a lazy view of one workspace version and its read-only mounts. Ported from
 * the Cloudflare spike (spikes/cloudflare/src/isolate/shell.ts and port.ts).
 *
 * The shell reads storage only through a `WorkspacePort`, so the same code runs in this process (the in-process
 * backend below), in a Dynamic Worker behind a gateway, or under a container simulator in tests. Bodies are fetched on
 * first read and cached by digest. After the command, the paths it touched are compared with the version it started
 * from, and the differences come back as changes for the caller to commit (the tiered sandboxes commit them at once).
 *
 * Mounts are read-only: each mount is its own filesystem under just-bash's MountableFs, and every write method on it
 * fails with `Read-only file system`, however the write is reached (directly, or inside a recursive `cp` or `mv`).
 * Nothing under a mount is ever collected.
 */
import type { CallContext, FileEntry, Mount, WorkspaceId } from "@harbour/contracts";
import { listAll, type ModedChange, type ModedFileEntry, type StoredWorkspaces } from "@harbour/workspace/stored";
import { Bash, type CustomCommand, type IFileSystem, InMemoryFs, MountableFs } from "just-bash/browser";
import type { BackendExec, BackendOutput, IsolateBackend } from "./tiered.ts";

export const ROOT = "/workspace";
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;
/** Workspace versions whose listings the in-process backend keeps. */
const ENTRY_CACHE_VERSIONS = 64;

/** What the shell needs from storage, for one workspace. A gateway can serve it over RPC. */
export interface WorkspacePort {
	/** Every workspace entry at `version`. */
	entries(version: number): Promise<readonly ModedFileEntry[]>;
	/** Every entry under the mount point `path` (absolute paths). */
	mountEntries(path: string): Promise<readonly FileEntry[]>;
	/** A workspace body by digest. */
	readBlob(digest: string): Promise<Uint8Array>;
	/** A body under a mount, by absolute path. */
	readMount(path: string): Promise<Uint8Array>;
}

export interface ShellRequest {
	readonly command: string | readonly string[];
	readonly baseVersion: number;
	readonly mounts: readonly Pick<Mount, "path">[];
	/** Relative to the workspace root. */
	readonly cwd?: string;
	readonly env?: { readonly [name: string]: string };
	readonly stdin?: string;
	readonly timeoutMs?: number;
}

/** Uncommitted changes a caller keeps across commands (a container simulator); applied over the base version. */
export type Overlay = ReadonlyMap<string, { readonly content: Uint8Array; readonly mode: number } | null>;

export interface ShellOutcome {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Differences from the base version (overlay included), for the caller to commit. */
	readonly changes: ModedChange[];
	readonly timings: Record<string, number>;
}

/** Bodies by digest, kept for the life of the isolate. */
export class BlobCache {
	readonly #blobs = new Map<string, Uint8Array>();
	#bytes = 0;
	get(digest: string): Uint8Array | undefined {
		return this.#blobs.get(digest);
	}
	set(digest: string, bytes: Uint8Array): void {
		if (this.#bytes + bytes.byteLength > BLOB_CACHE_BYTES) {
			this.#blobs.clear();
			this.#bytes = 0;
		}
		this.#blobs.set(digest, bytes);
		this.#bytes += bytes.byteLength;
	}
}

export interface ShellOptions {
	readonly cache?: BlobCache;
	readonly overlay?: Overlay;
	/** Extra programs, such as a `git` stand-in for a container simulator. */
	readonly commands?: readonly CustomCommand[];
	/** Entries by version, cached by the caller (versions are immutable). */
	readonly entries?: (version: number) => Promise<readonly ModedFileEntry[]>;
}

const WRITE_FIRST_ARG = new Set(["writeFile", "appendFile", "mkdir", "rm", "chmod", "createExclusive", "utimes", "mv"]);
const WRITE_SECOND_ARG = new Set(["cp", "mv", "link", "symlink"]);
const MOUNT_WRITES = new Set([...WRITE_FIRST_ARG, ...WRITE_SECOND_ARG]);
const SYNC_WRITES = new Set(["writeFileSync", "mkdirSync"]);
/** Where just-bash keeps its own files (command stubs, devices): a mount there would shadow or be written by it. */
const RESERVED = ["/bin", "/usr", "/dev", "/proc", ROOT];

/** A mount's filesystem: reads pass through; every write method fails, naming the absolute path. */
function readOnlyMount(inner: InMemoryFs, point: string): IFileSystem {
	return new Proxy(inner, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			if (MOUNT_WRITES.has(String(property))) {
				return (...args: unknown[]) => {
					const path = typeof args[0] === "string" ? args[0] : "/";
					return Promise.reject(new ReadOnlyError(path === "/" ? point : `${point}${path}`));
				};
			}
			if (SYNC_WRITES.has(String(property))) {
				return (...args: unknown[]) => {
					const path = typeof args[0] === "string" ? args[0] : "/";
					throw new ReadOnlyError(path === "/" ? point : `${point}${path}`);
				};
			}
			return (value as (...a: unknown[]) => unknown).bind(target);
		},
	}) as unknown as IFileSystem;
}

class ReadOnlyError extends Error {
	readonly code = "EROFS";
	constructor(readonly path: string) {
		super(`EROFS: Read-only file system, open '${path}'`);
	}
}

export async function runShell(
	port: WorkspacePort,
	request: ShellRequest,
	options: ShellOptions = {},
): Promise<ShellOutcome> {
	const timings: Record<string, number> = {};
	let at = performance.now();
	const mark = (phase: string) => {
		const now = performance.now();
		timings[phase] = Math.round((now - at) * 10) / 10;
		at = now;
	};
	const cache = options.cache ?? new BlobCache();
	const overlay = options.overlay ?? new Map();
	const entries = await (options.entries ?? ((version) => port.entries(version)))(request.baseVersion);
	const base = new Map(entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]));
	mark("isolate.manifest");

	// The workspace and everything outside the mounts; each mount gets its own read-only filesystem below.
	const fs = new InMemoryFs({});
	await fs.mkdir(ROOT, { recursive: true });
	const blob = async (digest: string) => {
		const cached = cache.get(digest);
		if (cached !== undefined) return cached;
		const bytes = await port.readBlob(digest);
		cache.set(digest, bytes);
		return bytes;
	};
	for (const entry of base.values()) {
		if (overlay.has(entry.path)) continue;
		const digest = entry.digest ?? "";
		fs.writeFileLazy(`${ROOT}/${entry.path}`, () => blob(digest), { mode: entry.mode ?? 0o644 });
	}
	for (const [path, change] of overlay) {
		if (change !== null) await fs.writeFile(`${ROOT}/${path}`, change.content, { mode: change.mode } as never);
	}
	const mountPoints = request.mounts.map((mount) => mount.path);
	const clash = mountPoints.find((point) =>
		RESERVED.some(
			(reserved) => point === reserved || point.startsWith(`${reserved}/`) || reserved.startsWith(`${point}/`),
		),
	);
	if (clash !== undefined) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: `harbour: the isolate cannot mount ${clash}: it overlaps the shell's own paths (${RESERVED.join(", ")})\n`,
			changes: [],
			timings,
		};
	}
	const mounts: { mountPoint: string; filesystem: IFileSystem }[] = [];
	for (const point of mountPoints) {
		const inner = new InMemoryFs({});
		for (const entry of await port.mountEntries(point)) {
			const inside = entry.path.slice(point.length) || "/";
			if (entry.kind === "directory") await inner.mkdir(inside, { recursive: true });
			else inner.writeFileLazy(inside, () => port.readMount(entry.path), { mode: 0o444 });
		}
		mounts.push({ mountPoint: point, filesystem: readOnlyMount(inner, point) });
	}
	const view: IFileSystem = mounts.length === 0 ? fs : new MountableFs({ base: fs, mounts });
	const underMount = (path: unknown) =>
		typeof path === "string" && mountPoints.some((point) => path === point || path.startsWith(`${point}/`));

	const touched = new Set<string>([...overlay.keys()].map((path) => `${ROOT}/${path}`));
	const tracked = new Proxy(view, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			const name = String(property);
			return (...args: unknown[]) => {
				const writes = [
					...(WRITE_FIRST_ARG.has(name) ? [args[0]] : []),
					...(WRITE_SECOND_ARG.has(name) ? [args[1]] : []),
				];
				const refused = writes.find(underMount);
				if (refused !== undefined) return Promise.reject(new ReadOnlyError(String(refused)));
				const apply = () => (value as (...a: unknown[]) => unknown).apply(target, args);
				if (writes.length === 0) return apply();
				// Record where the write really lands now, while any symlink on its way still exists: a command may remove
				// the link afterwards (`ln -s real alias && mktemp alias/t.XXX && rm alias`).
				return (async () => {
					for (const path of writes) {
						if (typeof path !== "string") continue;
						touched.add(path);
						for (const resolved of await destinations(target, path)) touched.add(resolved);
					}
					return apply();
				})();
			};
		},
	});
	const cwd = request.cwd === undefined || request.cwd === "" ? ROOT : `${ROOT}/${request.cwd}`;
	const bash = new Bash({
		fs: tracked,
		cwd,
		env: { HOME: ROOT, USER: "harbour", ...request.env },
		// just-bash's own allow-list is off on purpose: the vault is the policy point for egress, and the private-range
		// check needs DNS pinning, which Workers cannot do. Its default turns on when `process` exists, so it is set
		// explicitly.
		network: { dangerouslyAllowFullInternetAccess: true, denyPrivateRanges: false },
		...(options.commands === undefined ? {} : { customCommands: [...options.commands] }),
	});
	const controller = new AbortController();
	const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), request.timeoutMs);
	const command = typeof request.command === "string" ? request.command : request.command.map(shellQuote).join(" ");
	let result: { stdout: string; stderr: string; exitCode: number };
	try {
		result = await bash.exec(command, {
			signal: controller.signal,
			rawScript: true,
			...(request.stdin === undefined ? {} : { stdin: request.stdin }),
		});
	} catch (error) {
		// A redirection onto a read-only mount escapes just-bash as an exception; it fails the command, as in sh.
		if (!(error instanceof ReadOnlyError)) throw error;
		result = { stdout: "", stderr: `bash: ${error.path}: Read-only file system\n`, exitCode: 1 };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	mark("isolate.exec");
	const changes = await collectChanges(fs, base, touched, underMount, cache);
	mark("isolate.scan");
	return {
		exitCode: controller.signal.aborted ? 124 : result.exitCode,
		stdout: result.stdout,
		stderr: controller.signal.aborted ? `${result.stderr}timed out after ${request.timeoutMs} ms\n` : result.stderr,
		changes,
		timings,
	};
}

/** The real paths a write to `path` can land at: through a symlinked parent, or into a symlinked directory. */
async function destinations(fs: IFileSystem, path: string): Promise<string[]> {
	const clean = path.replace(/\/+$/, "");
	const found: string[] = [];
	try {
		found.push(await fs.realpath(clean));
	} catch {
		// Does not exist yet: resolve its parent below.
	}
	const slash = clean.lastIndexOf("/");
	if (slash > 0) {
		try {
			found.push(`${await fs.realpath(clean.slice(0, slash))}/${clean.slice(slash + 1)}`);
		} catch {
			// No parent: the write fails on its own.
		}
	}
	return found;
}

async function collectChanges(
	fs: InMemoryFs,
	base: ReadonlyMap<string, ModedFileEntry>,
	touched: ReadonlySet<string>,
	underMount: (path: unknown) => boolean,
	cache: BlobCache,
): Promise<ModedChange[]> {
	// A write through a symlinked parent lands at the resolved path, so track that too.
	const resolved = new Set<string>();
	for (const path of touched) {
		resolved.add(path);
		const clean = path.replace(/\/+$/, "");
		const slash = clean.lastIndexOf("/");
		if (slash <= 0) continue;
		try {
			resolved.add(`${await fs.realpath(clean.slice(0, slash))}/${clean.slice(slash + 1)}`);
		} catch {
			// The parent is gone (removed by the command): nothing to resolve.
		}
	}
	const prefixes = [...resolved].map((path) => path.replace(/\/+$/, ""));
	const isTouched = (absolute: string) =>
		prefixes.some((prefix) => absolute === prefix || absolute.startsWith(`${prefix}/`));

	const changes: ModedChange[] = [];
	const present = new Set<string>();
	for (const absolute of fs.getAllPaths()) {
		const path = relative(absolute);
		if (path === undefined || path === "" || underMount(absolute) || !isTouched(absolute)) continue;
		const stat = await fs.lstat(absolute);
		if (!stat.isFile) continue;
		present.add(path);
		const bytes = await fs.readFileBuffer(absolute);
		const mode = stat.mode & 0o777;
		const previous = base.get(path);
		if (previous !== undefined && (previous.mode ?? 0o644) === mode) {
			const digest = await sha256Hex(bytes);
			if (digest === previous.digest) continue;
			cache.set(digest, bytes);
		}
		changes.push({ op: "put", path, content: bytes, mode });
	}
	// An overlay put that the command then removed is not in the base: nothing to delete, nothing to put.
	for (const path of base.keys()) {
		if (present.has(path)) continue;
		if (!(await fs.exists(`${ROOT}/${path}`))) changes.push({ op: "delete", path });
	}
	return changes;
}

function relative(path: string): string | undefined {
	if (path === ROOT) return "";
	return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : undefined;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
	let hex = "";
	for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

export function shellQuote(word: string): string {
	return /^[A-Za-z0-9_./=:@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface WorkspacePortOptions {
	/** Listings by version; when absent each call lists the version afresh. */
	readonly entries?: (version: number) => Promise<readonly ModedFileEntry[]>;
}

/**
 * The shell's read-only view of one workspace at `version`, over stored workspaces with the caller's context: bodies
 * through `readBlob` at that version, mounts through `list` and `read` with absolute paths. It can list and read,
 * never write: the shell's changes go back to the sandboxes, which commit them.
 */
export function createWorkspacePort(
	workspaces: StoredWorkspaces,
	ctx: CallContext,
	id: WorkspaceId,
	version: number,
	options: WorkspacePortOptions = {},
): WorkspacePort {
	return {
		async entries(at: number): Promise<readonly ModedFileEntry[]> {
			return options.entries === undefined ? listAll(workspaces, ctx, id, { version: at }) : options.entries(at);
		},
		async mountEntries(path: string): Promise<readonly FileEntry[]> {
			if (!path.startsWith("/")) throw new Error("mountEntries takes an absolute mount point");
			return listAll(workspaces, ctx, id, { path });
		},
		async readBlob(digest: string): Promise<Uint8Array> {
			return workspaces.readBlob(ctx, id, digest, { version });
		},
		async readMount(path: string): Promise<Uint8Array> {
			if (!path.startsWith("/")) throw new Error("readMount takes an absolute path under a mount");
			return (await workspaces.read(ctx, id, path)).content;
		},
	};
}

export interface InProcessIsolateOptions {
	/** Bodies by digest; one per backend when absent. */
	readonly cache?: BlobCache;
	/** Extra programs for the shell. */
	readonly commands?: readonly CustomCommand[];
	/** Workspace versions whose listings are kept (default 64). */
	readonly entryCacheVersions?: number;
}

/**
 * An isolate backend that runs the shell in this process over stored workspaces. Listings are cached per workspace
 * version (versions are immutable), and bodies by digest. Every read goes through the caller's context, so the
 * workspace's own access checks apply; a cached listing is reused only for a workspace and version the sandboxes have
 * just read with that caller's context.
 */
export function createInProcessIsolateBackend(
	workspaces: StoredWorkspaces,
	options: InProcessIsolateOptions = {},
): IsolateBackend {
	const cache = options.cache ?? new BlobCache();
	const limit = options.entryCacheVersions ?? ENTRY_CACHE_VERSIONS;
	const listings = new Map<string, Promise<readonly ModedFileEntry[]>>();

	function cachedEntries(ctx: CallContext, id: WorkspaceId) {
		return (version: number): Promise<readonly ModedFileEntry[]> => {
			const key = `${ctx.organisationId}\u0000${id}\u0000${version}`;
			const cached = listings.get(key);
			if (cached !== undefined) {
				// Most recently used last.
				listings.delete(key);
				listings.set(key, cached);
				return cached;
			}
			const listing = listAll(workspaces, ctx, id, { version });
			// A failed listing is not kept, so the next command tries again.
			listing.catch(() => listings.delete(key));
			listings.set(key, listing);
			for (const oldest of listings.keys()) {
				if (listings.size <= limit) break;
				listings.delete(oldest);
			}
			return listing;
		};
	}

	return {
		async exec({ ctx, lease, record, request }: BackendExec): Promise<BackendOutput> {
			const entries = cachedEntries(ctx, lease.workspaceId);
			const port = createWorkspacePort(workspaces, ctx, lease.workspaceId, record.head, { entries });
			return runShell(
				port,
				{ ...request, baseVersion: record.head, mounts: record.mounts },
				{ cache, entries, ...(options.commands === undefined ? {} : { commands: options.commands }) },
			);
		},
	};
}
