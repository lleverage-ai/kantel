/**
 * Tree, paging and access helpers shared by every `Workspaces` implementation (memory, and the stored workspaces every
 * target builds on), so all of them answer alike. A tree maps normalised relative paths to file entries; directories
 * are derived from file paths.
 */
import {
	type CallContext,
	type FileContent,
	type FileEntry,
	KantelError,
	type Mount,
	type MountRequest,
	type MountSource,
	type OwnerRef,
	type Page,
	type ProjectAccess,
	type ProjectId,
	type Role,
	type SeedReadiness,
	type SeedSpec,
	type SessionId,
	type WorkspaceChange,
	type WorkspaceId,
	type WorkspaceRecord,
} from "@kantel/contracts";
import { findMount, isUnderMount, normalizeMountPoint, normalizeWorkspacePath, sha256Hex, toBytes } from "./index.ts";

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 1000;

/** What a tree keeps per file: enough to list and stat without reading the body. */
export interface TreeFile {
	readonly digest: string;
	readonly size: number;
	/** The version that last changed the file. */
	readonly version: number;
	/** POSIX permission bits, when a tier recorded them (an executable stays executable across tiers). */
	readonly mode?: number;
}

export type Tree<F extends TreeFile = TreeFile> = ReadonlyMap<string, F>;

/** A `FileEntry` that may carry the POSIX mode bits a tier recorded. The contract has no mode yet. */
export type ModedFileEntry = FileEntry & { readonly mode?: number };

/** A put that may carry mode bits; the contract's `WorkspaceChange` has none. */
export type ModedChange = WorkspaceChange & { readonly mode?: number };

export type PreparedChange =
	| {
			readonly op: "put";
			readonly path: string;
			readonly content: Uint8Array;
			readonly digest: string;
			readonly mode?: number;
	  }
	| { readonly op: "delete"; readonly path: string };

/** Normalises and hashes `changes`; rejects a path changed twice, a bad path or an unknown op with `invalid`. */
export async function prepareChanges(changes: readonly ModedChange[]): Promise<PreparedChange[]> {
	const seen = new Set<string>();
	const prepared: PreparedChange[] = [];
	for (const change of changes) {
		const path = normalizeWorkspacePath(change.path);
		if (seen.has(path)) throw new KantelError("invalid", `${path} is changed twice in one commit`, { path });
		seen.add(path);
		if (change.op === "delete") {
			prepared.push({ op: "delete", path });
		} else if (change.op === "put") {
			const content = toBytes(change.content);
			const mode = typeof change.mode === "number" ? change.mode & 0o777 : undefined;
			prepared.push({
				op: "put",
				path,
				content,
				digest: await sha256Hex(content),
				...(mode === undefined ? {} : { mode }),
			});
		} else {
			throw new KantelError("invalid", "a change is a put or a delete", { path });
		}
	}
	return prepared;
}

/**
 * A new tree with `changes` applied, each put stored as `make` builds it; rejects without changing `base`: a delete of a
 * missing path is `not_found`, and a path that would be both a file and a directory is `invalid`.
 */
export function applyChanges<F extends TreeFile>(
	base: Tree<F>,
	changes: readonly PreparedChange[],
	make: (change: Extract<PreparedChange, { op: "put" }>, previous: F | undefined) => F,
): Map<string, F> {
	const tree = new Map(base);
	for (const change of changes) {
		if (change.op === "delete") {
			if (!tree.delete(change.path)) {
				throw new KantelError("not_found", `${change.path} not found`, { path: change.path });
			}
		} else {
			tree.set(change.path, make(change, tree.get(change.path)));
		}
	}
	const shape = treeShapeConflict(tree.keys());
	if (shape !== undefined) throw new KantelError("invalid", shape);
	return tree;
}

