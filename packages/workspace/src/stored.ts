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
 *   race is `conflict` and leaves only unreferenced objects behind. A store that writes something of its own before
 *   the head (R2's archive records) takes the objects still in flight, and writes alongside them: nothing refers to any
 *   of them until the head moves, so their order doesn't matter, only that all are written first.
 * - With `hydration`, a seed is lazy (packages/workspace/CONTRACT.md): its bodies go out as a few staging packs
 *   (`./hydration.ts`) rather than one object each, the record names them (`staged`, never returned to callers) and
 *   says `hydration.hydrated: false`, and a background pass copies each body out to its blob, then clears `staged`.
 *   Until then a body is read from its pack, after the same access checks as any read.
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
	type ForkWorkspaceInput,
	KantelError,
	type ListOptions,
	type Mount,
	type MountSource,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type SeedStatusSink,
	type SessionId,
	systemClock,
	systemContext,
	type WorkspaceHydratedEvent,
	type WorkspaceHydrationSink,
	type WorkspaceId,
	type WorkspaceRecord,
	type Workspaces,
	type WorkspaceVersion,
	type WorkspaceVersionInfo,
} from "@kantel/contracts";
import {
	type BuiltPack,
	buildPacks,
	PACK_BYTES,
	PackReader,
	packDoneKey,
	packIndexKey,
	serialisePackIndex,
} from "./hydration.ts";
import {
	checkKeyedId,
	isUnderMount,
	type KeyedWorkspaces,
	normalizeMountPoint,
	normalizeWorkspacePath,
	sha256Hex,
	toBytes,
} from "./index.ts";
import { dependencyStage, resolveSeed, type Seeders, sendSeedStatus } from "./seed.ts";
import {
	applyChanges,
	checkExportPrefixes,
	checkExportSize,
	checkMountsDisjoint,
	checkOwner,
	checkReadSize,
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
	/**
	 * Moves the head from `current` to `next` and records `version`; false when the head changed meanwhile. Calls
	 * `options.check` as late as it can before the head moves (as the head write starts, or inside a transaction before
	 * it commits); when it throws, the store moves nothing and rejects with that error.
	 *
	 * Given `options.objects` (only when `writesAlongside` is true): the blobs and tree `next` refers to, still being
	 * written. The store runs its own writes before the head alongside them, and moves the head only once they have all
	 * been written; when `objects` rejects, it moves nothing and rejects with that error.
	 */
	advance(
		current: LoadedHead,
		next: StoredHead,
		version: StoredVersion,
		options?: { readonly check?: () => void; readonly objects?: Promise<void> },
	): Promise<boolean>;
	/**
	 * True when `advance` takes `options.objects`, so a commit's objects and the store's own writes before the head go
	 * out together. Otherwise a commit writes its objects before it calls `advance`.
	 */
	readonly writesAlongside?: boolean;
	/** Replaces the record without a new version (a remount); false when the head changed meanwhile. */
	update(current: LoadedHead, next: StoredHead): Promise<boolean>;
	/** The tree key of `version` (below the head's), null for an empty tree, undefined when the store has none. */
	treeAt(current: LoadedHead, version: WorkspaceVersion): Promise<string | null | undefined>;
	/** Up to `limit` history entries below version `below`, newest first. */
	history(current: LoadedHead, below: WorkspaceVersion, limit: number): Promise<readonly WorkspaceVersionInfo[]>;
	getObject(key: string): Promise<Uint8Array | undefined>;
	/**
	 * Optional: `length` bytes of an object from `offset`, as an HTTP range read does; undefined when there is no such
	 * object. A lazy workspace reads a body out of its staging pack with it; without it, the whole pack is read.
	 */
	getObjectRange?(key: string, offset: number, length: number): Promise<Uint8Array | undefined>;
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
/** Times the end of a hydration re-reads the head when a commit or remount moved it meanwhile. */
const HYDRATED_ATTEMPTS = 10;

/**
 * Lazy hydration (packages/workspace/CONTRACT.md). Given this, the host has it: a seed is lazy unless its spec
 * says `hydration: "eager"` (or `default` is `eager` and the spec says nothing).
 */
export interface StoredHydrationOptions {
	/** For a spec that names no `hydration`. Default `lazy`. */
	readonly default?: "lazy" | "eager";
	/** Receives `workspace.hydrated` once each lazy workspace (or fork of one) is hydrated. Never fails the workspace. */
	readonly onHydrated?: WorkspaceHydrationSink;
	/**
	 * Given each background hydration as it starts, so a host can keep it alive (a Worker's `ctx.waitUntil`). Without
	 * it the work runs unawaited; a hydration cut short is resumed by the next call that loads the workspace.
	 */
	readonly background?: (work: Promise<void>) => void;
	/** A seed with at most this many distinct bodies is written eagerly: one batch of writes either way. Default 16. */
	readonly minBodies?: number;
	/** The most bytes in one staging pack. Default 32 MiB. */
	readonly packBytes?: number;
}

/** A record as the store keeps it: the staging packs a lazy workspace still reads from, which callers never see. */
type StoredRecord = WorkspaceRecord & { readonly staged?: readonly string[] };

function stagedOf(record: WorkspaceRecord): readonly string[] {
	const staged = (record as StoredRecord).staged;
	return Array.isArray(staged) ? staged : [];
}

/** The record without the store's own fields. */
function publicRecord(record: WorkspaceRecord): WorkspaceRecord {
	if (!Object.hasOwn(record, "staged")) return record;
	const { staged: _staged, ...rest } = record as StoredRecord;
	return rest;
}

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
	/** Receives a `seed.status` event as each seed reaches a readiness stage, or fails. */
	readonly onSeedStatus?: SeedStatusSink;
	/** Lazy hydration of seeds; without it every seed is eager. */
	readonly hydration?: StoredHydrationOptions;
}

