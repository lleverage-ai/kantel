/**
 * `Workspaces` (from @harbour/contracts) on object storage: R2 when deployed, an in-memory store in tests.
 *
 * Layout under `ws/<id>/`:
 *   head                      the record, the organisation and the key of the head manifest. Replaced only with a
 *                             conditional put on its etag, so a stale writer fails with `conflict` instead of losing a
 *                             write.
 *   versions/<n>-<nonce>.json immutable manifests: every path's digest, size, mode and the version that last changed it,
 *                             plus the version's history entry and its parent's key. The nonce keeps two racing writers
 *                             of version n from overwriting each other's manifest; only the one that wins the head swap
 *                             is ever referenced.
 *   blobs/<sha256>            content-addressed bodies, read lazily.
 *
 * Listing reads only manifests, never bodies. Mounts are read through their `MountSource`, as in the memory target.
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
	type MountRequest,
	type MountSource,
	type MountSourceKind,
	type OwnerRef,
	type Page,
	type PageRequest,
	type SeedReadiness,
	type SeedSpec,
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
	findMount,
	isUnderMount,
	normalizeMountPoint,
	normalizeWorkspacePath,
	sha256Hex,
	toBytes,
} from "@harbour/workspace";

/** The part of R2's bucket API the workspace uses. `R2Bucket` satisfies it; tests use an in-memory store. */
export interface ObjectStore {
	get(key: string): Promise<StoredObject | null>;
	put(key: string, value: string | Uint8Array, options?: { onlyIf?: Conditional }): Promise<{ etag: string } | null>;
}

export interface StoredObject {
	readonly etag: string;
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Conditional {
	readonly etagMatches?: string;
	readonly etagDoesNotMatch?: string;
}

/**
 * A `FileEntry` with the POSIX mode bits the spike keeps alongside the contract's fields, so an executable stays
 * executable across tiers. The contract has no mode yet (see the README's reconciliation notes).
 */
export type ModedFileEntry = FileEntry & { readonly mode?: number };

/** A put that may carry mode bits; the contract's `WorkspaceChange` has none. */
export type ModedChange = WorkspaceChange & { readonly mode?: number };

interface StoredEntry {
	readonly digest: string;
	readonly size: number;
	/** The version that last changed the path. */
	readonly version: number;
	readonly mode?: number;
}

interface Manifest {
	readonly version: WorkspaceVersion;
	/** Key of the parent manifest; null for version 0. */
	readonly parent: string | null;
	readonly info: WorkspaceVersionInfo;
	readonly files: { readonly [path: string]: StoredEntry };
}

interface HeadDocument {
	readonly organisationId: string;
	readonly record: WorkspaceRecord;
	/** Key suffix of the head manifest, such as `3-a1b2c3`. */
	readonly manifest: string;
}

type Tree = ReadonlyMap<string, StoredEntry>;

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

export interface ObjectStoreWorkspacesOptions {
	readonly store: ObjectStore;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	readonly sources?: readonly MountSource[];
}

export class ObjectStoreWorkspaces implements Workspaces {
	readonly #store: ObjectStore;
	readonly #clock: Clock;
	readonly #audit: AuditSink | undefined;
	readonly #sources = new Map<MountSourceKind, MountSource>();
	/** Manifests are immutable, so a cache by key is always valid. */
	readonly #manifests = new Map<string, Manifest>();
	/** Committed version number to manifest key, per workspace; fixed once committed. */
	readonly #versionKeys = new Map<string, Map<number, string>>();

