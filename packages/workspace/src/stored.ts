/**
 * `Workspaces` over a `WorkspaceStore`: the logic every durable target shares (Postgres and S3 self-hosted, R2 on
 * Cloudflare), so they answer exactly as the in-memory reference does. A target supplies only storage.
 *
 * Layout:
 * - File bodies are content-addressed blobs, `org/<organisation>/blobs/<sha256>`, written before anything refers to
 *   them.
 * - Each version's tree is an immutable JSON object, `org/<organisation>/trees/<sha256>.json`, mapping each path to its
 *   digest, size, the version that last changed it and any mode bits. Listing reads only trees, never bodies.
 * - The store keeps the head (the record and the head tree's key) and each version's history entry and tree key. A
 *   commit writes its blobs and tree first, then moves the head with a compare-and-set on the head it read, so a lost
 *   race is `conflict` and leaves only unreferenced objects behind.
 */
import {
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
	type Page,
	type PageRequest,
	type ProjectAccess,
	type SessionId,
	systemClock,
	systemContext,
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
	sha256Hex,
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
	type ModedChange,
	type ModedFileEntry,
	mountAt,
	mountRequests,
	mountSources,
	type PreparedChange,
	pageByPath,
	pageLimit,
	prepareChanges,
	readTree,
	requireNotAborted,
	seedFiles,
	statTree,
	type Tree,
	type TreeFile,
	treeEntries,
	treeShapeConflict,
	workspaceAccess,
} from "./tree.ts";

/** What a store keeps as a workspace's head. */
export interface StoredHead {
	readonly organisationId: string;
	readonly record: WorkspaceRecord;
	/** Object key of the head version's tree; null for the empty tree. */
	readonly tree: string | null;
}

/** A head as loaded, with the token a compare-and-set on it needs (an etag, a row revision). */
export interface LoadedHead extends StoredHead {
	readonly token: string;
}

/** One version as a store keeps it. */
export interface StoredVersion {
	readonly info: WorkspaceVersionInfo;
	/** Object key of the version's tree; null for the empty tree. */
	readonly tree: string | null;
}

/**
 * The storage a target supplies. Objects are immutable and content-addressed, so a put of an existing key may simply
 * overwrite it with the same bytes. Every head change is a compare-and-set on the token `load` returned.
 */
export interface WorkspaceStore {
	/** The workspace's head, in any organisation; undefined when there is none. */
	load(id: WorkspaceId): Promise<LoadedHead | undefined>;
	/** Creates a workspace with its first versions (0, and 1 when seeded); false when the ID is taken. */
	create(head: StoredHead, versions: readonly StoredVersion[]): Promise<boolean>;
	/** Moves the head from `current` to `next` and records `version`; false when the head changed meanwhile. */
	advance(current: LoadedHead, next: StoredHead, version: StoredVersion): Promise<boolean>;
	/** Replaces the record without a new version (a remount); false when the head changed meanwhile. */
	update(current: LoadedHead, next: StoredHead): Promise<boolean>;
	/** The tree key of `version` (below the head's), null for an empty tree, undefined when the store has none. */
	treeAt(current: LoadedHead, version: WorkspaceVersion): Promise<string | null | undefined>;
	/** Up to `limit` history entries below version `below`, newest first. */
	history(current: LoadedHead, below: WorkspaceVersion, limit: number): Promise<readonly WorkspaceVersionInfo[]>;
	getObject(key: string): Promise<Uint8Array | undefined>;
	putObject(key: string, bytes: Uint8Array): Promise<void>;
}

/** Workspaces append their audit events as themselves. */
const AUDIT_CONTEXT = systemContext("workspace");
/** Object store requests in flight at once for one call. */
const OBJECT_BATCH = 16;
/** Parsed trees kept per process, counted in entries; trees are immutable, so a cached one is never stale. */
const TREE_CACHE_ENTRIES = 250_000;
/** Times a commit or remount re-reads the head when only the token moved (a remount racing a commit). */
const HEAD_ATTEMPTS = 3;

