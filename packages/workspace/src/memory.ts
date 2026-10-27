/**
 * In-memory workspaces and project files, for tests and local runs. Versions are immutable maps (copy-on-write).
 * `git` and `objects` seed sources are recorded but not fetched.
 */
import {
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	type CommitRequest,
	type CommitResult,
	type FileContent,
	type FileEntry,
	HarbourError,
	type ListOptions,
	type Mount,
	type MountRequest,
	type MountSource,
	type MountSourceKind,
	type OwnerRef,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type ProjectId,
	type Role,
	type SeedReadiness,
	type SeedSpec,
	type SessionId,
	systemClock,
	systemContext,
	type WorkspaceChange,
	type WorkspaceId,
	type WorkspaceRecord,
	type Workspaces,
	type WorkspaceVersion,
	type WorkspaceVersionInfo,
} from "@harbour/contracts";
import { findMount, isUnderMount, normalizeMountPoint, normalizeWorkspacePath, sha256Hex, toBytes } from "./index.ts";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

interface StoredFile {
	readonly content: Uint8Array;
	readonly digest: string;
	/** The version that last changed the file. */
	readonly version: number;
}

type Tree = ReadonlyMap<string, StoredFile>;

interface StoredVersion {
	readonly tree: Tree;
	readonly info: WorkspaceVersionInfo;
}

interface WorkspaceState {
	readonly organisationId: string;
	record: WorkspaceRecord;
	readonly versions: StoredVersion[];
}

/** Workspaces append their audit events as themselves. */
const AUDIT_CONTEXT = systemContext("workspace");

export interface MemoryWorkspacesOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** Mountable sources, one per kind. */
	readonly sources?: readonly MountSource[];
	/**
	 * Project access (settled question 7). Without it the workspaces check only the organisation; every target and
	 * every conformance run passes one.
	 */
	readonly access?: ProjectAccess;
}