	constructor(options: ObjectStoreWorkspacesOptions) {
		this.#store = options.store;
		this.#clock = options.clock ?? systemClock;
		this.#audit = options.audit;
		for (const source of options.sources ?? []) {
			if (this.#sources.has(source.kind)) throw new HarbourError("invalid", `two mount sources of kind ${source.kind}`);
			this.#sources.set(source.kind, source);
		}
	}

	// ---- create and read ---------------------------------------------------------------------------------------------

	create(ctx: CallContext, input: Parameters<Workspaces["create"]>[1]): Promise<WorkspaceRecord> {
		return this.createWithId(ctx, `ws_${crypto.randomUUID()}`, input);
	}

	/**
	 * `create` with an ID the caller chose, for the spike's scenario surface, which names workspaces. Rejects with
	 * `conflict` when the ID exists. A crash part way leaves only unreferenced objects, so a retry can still create it.
	 */
	async createWithId(
		ctx: CallContext,
		id: WorkspaceId,
		input: Parameters<Workspaces["create"]>[1],
	): Promise<WorkspaceRecord> {
		checkOwner(ctx, input.owner);
		if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) throw new HarbourError("invalid", `bad workspace id ${id}`);
		const seed = input.seed;
		const seedFiles = new Map<string, string>();
		for (const source of seed?.sources ?? []) {
			if (source.kind !== "files") continue;
			for (const [path, content] of Object.entries(source.files)) seedFiles.set(normalizeWorkspacePath(path), content);
		}
		const shape = treeShapeConflict(seedFiles.keys());
		if (shape !== undefined) throw new HarbourError("invalid", shape);

		const requests = new Map<string, MountRequest>();
		for (const request of [...(seed?.mounts ?? []), ...(input.mounts ?? [])]) requests.set(request.path, request);
		const mounts: Mount[] = [];
		for (const request of requests.values()) mounts.push(await this.#resolveMount(ctx, request));
		checkMountsDisjoint(mounts);

		const now = this.#clock.now();
		const empty: Manifest = {
			version: 0,
			parent: null,
			info: { version: 0, at: now, actor: ctx.actor, changed: [] },
			files: {},
		};
		let headKey = await this.#putManifest(id, empty);
		if (seedFiles.size > 0) {
			const files = fileTable();
			for (const [path, content] of seedFiles) {
				const bytes = toBytes(content);
				files[path] = { digest: await this.#putBlob(id, bytes), size: bytes.byteLength, version: 1 };
			}
			const changed = [...seedFiles.keys()].sort(compare);
			headKey = await this.#putManifest(id, {
				version: 1,
				parent: headKey,
				info: { version: 1, at: now, actor: ctx.actor, changed, message: "seed" },
				files,
			});
		}
		const record: WorkspaceRecord = {
			id,
			owner: input.owner,
			...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
			head: seedFiles.size > 0 ? 1 : 0,
			mounts,
			...(seed === undefined ? {} : { seed }),
			seedReadiness: seedReadiness(seed),
			createdAt: now,
			updatedAt: now,
		};
		const document: HeadDocument = { organisationId: ctx.organisationId, record, manifest: headKey };
		const created = await this.#store.put(headPath(id), JSON.stringify(document), {
			onlyIf: { etagDoesNotMatch: "*" },
		});
		if (created === null) throw new HarbourError("conflict", `workspace ${id} already exists`);
		return record;
	}

	/** Whether a workspace with this ID exists in the caller's organisation. */
	async exists(ctx: CallContext, id: WorkspaceId): Promise<boolean> {
		try {
			await this.#head(ctx, id);
			return true;
		} catch (error) {
			if (error instanceof HarbourError && error.code === "not_found") return false;
			throw error;
		}
	}

	async get(ctx: CallContext, id: WorkspaceId): Promise<WorkspaceRecord> {
		return (await this.#head(ctx, id)).document.record;
	}

	async list(ctx: CallContext, id: WorkspaceId, options: ListOptions = {}): Promise<Page<ModedFileEntry>> {
		const { document } = await this.#head(ctx, id);
		const limit = pageLimit(options.limit);
		const after = decodeCursor(options.cursor);
		const path = options.path ?? "";
		const recursive = options.recursive === true;
		let entries: ModedFileEntry[];
		if (path.startsWith("/")) {
			const { mount, sourcePath } = mountAt(document.record, path);
			entries = await listMount(ctx, this.#sourceFor(mount.source), mount, sourcePath, recursive);
		} else {
			const dir = path === "" ? "" : normalizeWorkspacePath(path);
			entries = treeEntries(await this.#treeAt(id, document, options.version), dir, recursive);
		}
		entries.sort((left, right) => compare(left.path, right.path));
		return pageByPath(entries, after, limit);
	}

	async stat(
		ctx: CallContext,
		id: WorkspaceId,
		path: string,
		options?: { readonly version?: WorkspaceVersion },
	): Promise<ModedFileEntry> {
		const { document } = await this.#head(ctx, id);
		if (path.startsWith("/")) {
			const { mount, sourcePath } = mountAt(document.record, path);
			if (sourcePath === "") return { path: mount.path, kind: "directory", size: 0, version: mount.version };
			const parent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
			const siblings = await this.#sourceFor(mount.source).list(ctx, mount.ref, mount.version, parent);
			const entry = siblings.find((candidate) => candidate.path === sourcePath);
			if (entry === undefined) throw new HarbourError("not_found", `${path} not found`, { path });
			return { ...entry, path: `${mount.path}/${entry.path}` };
		}
		return statTree(await this.#treeAt(id, document, options?.version), normalizeWorkspacePath(path));
	}

	async read(
		ctx: CallContext,
		id: WorkspaceId,
		path: string,
		options?: { readonly version?: WorkspaceVersion },
	): Promise<FileContent> {
		const { document } = await this.#head(ctx, id);
		if (path.startsWith("/")) {
			const { mount, sourcePath } = mountAt(document.record, path);
			if (sourcePath === "") throw new HarbourError("invalid", `${path} is a directory`, { path });
			const content = toBytes(await this.#sourceFor(mount.source).read(ctx, mount.ref, mount.version, sourcePath));
			return { path, content, version: mount.version, digest: await sha256Hex(content) };
		}
		const tree = await this.#treeAt(id, document, options?.version);
		const entry = readTree(tree, normalizeWorkspacePath(path));
		return { path, content: await this.#blob(id, entry.digest), version: entry.version, digest: entry.digest };
	}

	/** Reads a body by its digest, for tiers that already hold a listing. Not part of the contract. */
	async readBlob(ctx: CallContext, id: WorkspaceId, digest: string): Promise<Uint8Array> {
		await this.#head(ctx, id);
		if (!/^[0-9a-f]{64}$/.test(digest)) throw new HarbourError("invalid", "bad digest");
		return this.#blob(id, digest);
	}

	// ---- write -------------------------------------------------------------------------------------------------------

	async commit(ctx: CallContext, id: WorkspaceId, request: CommitRequest): Promise<CommitResult> {
		const { document, etag } = await this.#head(ctx, id);
		const record = document.record;
		const refused = request.changes
			.map((change) => change.path)
			.filter((path) => typeof path === "string" && path.startsWith("/") && isUnderMount(path, record.mounts));
		if (refused.length > 0) {
			await this.#emit({
				...this.#auditBase(ctx, document),
				id: `workspace:refused:${id}:${crypto.randomUUID()}`,
				type: "workspace.write.refused",
				data: { paths: refused, reason: "read-only mount" },
			});
			throw new HarbourError("refused", "mounts are read-only; write through the source's tools", { paths: refused });
		}
		if (request.changes.length === 0) throw new HarbourError("invalid", "a commit needs at least one change");
		const prepared = await prepareChanges(request.changes as readonly ModedChange[]);
		if (request.baseVersion !== record.head) {
			throw new HarbourError("conflict", `base version ${request.baseVersion} is not the head`, {
				head: record.head,
				baseVersion: request.baseVersion,
			});
		}

		const version = record.head + 1;
		const parent = await this.#manifest(id, document.manifest);
		const files = fileTable(parent.files);
		for (const change of prepared) {
			if (change.op === "delete") {
				if (files[change.path] === undefined) {
					throw new HarbourError("not_found", `${change.path} not found`, { path: change.path });
				}
				delete files[change.path];
			} else {
				const mode = change.mode ?? files[change.path]?.mode;
				files[change.path] = {
					digest: change.digest,
					size: change.content.byteLength,
					version,
					...(mode === undefined ? {} : { mode }),
				};
			}
		}
		const shape = treeShapeConflict(Object.keys(files));
		if (shape !== undefined) throw new HarbourError("invalid", shape);

		for (const change of prepared) if (change.op === "put") await this.#putBlob(id, change.content, change.digest);
		const now = this.#clock.now();
		const changed = prepared.map((change) => change.path).sort(compare);
		const info: WorkspaceVersionInfo = {
			version,
			at: now,
			actor: ctx.actor,
			changed,
			...(request.message === undefined ? {} : { message: request.message }),
		};
		const key = await this.#putManifest(id, { version, parent: document.manifest, info, files });
		const next: HeadDocument = { ...document, record: { ...record, head: version, updatedAt: now }, manifest: key };
		const swapped = await this.#store.put(headPath(id), JSON.stringify(next), { onlyIf: { etagMatches: etag } });
		if (swapped === null) {
			const head = (await this.#head(ctx, id)).document.record.head;
			throw new HarbourError("conflict", `the head moved to ${head} during the commit`, {
				head,
				baseVersion: request.baseVersion,
			});
		}
		await this.#emit({
			...this.#auditBase(ctx, document),
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
	}

	async history(ctx: CallContext, id: WorkspaceId, page: PageRequest = {}): Promise<Page<WorkspaceVersionInfo>> {
		const { document } = await this.#head(ctx, id);
		const limit = pageLimit(page.limit);
		// The cursor names the next manifest to read, so a page costs `limit` manifest reads wherever it starts.
		const after = decodeCursor(page.cursor);
		if (after !== undefined && !MANIFEST_KEY.test(after)) throw new HarbourError("invalid", "bad cursor");
		const items: WorkspaceVersionInfo[] = [];
		let key: string | null = after ?? document.manifest;
		while (key !== null && items.length < limit) {
			const manifest: Manifest = await this.#manifest(id, key);
			this.#rememberVersion(id, manifest.version, key);
			items.push(manifest.info);
			key = manifest.parent;
		}
		return key !== null && items.length > 0 ? { items, nextCursor: encodeCursor(key) } : { items };
	}

	async remount(ctx: CallContext, id: WorkspaceId, request: MountRequest): Promise<WorkspaceRecord> {
		const { document, etag } = await this.#head(ctx, id);
		const path = normalizeMountPoint(request.path);
		const index = document.record.mounts.findIndex((mount) => mount.path === path);
		if (index < 0) throw new HarbourError("not_found", `no mount at ${path}`, { path });
		const mount = await this.#resolveMount(ctx, request);
		const mounts = document.record.mounts.map((existing, at) => (at === index ? mount : existing));
		const record = { ...document.record, mounts, updatedAt: this.#clock.now() };
		const swapped = await this.#store.put(headPath(id), JSON.stringify({ ...document, record }), {
			onlyIf: { etagMatches: etag },
		});
		if (swapped === null) throw new HarbourError("conflict", "the workspace changed during the remount");
		return record;
	}

	async export(ctx: CallContext, id: WorkspaceId, prefixes: readonly string[]): Promise<readonly FileContent[]> {
		const { document } = await this.#head(ctx, id);
		for (const prefix of prefixes) {
			if (typeof prefix !== "string" || prefix.startsWith("/") || prefix.includes("\\")) {
				throw new HarbourError("invalid", "export prefixes are relative workspace prefixes such as notes/", {
					prefix: String(prefix),
				});
			}
		}
		const files: FileContent[] = [];
		for (const [path, entry] of await this.#treeAt(id, document, undefined)) {
			if (!prefixes.some((prefix) => path.startsWith(prefix))) continue;
			files.push({ path, content: await this.#blob(id, entry.digest), version: entry.version, digest: entry.digest });
		}
		return files.sort((left, right) => compare(left.path, right.path));
	}

	// ---- internals ---------------------------------------------------------------------------------------------------

	async #head(ctx: CallContext, id: WorkspaceId): Promise<{ document: HeadDocument; etag: string }> {
		if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(id)) {
			throw new HarbourError("not_found", `workspace ${String(id)} not found`);
		}
		const object = await this.#store.get(headPath(id));
		if (object === null) throw new HarbourError("not_found", `workspace ${id} not found`);
		const document = JSON.parse(await object.text()) as HeadDocument;
		// Another organisation's workspace looks exactly like a missing one.
		if (document.organisationId !== ctx.organisationId)
			throw new HarbourError("not_found", `workspace ${id} not found`);
		this.#rememberVersion(id, document.record.head, document.manifest);
		return { document, etag: object.etag };
	}

	async #treeAt(id: WorkspaceId, document: HeadDocument, version: WorkspaceVersion | undefined): Promise<Tree> {
		if (version === undefined) return toTree(await this.#manifest(id, document.manifest));
		if (!Number.isInteger(version) || version < 0) throw new HarbourError("invalid", `bad version ${version}`);
		if (version > document.record.head) throw new HarbourError("not_found", `version ${version} not found`);
		const known = this.#versionKeys.get(id)?.get(version);
		if (known !== undefined) return toTree(await this.#manifest(id, known));
		let key: string | null = document.manifest;
		while (key !== null) {
			const manifest: Manifest = await this.#manifest(id, key);
			this.#rememberVersion(id, manifest.version, key);
			if (manifest.version === version) return toTree(manifest);
			key = manifest.parent;
		}
		throw new HarbourError("not_found", `version ${version} not found`);
	}

	#rememberVersion(id: WorkspaceId, version: number, key: string): void {
		let keys = this.#versionKeys.get(id);
		if (keys === undefined) {
			keys = new Map();
			this.#versionKeys.set(id, keys);
		}
		keys.set(version, key);
	}

	async #manifest(id: WorkspaceId, key: string): Promise<Manifest> {
		const cacheKey = `${id}/${key}`;
		const cached = this.#manifests.get(cacheKey);
		if (cached !== undefined) return cached;
		const object = await this.#store.get(`ws/${id}/versions/${key}.json`);
		if (object === null) throw new HarbourError("unavailable", `workspace ${id} is missing manifest ${key}`);
		const manifest = JSON.parse(await object.text()) as Manifest;
		this.#manifests.set(cacheKey, manifest);
		return manifest;
	}

	/** Writes a manifest under a fresh key. Create-only, so a racing writer can never replace a published manifest. */
	async #putManifest(id: WorkspaceId, manifest: Manifest): Promise<string> {
		const body = JSON.stringify(manifest);
		for (let attempt = 0; attempt < 3; attempt++) {
			const key = `${manifest.version}-${nonce()}`;
			const put = await this.#store.put(`ws/${id}/versions/${key}.json`, body, {
				onlyIf: { etagDoesNotMatch: "*" },
			});
			if (put === null) continue;
			this.#manifests.set(`${id}/${key}`, manifest);
			return key;
		}
		throw new HarbourError("unavailable", "could not write a manifest under a fresh key");
	}

	async #putBlob(id: WorkspaceId, bytes: Uint8Array, digest?: string): Promise<string> {
		const hash = digest ?? (await sha256Hex(bytes));
		await this.#store.put(`ws/${id}/blobs/${hash}`, bytes);
		return hash;
	}

	async #blob(id: WorkspaceId, digest: string): Promise<Uint8Array> {
		const object = await this.#store.get(`ws/${id}/blobs/${digest}`);
		if (object === null) throw new HarbourError("unavailable", `workspace ${id} is missing blob ${digest}`);
		return new Uint8Array(await object.arrayBuffer());
	}

	#sourceFor(kind: MountSourceKind): MountSource {
		const source = this.#sources.get(kind);
		if (source === undefined) throw new HarbourError("invalid", `no mount source of kind ${kind}`);
		return source;
	}

	async #resolveMount(ctx: CallContext, request: MountRequest): Promise<Mount> {
		const path = normalizeMountPoint(request.path);
		const source = this.#sourceFor(request.source);
		let version = request.version;
		if (version === undefined) version = await source.latestVersion(ctx, request.ref);
		else await source.list(ctx, request.ref, version, "");
		return { path, source: request.source, ref: request.ref, version, readOnly: true };
	}

	#auditBase(ctx: CallContext, document: HeadDocument) {
		const sessionId = document.record.sessionId ?? (ctx.actor.kind === "agent" ? ctx.actor.sessionId : undefined);
		return {
			at: this.#clock.now(),
			source: "workspace" as const,
			actor: ctx.actor,
			organisationId: document.organisationId,
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(ctx.actor.kind === "agent" ? { agentId: ctx.actor.agentId } : {}),
			subject: { kind: "workspace", id: document.record.id },
		};
	}

	async #emit(event: AuditEventInput): Promise<void> {
		await this.#audit?.append(systemContext("workspace"), [event]);
	}
}