/** A commit with mode bits, and a guard for a caller whose right to commit can lapse meanwhile. */
export type StoredCommitRequest = Omit<CommitRequest, "changes"> & {
	readonly changes: readonly ModedChange[];
	/**
	 * Called just before the head moves, with `ctx.signal`'s check (in the store's `advance`, at its last moment):
	 * throwing stops the commit, which moves nothing and rejects with that error. A sandbox lease uses it to refuse a
	 * commit once the lease has ended or passed its TTL.
	 */
	readonly guard?: () => void;
};

/** Stored workspaces, plus what the sandbox tiers use beside the contract. */
export interface StoredWorkspaces extends KeyedWorkspaces {
	/** Lists with mode bits, where a tier recorded them. */
	list(ctx: CallContext, id: WorkspaceId, options?: ListOptions): Promise<Page<ModedFileEntry>>;
	/** Commits puts that may carry mode bits. */
	commit(ctx: CallContext, id: WorkspaceId, request: StoredCommitRequest): Promise<CommitResult>;
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
	/** A fork that shares the source's bodies: one tree object and a head, whatever the size. */
	fork(ctx: CallContext, id: WorkspaceId, input: ForkWorkspaceInput): Promise<WorkspaceRecord>;
	/** Resolves once every hydration this instance has started has ended (for tests and orderly shutdown). */
	hydrationSettled(): Promise<void>;
	/** Where this instance's reads of pending bodies were served from, for tests and timings. */
	readonly packReads: { readonly memory: number; readonly ranged: number; readonly whole: number };
}