/** Describes the first path that is both a file and a directory, or undefined when the tree is well formed. */
export function treeShapeConflict(paths: Iterable<string>): string | undefined {
	const files = new Set(paths);
	for (const path of files) {
		for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
			const parent = path.slice(0, slash);
			if (files.has(parent)) return `${parent} is a file, so ${path} cannot be under it`;
		}
	}
	return undefined;
}

/** Entries in `dir` (`""` is the root); directories derive from file paths and carry their newest file version. */
export function treeEntries<V extends number | string>(
	tree: Tree,
	dir: string,
	recursive: boolean,
	version: (stored: number) => V,
): ModedFileEntry[] {
	if (dir !== "" && tree.has(dir)) throw new KantelError("invalid", `${dir} is a file`, { path: dir });
	const prefix = dir === "" ? "" : `${dir}/`;
	const files: ModedFileEntry[] = [];
	const directories = new Map<string, number>();
	let found = dir === "";
	for (const [path, file] of tree) {
		if (!path.startsWith(prefix)) continue;
		found = true;
		const rest = path.slice(prefix.length).split("/");
		const depth = recursive ? rest.length - 1 : Math.min(rest.length - 1, 1);
		for (let level = 1; level <= depth; level++) {
			const directory = prefix + rest.slice(0, level).join("/");
			directories.set(directory, Math.max(directories.get(directory) ?? 0, file.version));
		}
		if (recursive || rest.length === 1) files.push(fileEntry(path, file, version));
	}
	if (!found) throw new KantelError("not_found", `${dir} not found`, { path: dir });
	for (const [path, newest] of directories) files.push({ path, kind: "directory", size: 0, version: version(newest) });
	return files;
}

export function statTree<V extends number | string>(
	tree: Tree,
	path: string,
	version: (stored: number) => V,
): ModedFileEntry {
	const file = tree.get(path);
	if (file !== undefined) return fileEntry(path, file, version);
	let newest: number | undefined;
	for (const [candidate, stored] of tree) {
		if (candidate.startsWith(`${path}/`)) newest = Math.max(newest ?? 0, stored.version);
	}
	if (newest === undefined) throw new KantelError("not_found", `${path} not found`, { path });
	return { path, kind: "directory", size: 0, version: version(newest) };
}

/** The file at `path`; `invalid` for a directory, `not_found` otherwise. */
export function readTree<F extends TreeFile>(tree: Tree<F>, path: string): F {
	const file = tree.get(path);
	if (file !== undefined) return file;
	for (const candidate of tree.keys()) {
		if (candidate.startsWith(`${path}/`)) throw new KantelError("invalid", `${path} is a directory`, { path });
	}
	throw new KantelError("not_found", `${path} not found`, { path });
}

export function fileEntry<V extends number | string>(
	path: string,
	file: TreeFile,
	version: (stored: number) => V,
): ModedFileEntry {
	return {
		path,
		kind: "file",
		size: file.size,
		digest: file.digest,
		version: version(file.version),
		...(file.mode === undefined ? {} : { mode: file.mode }),
	};
}

/** Lists a mount through its source, with paths rewritten under the mount point. */
export async function listMount(
	ctx: CallContext,
	source: MountSource,
	mount: Mount,
	sourcePath: string,
	recursive: boolean,
): Promise<FileEntry[]> {
	const entries: FileEntry[] = [];
	const pending = [sourcePath];
	for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
		for (const entry of await source.list(ctx, mount.ref, mount.version, dir)) {
			entries.push({ ...entry, path: `${mount.path}/${entry.path}` });
			if (recursive && entry.kind === "directory") pending.push(entry.path);
		}
	}
	return entries;
}

/** The mountable sources of a workspace implementation, one per kind. */
export interface MountSources {
	sourceFor(kind: MountSource["kind"]): MountSource;
	/** Pins `request` to its version, or to the source's latest; checks a given version exists by listing its root. */
	resolve(ctx: CallContext, request: MountRequest): Promise<Mount>;
	/** Stats an absolute path under `mount`. */
	stat(ctx: CallContext, mount: Mount, sourcePath: string, path: string): Promise<FileEntry>;
	/** Reads an absolute path under `mount`. */
	read(ctx: CallContext, mount: Mount, sourcePath: string, path: string): Promise<FileContent>;
}