// ---- helpers, after @harbour/workspace/memory so both targets answer alike ---------------------------------------------

function headPath(id: WorkspaceId): string {
	return `ws/${id}/head`;
}

const MANIFEST_KEY = /^\d+-[0-9a-f]{8,32}$/;

function nonce(): string {
	let hex = "";
	for (const byte of crypto.getRandomValues(new Uint8Array(16))) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/**
 * A manifest's path table. No prototype, so a file named `__proto__` or `constructor` is an ordinary own key that
 * survives `JSON.stringify` and never matches an inherited property.
 */
function fileTable(from?: { readonly [path: string]: StoredEntry }): Record<string, StoredEntry> {
	const table = Object.create(null) as Record<string, StoredEntry>;
	if (from !== undefined) for (const [path, entry] of Object.entries(from)) table[path] = entry;
	return table;
}

function toTree(manifest: Manifest): Tree {
	return new Map(Object.entries(manifest.files));
}

type PreparedChange =
	| {
			readonly op: "put";
			readonly path: string;
			readonly content: Uint8Array;
			readonly digest: string;
			readonly mode?: number;
	  }
	| { readonly op: "delete"; readonly path: string };

async function prepareChanges(changes: readonly ModedChange[]): Promise<PreparedChange[]> {
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
			const mode = typeof change.mode === "number" ? change.mode & 0o777 : undefined;
			prepared.push({
				op: "put",
				path,
				content,
				digest: await sha256Hex(content),
				...(mode === undefined ? {} : { mode }),
			});
		} else {
			throw new HarbourError("invalid", "a change is a put or a delete", { path });
		}
	}
	return prepared;
}

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