export interface StoredWorkspacesOptions {
	readonly store: WorkspaceStore;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** Mountable sources, one per kind. */
	readonly sources?: readonly MountSource[];
	/** Project access (settled question 7). Without it the workspaces check only the organisation. */
	readonly access?: ProjectAccess;
	/** Parsed tree entries kept per instance; a larger tree is parsed for each call and not kept. */
	readonly treeCacheEntries?: number;
	/** How seed sources other than `files` are fetched. Without a git fetcher, git sources wait at `metadata`. */
	readonly seeders?: Seeders;
}

/** Stored workspaces, plus what the sandbox tiers use beside the contract. */
export interface StoredWorkspaces extends KeyedWorkspaces {
	/** Lists with mode bits, where a tier recorded them. */
	list(ctx: CallContext, id: WorkspaceId, options?: ListOptions): Promise<Page<ModedFileEntry>>;
	/** Commits puts that may carry mode bits. */
	commit(
		ctx: CallContext,
		id: WorkspaceId,
		request: Omit<CommitRequest, "changes"> & { readonly changes: readonly ModedChange[] },
	): Promise<CommitResult>;
	/**
	 * A body by digest, for a tier that already holds a listing of `version`. The digest must be a file of that version,
	 * so a digest from elsewhere reads nothing. Needs viewer, as `read` does.
	 */
	readBlob(
		ctx: CallContext,
		id: WorkspaceId,
		digest: string,
		options: { readonly version: WorkspaceVersion },
	): Promise<Uint8Array>;
}