export function mountSources(sources: readonly MountSource[] = []): MountSources {
	const byKind = new Map<MountSource["kind"], MountSource>();
	for (const source of sources) {
		if (byKind.has(source.kind)) throw new KantelError("invalid", `two mount sources of kind ${source.kind}`);
		byKind.set(source.kind, source);
	}
	const sourceFor = (kind: MountSource["kind"]): MountSource => {
		const source = byKind.get(kind);
		if (source === undefined) throw new KantelError("invalid", `no mount source of kind ${kind}`);
		return source;
	};
	return {
		sourceFor,
		async resolve(ctx, request) {
			const path = normalizeMountPoint(request.path);
			const source = sourceFor(request.source);
			let version = request.version;
			if (version === undefined) version = await source.latestVersion(ctx, request.ref);
			// Listing the root checks that the pinned version exists.
			else await source.list(ctx, request.ref, version, "");
			return { path, source: request.source, ref: request.ref, version, readOnly: true };
		},
		async stat(ctx, mount, sourcePath, path) {
			if (sourcePath === "") return { path: mount.path, kind: "directory", size: 0, version: mount.version };
			const parent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
			const siblings = await sourceFor(mount.source).list(ctx, mount.ref, mount.version, parent);
			const entry = siblings.find((candidate) => candidate.path === sourcePath);
			if (entry === undefined) throw new KantelError("not_found", `${path} not found`, { path });
			return { ...entry, path: `${mount.path}/${entry.path}` };
		},
		async read(ctx, mount, sourcePath, path) {
			if (sourcePath === "") throw new KantelError("invalid", `${path} is a directory`, { path });
			const content = toBytes(await sourceFor(mount.source).read(ctx, mount.ref, mount.version, sourcePath));
			return { path, content, version: mount.version, digest: await sha256Hex(content) };
		},
	};
}

/** The mount an absolute path reads; `invalid` when it is under no mount. */
export function mountAt(record: WorkspaceRecord, path: string): { mount: Mount; sourcePath: string } {
	const found = findMount(path, record.mounts);
	if (found === undefined) throw new KantelError("invalid", `${path} is absolute and under no mount`, { path });
	return found;
}

/** The project a workspace is scoped to, through a project owner, a session, or both; undefined when neither. */
export function projectScope(
	owner: OwnerRef,
	sessionId: SessionId | undefined,
): { readonly projectId?: ProjectId; readonly sessionId?: SessionId } | undefined {
	const projectId = owner.kind === "project" ? owner.projectId : undefined;
	if (projectId === undefined && sessionId === undefined) return undefined;
	return {
		...(projectId === undefined ? {} : { projectId }),
		...(sessionId === undefined ? {} : { sessionId }),
	};
}

/** An `org-files` ref names the caller's own organisation; any other is `not_found`. */
export function checkOrgFilesRef(ctx: CallContext, ref: string): void {
	if (typeof ref !== "string" || ref === "") throw new KantelError("invalid", "an org-files ref is an organisation ID");
	if (ref !== ctx.organisationId) throw new KantelError("not_found", "organisation files not found");
}

export function checkOwner(ctx: CallContext, owner: OwnerRef): void {
	if (owner.kind !== "platform" && owner.organisationId !== ctx.organisationId) {
		throw new KantelError("forbidden", "a workspace's owner must be in the calling organisation");
	}
}

export function checkMountsDisjoint(mounts: readonly Mount[]): void {
	for (const mount of mounts) {
		const others = mounts.filter((other) => other !== mount);
		if (isUnderMount(mount.path, others)) {
			throw new KantelError("invalid", `mount ${mount.path} overlaps another mount`, { path: mount.path });
		}
	}
}

