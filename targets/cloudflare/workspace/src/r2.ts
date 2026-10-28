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
 * R2 reads are strongly consistent, so a head read after a put sees it.
 */
import { HarbourError, isHarbourError, type WorkspaceId, type WorkspaceRecord } from "@harbour/contracts";
import type { LoadedHead, StoredHead, StoredVersion, WorkspaceStore } from "@harbour/workspace/stored";

/** The part of R2's `R2Bucket` the store uses; the Workers binding and Miniflare's both satisfy it. */
export interface R2BucketLike {
	get(key: string): Promise<R2ObjectBodyLike | null>;
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

export interface R2WorkspaceStoreOptions {
	readonly bucket: R2BucketLike;
	/** Prepended to every key, so several stores (or test runs) share one bucket apart. */
	readonly prefix?: string;
}

export function createR2WorkspaceStore(options: R2WorkspaceStoreOptions): WorkspaceStore {
	const { bucket } = options;
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

	async function documentOf(current: LoadedHead): Promise<HeadDocument> {
		const known = documents.get(current);
		if (known !== undefined) return known;
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
		check?: () => void,
	): Promise<boolean> {
		const id = current.record.id;
		if (next.record.id !== id) throw new HarbourError("invalid", "a head cannot change its ID");
		let document: HeadDocument;
		try {
			document = await documentOf(current);
		} catch (error) {
			if (isHarbourError(error, "conflict")) return false;
			throw error;
		}
		let recent = document.recent;
		if (version !== undefined) {
			// Archive first: the head written below no longer carries these.
			await inBatches(recent, (entry) => bucket.put(versionKey(id, entry.info.version), JSON.stringify(entry)));
			recent = [version];
		}
		const written: HeadDocument = { organisationId: next.organisationId, record: next.record, tree: next.tree, recent };
		// The last moment a commit can stop: the versions archived above are below the head, so harmless.
		check?.();
		const result = await bucket.put(headKey(id), JSON.stringify(written), { onlyIf: { etagMatches: current.token } });
		return result !== null;
	}

	return {
		async load(id) {
			const object = await bucket.get(headKey(id));
			if (object === null) return undefined;
			return loaded(parseHead(await object.text(), id), object.etag);
		},

		async create(head, versions) {
			const document: HeadDocument = { ...head, recent: versions };
			const result = await bucket.put(headKey(head.record.id), JSON.stringify(document), {
				onlyIf: { etagDoesNotMatch: "*" },
			});
			return result !== null;
		},

		advance: (current, next, version, options) => swap(current, next, version, options?.check),
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