export function createStoredWorkspaces(options: StoredWorkspacesOptions): StoredWorkspaces {
	const { store } = options;
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const checks = workspaceAccess(options.access);
	const sources = mountSources(options.sources);
	const trees = new TreeCache(options.treeCacheEntries ?? TREE_CACHE_ENTRIES);

	/** The head in the caller's organisation; another organisation's workspace looks exactly like a missing one. */
	async function load(ctx: CallContext, id: WorkspaceId): Promise<LoadedHead> {
		const head = typeof id === "string" && id.length > 0 ? await store.load(id) : undefined;
		if (head === undefined || head.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `workspace ${String(id)} not found`);
		}
		return head;
	}

	async function treeAt(head: LoadedHead, version: WorkspaceVersion | undefined): Promise<Tree> {
		if (version === undefined) return readTreeObject(head.tree);
		if (!Number.isInteger(version) || version < 0) throw new HarbourError("invalid", `bad version ${version}`);
		if (version > head.record.head) throw new HarbourError("not_found", `version ${version} not found`);
		if (version === head.record.head) return readTreeObject(head.tree);
		const key = await store.treeAt(head, version);
		if (key === undefined) throw new HarbourError("not_found", `version ${version} not found`);
		return readTreeObject(key);
	}

	async function readTreeObject(key: string | null): Promise<Tree> {
		if (key === null) return new Map();
		const cached = trees.get(key);
		if (cached !== undefined) return cached;
		const bytes = await store.getObject(key);
		if (bytes === undefined) throw new HarbourError("unavailable", `workspace tree ${key} is missing`);
		return trees.set(key, parseTree(new TextDecoder().decode(bytes), key));
	}

	async function readBlobObject(organisationId: string, digest: string): Promise<Uint8Array> {
		const bytes = await store.getObject(blobKey(organisationId, digest));
		if (bytes === undefined) throw new HarbourError("unavailable", `workspace blob ${digest} is missing`);
		return bytes;
	}

	/** Writes the blobs `changes` put and `tree`; returns the tree's key, or null for an empty tree. */
	async function writeVersion(
		organisationId: string,
		tree: Tree,
		changes: readonly PreparedChange[],
	): Promise<string | null> {
		const blobs = new Map<string, Uint8Array>();
		for (const change of changes) if (change.op === "put") blobs.set(change.digest, change.content);
		await inBatches([...blobs], ([digest, content]) => store.putObject(blobKey(organisationId, digest), content));
		if (tree.size === 0) return null;
		const bytes = toBytes(serialiseTree(tree));
		const key = `${organisationPrefix(organisationId)}/trees/${await sha256Hex(bytes)}.json`;
		await store.putObject(key, bytes);
		trees.set(key, tree);
		return key;
	}

	async function emit(event: AuditEventInput): Promise<void> {
		await audit?.append(AUDIT_CONTEXT, [event]);
	}

	function auditBase(ctx: CallContext, head: StoredHead) {
		const sessionId: SessionId | undefined =
			head.record.sessionId ?? (ctx.actor.kind === "agent" ? ctx.actor.sessionId : undefined);
		return {
			at: clock.now(),
			source: "workspace" as const,
			actor: ctx.actor,
			organisationId: head.organisationId,
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(ctx.actor.kind === "agent" ? { agentId: ctx.actor.agentId } : {}),
			subject: { kind: "workspace", id: head.record.id },
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
			[...seeded.files].map(([path, file]) => ({
				op: "put",
				path,
				content: file.content,
				...(file.mode === undefined ? {} : { mode: file.mode }),
			})),
		);
		const tree = applyChanges<TreeFile>(new Map(), prepared, (change) => ({
			digest: change.digest,
			size: change.content.byteLength,
			version: 1,
			...(change.mode === undefined ? {} : { mode: change.mode }),
		}));
		const treeKey = await writeVersion(ctx.organisationId, tree, prepared);
		const now = clock.now();
		const versions: StoredVersion[] = [{ info: { version: 0, at: now, actor: ctx.actor, changed: [] }, tree: null }];
		if (treeKey !== null) {
			versions.push({
				info: { version: 1, at: now, actor: ctx.actor, changed: [...tree.keys()].sort(compare), message: "seed" },
				tree: treeKey,
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
		if (await store.create({ organisationId: ctx.organisationId, record, tree: treeKey }, versions)) return record;
		// A racing `ensure` created it while this one worked; the first one wins.
		const raced = await store.load(id);
		if (keyed && raced !== undefined && raced.organisationId === ctx.organisationId) {
			// The winner may be another project's: the loser sees it only as any existing workspace would be seen.
			await checks.requireWorkspace(ctx, raced.record, "viewer", "workspace.get");
			return raced.record;
		}
		throw new HarbourError("conflict", `workspace ${id} is taken`);
	}

	const workspaces: StoredWorkspaces = {
		create: (ctx, input) => create(ctx, input, `ws_${crypto.randomUUID()}`),

		async ensure(ctx, id, input) {
			checkKeyedId(id);
			const existing = await store.load(id);
			if (existing === undefined) return create(ctx, input, id, true);
			if (existing.organisationId !== ctx.organisationId) {
				throw new HarbourError("conflict", `workspace ${id} is taken`);
			}
			await checks.requireWorkspace(ctx, existing.record, "viewer", "workspace.get");
			return existing.record;
		},

		async get(ctx, id) {
			const head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "viewer", "workspace.get");
			return head.record;
		},

		async list(ctx, id, listOptions: ListOptions = {}) {
			const head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "viewer", "workspace.list");
			const limit = pageLimit(listOptions.limit);
			const after = decodeCursor(listOptions.cursor);
			const path = listOptions.path ?? "";
			const recursive = listOptions.recursive === true;
			let entries: ModedFileEntry[];
			if (path.startsWith("/")) {
				const { mount, sourcePath } = mountAt(head.record, path);
				await checks.requireMountRead(ctx, head.record, mount);
				entries = await listMount(ctx, sources.sourceFor(mount.source), mount, sourcePath, recursive);
			} else {
				const dir = path === "" ? "" : normalizeWorkspacePath(path);
				entries = treeEntries(await treeAt(head, listOptions.version), dir, recursive, (version) => version);
			}
			entries.sort((left, right) => compare(left.path, right.path));
			return pageByPath(entries, after, limit);
		},

		async stat(ctx, id, path, statOptions) {
			const head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "viewer", "workspace.stat");
			if (path.startsWith("/")) {
				const { mount, sourcePath } = mountAt(head.record, path);
				await checks.requireMountRead(ctx, head.record, mount);
				return sources.stat(ctx, mount, sourcePath, path);
			}
			return statTree(await treeAt(head, statOptions?.version), normalizeWorkspacePath(path), (version) => version);
		},

		async read(ctx, id, path, readOptions): Promise<FileContent> {
			const head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "viewer", "workspace.read");
			if (path.startsWith("/")) {
				const { mount, sourcePath } = mountAt(head.record, path);
				await checks.requireMountRead(ctx, head.record, mount);
				return sources.read(ctx, mount, sourcePath, path);
			}
			const file = readTree(await treeAt(head, readOptions?.version), normalizeWorkspacePath(path));
			const content = await readBlobObject(head.organisationId, file.digest);
			return { path, content, version: file.version, digest: file.digest };
		},

		async readBlob(ctx, id, digest, blobOptions) {
			const head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "viewer", "workspace.read");
			if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
				throw new HarbourError("invalid", "bad digest");
			}
			const tree = await treeAt(head, blobOptions.version);
			let found = false;
			for (const file of tree.values()) {
				if (file.digest === digest) {
					found = true;
					break;
				}
			}
			if (!found) {
				throw new HarbourError("not_found", `no file with digest ${digest} at version ${blobOptions.version}`);
			}
			return readBlobObject(head.organisationId, digest);
		},

		async commit(ctx, id, request): Promise<CommitResult> {
			let head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "operator", "workspace.commit");
			const mounts = head.record.mounts;
			const refused = request.changes
				.map((change) => change.path)
				.filter((path) => typeof path === "string" && path.startsWith("/") && isUnderMount(path, mounts));
			if (refused.length > 0) {
				await emit({
					...auditBase(ctx, head),
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
			const stale = (current: number) =>
				new HarbourError("conflict", `base version ${request.baseVersion} is not the head`, {
					head: current,
					baseVersion: request.baseVersion,
				});
			if (request.baseVersion !== head.record.head) throw stale(head.record.head);

			const version = head.record.head + 1;
			const tree = applyChanges<TreeFile>(await treeAt(head, undefined), prepared, (change, previous) => {
				const mode = change.mode ?? previous?.mode;
				return {
					digest: change.digest,
					size: change.content.byteLength,
					version,
					...(mode === undefined ? {} : { mode }),
				};
			});
			// Objects first: until the head moves below, nothing refers to them.
			const treeKey = await writeVersion(head.organisationId, tree, prepared);
			const now = clock.now();
			const changed = prepared.map((change) => change.path).sort(compare);
			const info: WorkspaceVersionInfo = {
				version,
				at: now,
				actor: ctx.actor,
				changed,
				...(request.message === undefined ? {} : { message: request.message }),
			};
			for (let attempt = 1; ; attempt++) {
				const next: StoredHead = {
					organisationId: head.organisationId,
					record: { ...head.record, head: version, updatedAt: now },
					tree: treeKey,
				};
				// The last moment a cancelled caller (or an ended sandbox lease) can stop the commit: nothing refers to the
				// objects written so far.
				requireNotAborted(ctx);
				if (await store.advance(head, next, { info, tree: treeKey })) break;
				// The head changed: a commit that won is a conflict; a remount that only moved the token is retried.
				const reloaded = await load(ctx, id);
				if (reloaded.record.head !== request.baseVersion || attempt >= HEAD_ATTEMPTS) {
					throw stale(reloaded.record.head);
				}
				head = reloaded;
			}
			await emit({
				...auditBase(ctx, head),
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
			const head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "viewer", "workspace.history");
			const limit = pageLimit(page.limit);
			const after = decodeCursor(page.cursor);
			let below = head.record.head + 1;
			if (after !== undefined) {
				const cursor = Number(after);
				if (!Number.isInteger(cursor)) throw new HarbourError("invalid", "bad cursor");
				below = Math.max(0, Math.min(cursor, below));
			}
			const items = below === 0 ? [] : [...(await store.history(head, below, limit))];
			const last = items.at(-1);
			return last !== undefined && last.version > 0
				? { items, nextCursor: encodeCursor(String(last.version)) }
				: { items };
		},

		async remount(ctx, id, request) {
			let head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "operator", "workspace.remount");
			await checks.requireMounts(ctx, [request], { kind: "workspace", id });
			const path = normalizeMountPoint(request.path);
			if (!head.record.mounts.some((mount) => mount.path === path)) {
				throw new HarbourError("not_found", `no mount at ${path}`, { path });
			}
			const mount = await sources.resolve(ctx, request);
			for (let attempt = 1; ; attempt++) {
				const mounts = head.record.mounts.map((existing) => (existing.path === path ? mount : existing));
				const record: WorkspaceRecord = { ...head.record, mounts, updatedAt: clock.now() };
				if (await store.update(head, { organisationId: head.organisationId, record, tree: head.tree })) return record;
				if (attempt >= HEAD_ATTEMPTS) throw new HarbourError("conflict", "the workspace changed during the remount");
				head = await load(ctx, id);
			}
		},

		async export(ctx, id, prefixes, options) {
			const head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "viewer", "workspace.export");
			checkExportPrefixes(prefixes);
			const selected = [...(await treeAt(head, undefined))]
				.filter(([path]) => prefixes.some((prefix) => path.startsWith(prefix)))
				.sort(([left], [right]) => compare(left, right));
			// Sizes come from the same tree the bodies are read from, so nothing over the budget is loaded.
			checkExportSize(
				selected.map(([, file]) => file.size),
				options?.maxBytes,
			);
			return inBatches(selected, async ([path, file]) => ({
				path,
				content: await readBlobObject(head.organisationId, file.digest),
				version: file.version,
				digest: file.digest,
			}));
		},
	};
	return workspaces;
}