export function createMemoryWorkspaces(options: MemoryWorkspacesOptions = {}): Workspaces {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const access = options.access;
	const sources = new Map<MountSourceKind, MountSource>();
	for (const source of options.sources ?? []) {
		if (sources.has(source.kind)) throw new HarbourError("invalid", `two mount sources of kind ${source.kind}`);
		sources.set(source.kind, source);
	}
	const workspaces = new Map<WorkspaceId, WorkspaceState>();

	function load(ctx: CallContext, id: WorkspaceId): WorkspaceState {
		const state = workspaces.get(id);
		if (state === undefined || state.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `workspace ${id} not found`);
		}
		return state;
	}

	/** Requires `needed` on the workspace's project, when its owner or session ties it to one. */
	async function requireWorkspace(
		ctx: CallContext,
		record: WorkspaceRecord,
		needed: Role,
		operation: string,
	): Promise<void> {
		const scope = projectScope(record.owner, record.sessionId);
		if (access === undefined || scope === undefined) return;
		await access.require(ctx, { ...scope, needed, operation, subject: { kind: "workspace", id: record.id } });
	}

	/**
	 * Requires viewer on the project a `project-files` mount's files come from, on every read through it (settled
	 * question 11). Nothing is cached: a role revoked since the last read refuses the next one.
	 */
	async function requireMountRead(ctx: CallContext, record: WorkspaceRecord, mount: Mount): Promise<void> {
		if (access === undefined || mount.source !== "project-files") return;
		await access.require(ctx, {
			projectId: mount.ref,
			needed: "viewer",
			operation: "workspace.mount.read",
			subject: { kind: "workspace", id: record.id },
		});
	}

	/** Requires viewer on the project each `project-files` mount names in its `ref`. */
	async function requireMounts(
		ctx: CallContext,
		requests: Iterable<MountRequest>,
		subject?: { readonly kind: "workspace"; readonly id: WorkspaceId },
	): Promise<void> {
		if (access === undefined) return;
		for (const request of requests) {
			if (request.source !== "project-files") continue;
			await access.require(ctx, {
				projectId: request.ref,
				needed: "viewer",
				operation: "workspace.mount",
				...(subject === undefined ? {} : { subject }),
			});
		}
	}

	function treeAt(state: WorkspaceState, version: WorkspaceVersion | undefined): Tree {
		if (version === undefined) return state.versions[state.record.head]!.tree;
		if (!Number.isInteger(version) || version < 0) throw new HarbourError("invalid", `bad version ${version}`);
		const stored = state.versions[version];
		if (stored === undefined) throw new HarbourError("not_found", `version ${version} not found`);
		return stored.tree;
	}

	function sourceFor(kind: MountSourceKind): MountSource {
		const source = sources.get(kind);
		if (source === undefined) throw new HarbourError("invalid", `no mount source of kind ${kind}`);
		return source;
	}

	async function resolveMount(ctx: CallContext, request: MountRequest): Promise<Mount> {
		const path = normalizeMountPoint(request.path);
		const source = sourceFor(request.source);
		let version = request.version;
		if (version === undefined) version = await source.latestVersion(ctx, request.ref);
		// Listing the root checks that the pinned version exists.
		else await source.list(ctx, request.ref, version, "");
		return { path, source: request.source, ref: request.ref, version, readOnly: true };
	}

	function mountAt(state: WorkspaceState, path: string): { mount: Mount; sourcePath: string } {
		const found = findMount(path, state.record.mounts);
		if (found === undefined) throw new HarbourError("invalid", `${path} is absolute and under no mount`, { path });
		return found;
	}

	async function emit(event: AuditEventInput): Promise<void> {
		await audit?.append(AUDIT_CONTEXT, [event]);
	}

	function auditBase(ctx: CallContext, state: WorkspaceState) {
		const sessionId: SessionId | undefined =
			state.record.sessionId ?? (ctx.actor.kind === "agent" ? ctx.actor.sessionId : undefined);
		return {
			at: clock.now(),
			source: "workspace" as const,
			actor: ctx.actor,
			organisationId: state.organisationId,
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(ctx.actor.kind === "agent" ? { agentId: ctx.actor.agentId } : {}),
			subject: { kind: "workspace", id: state.record.id },
		};
	}

	return {
		async create(ctx, input) {
			checkOwner(ctx, input.owner);
			const scope = projectScope(input.owner, input.sessionId);
			if (access !== undefined && scope !== undefined) {
				await access.require(ctx, { ...scope, needed: "operator", operation: "workspace.create" });
			}
			const seed = input.seed;
			const seedFiles = new Map<string, string>();
			for (const source of seed?.sources ?? []) {
				if (source.kind !== "files") continue;
				for (const [path, content] of Object.entries(source.files))
					seedFiles.set(normalizeWorkspacePath(path), content);
			}
			const shape = treeShapeConflict(seedFiles.keys());
			if (shape !== undefined) throw new HarbourError("invalid", shape);

			const requests = new Map<string, MountRequest>();
			for (const request of [...(seed?.mounts ?? []), ...(input.mounts ?? [])]) requests.set(request.path, request);
			await requireMounts(ctx, requests.values());
			const mounts: Mount[] = [];
			for (const request of requests.values()) mounts.push(await resolveMount(ctx, request));
			checkMountsDisjoint(mounts);

			const files = new Map<string, StoredFile>();
			for (const [path, content] of seedFiles) {
				const bytes = toBytes(content);
				files.set(path, { content: bytes, digest: await sha256Hex(bytes), version: 1 });
			}

			const now = clock.now();
			const id = `ws_${crypto.randomUUID()}`;
			const versions: StoredVersion[] = [
				{ tree: new Map(), info: { version: 0, at: now, actor: ctx.actor, changed: [] } },
			];
			if (files.size > 0) {
				versions.push({
					tree: files,
					info: { version: 1, at: now, actor: ctx.actor, changed: [...files.keys()].sort(), message: "seed" },
				});
			}
			const record: WorkspaceRecord = {
				id,
				owner: input.owner,
				...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
				head: versions.length - 1,
				mounts,
				...(seed === undefined ? {} : { seed }),
				seedReadiness: seedReadiness(seed),
				createdAt: now,
				updatedAt: now,
			};
			workspaces.set(id, { organisationId: ctx.organisationId, record, versions });
			return record;
		},

		async get(ctx, id) {
			const state = load(ctx, id);
			await requireWorkspace(ctx, state.record, "viewer", "workspace.get");
			return state.record;
		},

		async list(ctx, id, listOptions: ListOptions = {}) {
			const state = load(ctx, id);
			await requireWorkspace(ctx, state.record, "viewer", "workspace.list");
			const limit = pageLimit(listOptions.limit);
			const after = decodeCursor(listOptions.cursor);
			const path = listOptions.path ?? "";
			const recursive = listOptions.recursive === true;
			let entries: FileEntry[];
			if (path.startsWith("/")) {
				const { mount, sourcePath } = mountAt(state, path);
				await requireMountRead(ctx, state.record, mount);
				entries = await listMount(ctx, sourceFor(mount.source), mount, sourcePath, recursive);
			} else {
				const dir = path === "" ? "" : normalizeWorkspacePath(path);
				entries = treeEntries(treeAt(state, listOptions.version), dir, recursive, (version) => version);
			}
			entries.sort((left, right) => compare(left.path, right.path));
			return pageByPath(entries, after, limit);
		},

		async stat(ctx, id, path, statOptions) {
			const state = load(ctx, id);
			await requireWorkspace(ctx, state.record, "viewer", "workspace.stat");
			if (path.startsWith("/")) {
				const { mount, sourcePath } = mountAt(state, path);
				await requireMountRead(ctx, state.record, mount);
				if (sourcePath === "") return { path: mount.path, kind: "directory", size: 0, version: mount.version };
				const parent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
				const siblings = await sourceFor(mount.source).list(ctx, mount.ref, mount.version, parent);
				const entry = siblings.find((candidate) => candidate.path === sourcePath);
				if (entry === undefined) throw new HarbourError("not_found", `${path} not found`, { path });
				return { ...entry, path: `${mount.path}/${entry.path}` };
			}
			return statTree(treeAt(state, statOptions?.version), normalizeWorkspacePath(path), (version) => version);
		},

		async read(ctx, id, path, readOptions) {
			const state = load(ctx, id);
			await requireWorkspace(ctx, state.record, "viewer", "workspace.read");
			if (path.startsWith("/")) {
				const { mount, sourcePath } = mountAt(state, path);
				await requireMountRead(ctx, state.record, mount);
				if (sourcePath === "") throw new HarbourError("invalid", `${path} is a directory`, { path });
				const content = toBytes(await sourceFor(mount.source).read(ctx, mount.ref, mount.version, sourcePath));
				return { path, content, version: mount.version, digest: await sha256Hex(content) };
			}
			const file = readTree(treeAt(state, readOptions?.version), normalizeWorkspacePath(path));
			return { path, content: new Uint8Array(file.content), version: file.version, digest: file.digest };
		},

		async commit(ctx, id, request: CommitRequest): Promise<CommitResult> {
			const state = load(ctx, id);
			await requireWorkspace(ctx, state.record, "operator", "workspace.commit");
			const refused = request.changes
				.map((change) => change.path)
				.filter((path) => typeof path === "string" && path.startsWith("/") && isUnderMount(path, state.record.mounts));
			if (refused.length > 0) {
				await emit({
					...auditBase(ctx, state),
					id: `workspace:refused:${id}:${crypto.randomUUID()}`,
					type: "workspace.write.refused",
					data: { paths: refused, reason: "read-only mount" },
				});
				throw new HarbourError("refused", "mounts are read-only; write through the source's tools", {
					paths: refused,
				});
			}
			if (request.changes.length === 0) throw new HarbourError("invalid", "a commit needs at least one change");
			const prepared = await prepareChanges(request.changes);

			// Everything below is synchronous, so the head check and the new version are atomic.
			if (request.baseVersion !== state.record.head) {
				throw new HarbourError("conflict", `base version ${request.baseVersion} is not the head`, {
					head: state.record.head,
					baseVersion: request.baseVersion,
				});
			}
			const version = state.record.head + 1;
			const tree = applyChanges(state.versions[state.record.head]!.tree, prepared, version);
			const now = clock.now();
			const changed = prepared.map((change) => change.path).sort();
			const info: WorkspaceVersionInfo = {
				version,
				at: now,
				actor: ctx.actor,
				changed,
				...(request.message === undefined ? {} : { message: request.message }),
			};
			state.versions.push({ tree, info });
			state.record = { ...state.record, head: version, updatedAt: now };
			await emit({
				...auditBase(ctx, state),
				...(request.writer?.sessionId === undefined ? {} : { sessionId: request.writer.sessionId }),
				id: `workspace:commit:${id}:${version}`,
				type: "workspace.committed",
				data: {
					version,
					changed,
					...(request.writer?.leaseId === undefined ? {} : { leaseId: request.writer.leaseId }),
				},
			});
			return { version, changed };
		},

		async history(ctx, id, page: PageRequest = {}) {
			const state = load(ctx, id);
			await requireWorkspace(ctx, state.record, "viewer", "workspace.history");
			const limit = pageLimit(page.limit);
			const after = decodeCursor(page.cursor);
			let below = state.versions.length;
			if (after !== undefined) {
				below = Number(after);
				if (!Number.isInteger(below)) throw new HarbourError("invalid", "bad cursor");
			}
			const items: WorkspaceVersionInfo[] = [];
			for (let version = Math.min(below, state.versions.length) - 1; version >= 0; version--) {
				if (items.length === limit) break;
				items.push(state.versions[version]!.info);
			}
			const last = items.at(-1);
			return last !== undefined && last.version > 0
				? { items, nextCursor: encodeCursor(String(last.version)) }
				: { items };
		},

		async remount(ctx, id, request) {
			const state = load(ctx, id);
			await requireWorkspace(ctx, state.record, "operator", "workspace.remount");
			await requireMounts(ctx, [request], { kind: "workspace", id });
			const path = normalizeMountPoint(request.path);
			const index = state.record.mounts.findIndex((mount) => mount.path === path);
			if (index < 0) throw new HarbourError("not_found", `no mount at ${path}`, { path });
			const mount = await resolveMount(ctx, request);
			const mounts = state.record.mounts.map((existing, at) => (at === index ? mount : existing));
			state.record = { ...state.record, mounts, updatedAt: clock.now() };
			return state.record;
		},

		async export(ctx, id, prefixes) {
			const state = load(ctx, id);
			await requireWorkspace(ctx, state.record, "viewer", "workspace.export");
			for (const prefix of prefixes) {
				if (typeof prefix !== "string" || prefix.startsWith("/") || prefix.includes("\\")) {
					throw new HarbourError("invalid", "export prefixes are relative workspace prefixes such as notes/", {
						prefix: String(prefix),
					});
				}
			}
			const files: FileContent[] = [];
			for (const [path, file] of state.versions[state.record.head]!.tree) {
				if (!prefixes.some((prefix) => path.startsWith(prefix))) continue;
				files.push({ path, content: new Uint8Array(file.content), version: file.version, digest: file.digest });
			}
			return files.sort((left, right) => compare(left.path, right.path));
		},
	};
}