function treeEntries(tree: Tree, dir: string, recursive: boolean): ModedFileEntry[] {
	if (dir !== "" && tree.has(dir)) throw new HarbourError("invalid", `${dir} is a file`, { path: dir });
	const prefix = dir === "" ? "" : `${dir}/`;
	const files: ModedFileEntry[] = [];
	const directories = new Map<string, number>();
	let found = dir === "";
	for (const [path, entry] of tree) {
		if (!path.startsWith(prefix)) continue;
		found = true;
		const rest = path.slice(prefix.length).split("/");
		const depth = recursive ? rest.length - 1 : Math.min(rest.length - 1, 1);
		for (let level = 1; level <= depth; level++) {
			const directory = prefix + rest.slice(0, level).join("/");
			directories.set(directory, Math.max(directories.get(directory) ?? 0, entry.version));
		}
		if (recursive || rest.length === 1) files.push(fileEntry(path, entry));
	}
	if (!found) throw new HarbourError("not_found", `${dir} not found`, { path: dir });
	for (const [path, newest] of directories) files.push({ path, kind: "directory", size: 0, version: newest });
	return files;
}

function statTree(tree: Tree, path: string): ModedFileEntry {
	const entry = tree.get(path);
	if (entry !== undefined) return fileEntry(path, entry);
	let newest: number | undefined;
	for (const [candidate, stored] of tree) {
		if (candidate.startsWith(`${path}/`)) newest = Math.max(newest ?? 0, stored.version);
	}
	if (newest === undefined) throw new HarbourError("not_found", `${path} not found`, { path });
	return { path, kind: "directory", size: 0, version: newest };
}

