/**
 * The Cloudflare `WorkspaceStore`: everything in one R2 bucket. Adapted from spikes/cloudflare's ObjectStoreWorkspaces,
 * which stays in place for the deployment lane; the tree, paging and access logic is `@harbour/workspace/stored`'s,
 * shared with the self-hosted target.
 *
 * Layout under the prefix:
 *   ws/<id>/head            the organisation, the record, the head tree's key and the versions not yet archived (the
 *                           head's own among them). Replaced only by a conditional put on its etag, so a stale writer
 *                           loses instead of overwriting; created only where no head exists.
 *   ws/<id>/versions/<n>    each older version's history entry and tree key, archived by the commit that moves the
 *                           head past it. Every writer racing from one head archives the same entries, so an archive
 *                           put is idempotent; a version is always archived before the head that drops it is written.
 *   org/<org>/blobs, trees  the immutable objects (`@harbour/workspace/stored`'s keys).
 *
 * A commit is two round trips: its blobs, its tree and the archive records go out together (none is referenced until
 * the head moves), then the conditional head put, only once all of them have been written.
 *
 * R2 reads are strongly consistent, so a head read after a put sees it.
 *
 * With `headCache`, each head's document and etag are kept in front of R2, which stays the source of truth: a load
 * that finds the head there makes no R2 request. Every write drops the cached head before it starts, and only a write
 * no other write overlapped puts its own result back, so a read never sees a head older than this store's last write.
 * A cached head that is stale anyway (another writer moved it) fails the next write's conditional put, which drops it.
 */
import { HarbourError, isHarbourError, type WorkspaceId, type WorkspaceRecord } from "@harbour/contracts";
import type { LoadedHead, StoredHead, StoredVersion, WorkspaceStore } from "@harbour/workspace/stored";

/** The part of R2's `R2Bucket` the store uses; the Workers binding and Miniflare's both satisfy it. */
export interface R2BucketLike {
	/** With `range`, only those bytes (a lazy workspace's read out of a staging pack); a bucket may ignore it. */
	get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBodyLike | null>;
	put(
		key: string,
		value: ArrayBuffer | Uint8Array | string,
		options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
	): Promise<{ readonly etag: string } | null>;
}

export interface R2ObjectBodyLike {
	readonly etag: string;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}

interface HeadDocument {
	readonly organisationId: string;
	readonly record: WorkspaceRecord;
	readonly tree: string | null;
	/** Versions not yet archived, oldest first; the last is the head's. */
	readonly recent: readonly StoredVersion[];
}

/** Object store requests in flight at once for one call. */
const BATCH = 16;

/** A head as `HeadCache` keeps it: the head object's text and its etag. */
export interface CachedHead {
	readonly etag: string;
	readonly text: string;
}

/**
 * Somewhere to keep heads in front of R2, such as a Durable Object's synchronous storage (`ctx.storage.kv`).
 * Synchronous on purpose: the store's guards decide whether to `set` just before calling it, so each call must take
 * effect when it is made, in call order. A failed `get` or `set` is only a miss; a failed `delete` fails the write it
 * comes before.
 */
export interface HeadCache {
	get(id: WorkspaceId): CachedHead | undefined;
	set(id: WorkspaceId, head: CachedHead): void;
	delete(id: WorkspaceId): void;
}

export interface R2WorkspaceStoreOptions {
	readonly bucket: R2BucketLike;
	/** Prepended to every key, so several stores (or test runs) share one bucket apart. */
	readonly prefix?: string;
	/**
	 * Heads kept in front of R2. Only for a store that every write to its workspaces goes through, such as the one in
	 * Harbour's single stack object: a write made elsewhere is seen only once a write here fails on it.
	 */
	readonly headCache?: HeadCache;
}

