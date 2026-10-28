/**
 * Workspace heads kept in the stack object's own storage, in front of R2 (`@harbour/cloudflare-workspace`'s
 * `headCache`). R2 stays the source of truth; this only saves the head read that every workspace call starts with,
 * about 55 ms each from the object (docs/measurements/m1-cf1/README.md), twice in every sandbox run.
 *
 * It is coherent because every write to the workspaces goes through the one stack object's store (M1's single
 * SessionDO; see README.md's Decisions). The store drops a head before writing it and puts back only what it wrote, and
 * a head made stale some other way fails the next write's conditional put, which drops it.
 *
 * Synchronous storage (`ctx.storage.kv`), so a get, set and delete apply in the order they are called.
 */

import type { CachedHead, HeadCache } from "@harbour/cloudflare-workspace";
import type { WorkspaceId } from "@harbour/contracts";

/** The part of a Durable Object's `ctx.storage.kv` the cache uses. */
export interface SyncKvLike {
	get<T = unknown>(key: string): T | undefined;
	put<T>(key: string, value: T): void;
	delete(key: string): boolean;
}

export const WORKSPACE_HEAD_PREFIX = "workspace-head:";

export function durableHeadCache(kv: SyncKvLike): HeadCache {
	const key = (id: WorkspaceId) => `${WORKSPACE_HEAD_PREFIX}${id}`;
	return {
		async get(id) {
			const value = kv.get<CachedHead>(key(id));
			return value !== undefined && typeof value.etag === "string" && typeof value.text === "string"
				? value
				: undefined;
		},
		async set(id, head) {
			kv.put<CachedHead>(key(id), { etag: head.etag, text: head.text });
		},
		async delete(id) {
			kv.delete(key(id));
		},
	};
}