/** Keys of one organisation's objects start with this, so its data can be found and removed on its own. */
export function organisationPrefix(organisationId: string): string {
	return `org/${encodeURIComponent(organisationId)}`;
}

export function blobKey(organisationId: string, digest: string): string {
	return `${organisationPrefix(organisationId)}/blobs/${digest}`;
}

/** A tree as JSON with sorted paths, so equal trees serialise to equal bytes (and so to one key). */
function serialiseTree(tree: Tree): string {
	// No prototype, so a file named `__proto__` is an ordinary own key that survives `JSON.stringify`.
	const table: Record<string, TreeFile> = Object.create(null);
	for (const [path, file] of [...tree].sort(([left], [right]) => compare(left, right))) {
		table[path] = {
			digest: file.digest,
			size: file.size,
			version: file.version,
			...(file.mode === undefined ? {} : { mode: file.mode }),
		};
	}
	return JSON.stringify(table);
}

function parseTree(json: string, key: string): Tree {
	const corrupt = () => new HarbourError("unavailable", `workspace tree ${key} is malformed`);
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw corrupt();
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw corrupt();
	const tree = new Map<string, TreeFile>();
	const count = (field: unknown): field is number => Number.isSafeInteger(field) && (field as number) >= 0;
	for (const [path, entry] of Object.entries(value) as [string, unknown][]) {
		if (typeof entry !== "object" || entry === null) throw corrupt();
		const { digest, size, version, mode } = entry as Record<string, unknown>;
		if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || !count(size) || !count(version)) {
			throw corrupt();
		}
		if (mode !== undefined && (!count(mode) || mode > 0o7777)) throw corrupt();
		try {
			if (normalizeWorkspacePath(path) !== path) throw corrupt();
		} catch {
			throw corrupt();
		}
		tree.set(path, { digest, size, version, ...(mode === undefined ? {} : { mode }) });
	}
	if (treeShapeConflict(tree.keys()) !== undefined) throw corrupt();
	return tree;
}