export function createR2WorkspaceStore(options: R2WorkspaceStoreOptions): WorkspaceStore {
	const { bucket, headCache } = options;
	const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
	const at = (key: string) => (prefix === "" ? key : `${prefix}/${key}`);
	const workspaceKey = (id: WorkspaceId) => at(`ws/${encodeURIComponent(id)}`);
	const headKey = (id: WorkspaceId) => `${workspaceKey(id)}/head`;
	const versionKey = (id: WorkspaceId, version: number) => `${workspaceKey(id)}/versions/${version}.json`;
	// The document behind each head this store handed out, so a swap knows which versions to archive.
	const documents = new WeakMap<LoadedHead, HeadDocument>();

	function loaded(document: HeadDocument, etag: string): LoadedHead {
		const head: LoadedHead = {
			organisationId: document.organisationId,
			record: document.record,
			tree: document.tree,
			token: etag,
		};
		documents.set(head, document);
		return head;
	}

	// Writes started, and writes in flight, per workspace. A write puts its head in the cache only if no other write
	// started after it; a load only if no write was in flight when it began and none started before it finished.
	const writes = new Map<WorkspaceId, number>();
	const writesOf = (id: WorkspaceId) => writes.get(id) ?? 0;
	const inFlight = new Map<WorkspaceId, number>();
	const inFlightOf = (id: WorkspaceId) => inFlight.get(id) ?? 0;

	function cached(id: WorkspaceId): CachedHead | undefined {
		try {
			return headCache?.get(id);
		} catch (error) {
			console.warn("harbour: the workspace head cache could not be read", error);
			return undefined;
		}
	}

	// No await between the check and the `set`, so nothing can start in between.
	function remember(id: WorkspaceId, since: number, head: CachedHead): void {
		if (headCache === undefined || writesOf(id) !== since) return;
		try {
			headCache.set(id, head);
		} catch (error) {
			console.warn("harbour: the workspace head cache could not be written", error);
			try {
				headCache.delete(id);
			} catch {}
		}
	}

	/** Runs a write of `id`'s head: drops the cached head first, and caches what it wrote if no other write overlapped. */
	async function writing(
		id: WorkspaceId,
		write: () => Promise<{ readonly etag: string; readonly text: string } | undefined>,
	): Promise<boolean> {
		if (headCache === undefined) return (await write()) !== undefined;
		const since = writesOf(id) + 1;
		writes.set(id, since);
		inFlight.set(id, inFlightOf(id) + 1);
		try {
			headCache.delete(id);
			const written = await write();
			if (written !== undefined) remember(id, since, written);
			return written !== undefined;
		} finally {
			const left = inFlightOf(id) - 1;
			if (left > 0) inFlight.set(id, left);
			else inFlight.delete(id);
		}
	}

	async function documentOf(current: LoadedHead): Promise<HeadDocument> {
		const known = documents.get(current);
		if (known !== undefined) return known;
		const hit = cached(current.record.id);
		if (hit !== undefined && hit.etag === current.token) return parseHead(hit.text, current.record.id);
		const object = await bucket.get(headKey(current.record.id));
		if (object === null || object.etag !== current.token) {
			throw new HarbourError("conflict", `the head of ${current.record.id} moved`);
		}
		return parseHead(await object.text(), current.record.id);
	}

	async function readVersion(id: WorkspaceId, document: HeadDocument, version: number) {
		const recent = document.recent.find((entry) => entry.info.version === version);
		if (recent !== undefined) return recent;
		const object = await bucket.get(versionKey(id, version));
		if (object === null) return undefined;
		return JSON.parse(await object.text()) as StoredVersion;
	}

	async function swap(
		current: LoadedHead,
		next: StoredHead,
		version?: StoredVersion,
		options?: { readonly check?: () => void; readonly objects?: Promise<void> },
	): Promise<boolean> {
		const id = current.record.id;
		if (next.record.id !== id) throw new HarbourError("invalid", "a head cannot change its ID");
		return writing(id, async () => {
			let document: HeadDocument;
			try {
				document = await documentOf(current);
			} catch (error) {
				if (isHarbourError(error, "conflict")) return undefined;
				throw error;
			}
			let recent = document.recent;
			const archived =
				version === undefined
					? undefined
					: inBatches(recent, (entry) => bucket.put(versionKey(id, entry.info.version), JSON.stringify(entry)));
			if (version !== undefined) recent = [version];
			// Archive before the head, alongside the commit's objects: the head written below no longer carries these
			// versions, and it refers to the objects. A failed write of any of them moves nothing.
			await Promise.all([archived, options?.objects]);
			const written: HeadDocument = {
				organisationId: next.organisationId,
				record: next.record,
				tree: next.tree,
				recent,
			};
			const text = JSON.stringify(written);
			// The last moment a commit can stop: the versions archived above are below the head, so harmless.
			options?.check?.();
			const result = await bucket.put(headKey(id), text, { onlyIf: { etagMatches: current.token } });
			return result === null ? undefined : { etag: result.etag, text };
		});
	}

	return {
		async load(id) {
			const hit = cached(id);
			if (hit !== undefined) return loaded(parseHead(hit.text, id), hit.etag);
			const since = writesOf(id);
			const quiet = inFlightOf(id) === 0;
			const object = await bucket.get(headKey(id));
			if (object === null) return undefined;
			const text = await object.text();
			const head = loaded(parseHead(text, id), object.etag);
			if (quiet) remember(id, since, { etag: object.etag, text });
			return head;
		},

		create(head, versions) {
			const document: HeadDocument = { ...head, recent: versions };
			const text = JSON.stringify(document);
			return writing(head.record.id, async () => {
				const result = await bucket.put(headKey(head.record.id), text, { onlyIf: { etagDoesNotMatch: "*" } });
				return result === null ? undefined : { etag: result.etag, text };
			});
		},

		writesAlongside: true,
		advance: (current, next, version, options) => swap(current, next, version, options),
		update: (current, next) => swap(current, next),

		async treeAt(current, version) {
			return (await readVersion(current.record.id, await documentOf(current), version))?.tree;
		},

		async history(current, below, limit) {
			const document = await documentOf(current);
			const wanted: number[] = [];
			for (let version = below - 1; version >= 0 && wanted.length < limit; version--) wanted.push(version);
			const found = await inBatches(wanted, (version) => readVersion(current.record.id, document, version));
			return found.filter((entry) => entry !== undefined).map((entry) => entry.info);
		},

		async getObject(key) {
			const object = await bucket.get(at(key));
			return object === null ? undefined : new Uint8Array(await object.arrayBuffer());
		},

		async getObjectRange(key, offset, length) {
			const object = await bucket.get(at(key), { range: { offset, length } });
			if (object === null) return undefined;
			const bytes = new Uint8Array(await object.arrayBuffer());
			// A bucket that ignored the range sent the whole object.
			return bytes.byteLength === length ? bytes : bytes.slice(offset, offset + length);
		},

		async putObject(key, bytes) {
			await bucket.put(at(key), bytes);
		},
	};
}

function parseHead(text: string, id: WorkspaceId): HeadDocument {
	try {
		const document = JSON.parse(text) as HeadDocument;
		if (typeof document.organisationId === "string" && Array.isArray(document.recent)) return document;
	} catch {}
	throw new HarbourError("unavailable", `the head of workspace ${id} is malformed`);
}

async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let start = 0; start < items.length; start += BATCH) {
		results.push(...(await Promise.all(items.slice(start, start + BATCH).map(run))));
	}
	return results;
}
