// The timeline's data: pages from the audit source for the current query, appended as the reader scrolls. With the
// credential filter set, a page can match nothing, so the feed keeps reading pages until it has a screenful or the
// log ends. A new query starts again from the first page and drops any reply to the old one.

import type { AuditEvent } from "@harbour/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuditSource, type AuditViewQuery, matchesCredential } from "./audit-model.ts";

/** Rows per request. The contract's store caps a page at 500. */
export const PAGE_SIZE = 200;
/** With a filter applied here, read until at least this many rows match before stopping. */
const SCREENFUL = 60;
/** And never read more than this many pages for one "load more", so a filter that matches nothing can't spin. */
const MAX_PAGES_PER_LOAD = 25;

export interface AuditFeed {
	readonly events: readonly AuditEvent[];
	/** True until the first page arrives, and again after a new query. */
	readonly loading: boolean;
	/** True while a further page is being read. */
	readonly loadingMore: boolean;
	readonly error?: string;
	/** Whether more pages remain. */
	readonly hasMore: boolean;
	/** Rows the store returned for this query, matched or not. */
	readonly scanned: number;
	/** Events newer than the first row, found by polling; shown when the reader asks. */
	readonly newer: number;
	loadMore(): void;
	retry(): void;
	/** Reads the log again from the newest event. */
	showNewer(): void;
}

/**
 * The feed for a query. With `pollMs`, it checks for newer events that often while the page is visible, and counts
 * them rather than moving the rows under the reader.
 */
export function useAuditFeed(
	source: AuditSource,
	query: AuditViewQuery,
	credential?: string,
	pollMs?: number,
): AuditFeed {
	const [events, setEvents] = useState<AuditEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string>();
	const [cursor, setCursor] = useState<string | undefined>();
	const [hasMore, setHasMore] = useState(false);
	const [scanned, setScanned] = useState(0);
	const [attempt, setAttempt] = useState(0);
	const [newer, setNewer] = useState(0);
	// Each query gets a generation; replies to an older one are dropped.
	const generation = useRef(0);
	const busy = useRef(false);
	const queryKey = JSON.stringify(query);

	// biome-ignore lint/correctness/useExhaustiveDependencies: queryKey stands for query; the same filters are the same query.
	const read = useCallback(
		async (from: string | undefined, mine: number) => {
			busy.current = true;
			try {
				const found: AuditEvent[] = [];
				let next = from;
				let pages = 0;
				let seen = 0;
				do {
					const page = await source.query(query, { limit: PAGE_SIZE, ...(next === undefined ? {} : { cursor: next }) });
					if (generation.current !== mine) return;
					seen += page.items.length;
					for (const event of page.items) if (matchesCredential(event, credential)) found.push(event);
					next = page.nextCursor;
					pages += 1;
				} while (
					next !== undefined &&
					found.length < SCREENFUL &&
					credential !== undefined &&
					pages < MAX_PAGES_PER_LOAD
				);
				setEvents((previous) => (from === undefined ? found : previous.concat(found)));
				setCursor(next);
				setHasMore(next !== undefined);
				setScanned((previous) => (from === undefined ? seen : previous + seen));
				setError(undefined);
			} catch {
				if (generation.current === mine) setError("Couldn't read the audit log.");
			} finally {
				if (generation.current === mine) {
					busy.current = false;
					setLoading(false);
					setLoadingMore(false);
				}
			}
		},
		[source, queryKey, credential],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt reads the log again on "Try again" and "newer events".
	useEffect(() => {
		generation.current += 1;
		setLoading(true);
		setEvents([]);
		setScanned(0);
		setHasMore(false);
		setNewer(0);
		void read(undefined, generation.current);
	}, [read, attempt]);

	const top = events[0]?.seq;
	// biome-ignore lint/correctness/useExhaustiveDependencies: queryKey stands for query; the same filters are the same query.
	useEffect(() => {
		if (pollMs === undefined || top === undefined) return;
		const mine = generation.current;
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			// Newest first, the rows above `top` are the newer ones; a full page of them reads as "200 or more".
			void source.query(query, { limit: PAGE_SIZE }).then(
				(page) => {
					if (generation.current !== mine) return;
					setNewer(page.items.filter((event) => event.seq > top && matchesCredential(event, credential)).length);
				},
				() => {},
			);
		}, pollMs);
		return () => clearInterval(timer);
	}, [pollMs, top, source, queryKey, credential]);

	const loadMore = useCallback(() => {
		if (busy.current || cursor === undefined) return;
		setLoadingMore(true);
		void read(cursor, generation.current);
	}, [read, cursor]);

	const retry = useCallback(() => {
		if (events.length === 0) setAttempt((count) => count + 1);
		else loadMore();
	}, [events.length, loadMore]);

	const showNewer = useCallback(() => setAttempt((count) => count + 1), []);

	return {
		events,
		newer,
		showNewer,
		loading,
		loadingMore,
		...(error === undefined ? {} : { error }),
		hasMore,
		scanned,
		loadMore,
		retry,
	};
}