function readTree(tree: Tree, path: string): StoredEntry {
	const entry = tree.get(path);
	if (entry !== undefined) return entry;
	for (const candidate of tree.keys()) {
		if (candidate.startsWith(`${path}/`)) throw new HarbourError("invalid", `${path} is a directory`, { path });
	}
	throw new HarbourError("not_found", `${path} not found`, { path });
}

function fileEntry(path: string, entry: StoredEntry): ModedFileEntry {
	return {
		path,
		kind: "file",
		size: entry.size,
		digest: entry.digest,
		version: entry.version,
		...(entry.mode === undefined ? {} : { mode: entry.mode }),
	};
}

function mountAt(record: WorkspaceRecord, path: string): { mount: Mount; sourcePath: string } {
	const found = findMount(path, record.mounts);
	if (found === undefined) throw new HarbourError("invalid", `${path} is absolute and under no mount`, { path });
	return found;
}

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
	return seed?.sources.some((source) => source.kind !== "files") === true ? "metadata" : "files";
}

function pageLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_PAGE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw new HarbourError("invalid", "limit must be a positive integer");
	return Math.min(limit, MAX_PAGE_LIMIT);
}

function pageByPath<T extends FileEntry>(entries: readonly T[], after: string | undefined, limit: number): Page<T> {
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
		const page: Page<ModedFileEntry> = await workspaces.list(ctx, id, {
			...options,
			recursive: true,
			limit: MAX_PAGE_LIMIT,
			...(cursor === undefined ? {} : { cursor }),
		});
		entries.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return entries;
}
