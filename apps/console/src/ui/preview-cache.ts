import type { PreviewContent } from "@kantel/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { WorkspaceFile } from "../api/client.ts";
import { ApiError } from "../api/http.ts";

// The file preview's content, read once and kept: a file opened again, or one the person hovered or focused before
// opening, shows in the panel's first frame rather than after a round trip. Reads of one file are shared, a failed
// read isn't kept (opening it again tries again), and the least recently used files go once the cache holds more
// than its budget. A save puts the saved text in, so the preview never shows an older version than the person wrote.
// A read made elsewhere (an image's card, which has already drawn it) can seed the cache (`peek`): the file then shows
// from it at once, and is read again behind it in case it has changed since.

/** What the cache keeps of a file: its bytes as read, what to write it back against, and a URL already made of it. */
export type CachedFile = WorkspaceFile & { readonly url?: string | undefined };

type Entry =
	| { readonly status: "loading"; readonly promise: Promise<CachedFile> }
	| { readonly status: "ready"; readonly file: CachedFile }
	| { readonly status: "error"; readonly content: PreviewContent };

export type PreviewCache<F> = {
	/** What the cache has of the file now: ready, loading, or why it couldn't be read. */
	content(file: F): PreviewContent;
	/** The cached read, if any. */
	cached(file: F): CachedFile | undefined;
	/** Reads the file into the cache, unless it is there or on its way. */
	load(file: F): void;
	/** Puts what was just saved in place of what was read. */
	put(file: F, value: CachedFile): void;
	subscribe(listener: () => void): () => void;
};

export type PreviewCacheOptions = {
	/** The most bytes kept, beyond the file open now. */
	readonly maxBytes?: number;
	readonly maxEntries?: number;
	/** The file's name, for the error a failed read shows. */
	readonly nameOf: (file: never) => string;
	/** A finished read of the file made elsewhere (an image's card), to show at once instead of reading it again. */
	readonly peek?: ((file: never) => CachedFile | undefined) | undefined;
};

const LOADING: PreviewContent = { status: "loading" };

function failure(name: string, reason: unknown): PreviewContent {
	if (reason instanceof ApiError && reason.code === "too_large") return { status: "too-large" };
	if (reason instanceof ApiError && reason.code === "not_found") {
		return { status: "error", message: `${name} is no longer in the workspace.` };
	}
	return {
		status: "error",
		message: `${name} couldn't be read: ${reason instanceof Error ? reason.message : String(reason)}`,
	};
}

/**
 * A cache over `read`, keyed by `keyOf`. Reads aren't aborted when the person moves on: a file they opened or hovered
 * is likely to be opened again, and a read already on its way costs nothing more to finish.
 */
export function createPreviewCache<F>(
	read: (file: F, signal: AbortSignal) => Promise<WorkspaceFile>,
	keyOf: (file: F) => string,
	{ maxBytes = 48 * 1024 * 1024, maxEntries = 60, nameOf, peek }: PreviewCacheOptions,
): PreviewCache<F> {
	const peekAt = peek as ((file: F) => CachedFile | undefined) | undefined;
	const entries = new Map<string, Entry>();
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const touch = (key: string, entry: Entry) => {
		entries.delete(key);
		entries.set(key, entry);
	};
	const trim = (keep: string) => {
		let bytes = 0;
		for (const entry of entries.values()) if (entry.status === "ready") bytes += entry.file.content.byteLength;
		for (const [key, entry] of entries) {
			if (bytes <= maxBytes && entries.size <= maxEntries) break;
			if (key === keep || entry.status === "loading") continue;
			entries.delete(key);
			if (entry.status === "ready") bytes -= entry.file.content.byteLength;
		}
	};
	/** Seeded files not yet read again to check they haven't changed since the read that seeded them. */
	const unchecked = new Set<string>();
	/** Seeds the file from a read made elsewhere, if there is one: true when it did. */
	const seed = (key: string, file: F): boolean => {
		const seen = peekAt?.(file);
		if (seen === undefined) return false;
		touch(key, { status: "ready", file: seen });
		unchecked.add(key);
		trim(key);
		return true;
	};
	/** Reads a seeded file again (a 304 while it is the same) and shows the new bytes if it changed; a failure keeps the seed. */
	const check = (key: string, file: F, seeded: CachedFile) => {
		read(file, new AbortController().signal).then(
			(now) => {
				const current = entries.get(key);
				if (current?.status !== "ready" || current.file !== seeded) return;
				if (now.digest !== undefined && now.digest !== seeded.digest) {
					touch(key, { status: "ready", file: now });
					notify();
				}
			},
			() => {},
		);
	};
	const load = (file: F) => {
		const key = keyOf(file);
		const before = entries.get(key);
		const seeded = before === undefined && seed(key, file);
		const existing = entries.get(key);
		if (existing !== undefined && existing.status !== "error") {
			touch(key, existing);
			if (existing.status === "ready" && unchecked.delete(key)) check(key, file, existing.file);
			if (seeded) notify();
			return;
		}
		const promise = read(file, new AbortController().signal);
		entries.set(key, { status: "loading", promise });
		promise.then(
			(value) => {
				if (entries.get(key)?.status !== "loading") return;
				touch(key, { status: "ready", file: value });
				trim(key);
				notify();
			},
			(reason: unknown) => {
				if (entries.get(key)?.status !== "loading") return;
				entries.set(key, { status: "error", content: failure((nameOf as (file: F) => string)(file), reason) });
				notify();
			},
		);
		if (existing !== undefined) notify();
	};
	return {
		content(file) {
			const key = keyOf(file);
			// A seed shows in the first render, before the effect that loads the file has run.
			if (!entries.has(key)) seed(key, file);
			const entry = entries.get(key);
			if (entry === undefined || entry.status === "loading") return LOADING;
			if (entry.status === "error") return entry.content;
			return {
				status: "ready",
				bytes: entry.file.content,
				contentType: entry.file.contentType,
				...(entry.file.url === undefined ? {} : { url: entry.file.url }),
			};
		},
		cached(file) {
			const entry = entries.get(keyOf(file));
			return entry?.status === "ready" ? entry.file : undefined;
		},
		load,
		put(file, value) {
			const key = keyOf(file);
			unchecked.delete(key);
			touch(key, { status: "ready", file: value });
			notify();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/**
 * The open file's content from the cache, read if it isn't there. Ready in the first render when it was cached; the
 * same object while nothing changes, so the panel's body doesn't render again.
 */
export function usePreviewContent<F>(cache: PreviewCache<F> | undefined, file: F | undefined): PreviewContent {
	const [, setVersion] = useState(0);
	useSyncExternalStore(cache?.subscribe ?? noSubscribe, () =>
		cache === undefined || file === undefined ? undefined : cache.cached(file),
	);
	useEffect(() => {
		if (cache !== undefined && file !== undefined) {
			cache.load(file);
			setVersion((version) => version + 1);
		}
	}, [cache, file]);
	const content = cache === undefined || file === undefined ? LOADING : cache.content(file);
	return useStable(content);
}

const noSubscribe = () => () => {};

/** The same object for content that hasn't changed, so a memoised body doesn't render again. */
function useStable(content: PreviewContent): PreviewContent {
	const [last, setLast] = useState(content);
	const same =
		last.status === content.status &&
		(content.status !== "ready" ||
			(last.status === "ready" &&
				last.bytes === content.bytes &&
				last.contentType === content.contentType &&
				last.url === content.url)) &&
		(content.status !== "error" || (last.status === "error" && last.message === content.message));
	if (!same) setLast(content);
	return same ? last : content;
}
