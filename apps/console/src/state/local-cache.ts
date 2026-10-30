// What this browser last showed of the console, kept so a reload shows it at once while the API answers
// (stale-while-revalidate): the projects, each project's newest sessions and the sessions last open. The API's answers
// replace it as they come, and are written back.
//
// It belongs to one person: every entry is stored under its owner (organisation and person, from `GET /v1/me`), it is
// opened only once `/v1/me` has said who is signed in, and opening it for someone deletes everyone else's entries, so
// one person's sessions never show to, or stay behind for, another on the same browser. Signing out, a 401 and a
// signed-out boot clear all of it. `?cache=off` turns it off for this browser (and clears it); `?cache=on` back on.

import type { SessionSnapshot } from "@harbour/protocol";
import type { SessionSummary } from "@harbour/ui";
import type { ProjectSummary } from "../api/client.ts";

/** Where entries are kept: IndexedDB in a browser, a Map in tests. Keys are opaque. */
export interface CacheStore {
	get(key: string): Promise<CacheEntry | undefined>;
	put(entry: CacheEntry): Promise<void>;
	delete(key: string): Promise<void>;
	/** Every entry's key, for clearing out other people's; a key starts with its owner and OWNER_END. */
	keys(): Promise<readonly string[]>;
	clear(): Promise<void>;
}

export type CacheEntry = { readonly key: string; readonly owner: string; readonly at: number; readonly value: unknown };

/** The most sessions a project's cached list keeps, newest first. */
export const CACHED_LIST_SIZE = 200;
/** The most open sessions kept, the most recently shown first. */
export const CACHED_SESSIONS = 5;
/** The most items a cached session keeps, the newest; a page or two of the transcript. */
export const CACHED_ITEMS = 100;

/** The console's cache for one person. Reads never reject: a cache that fails is an empty one. */
export interface LocalCache {
	readonly owner: string;
	projects(): Promise<readonly ProjectSummary[] | undefined>;
	setProjects(projects: readonly ProjectSummary[]): void;
	sessions(projectId: string): Promise<readonly SessionSummary[] | undefined>;
	setSessions(projectId: string, sessions: readonly SessionSummary[]): void;
	session(sessionId: string): Promise<SessionSnapshot | undefined>;
	setSession(snapshot: SessionSnapshot): void;
}

const LRU_KEY = "recent-sessions";
/** Ends the owner at the start of every key. */
const OWNER_END = "\u0000";

/** Cuts a session to its newest items, so what is kept stays small; the transcript pages back from there as usual. */
export function trimSnapshot(snapshot: SessionSnapshot, max = CACHED_ITEMS): SessionSnapshot {
	if (snapshot.items.length <= max) return snapshot;
	return { ...snapshot, items: snapshot.items.slice(-max), hasEarlier: true };
}

/**
 * Opens the cache for `owner`, first deleting every entry anyone else left. Writes are queued in order and never block
 * the caller; a failing store loses them silently. Once `open()` says no (the cache was cleared on signing out or a
 * 401), nothing more is read or written, so nothing queued before the clear lands after it.
 */
