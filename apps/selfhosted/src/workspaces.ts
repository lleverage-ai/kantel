// Harbour's `Workspaces` contract, durable over Postgres + MinIO. Semantics mirror the in-memory reference
// (packages/workspace/src/memory.ts).
//
// - File bodies are content-addressed blobs in MinIO: `<prefix>/blobs/<sha256>`.
// - Each version's tree is an immutable JSON object in MinIO, `<prefix>/trees/<id>/<version>-<sha256>.json`, mapping
//   path -> { digest, size, version }. The tree's own hash is in the key, so two writers racing for one version never
//   overwrite each other's tree; the winner's key is the one recorded in harbour.ws_versions.
// - Postgres holds the record and the head (sql/003_workspaces_contract.sql). A commit writes its blobs and tree first,
//   then moves the head with `UPDATE ... WHERE head = <base>` in one transaction with its ws_versions row. A lost race
//   is `conflict` and leaves only unreferenced objects behind.

import type { S3Client } from "bun";
import type pg from "pg";
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
	type SeedReadiness,
	type SeedSpec,
	type SessionId,
	systemContext,
	type WorkspaceChange,
	type WorkspaceId,
	type WorkspaceRecord,
	type Workspaces,
	type WorkspaceVersion,
	type WorkspaceVersionInfo,
} from "../../../packages/contracts/src/index.ts";
import {
	findMount,
	isUnderMount,
	normalizeMountPoint,
	normalizeWorkspacePath,
	sha256Hex,
	toBytes,
} from "../../../packages/workspace/src/index.ts";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;
/** Object store requests in flight at once for one call. */
const S3_BATCH = 16;
/** Parsed trees kept in process; trees are immutable, so a cached one is never stale. */
const TREE_CACHE = 256;

interface TreeEntry {
	readonly digest: string;
	readonly size: number;
	/** The version that last changed the file. */
	readonly version: number;
}

type Tree = ReadonlyMap<string, TreeEntry>;

type RecordRow = {
	id: string;
	organisation_id: string;
	owner: OwnerRef;
	session_id: string | null;
	head: number;
	mounts: Mount[];
	seed: SeedSpec | null;
	seed_readiness: SeedReadiness;
	created_at: string | number;
	updated_at: string | number;
};

type VersionRow = {
	version: number;
	at: string | number;
	actor: Actor;
	changed: string[];
	message: string | null;
};

type AtVersion = { readonly version?: WorkspaceVersion };

interface Loaded {
	readonly organisationId: string;
	readonly record: WorkspaceRecord;
}

export interface PostgresWorkspacesOptions {
	readonly pool: pg.Pool;
	readonly s3: S3Client;
	readonly clock: Clock;
	readonly audit?: AuditSink;
	/** Mountable sources, one per kind. */
	readonly sources?: readonly MountSource[];
	/** Key prefix in the bucket; `harbour-workspaces` when absent. */
	readonly prefix?: string;
}

export class PostgresWorkspaces implements Workspaces {
	readonly #pool: pg.Pool;
	readonly #s3: S3Client;
	readonly #clock: Clock;
	readonly #audit: AuditSink | undefined;
	readonly #prefix: string;
	readonly #sources = new Map<MountSourceKind, MountSource>();
	readonly #trees = new Map<string, Tree>();

	constructor(options: PostgresWorkspacesOptions) {
		this.#pool = options.pool;
		this.#s3 = options.s3;
		this.#clock = options.clock;
		this.#audit = options.audit;
		this.#prefix = (options.prefix ?? "harbour-workspaces").replace(/\/+$/, "");
		for (const source of options.sources ?? []) {
			if (this.#sources.has(source.kind)) {
				throw new HarbourError("invalid", `two mount sources of kind ${source.kind}`);
			}
			this.#sources.set(source.kind, source);
		}
	}