/** Maps `items` with at most OBJECT_BATCH calls in flight, keeping order. */
async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let start = 0; start < items.length; start += OBJECT_BATCH) {
		results.push(...(await Promise.all(items.slice(start, start + OBJECT_BATCH).map(run))));
	}
	return results;
}

/** Least recently used trees, bounded by their total entries. */
class TreeCache {
	readonly #trees = new Map<string, Tree>();
	#entries = 0;
	readonly #limit: number;

	constructor(limit: number) {
		this.#limit = limit;
	}

	get(key: string): Tree | undefined {
		const tree = this.#trees.get(key);
		if (tree !== undefined) {
			this.#trees.delete(key);
			this.#trees.set(key, tree);
		}
		return tree;
	}

	set(key: string, tree: Tree): Tree {
		const existing = this.get(key);
		if (existing !== undefined) return existing;
		// A tree over the whole budget would stay cached alone, unbounded; it is used once and dropped instead.
		if (tree.size > this.#limit) return tree;
		this.#trees.set(key, tree);
		this.#entries += tree.size;
		for (const [oldest, evicted] of this.#trees) {
			if (this.#entries <= this.#limit || oldest === key) break;
			this.#trees.delete(oldest);
			this.#entries -= evicted.size;
		}
		return tree;
	}
}

/**
 * An in-memory `WorkspaceStore`, for tests and local runs. `counts` records object reads by kind, so a test can prove
 * a listing read no bodies.
 */
export interface MemoryWorkspaceStore extends WorkspaceStore {
	readonly counts: { blobReads: number; treeReads: number; objectWrites: number };
	/** Object keys, for tests. */
	keys(): string[];
}

export function createMemoryWorkspaceStore(): MemoryWorkspaceStore {
	interface Row {
		head: StoredHead;
		revision: number;
		readonly versions: StoredVersion[];
	}
	const rows = new Map<WorkspaceId, Row>();
	const objects = new Map<string, Uint8Array>();
	const counts = { blobReads: 0, treeReads: 0, objectWrites: 0 };
	const loaded = (row: Row): LoadedHead => ({ ...row.head, token: String(row.revision) });
	const current = (head: LoadedHead): Row | undefined => {
		const row = rows.get(head.record.id);
		return row !== undefined && String(row.revision) === head.token ? row : undefined;
	};
	return {
		counts,
		keys: () => [...objects.keys()].sort(compare),
		async load(id) {
			const row = rows.get(id);
			return row === undefined ? undefined : loaded(row);
		},
		async create(head, versions) {
			if (rows.has(head.record.id)) return false;
			rows.set(head.record.id, { head, revision: 1, versions: [...versions] });
			return true;
		},
		async advance(head, next, version) {
			const row = current(head);
			if (row === undefined) return false;
			row.head = next;
			row.revision++;
			row.versions[version.info.version] = version;
			return true;
		},
		async update(head, next) {
			const row = current(head);
			if (row === undefined) return false;
			row.head = next;
			row.revision++;
			return true;
		},
		async treeAt(head, version) {
			return rows.get(head.record.id)?.versions[version]?.tree;
		},
		async history(head, below, limit) {
			const versions = rows.get(head.record.id)?.versions ?? [];
			const items: WorkspaceVersionInfo[] = [];
			for (let version = Math.min(below, versions.length) - 1; version >= 0 && items.length < limit; version--) {
				const stored = versions[version];
				if (stored !== undefined) items.push(stored.info);
			}
			return items;
		},
		async getObject(key) {
			const bytes = objects.get(key);
			if (bytes === undefined) return undefined;
			if (key.includes("/blobs/")) counts.blobReads++;
			else counts.treeReads++;
			return new Uint8Array(bytes);
		},
		async putObject(key, bytes) {
			counts.objectWrites++;
			objects.set(key, new Uint8Array(bytes));
		},
	};
}

/** Every entry of a workspace version, all pages, for tiers that mirror the whole tree. */
export async function listAll(
	workspaces: Pick<Workspaces, "list">,
	ctx: CallContext,
	id: WorkspaceId,
	options: Omit<ListOptions, "cursor" | "limit"> = {},
): Promise<ModedFileEntry[]> {
	const entries: ModedFileEntry[] = [];
	let cursor: string | undefined;
	do {
		const page: Page<FileEntry> = await workspaces.list(ctx, id, {
			...options,
			recursive: true,
			limit: 1000,
			...(cursor === undefined ? {} : { cursor }),
		});
		entries.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return entries;
}

export type { ModedChange, ModedFileEntry } from "./tree.ts";