/** The concrete in-memory project files source; `seed` is a test helper outside the contract. */
export interface MemoryProjectFiles extends MountSource {
	write(
		ctx: CallContext,
		ref: string,
		changes: readonly WorkspaceChange[],
	): Promise<{ readonly version: string; readonly actor: Actor }>;
	/** Puts `files` into the project as one new version and returns the version. */
	seed(ref: string, files: { readonly [path: string]: string | Uint8Array }): Promise<string>;
}

export interface MemoryProjectFilesOptions {
	/**
	 * Project access (settled question 7): `write` then needs operator on the project its `ref` names. Reads stay
	 * unchecked; the workspace checks the caller may mount the ref. Without it the source checks nothing.
	 */
	readonly access?: ProjectAccess;
}

/**
 * A `project-files` mount source, versioned per ref (a project ID). Version `"0"` is the empty tree; each write adds
 * one version. Paths inside the source are relative, and `""` is the root.
 */
export function createMemoryProjectFiles(options: MemoryProjectFilesOptions = {}): MemoryProjectFiles {
	const access = options.access;
	const projects = new Map<string, Tree[]>();

	function versionsOf(ref: string): Tree[] {
		let versions = projects.get(ref);
		if (versions === undefined) {
			versions = [new Map()];
			projects.set(ref, versions);
		}
		return versions;
	}

	function treeAt(ref: string, version: string): Tree {
		const versions = versionsOf(ref);
		const tree = /^\d+$/.test(version) ? versions[Number(version)] : undefined;
		if (tree === undefined) throw new HarbourError("not_found", `version ${version} of ${ref} not found`);
		return tree;
	}

	async function apply(ref: string, changes: readonly WorkspaceChange[]): Promise<string> {
		const prepared = await prepareChanges(changes);
		const versions = versionsOf(ref);
		const version = versions.length;
		versions.push(applyChanges(versions[version - 1]!, prepared, version));
		return String(version);
	}

	return {
		kind: "project-files",
		async latestVersion(_ctx, ref) {
			return String(versionsOf(ref).length - 1);
		},
		async list(_ctx, ref, version, path) {
			const dir = path === "" ? "" : normalizeWorkspacePath(path);
			return treeEntries(treeAt(ref, version), dir, false, String);
		},
		async read(_ctx, ref, version, path) {
			return new Uint8Array(readTree(treeAt(ref, version), normalizeWorkspacePath(path)).content);
		},
		async write(ctx, ref, changes) {
			await access?.require(ctx, { projectId: ref, needed: "operator", operation: "workspace.files.write" });
			if (changes.length === 0) throw new HarbourError("invalid", "a write needs at least one change");
			return { version: await apply(ref, changes), actor: ctx.actor };
		},
		async seed(ref, files) {
			return apply(
				ref,
				Object.entries(files).map(([path, content]) => ({ op: "put", path, content })),
			);
		},
	};
}