export function createStoredWorkspaces(options: StoredWorkspacesOptions): StoredWorkspaces {
	const { store } = options;
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const checks = workspaceAccess(options.access);
	const sources = mountSources(options.sources);
	const trees = new TreeCache(options.treeCacheEntries ?? TREE_CACHE_ENTRIES);
	const hydration = options.hydration;
	const packs = new PackReader(store);
	/** Hydrations running in this instance, by workspace, and pack explosions, by pack key. */
	const hydrating = new Map<WorkspaceId, Promise<void>>();
	const exploding = new Map<string, Promise<void>>();

	/** The head in the caller's organisation; another organisation's workspace looks exactly like a missing one. */
	async function load(ctx: CallContext, id: WorkspaceId): Promise<LoadedHead> {
		const head = typeof id === "string" && id.length > 0 ? await store.load(id) : undefined;
		if (head === undefined || head.organisationId !== ctx.organisationId) {
			throw new KantelError("not_found", `workspace ${String(id)} not found`);
		}
		// A hydration this instance did not start (another process's, cut short, or a fork's) is resumed here.
		if (stagedOf(head.record).length > 0) startHydration(id);
		return head;
	}

	/**
	 * A body of `head`'s workspace: from a staging pack while the workspace still has one that holds it, else its blob.
	 * Callers have made the workspace's access checks, and the digest is one of a tree the caller may read.
	 */
	async function readBody(head: StoredHead, digest: string): Promise<Uint8Array> {
		const staged = stagedOf(head.record);
		if (staged.length > 0) {
			const body = await packs.read(staged, digest);
			if (body !== undefined) return body;
		}
		return readBlobObject(head.organisationId, digest);
	}

	/** Starts hydrating `id` in the background, unless this instance is already. */
	function startHydration(id: WorkspaceId): void {
		if (hydration === undefined || hydrating.has(id)) return;
		const work = hydrate(id)
			.catch((error: unknown) => {
				// Reads keep working from the packs; the next load of the workspace tries again.
				console.warn(`harbour: hydrating workspace ${id} failed; it will be retried`, error);
			})
			.finally(() => {
				hydrating.delete(id);
			});
		hydrating.set(id, work);
		hydration.background?.(work);
	}

	/** Copies every staged body of `id` out to its blob, then clears `staged` and sends `workspace.hydrated`. */
	async function hydrate(id: WorkspaceId): Promise<void> {
		for (let attempt = 1; attempt <= HYDRATED_ATTEMPTS; attempt++) {
			const head = await store.load(id);
			if (head === undefined) return;
			const staged = stagedOf(head.record);
			if (staged.length === 0) return;
			for (const key of staged) await explode(key);
			const now = clock.now();
			const { staged: _staged, ...rest } = head.record as StoredRecord;
			const before = head.record.hydration;
			const startedAt = before?.startedAt ?? now;
			const state = {
				hydrated: true,
				entriesTotal: before?.entriesTotal ?? 0,
				bytesTotal: before?.bytesTotal ?? 0,
				startedAt,
				hydratedAt: now,
			};
			const record: WorkspaceRecord = { ...rest, hydration: state, updatedAt: now };
			if (!(await store.update(head, { organisationId: head.organisationId, record, tree: head.tree }))) continue;
			await hydrated(head.organisationId, record, now - startedAt);
			return;
		}
		throw new KantelError("conflict", `workspace ${id} kept changing while its hydration ended`);
	}

	async function hydrated(organisationId: string, record: WorkspaceRecord, elapsedMs: number): Promise<void> {
		const state = record.hydration;
		if (state === undefined) return;
		const at = state.hydratedAt ?? clock.now();
		const event: WorkspaceHydratedEvent = {
			type: "workspace.hydrated",
			workspaceId: record.id,
			organisationId,
			...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
			at,
			elapsedMs,
			entriesTotal: state.entriesTotal,
			bytesTotal: state.bytesTotal,
		};
		try {
			void Promise.resolve(hydration?.onHydrated?.(event)).catch(() => undefined);
		} catch {
			// A sink never fails the workspace.
		}
		await emit({
			id: `workspace:hydrated:${record.id}`,
			at,
			source: "workspace",
			type: "workspace.hydrated",
			actor: AUDIT_CONTEXT.actor,
			organisationId,
			...(record.owner.kind === "project" ? { projectId: record.owner.projectId } : {}),
			...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
			subject: { kind: "workspace", id: record.id },
			data: { entriesTotal: state.entriesTotal, bytesTotal: state.bytesTotal, elapsedMs },
		});
	}

	/** Copies one pack's bodies out to their blobs, once per instance at a time; a pack marked done is skipped. */
	function explode(key: string): Promise<void> {
		const running = exploding.get(key);
		if (running !== undefined) return running;
		const work = explodeOnce(key).finally(() => exploding.delete(key));
		exploding.set(key, work);
		return work;
	}

	async function explodeOnce(key: string): Promise<void> {
		if ((await store.getObject(packDoneKey(key))) !== undefined) {
			packs.release(key);
			return;
		}
		const bytes = packs.held(key) ?? (await store.getObject(key));
		if (bytes === undefined) throw new KantelError("unavailable", `workspace pack ${key} is missing`);
		const index = await packs.index(key);
		// Blobs sit beside the pack, under the same organisation's prefix.
		const blobs = `${key.slice(0, key.lastIndexOf("/packs/"))}/blobs`;
		await inBatches([...index], async ([digest, [offset, length]]) => {
			const body = bytes.slice(offset, offset + length);
			// A blob's key is its content's hash: a damaged pack must never put wrong bytes under one.
			if ((await sha256Hex(body)) !== digest) {
				throw new KantelError("unavailable", `workspace pack ${key} does not match its index`);
			}
			await store.putObject(`${blobs}/${digest}`, body);
		});
		await store.putObject(packDoneKey(key), new Uint8Array(0));
		packs.release(key);
	}

	/** Writes staging packs and their indexes, all at once. */
	async function writePacks(built: readonly BuiltPack[]): Promise<void> {
		await inBatches(
			built.flatMap((pack) => [
				[pack.key, pack.bytes] as const,
				[packIndexKey(pack.key), serialisePackIndex(pack.index)] as const,
			]),
			([objectKey, bytes]) => store.putObject(objectKey, bytes),
		);
	}

	async function treeAt(head: LoadedHead, version: WorkspaceVersion | undefined): Promise<Tree> {
		if (version === undefined) return readTreeObject(head.tree);
		if (!Number.isInteger(version) || version < 0) throw new KantelError("invalid", `bad version ${version}`);
		if (version > head.record.head) throw new KantelError("not_found", `version ${version} not found`);
		if (version === head.record.head) return readTreeObject(head.tree);
		const key = await store.treeAt(head, version);
		if (key === undefined) throw new KantelError("not_found", `version ${version} not found`);
		return readTreeObject(key);
	}

	async function readTreeObject(key: string | null): Promise<Tree> {
		if (key === null) return new Map();
		const cached = trees.get(key);
		if (cached !== undefined) return cached;
		const bytes = await store.getObject(key);
		if (bytes === undefined) throw new KantelError("unavailable", `workspace tree ${key} is missing`);
		return trees.set(key, parseTree(new TextDecoder().decode(bytes), key));
	}

	async function readBlobObject(organisationId: string, digest: string): Promise<Uint8Array> {
		const bytes = await store.getObject(blobKey(organisationId, digest));
		if (bytes === undefined) throw new KantelError("unavailable", `workspace blob ${digest} is missing`);
		return bytes;
	}

	/**
	 * Starts writing the blobs `changes` put and `tree`, all at once (up to OBJECT_BATCH in flight). Returns the tree's
	 * key (null for an empty tree), known before anything is written, and the writes.
	 */
	async function writeVersion(
		organisationId: string,
		tree: Tree,
		changes: readonly PreparedChange[],
	): Promise<{ readonly treeKey: string | null; readonly written: Promise<void> }> {
		const objects = new Map<string, Uint8Array>();
		for (const change of changes) {
			if (change.op === "put") objects.set(blobKey(organisationId, change.digest), change.content);
		}
		let treeKey: string | null = null;
		if (tree.size > 0) {
			const bytes = toBytes(serialiseTree(tree));
			treeKey = `${organisationPrefix(organisationId)}/trees/${await sha256Hex(bytes)}.json`;
			objects.set(treeKey, bytes);
		}
		const key = treeKey;
		const written = inBatches([...objects], ([objectKey, bytes]) => store.putObject(objectKey, bytes)).then(() => {
			// Cached only once written: a cached tree is one a head may refer to.
			if (key !== null) trees.set(key, tree);
		});
		// A store may stop before it waits for these (a head that moved); their failure is then only an unreferenced object.
		written.catch(() => {});
		return { treeKey, written };
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

		const seeded = await resolveSeed(ctx, seed, options.seeders ?? {}, clock, mounts, {
			workspaceId: id,
			organisationId: ctx.organisationId,
			...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
			...(options.onSeedStatus === undefined ? {} : { onStatus: options.onSeedStatus }),
		});
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
		// A lazy seed stages its bodies in a few packs, so the workspace is usable once the tree and packs are written.
		const bodies = new Map<string, Uint8Array>();
		for (const change of prepared) if (change.op === "put") bodies.set(change.digest, change.content);
		const lazy =
			hydration !== undefined &&
			(seed?.hydration ?? hydration.default ?? "lazy") === "lazy" &&
			bodies.size > (hydration.minBodies ?? OBJECT_BATCH);
		const staging = lazy
			? await buildPacks(organisationPrefix(ctx.organisationId), bodies, hydration?.packBytes ?? PACK_BYTES)
			: undefined;
		const { treeKey, written } = await writeVersion(ctx.organisationId, tree, staging === undefined ? prepared : []);
		if (staging !== undefined) for (const pack of staging) packs.hold(pack);
		await Promise.all([written, staging === undefined ? undefined : writePacks(staging)]);
		const now = clock.now();
		const versions: StoredVersion[] = [{ info: { version: 0, at: now, actor: ctx.actor, changed: [] }, tree: null }];
		if (treeKey !== null) {
			versions.push({
				info: { version: 1, at: now, actor: ctx.actor, changed: [...tree.keys()].sort(compare), message: "seed" },
				tree: treeKey,
			});
		}
		const record: StoredRecord = {
			id,
			owner: input.owner,
			...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
			head: versions.length - 1,
			mounts,
			...(seed === undefined ? {} : { seed }),
			seedReadiness: seeded.readiness,
			...(seeded.report === undefined ? {} : { seedReport: seeded.report }),
			...(staging === undefined
				? {}
				: {
						hydration: { hydrated: false, entriesTotal: tree.size, bytesTotal: treeBytes(tree), startedAt: now },
						staged: staging.map((pack) => pack.key),
					}),
			createdAt: now,
			updatedAt: now,
		};
		if (await store.create({ organisationId: ctx.organisationId, record, tree: treeKey }, versions)) {
			if (staging !== undefined) startHydration(id);
			return publicRecord(record);
		}
		// A racing `ensure` created it while this one worked; the first one wins.
		const raced = await store.load(id);
		if (staging !== undefined) {
			const kept = new Set(raced === undefined ? [] : stagedOf(raced.record));
			for (const pack of staging) if (!kept.has(pack.key) && !exploding.has(pack.key)) packs.release(pack.key);
		}
		if (keyed && raced !== undefined && raced.organisationId === ctx.organisationId) {
			// The winner may be another project's: the loser sees it only as any existing workspace would be seen.
			await checks.requireWorkspace(ctx, raced.record, "viewer", "workspace.get");
			return publicRecord(raced.record);
		}
		throw new KantelError("conflict", `workspace ${id} is taken`);
	}

	async function fork(ctx: CallContext, id: WorkspaceId, input: ForkWorkspaceInput): Promise<WorkspaceRecord> {
		const source = await load(ctx, id);
		// Reading the source's tree is what a fork does with it: viewer, as for reading it.
		await checks.requireWorkspace(ctx, source.record, "viewer", "workspace.fork");
		checkOwner(ctx, input.owner);
		await checks.requireCreate(ctx, input.owner, input.sessionId);
		// The fork keeps the source's pins, so its owner must be allowed to mount them, as at create.
		await checks.requireMounts(ctx, source.record.mounts);
		// A seed still being fetched would never reach the fork, which would wait at `metadata` for good.
		if (source.record.seedReadiness === "pending" || source.record.seedReadiness === "metadata") {
			throw new KantelError("conflict", `workspace ${id} is still seeding; fork it once its files are in`);
		}
		const version = input.version ?? source.record.head;
		const base = await treeAt(source, version);
		// The fork's history starts at its version 1, so every path was last changed there. Only the tree is written: the
		// bodies are the source's, in the same organisation's blobs (or its staging packs, which the fork reads too).
		const tree = new Map<string, TreeFile>();
		for (const [path, file] of base) tree.set(path, { ...file, version: 1 });
		const { treeKey, written } = await writeVersion(source.organisationId, tree, []);
		await written;
		const forkId: WorkspaceId = `ws_${crypto.randomUUID()}`;
		const now = clock.now();
		const versions: StoredVersion[] = [{ info: { version: 0, at: now, actor: ctx.actor, changed: [] }, tree: null }];
		if (treeKey !== null) {
			versions.push({
				info: {
					version: 1,
					at: now,
					actor: ctx.actor,
					changed: [...tree.keys()].sort(compare),
					message: `fork of ${id} at version ${version}`,
				},
				tree: treeKey,
			});
		}
		const staged = treeKey === null ? [] : stagedOf(source.record);
		const from = source.record;
		const record: StoredRecord = {
			id: forkId,
			owner: input.owner,
			...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
			head: versions.length - 1,
			mounts: from.mounts,
			...(from.seed === undefined ? {} : { seed: from.seed }),
			seedReadiness: from.seedReadiness,
			...(from.seedReport === undefined ? {} : { seedReport: from.seedReport }),
			...(staged.length === 0
				? {}
				: {
						hydration: { hydrated: false, entriesTotal: tree.size, bytesTotal: treeBytes(tree), startedAt: now },
						staged,
					}),
			forkedFrom: { workspaceId: id, version },
			createdAt: now,
			updatedAt: now,
		};
		const head: StoredHead = { organisationId: source.organisationId, record, tree: treeKey };
		if (!(await store.create(head, versions))) throw new KantelError("conflict", `workspace ${forkId} is taken`);
		await emit({
			...auditBase(ctx, head),
			id: `workspace:forked:${forkId}`,
			type: "workspace.forked",
			data: { from: id, version, entries: tree.size },
		});
		if (staged.length > 0) startHydration(forkId);
		return publicRecord(record);
	}

	const workspaces: StoredWorkspaces = {
		create: (ctx, input) => create(ctx, input, `ws_${crypto.randomUUID()}`),

		async ensure(ctx, id, input) {
			checkKeyedId(id);
			const existing = await store.load(id);
			if (existing === undefined) return create(ctx, input, id, true);
			if (existing.organisationId !== ctx.organisationId) {
				throw new KantelError("conflict", `workspace ${id} is taken`);
			}
			await checks.requireWorkspace(ctx, existing.record, "viewer", "workspace.get");
			return publicRecord(existing.record);
		},

		async get(ctx, id) {
			const head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "viewer", "workspace.get");
			return publicRecord(head.record);
		},

		fork,

		async hydrationSettled() {
			while (hydrating.size > 0) await Promise.allSettled([...hydrating.values()]);
		},

		packReads: packs.counts,

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
				const read = await sources.read(ctx, mount, sourcePath, path);
				checkReadSize(path, read.content.byteLength, readOptions?.maxBytes);
				return read;
			}
			const file = readTree(await treeAt(head, readOptions?.version), normalizeWorkspacePath(path));
			// The tree holds the size, so a file over the limit is refused before its body is fetched.
			checkReadSize(path, file.size, readOptions?.maxBytes);
			const content = await readBody(head, file.digest);
			return { path, content, version: file.version, digest: file.digest };
		},

		async readBlob(ctx, id, digest, blobOptions) {
			const head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "viewer", "workspace.read");
			if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
				throw new KantelError("invalid", "bad digest");
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
				throw new KantelError("not_found", `no file with digest ${digest} at version ${blobOptions.version}`);
			}
			return readBody(head, digest);
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
				throw new KantelError("refused", "mounts are read-only; write through the source's tools", {
					paths: refused,
				});
			}
			if (request.changes.length === 0) throw new KantelError("invalid", "a commit needs at least one change");
			const prepared = await prepareChanges(request.changes);
			const stale = (current: number) =>
				new KantelError("conflict", `base version ${request.baseVersion} is not the head`, {
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
			// Objects before the head: until the head moves below, nothing refers to them. A store that writes alongside
			// takes them in flight, with its own writes before the head; any other gets them written first.
			const { treeKey, written } = await writeVersion(head.organisationId, tree, prepared);
			const alongside = store.writesAlongside === true;
			if (!alongside) await written;
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
				// A cancelled caller (or a lapsed guard) stops the commit as late as the store can check: nothing refers to
				// the objects written so far.
				const check = () => {
					requireNotAborted(ctx);
					request.guard?.();
				};
				check();
				const advanced = await store.advance(
					head,
					next,
					{ info, tree: treeKey },
					alongside ? { check, objects: written } : { check },
				);
				if (advanced) break;
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
				if (!Number.isInteger(cursor)) throw new KantelError("invalid", "bad cursor");
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
				throw new KantelError("not_found", `no mount at ${path}`, { path });
			}
			const mount = await sources.resolve(ctx, request);
			for (let attempt = 1; ; attempt++) {
				const mounts = head.record.mounts.map((existing) => (existing.path === path ? mount : existing));
				const record: WorkspaceRecord = { ...head.record, mounts, updatedAt: clock.now() };
				if (await store.update(head, { organisationId: head.organisationId, record, tree: head.tree })) {
					return publicRecord(record);
				}
				if (attempt >= HEAD_ATTEMPTS) throw new KantelError("conflict", "the workspace changed during the remount");
				head = await load(ctx, id);
			}
		},

		async recordDependencies(ctx, id, update) {
			let head = await load(ctx, id);
			await checks.requireWorkspace(ctx, head.record, "operator", "workspace.seed");
			for (let attempt = 1; ; attempt++) {
				// Checked against each head loaded: a racing stage that recorded first leaves this one in conflict.
				const { record, event } = dependencyStage(head.record, head.organisationId, update, clock.now());
				if (await store.update(head, { organisationId: head.organisationId, record, tree: head.tree })) {
					sendSeedStatus(options.onSeedStatus, event);
					return publicRecord(record);
				}
				if (attempt >= HEAD_ATTEMPTS) throw new KantelError("conflict", "the workspace changed during the update");
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
				content: await readBody(head, file.digest),
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

function treeBytes(tree: Tree): number {
	let total = 0;
	for (const file of tree.values()) total += file.size;
	return total;
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
	const corrupt = () => new KantelError("unavailable", `workspace tree ${key} is malformed`);
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
	readonly counts: { blobReads: number; treeReads: number; objectWrites: number; packReads: number };
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
	const counts = { blobReads: 0, treeReads: 0, objectWrites: 0, packReads: 0 };
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
		writesAlongside: true,
		async advance(head, next, version, options) {
			await options?.objects;
			options?.check?.();
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
			else if (key.includes("/packs/")) counts.packReads++;
			else counts.treeReads++;
			return new Uint8Array(bytes);
		},
		async getObjectRange(key, offset, length) {
			const bytes = objects.get(key);
			if (bytes === undefined) return undefined;
			counts.packReads++;
			return bytes.slice(offset, offset + length);
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