/** Seed `files` sources are applied at create; a workspace whose seed has other sources waits at `metadata`. */
export function seedReadiness(seed: SeedSpec | undefined): SeedReadiness {
	return seed?.sources.some((source) => source.kind !== "files") === true ? "metadata" : "files";
}

/** The seed's `files` sources, normalised, later sources winning; rejects a tree that is not well formed. */
export function seedFiles(seed: SeedSpec | undefined): Map<string, string> {
	const files = new Map<string, string>();
	for (const source of seed?.sources ?? []) {
		if (source.kind !== "files") continue;
		for (const [path, content] of Object.entries(source.files)) files.set(normalizeWorkspacePath(path), content);
	}
	const shape = treeShapeConflict(files.keys());
	if (shape !== undefined) throw new KantelError("invalid", shape);
	return files;
}

/** Seed mounts and input mounts merged by mount point, the input winning. */
export function mountRequests(
	seed: SeedSpec | undefined,
	mounts: readonly MountRequest[] | undefined,
): Map<string, MountRequest> {
	const requests = new Map<string, MountRequest>();
	for (const request of [...(seed?.mounts ?? []), ...(mounts ?? [])]) requests.set(request.path, request);
	return requests;
}

/** Checks the prefixes `export` takes: relative workspace prefixes such as `notes/`. */
export function checkExportPrefixes(prefixes: readonly string[]): void {
	for (const prefix of prefixes) {
		if (typeof prefix !== "string" || prefix.startsWith("/") || prefix.includes("\\")) {
			throw new KantelError("invalid", "export prefixes are relative workspace prefixes such as notes/", {
				prefix: String(prefix),
			});
		}
	}
}

/**
 * Rejects with `refused` an export whose bodies add up to more than `maxBytes`, from sizes the tree already holds, so
 * the check reads no body. Absent `maxBytes` allows any size.
 */
export function checkExportSize(sizes: Iterable<number>, maxBytes: number | undefined): void {
	if (maxBytes === undefined) return;
	if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new KantelError("invalid", "maxBytes must be a size in bytes");
	let bytes = 0;
	for (const size of sizes) bytes += size;
	if (bytes > maxBytes) {
		throw new KantelError("refused", `the export is ${bytes} bytes, over the ${maxBytes} allowed`, {
			maxBytes,
			bytes,
		});
	}
}

/**
 * Rejects with `refused` a file read of more than `maxBytes` (`Workspaces.read`'s option), from the size the tree or the
 * read already holds. Absent `maxBytes` allows any size.
 */
export function checkReadSize(path: string, bytes: number, maxBytes: number | undefined): void {
	if (maxBytes === undefined) return;
	if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new KantelError("invalid", "maxBytes must be a size in bytes");
	if (bytes > maxBytes) {
		throw new KantelError("refused", `${path} is ${bytes} bytes, over the ${maxBytes} allowed`, {
			path,
			maxBytes,
			bytes,
		});
	}
}

/** Rejects with `aborted` when the caller's signal fired: a commit checks it just before it moves the head. */
export function requireNotAborted(ctx: CallContext): void {
	if (ctx.signal?.aborted === true) {
		throw new KantelError("aborted", "the call was cancelled before the commit moved the head; nothing was committed");
	}
}

export function pageLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_PAGE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw new KantelError("invalid", "limit must be a positive integer");
	return Math.min(limit, MAX_PAGE_LIMIT);
}

export function pageByPath<T extends FileEntry>(
	entries: readonly T[],
	after: string | undefined,
	limit: number,
): Page<T> {
	const start = after === undefined ? 0 : entries.findIndex((entry) => compare(entry.path, after) > 0);
	const remaining = start < 0 ? [] : entries.slice(start);
	const items = remaining.slice(0, limit);
	const last = items.at(-1);
	return remaining.length > limit && last !== undefined ? { items, nextCursor: encodeCursor(last.path) } : { items };
}