type PreparedChange =
	| { readonly op: "put"; readonly path: string; readonly content: Uint8Array; readonly digest: string }
	| { readonly op: "delete"; readonly path: string };

async function prepareChanges(changes: readonly WorkspaceChange[]): Promise<PreparedChange[]> {
	const seen = new Set<string>();
	const prepared: PreparedChange[] = [];
	for (const change of changes) {
		const path = normalizeWorkspacePath(change.path);
		if (seen.has(path)) throw new HarbourError("invalid", `${path} is changed twice in one commit`, { path });
		seen.add(path);
		if (change.op === "delete") {
			prepared.push({ op: "delete", path });
		} else if (change.op === "put") {
			const content = toBytes(change.content);
			prepared.push({ op: "put", path, content, digest: await sha256Hex(content) });
		} else {
			throw new HarbourError("invalid", "a change is a put or a delete", { path });
		}
	}
	return prepared;
}

/** A new tree with `changes` applied; rejects without changing `base`. */
function applyChanges(base: Tree, changes: readonly PreparedChange[], version: number): Tree {
	const tree = new Map(base);
	for (const change of changes) {
		if (change.op === "delete") {
			if (!tree.delete(change.path)) {
				throw new HarbourError("not_found", `${change.path} not found`, { path: change.path });
			}
		} else {
			tree.set(change.path, { content: change.content, digest: change.digest, version });
		}
	}
	const shape = treeShapeConflict(tree.keys());
	if (shape !== undefined) throw new HarbourError("invalid", shape);
	return tree;
}