	async create(ctx: CallContext, input: Parameters<Workspaces["create"]>[1]): Promise<WorkspaceRecord> {
		checkOwner(ctx, input.owner);
		const seed = input.seed;
		const seedFiles = new Map<string, string>();
		for (const source of seed?.sources ?? []) {
			if (source.kind !== "files") continue;
			for (const [path, content] of Object.entries(source.files)) {
				seedFiles.set(normalizeWorkspacePath(path), content);
			}
		}
		const puts = [...seedFiles].map(([path, content]): WorkspaceChange => ({ op: "put", path, content }));
		const prepared = await prepareChanges(puts);
		const tree = applyChanges(new Map(), prepared, 1);

		const requests = new Map<string, MountRequest>();
		for (const request of [...(seed?.mounts ?? []), ...(input.mounts ?? [])]) requests.set(request.path, request);
		const mounts: Mount[] = [];
		for (const request of requests.values()) mounts.push(await this.#resolveMount(ctx, request));
		checkMountsDisjoint(mounts);

		const id = `ws_${crypto.randomUUID()}`;
		const treeKey = tree.size > 0 ? await this.#writeVersion(id, 1, tree, prepared) : null;
		const now = this.#clock.now();
		const record: WorkspaceRecord = {
			id,
			owner: input.owner,
			...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
			head: treeKey === null ? 0 : 1,
			mounts,
			...(seed === undefined ? {} : { seed }),
			seedReadiness: seedReadiness(seed),
			createdAt: now,
			updatedAt: now,
		};
		const actor = JSON.stringify(ctx.actor);
		await this.#transaction(async (client) => {
			await client.query(
				`INSERT INTO harbour.ws_records
				 (id, organisation_id, owner, session_id, head, mounts, seed, seed_readiness, created_at, updated_at)
				 VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $9)`,
				[
					id,
					ctx.organisationId,
					JSON.stringify(input.owner),
					input.sessionId ?? null,
					record.head,
					JSON.stringify(mounts),
					seed === undefined ? null : JSON.stringify(seed),
					record.seedReadiness,
					now,
				],
			);
			await this.#insertVersion(client, id, 0, now, actor, [], null, null);
			if (treeKey !== null) {
				await this.#insertVersion(client, id, 1, now, actor, [...tree.keys()].sort(), "seed", treeKey);
			}
		});
		return record;
	}

	async get(ctx: CallContext, id: WorkspaceId): Promise<WorkspaceRecord> {
		return (await this.#load(ctx, id)).record;
	}

	async list(ctx: CallContext, id: WorkspaceId, options: ListOptions = {}): Promise<Page<FileEntry>> {
		const { record } = await this.#load(ctx, id);
		const limit = pageLimit(options.limit);
		const after = decodeCursor(options.cursor);
		const path = options.path ?? "";
		const recursive = options.recursive === true;
		let entries: FileEntry[];
		if (path.startsWith("/")) {
			const { mount, sourcePath } = mountAt(record, path);
			entries = await listMount(ctx, this.#sourceFor(mount.source), mount, sourcePath, recursive);
		} else {
			const dir = path === "" ? "" : normalizeWorkspacePath(path);
			entries = treeEntries(await this.#treeAt(record, options.version), dir, recursive);
		}
		entries.sort((left, right) => compare(left.path, right.path));
		return pageByPath(entries, after, limit);
	}

	async stat(ctx: CallContext, id: WorkspaceId, path: string, options?: AtVersion): Promise<FileEntry> {
		const { record } = await this.#load(ctx, id);
		if (path.startsWith("/")) {
			const { mount, sourcePath } = mountAt(record, path);
			if (sourcePath === "") return { path: mount.path, kind: "directory", size: 0, version: mount.version };
			const parent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
			const siblings = await this.#sourceFor(mount.source).list(ctx, mount.ref, mount.version, parent);
			const entry = siblings.find((candidate) => candidate.path === sourcePath);
			if (entry === undefined) throw new HarbourError("not_found", `${path} not found`, { path });
			return { ...entry, path: `${mount.path}/${entry.path}` };
		}
		return statTree(await this.#treeAt(record, options?.version), normalizeWorkspacePath(path));
	}

	async read(ctx: CallContext, id: WorkspaceId, path: string, options?: AtVersion): Promise<FileContent> {
		const { record } = await this.#load(ctx, id);
		if (path.startsWith("/")) {
			const { mount, sourcePath } = mountAt(record, path);
			if (sourcePath === "") throw new HarbourError("invalid", `${path} is a directory`, { path });
			const content = toBytes(await this.#sourceFor(mount.source).read(ctx, mount.ref, mount.version, sourcePath));
			return { path, content, version: mount.version, digest: await sha256Hex(content) };
		}
		const normalized = normalizeWorkspacePath(path);
		const file = readTree(await this.#treeAt(record, options?.version), normalized);
		return { path, content: await this.#readBlob(file.digest), version: file.version, digest: file.digest };
	}

	async commit(ctx: CallContext, id: WorkspaceId, request: CommitRequest): Promise<CommitResult> {
		const { organisationId, record } = await this.#load(ctx, id);
		const refused = request.changes
			.map((change) => change.path)
			.filter((path) => typeof path === "string" && path.startsWith("/") && isUnderMount(path, record.mounts));
		if (refused.length > 0) {
			await this.#audit?.append(systemContext("workspace"), [
				{
					...this.#auditBase(ctx, organisationId, record),
					id: `workspace:refused:${id}:${crypto.randomUUID()}`,
					type: "workspace.write.refused",
					data: { paths: refused, reason: "read-only mount" },
				},
			]);
			throw new HarbourError("refused", "mounts are read-only; write through the source's tools", { paths: refused });
		}
		if (request.changes.length === 0) throw new HarbourError("invalid", "a commit needs at least one change");
		const prepared = await prepareChanges(request.changes);
		const stale = () =>
			new HarbourError("conflict", `base version ${request.baseVersion} is not the head`, {
				baseVersion: request.baseVersion,
			});
		if (request.baseVersion !== record.head) throw stale();

		const version = record.head + 1;
		const tree = applyChanges(await this.#treeAt(record, record.head), prepared, version);
		// Objects first: until the head moves below, nothing refers to them.
		const treeKey = await this.#writeVersion(id, version, tree, prepared);
		const now = this.#clock.now();
		const changed = prepared.map((change) => change.path).sort();
		await this.#transaction(async (client) => {
			const moved = await client.query(
				"UPDATE harbour.ws_records SET head = head + 1, updated_at = $3 WHERE id = $1 AND head = $2",
				[id, record.head, now],
			);
			if (moved.rowCount !== 1) throw stale();
			const actor = JSON.stringify(ctx.actor);
			await this.#insertVersion(client, id, version, now, actor, changed, request.message ?? null, treeKey);
		});
		await this.#audit?.append(systemContext("workspace"), [
			{
				...this.#auditBase(ctx, organisationId, record),
				...(request.writer?.sessionId === undefined ? {} : { sessionId: request.writer.sessionId }),
				id: `workspace:commit:${id}:${version}`,
				type: "workspace.committed",
				data: {
					version,
					changed,
					...(request.writer?.leaseId === undefined ? {} : { leaseId: request.writer.leaseId }),
				},
			},
		]);
		return { version, changed };
	}

	async history(ctx: CallContext, id: WorkspaceId, page: PageRequest = {}): Promise<Page<WorkspaceVersionInfo>> {
		const { record } = await this.#load(ctx, id);
		const limit = pageLimit(page.limit);
		const after = decodeCursor(page.cursor);
		let below = record.head + 1;
		if (after !== undefined) {
			const cursor = Number(after);
			if (!Number.isInteger(cursor)) throw new HarbourError("invalid", "bad cursor");
			below = Math.max(0, Math.min(cursor, below));
		}
		const result = await this.#pool.query<VersionRow>(
			`SELECT version, at, actor, changed, message FROM harbour.ws_versions
			 WHERE workspace_id = $1 AND version < $2 ORDER BY version DESC LIMIT $3`,
			[id, below, limit],
		);
		const items: WorkspaceVersionInfo[] = result.rows.map((row) => ({
			version: row.version,
			at: Number(row.at),
			actor: row.actor,
			changed: row.changed,
			...(row.message === null ? {} : { message: row.message }),
		}));
		const last = items.at(-1);
		return last !== undefined && last.version > 0
			? { items, nextCursor: encodeCursor(String(last.version)) }
			: { items };
	}

	async remount(ctx: CallContext, id: WorkspaceId, request: MountRequest): Promise<WorkspaceRecord> {
		const { record } = await this.#load(ctx, id);
		const path = normalizeMountPoint(request.path);
		const index = record.mounts.findIndex((mount) => mount.path === path);
		if (index < 0) throw new HarbourError("not_found", `no mount at ${path}`, { path });
		const mount = await this.#resolveMount(ctx, request);
		// Mounts are fixed at create and only replaced in place, so the index is stable; jsonb_set avoids a lost update.
		const result = await this.#pool.query<RecordRow>(
			`UPDATE harbour.ws_records SET mounts = jsonb_set(mounts, $2::text[], $3::jsonb), updated_at = $4
			 WHERE id = $1 RETURNING *`,
			[id, [String(index)], JSON.stringify(mount), this.#clock.now()],
		);
		const row = result.rows[0];
		if (row === undefined) throw new HarbourError("not_found", `workspace ${id} not found`);
		return toRecord(row);
	}

	async export(ctx: CallContext, id: WorkspaceId, prefixes: readonly string[]): Promise<readonly FileContent[]> {
		const { record } = await this.#load(ctx, id);
		for (const prefix of prefixes) {
			if (typeof prefix !== "string" || prefix.startsWith("/") || prefix.includes("\\")) {
				throw new HarbourError("invalid", "export prefixes are relative workspace prefixes such as notes/", {
					prefix: String(prefix),
				});
			}
		}
		const selected = [...(await this.#treeAt(record, undefined))]
			.filter(([path]) => prefixes.some((prefix) => path.startsWith(prefix)))
			.sort(([left], [right]) => compare(left, right));
		return inBatches(selected, async ([path, file]) => ({
			path,
			content: await this.#readBlob(file.digest),
			version: file.version,
			digest: file.digest,
		}));
	}

	async #load(ctx: CallContext, id: WorkspaceId): Promise<Loaded> {
		const result = await this.#pool.query<RecordRow>(
			"SELECT * FROM harbour.ws_records WHERE id = $1 AND organisation_id = $2",
			[String(id), ctx.organisationId],
		);
		const row = result.rows[0];
		if (row === undefined) throw new HarbourError("not_found", `workspace ${id} not found`);
		return { organisationId: row.organisation_id, record: toRecord(row) };
	}

	async #treeAt(record: WorkspaceRecord, version: WorkspaceVersion | undefined): Promise<Tree> {
		if (version !== undefined && (!Number.isInteger(version) || version < 0)) {
			throw new HarbourError("invalid", `bad version ${version}`);
		}
		const at = version ?? record.head;
		if (at > record.head) throw new HarbourError("not_found", `version ${at} not found`);
		const result = await this.#pool.query<{ tree_key: string | null }>(
			"SELECT tree_key FROM harbour.ws_versions WHERE workspace_id = $1 AND version = $2",
			[record.id, at],
		);
		const row = result.rows[0];
		if (row === undefined) throw new HarbourError("not_found", `version ${at} not found`);
		if (row.tree_key === null) return new Map();
		const cached = this.#trees.get(row.tree_key);
		if (cached !== undefined) return cached;
		const parsed: unknown = await this.#s3.file(row.tree_key).json();
		return this.#remember(row.tree_key, parseTree(parsed, row.tree_key));
	}

	/** Writes the blobs `changes` put and the tree object for `version`; returns the tree's key. */
	async #writeVersion(id: string, version: number, tree: Tree, changes: readonly PreparedChange[]): Promise<string> {
		const blobs = new Map<string, Uint8Array>();
		for (const change of changes) if (change.op === "put") blobs.set(change.digest, change.content);
		await inBatches([...blobs], ([digest, content]) => this.#s3.write(this.#blobKey(digest), content));
		// Entries hold exactly { digest, size, version }; sorted paths make equal trees serialise to equal bytes.
		const json = JSON.stringify(Object.fromEntries([...tree].sort(([left], [right]) => compare(left, right))));
		const key = `${this.#prefix}/trees/${id}/${version}-${await sha256Hex(toBytes(json))}.json`;
		await this.#s3.write(key, json);
		this.#remember(key, tree);
		return key;
	}

	async #readBlob(digest: string): Promise<Uint8Array> {
		return new Uint8Array(await this.#s3.file(this.#blobKey(digest)).arrayBuffer());
	}

	#blobKey(digest: string): string {
		return `${this.#prefix}/blobs/${digest}`;
	}

	#remember(key: string, tree: Tree): Tree {
		const oldest: string | undefined = this.#trees.keys().next().value;
		if (this.#trees.size >= TREE_CACHE && oldest !== undefined) this.#trees.delete(oldest);
		this.#trees.set(key, tree);
		return tree;
	}

	async #insertVersion(
		client: pg.PoolClient,
		id: string,
		version: number,
		at: number,
		actor: string,
		changed: readonly string[],
		message: string | null,
		treeKey: string | null,
	): Promise<void> {
		await client.query(
			`INSERT INTO harbour.ws_versions (workspace_id, version, at, actor, changed, message, tree_key)
			 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
			[id, version, at, actor, JSON.stringify(changed), message, treeKey],
		);
	}

	async #transaction(run: (client: pg.PoolClient) => Promise<void>): Promise<void> {
		const client = await this.#pool.connect();
		try {
			await client.query("BEGIN");
			await run(client);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
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
		// Listing the root checks that the pinned version exists.
		else await source.list(ctx, request.ref, version, "");
		return { path, source: request.source, ref: request.ref, version, readOnly: true };
	}

	#auditBase(ctx: CallContext, organisationId: string, record: WorkspaceRecord) {
		const sessionId: SessionId | undefined =
			record.sessionId ?? (ctx.actor.kind === "agent" ? ctx.actor.sessionId : undefined);
		return {
			at: this.#clock.now(),
			source: "workspace" as const,
			actor: ctx.actor,
			organisationId,
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(ctx.actor.kind === "agent" ? { agentId: ctx.actor.agentId } : {}),
			subject: { kind: "workspace", id: record.id },
		} satisfies Partial<AuditEventInput>;
	}
}

function toRecord(row: RecordRow): WorkspaceRecord {
	return {
		id: row.id,
		owner: row.owner,
		...(row.session_id === null ? {} : { sessionId: row.session_id }),
		head: row.head,
		mounts: row.mounts,
		...(row.seed === null ? {} : { seed: row.seed }),
		seedReadiness: row.seed_readiness,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function parseTree(value: unknown, key: string): Tree {
	const corrupt = () => new HarbourError("unavailable", `workspace tree ${key} is malformed`);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw corrupt();
	const tree = new Map<string, TreeEntry>();
	for (const [path, entry] of Object.entries(value) as [string, unknown][]) {
		if (typeof entry !== "object" || entry === null) throw corrupt();
		const { digest, size, version } = entry as { digest?: unknown; size?: unknown; version?: unknown };
		if (typeof digest !== "string" || typeof size !== "number" || typeof version !== "number") throw corrupt();
		tree.set(path, { digest, size, version });
	}
	return tree;
}

/** Maps `items` with at most S3_BATCH calls in flight, keeping order. */
async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let start = 0; start < items.length; start += S3_BATCH) {
		results.push(...(await Promise.all(items.slice(start, start + S3_BATCH).map(run))));
	}
	return results;
}

function mountAt(record: WorkspaceRecord, path: string): { mount: Mount; sourcePath: string } {
	const found = findMount(path, record.mounts);
	if (found === undefined) throw new HarbourError("invalid", `${path} is absolute and under no mount`, { path });
	return found;
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
			tree.set(change.path, { digest: change.digest, size: change.content.byteLength, version });
		}
	}
	const files = new Set(tree.keys());
	for (const path of files) {
		for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
			const parent = path.slice(0, slash);
			if (files.has(parent)) throw new HarbourError("invalid", `${parent} is a file, so ${path} cannot be under it`);
		}
	}
	return tree;
}

/** Entries in `dir` (`""` is the root); directories derive from file paths and carry their newest file version. */
function treeEntries(tree: Tree, dir: string, recursive: boolean): FileEntry[] {
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
		if (recursive || rest.length === 1) files.push(fileEntry(path, file));
	}
	if (!found) throw new HarbourError("not_found", `${dir} not found`, { path: dir });
	for (const [path, newest] of directories) files.push({ path, kind: "directory", size: 0, version: newest });
	return files;
}

function statTree(tree: Tree, path: string): FileEntry {
	const file = tree.get(path);
	if (file !== undefined) return fileEntry(path, file);
	let newest: number | undefined;
	for (const [candidate, stored] of tree) {
		if (candidate.startsWith(`${path}/`)) newest = Math.max(newest ?? 0, stored.version);
	}
	if (newest === undefined) throw new HarbourError("not_found", `${path} not found`, { path });
	return { path, kind: "directory", size: 0, version: newest };
}

function readTree(tree: Tree, path: string): TreeEntry {
	const file = tree.get(path);
	if (file !== undefined) return file;
	for (const candidate of tree.keys()) {
		if (candidate.startsWith(`${path}/`)) throw new HarbourError("invalid", `${path} is a directory`, { path });
	}
	throw new HarbourError("not_found", `${path} not found`, { path });
}

function fileEntry(path: string, file: TreeEntry): FileEntry {
	return { path, kind: "file", size: file.size, digest: file.digest, version: file.version };
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

function checkOwner(ctx: CallContext, owner: OwnerRef): void {
	if (owner.kind !== "platform" && owner.organisationId !== ctx.organisationId) {
		throw new HarbourError("forbidden", "a workspace's owner must be in the calling organisation");
	}
}

function checkMountsDisjoint(mounts: readonly Mount[]): void {
	for (const mount of mounts) {
		if (
			isUnderMount(
				mount.path,
				mounts.filter((other) => other !== mount),
			)
		) {
			throw new HarbourError("invalid", `mount ${mount.path} overlaps another mount`, { path: mount.path });
		}
	}
}

function seedReadiness(seed: SeedSpec | undefined): SeedReadiness {
	// Only `files` sources are applied; `git` and `objects` sources stay at their metadata.
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