export async function openLocalCache(
	store: CacheStore,
	owner: string,
	{ now = Date.now, open = () => true }: { now?: () => number; open?: () => boolean } = {},
): Promise<LocalCache> {
	const keyOf = (name: string) => `${owner}${OWNER_END}${name}`;
	const mine = keyOf("");
	const others = (await store.keys()).filter((key) => !key.startsWith(mine));
	await Promise.all(others.map((key) => store.delete(key)));
	let queue: Promise<void> = Promise.resolve();
	const write = (name: string, value: unknown) => {
		queue = queue.then(
			() => (open() ? store.put({ key: keyOf(name), owner, at: now(), value }).catch(() => {}) : undefined),
			() => {},
		);
	};
	const read = async <T>(name: string): Promise<T | undefined> => {
		if (!open()) return undefined;
		try {
			const entry = await store.get(keyOf(name));
			// Never another person's, even if the key were to collide.
			return entry?.owner === owner ? (entry.value as T) : undefined;
		} catch {
			return undefined;
		}
	};
	/** What was last written for each name, to skip writing the same again every poll. */
	const written = new Map<string, string>();
	const writeChanged = (name: string, value: unknown) => {
		const text = JSON.stringify(value);
		if (written.get(name) === text) return;
		written.set(name, text);
		write(name, value);
	};
	let recent: Promise<string[]> = read<string[]>(LRU_KEY).then((ids) => ids ?? []);
	return {
		owner,
		projects: () => read<readonly ProjectSummary[]>("projects"),
		setProjects: (projects) => writeChanged("projects", projects),
		sessions: (projectId) => read<readonly SessionSummary[]>(`sessions:${projectId}`),
		setSessions: (projectId, sessions) => writeChanged(`sessions:${projectId}`, sessions.slice(0, CACHED_LIST_SIZE)),
		session: (sessionId) => read<SessionSnapshot>(`session:${sessionId}`),
		setSession(snapshot) {
			const sessionId = snapshot.sessionId;
			write(`session:${sessionId}`, trimSnapshot(snapshot));
			recent = recent.then((ids) => {
				const next = [sessionId, ...ids.filter((id) => id !== sessionId)];
				for (const dropped of next.slice(CACHED_SESSIONS)) {
					queue = queue.then(
						() => store.delete(keyOf(`session:${dropped}`)).catch(() => {}),
						() => {},
					);
				}
				const kept = next.slice(0, CACHED_SESSIONS);
				write(LRU_KEY, kept);
				return kept;
			});
		},
	};
}

/** Entries in a Map, for tests and a browser without IndexedDB. */
export function memoryCacheStore(): CacheStore & { readonly entries: Map<string, CacheEntry> } {
	const entries = new Map<string, CacheEntry>();
	return {
		entries,
		get: async (key) => entries.get(key),
		put: async (entry) => {
			entries.set(entry.key, entry);
		},
		delete: async (key) => {
			entries.delete(key);
		},
		keys: async () => [...entries.keys()],
		clear: async () => {
			entries.clear();
		},
	};
}

const DB_NAME = "harbour-console";
const STORE = "cache";

/** The browser's IndexedDB, opened on first use. Undefined where there is none. */
export function indexedDbCacheStore(factory: IDBFactory | undefined = globalThis.indexedDB): CacheStore | undefined {
	if (factory === undefined) return undefined;
	let opened: Promise<IDBDatabase> | undefined;
	const db = () => {
		opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(DB_NAME, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
			request.onblocked = () => reject(new Error("The console's cache is blocked by another tab"));
		});
		return opened;
	};
	const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
		const database = await db();
		return new Promise<T>((resolve, reject) => {
			const transaction = database.transaction(STORE, mode);
			const request = act(transaction.objectStore(STORE));
			transaction.oncomplete = () => resolve(request.result);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	};
	return {
		get: (key) => run("readonly", (store) => store.get(key) as IDBRequest<CacheEntry | undefined>),
		put: async (entry) => {
			await run("readwrite", (store) => store.put(entry));
		},
		delete: async (key) => {
			await run("readwrite", (store) => store.delete(key));
		},
		keys: async () =>
			(await run("readonly", (store) => store.getAllKeys())).filter((key): key is string => typeof key === "string"),
		clear: async () => {
			await run("readwrite", (store) => store.clear());
		},
	};
}

const SWITCH_KEY = "harbour.console.cache";

/**
 * Whether the cache is on for this browser: on unless `?cache=off` said otherwise, which is kept until `?cache=on`.
 * Experimental, so it can be turned off without a deploy.
 */
export function cacheSwitch(params: URLSearchParams, storage: Storage | undefined): boolean {
	const asked = params.get("cache");
	try {
		if (asked === "off" || asked === "on") storage?.setItem(SWITCH_KEY, asked);
		return storage?.getItem(SWITCH_KEY) !== "off";
	} catch {
		return asked !== "off";
	}
}