/** Describes the first path that is both a file and a directory, or undefined when the tree is well formed. */
function treeShapeConflict(paths: Iterable<string>): string | undefined {
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
function treeEntries<V extends number | string>(
	tree: Tree,
	dir: string,
	recursive: boolean,
	version: (stored: number) => V,
): FileEntry[] {
	if (dir !== "" && tree.has(dir)) throw new HarbourError("invalid", `${dir} is a file`, { path: dir });
	const prefix = dir === "" ? "" : `${dir}/`;
	const files: FileEntry[] = [];
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
	if (!found) throw new HarbourError("not_found", `${dir} not found`, { path: dir });
	for (const [path, newest] of directories) files.push({ path, kind: "directory", size: 0, version: version(newest) });
	return files;
}

function statTree<V extends number | string>(tree: Tree, path: string, version: (stored: number) => V): FileEntry {
	const file = tree.get(path);
	if (file !== undefined) return fileEntry(path, file, version);
	let newest: number | undefined;
	for (const [candidate, stored] of tree) {
		if (candidate.startsWith(`${path}/`)) newest = Math.max(newest ?? 0, stored.version);
	}
	if (newest === undefined) throw new HarbourError("not_found", `${path} not found`, { path });
	return { path, kind: "directory", size: 0, version: version(newest) };
}

function readTree(tree: Tree, path: string): StoredFile {
	const file = tree.get(path);
	if (file !== undefined) return file;
	for (const candidate of tree.keys()) {
		if (candidate.startsWith(`${path}/`)) throw new HarbourError("invalid", `${path} is a directory`, { path });
	}
	throw new HarbourError("not_found", `${path} not found`, { path });
}

function fileEntry<V extends number | string>(
	path: string,
	file: StoredFile,
	version: (stored: number) => V,
): FileEntry {
	return { path, kind: "file", size: file.content.byteLength, digest: file.digest, version: version(file.version) };
}

/** Lists a mount through its source, with paths rewritten under the mount point. */
async function listMount(
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

/** The project a workspace is scoped to, through a project owner, a session, or both; undefined when neither. */
function projectScope(
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

function checkOwner(ctx: CallContext, owner: OwnerRef): void {
	if (owner.kind !== "platform" && owner.organisationId !== ctx.organisationId) {
		throw new HarbourError("forbidden", "a workspace's owner must be in the calling organisation");
	}
}

function checkMountsDisjoint(mounts: readonly Mount[]): void {
	for (const mount of mounts) {
		const others = mounts.filter((other) => other !== mount);
		if (isUnderMount(mount.path, others)) {
			throw new HarbourError("invalid", `mount ${mount.path} overlaps another mount`, { path: mount.path });
		}
	}
}

function seedReadiness(seed: SeedSpec | undefined): SeedReadiness {
	// Only `files` sources are applied in memory; other sources stay at their metadata.
	return seed?.sources.some((source) => source.kind !== "files") === true ? "metadata" : "files";
}

function pageLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_PAGE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw new HarbourError("invalid", "limit must be a positive integer");
	return Math.min(limit, MAX_PAGE_LIMIT);
}

function pageByPath(entries: readonly FileEntry[], after: string | undefined, limit: number): Page<FileEntry> {
	const start = after === undefined ? 0 : entries.findIndex((entry) => compare(entry.path, after) > 0);
	const remaining = start < 0 ? [] : entries.slice(start);
	const items = remaining.slice(0, limit);
	const last = items.at(-1);
	return remaining.length > limit && last !== undefined ? { items, nextCursor: encodeCursor(last.path) } : { items };
}

function encodeCursor(after: string): string {
	return btoa(encodeURIComponent(JSON.stringify({ after })));
}

function decodeCursor(cursor: string | undefined): string | undefined {
	if (cursor === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(atob(cursor)));
		if (typeof parsed === "object" && parsed !== null && typeof (parsed as { after?: unknown }).after === "string") {
			return (parsed as { after: string }).after;
		}
	} catch {
		// Falls through to the error below.
	}
	throw new HarbourError("invalid", "bad cursor");
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
