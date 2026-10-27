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
	type MountSource,
	type PageRequest,
	type ProjectAccess,
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
import {
	checkKeyedId,
	isUnderMount,
	type KeyedWorkspaces,
	normalizeMountPoint,
	normalizeWorkspacePath,
	toBytes,
} from "./index.ts";
import { resolveSeed, type Seeders } from "./seed.ts";
import {
	applyChanges,
	checkExportPrefixes,
	checkExportSize,
	checkMountsDisjoint,
	checkOwner,
	compare,
	decodeCursor,
	encodeCursor,
	listMount,
	mountAt,
	mountRequests,
	mountSources,
	pageByPath,
	pageLimit,
	prepareChanges,
	readTree,
	requireNotAborted,
	seedFiles,
	statTree,
	type TreeFile,
	treeEntries,
	workspaceAccess,
} from "./tree.ts";

interface StoredFile extends TreeFile {
	readonly content: Uint8Array;
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
	/** How seed sources other than `files` are fetched. Without a git fetcher, git sources wait at `metadata`. */
	readonly seeders?: Seeders;
}

export function createMemoryWorkspaces(options: MemoryWorkspacesOptions = {}): KeyedWorkspaces {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const checks = workspaceAccess(options.access);
	const sources = mountSources(options.sources);
	const workspaces = new Map<WorkspaceId, WorkspaceState>();

	function load(ctx: CallContext, id: WorkspaceId): WorkspaceState {
		const state = workspaces.get(id);
		if (state === undefined || state.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `workspace ${id} not found`);
		}
		return state;
	}

	function treeAt(state: WorkspaceState, version: WorkspaceVersion | undefined): Tree {
		if (version === undefined) return state.versions[state.record.head]!.tree;
		if (!Number.isInteger(version) || version < 0) throw new HarbourError("invalid", `bad version ${version}`);
		const stored = state.versions[version];
		if (stored === undefined) throw new HarbourError("not_found", `version ${version} not found`);
		return stored.tree;
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

	async function create(
		ctx: CallContext,
		input: Parameters<Workspaces["create"]>[1],
		id: WorkspaceId,
		keyed = false,
	): Promise<WorkspaceRecord> {
		checkOwner(ctx, input.owner);
		await checks.requireCreate(ctx, input.owner, input.sessionId);
		const seed = input.seed;
		// Static files are checked before anything is fetched.
		seedFiles(seed);
		const requests = mountRequests(seed, input.mounts);
		await checks.requireMounts(ctx, requests.values());
		const mounts: Mount[] = [];
		for (const request of requests.values()) mounts.push(await sources.resolve(ctx, request));
		checkMountsDisjoint(mounts);

		const seeded = await resolveSeed(ctx, seed, options.seeders ?? {}, clock, mounts);
		const prepared = await prepareChanges(
			[...seeded.files].map(([path, file]) => ({ op: "put", path, content: file.content })),
		);
		const files = applyChanges<StoredFile>(new Map(), prepared, (change) => ({
			content: change.content,
			digest: change.digest,
			size: change.content.byteLength,
			version: 1,
		}));

		const now = clock.now();
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
			seedReadiness: seeded.readiness,
			...(seeded.report === undefined ? {} : { seedReport: seeded.report }),
			createdAt: now,
			updatedAt: now,
		};
		// A racing `ensure` may have created it while this one awaited; the first one wins.
		const raced = workspaces.get(id);
		if (raced !== undefined) {
			if (keyed && raced.organisationId === ctx.organisationId) {
				// The winner may be another project's: the loser sees it only as any existing workspace would be seen.
				await checks.requireWorkspace(ctx, raced.record, "viewer", "workspace.get");
				return raced.record;
			}
			throw new HarbourError("conflict", `workspace ${id} is taken`);
		}
		workspaces.set(id, { organisationId: ctx.organisationId, record, versions });
		return record;
	}

	return {
		create: (ctx, input) => create(ctx, input, `ws_${crypto.randomUUID()}`),

		async ensure(ctx, id, input) {
			checkKeyedId(id);
			const existing = workspaces.get(id);
			if (existing === undefined) return create(ctx, input, id, true);
			if (existing.organisationId !== ctx.organisationId) {
				throw new HarbourError("conflict", `workspace ${id} is taken`);
			}
			await checks.requireWorkspace(ctx, existing.record, "viewer", "workspace.get");
			return existing.record;
		},

		async get(ctx, id) {
			const state = load(ctx, id);
			await checks.requireWorkspace(ctx, state.record, "viewer", "workspace.get");
			return state.record;
		},

		async list(ctx, id, listOptions: ListOptions = {}) {
			const state = load(ctx, id);
			await checks.requireWorkspace(ctx, state.record, "viewer", "workspace.list");
			const limit = pageLimit(listOptions.limit);
			const after = decodeCursor(listOptions.cursor);
			const path = listOptions.path ?? "";
			const recursive = listOptions.recursive === true;
			let entries: FileEntry[];
			if (path.startsWith("/")) {
				const { mount, sourcePath } = mountAt(state.record, path);
				await checks.requireMountRead(ctx, state.record, mount);
				entries = await listMount(ctx, sources.sourceFor(mount.source), mount, sourcePath, recursive);
			} else {
				const dir = path === "" ? "" : normalizeWorkspacePath(path);
				entries = treeEntries(treeAt(state, listOptions.version), dir, recursive, (version) => version);
			}
			entries.sort((left, right) => compare(left.path, right.path));
			return pageByPath(entries, after, limit);
		},

		async stat(ctx, id, path, statOptions) {
			const state = load(ctx, id);
			await checks.requireWorkspace(ctx, state.record, "viewer", "workspace.stat");
			if (path.startsWith("/")) {
				const { mount, sourcePath } = mountAt(state.record, path);
				await checks.requireMountRead(ctx, state.record, mount);
				return sources.stat(ctx, mount, sourcePath, path);
			}
			return statTree(treeAt(state, statOptions?.version), normalizeWorkspacePath(path), (version) => version);
		},

		async read(ctx, id, path, readOptions) {
			const state = load(ctx, id);
			await checks.requireWorkspace(ctx, state.record, "viewer", "workspace.read");
			if (path.startsWith("/")) {
				const { mount, sourcePath } = mountAt(state.record, path);
				await checks.requireMountRead(ctx, state.record, mount);
				return sources.read(ctx, mount, sourcePath, path);
			}
			const file = readTree(treeAt(state, readOptions?.version), normalizeWorkspacePath(path));
			return { path, content: new Uint8Array(file.content), version: file.version, digest: file.digest };
		},

		async commit(ctx, id, request: CommitRequest): Promise<CommitResult> {
			const state = load(ctx, id);
			await checks.requireWorkspace(ctx, state.record, "operator", "workspace.commit");
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
			requireNotAborted(ctx);
			if (request.baseVersion !== state.record.head) {
				throw new HarbourError("conflict", `base version ${request.baseVersion} is not the head`, {
					head: state.record.head,
					baseVersion: request.baseVersion,
				});
			}
			const version = state.record.head + 1;
			const tree = applyChanges<StoredFile>(state.versions[state.record.head]!.tree, prepared, (change, previous) => {
				const mode = change.mode ?? previous?.mode;
				return {
					content: change.content,
					digest: change.digest,
					size: change.content.byteLength,
					version,
					...(mode === undefined ? {} : { mode }),
				};
			});
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
			await checks.requireWorkspace(ctx, state.record, "viewer", "workspace.history");
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
			await checks.requireWorkspace(ctx, state.record, "operator", "workspace.remount");
			await checks.requireMounts(ctx, [request], { kind: "workspace", id });
			const path = normalizeMountPoint(request.path);
			const index = state.record.mounts.findIndex((existing) => existing.path === path);
			if (index < 0) throw new HarbourError("not_found", `no mount at ${path}`, { path });
			const mount = await sources.resolve(ctx, request);
			const mounts = state.record.mounts.map((existing, at) => (at === index ? mount : existing));
			state.record = { ...state.record, mounts, updatedAt: clock.now() };
			return state.record;
		},

		async export(ctx, id, prefixes, options) {
			const state = load(ctx, id);
			await checks.requireWorkspace(ctx, state.record, "viewer", "workspace.export");
			checkExportPrefixes(prefixes);
			const tree = state.versions[state.record.head]!.tree;
			checkExportSize(
				[...tree].filter(([path]) => prefixes.some((prefix) => path.startsWith(prefix))).map(([, file]) => file.size),
				options?.maxBytes,
			);
			const files: FileContent[] = [];
			for (const [path, file] of tree) {
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
		versions.push(
			applyChanges<StoredFile>(versions[version - 1]!, prepared, (change) => ({
				content: change.content,
				digest: change.digest,
				size: change.content.byteLength,
				version,
			})),
		);
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
			return toBytes(readTree(treeAt(ref, version), normalizeWorkspacePath(path)).content);
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