export function encodeCursor(after: string): string {
	return btoa(encodeURIComponent(JSON.stringify({ after })));
}

export function decodeCursor(cursor: string | undefined): string | undefined {
	if (cursor === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(atob(cursor)));
		if (typeof parsed === "object" && parsed !== null && typeof (parsed as { after?: unknown }).after === "string") {
			return (parsed as { after: string }).after;
		}
	} catch {
		// Falls through to the error below.
	}
	throw new KantelError("invalid", "bad cursor");
}

/** Code-unit order, the order listings and exports use. */
export function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The project-access checks every workspace runs (settled questions 7 and 11). Without `access` they check nothing
 * beyond the organisation lookup the caller already did.
 */
export interface WorkspaceAccessChecks {
	/** Requires `needed` on the workspace's project, when its owner or session ties it to one. */
	requireWorkspace(ctx: CallContext, record: WorkspaceRecord, needed: Role, operation: string): Promise<void>;
	/**
	 * Requires viewer on the project a `project-files` mount's files come from, on every read through it. Nothing is
	 * cached: a role revoked since the last read refuses the next one.
	 */
	requireMountRead(ctx: CallContext, record: WorkspaceRecord, mount: Mount): Promise<void>;
	/**
	 * Requires viewer on the project each `project-files` mount names in its `ref`, and that each `org-files` mount names
	 * the caller's organisation.
	 */
	requireMounts(
		ctx: CallContext,
		requests: Iterable<MountRequest>,
		subject?: { readonly kind: "workspace"; readonly id: WorkspaceId },
	): Promise<void>;
	/** Requires operator on the project a new workspace is scoped to. */
	requireCreate(ctx: CallContext, owner: OwnerRef, sessionId: SessionId | undefined): Promise<void>;
}

export function workspaceAccess(access: ProjectAccess | undefined): WorkspaceAccessChecks {
	return {
		async requireWorkspace(ctx, record, needed, operation) {
			const scope = projectScope(record.owner, record.sessionId);
			if (access === undefined || scope === undefined) return;
			const subject = { kind: "workspace", id: record.id } as const;
			// A project's workspace not bound to a session may be shared (docs/design/sharing.md): reading needs `use`,
			// anything more `edit`, which an agent holds only through a share that lets agents write (`agentWrites`).
			if (
				record.owner.kind === "project" &&
				record.sessionId === undefined &&
				!(await access.allows(ctx, { ...scope, needed }))
			) {
				await access.resource(ctx, {
					resource: subject,
					owner: record.owner,
					permission: needed === "viewer" ? "use" : "edit",
					needed,
					operation,
				});
				return;
			}
			await access.require(ctx, { ...scope, needed, operation, subject });
		},
		async requireMountRead(ctx, record, mount) {
			// Organisation files are open to the organisation's members: the workspace check above is the caller's, and
			// the ref must still be the caller's organisation (docs/design/org-scope.md).
			if (mount.source === "org-files") return checkOrgFilesRef(ctx, mount.ref);
			if (access === undefined || mount.source !== "project-files") return;
			await access.require(ctx, {
				projectId: mount.ref,
				needed: "viewer",
				operation: "workspace.mount.read",
				subject: { kind: "workspace", id: record.id },
			});
		},
		async requireMounts(ctx, requests, subject) {
			for (const request of requests) {
				if (request.source === "org-files") checkOrgFilesRef(ctx, request.ref);
				if (access === undefined || request.source !== "project-files") continue;
				await access.require(ctx, {
					projectId: request.ref,
					needed: "viewer",
					operation: "workspace.mount",
					...(subject === undefined ? {} : { subject }),
				});
			}
		},
		async requireCreate(ctx, owner, sessionId) {
			const scope = projectScope(owner, sessionId);
			if (access === undefined || scope === undefined) return;
			await access.require(ctx, { ...scope, needed: "operator", operation: "workspace.create" });
		},
	};
}
