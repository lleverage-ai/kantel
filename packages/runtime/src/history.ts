/**
 * A session's transcript in pages, newest first (`SessionHistory` in `@kantel/contracts`), read from the session's
 * protocol stream: the latest page from its snapshot, older pages through its `history`.
 *
 * A cursor is the oldest item's ID of the page that gave it, so it names a place in the transcript, not an offset from
 * its end: new turns arriving between two pages move nothing behind it. Item IDs come from the stored conversation
 * (`project.ts`), so a cursor still holds after the runtime reopens the session.
 */
import {
	KantelError,
	SESSION_HISTORY_DEFAULT_LIMIT,
	SESSION_HISTORY_MAX_LIMIT,
	type SessionHistoryPage,
	type SessionHistoryRequest,
} from "@kantel/contracts";
import { ProtocolError, type SessionStream, type TranscriptItem } from "@kantel/protocol";

const CURSOR_PREFIX = "h1.";

function base64url(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): string {
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

/** The cursor for the page of items older than `itemId`. */
export function historyCursor(itemId: string): string {
	return `${CURSOR_PREFIX}${base64url(itemId)}`;
}

/** The item ID a cursor names; `invalid` when it is not one of ours. */
export function itemOfCursor(cursor: string): string {
	if (!cursor.startsWith(CURSOR_PREFIX) || !/^[A-Za-z0-9_-]+$/.test(cursor.slice(CURSOR_PREFIX.length))) {
		throw new KantelError("invalid", "The history cursor is not valid");
	}
	try {
		const id = fromBase64url(cursor.slice(CURSOR_PREFIX.length));
		if (id !== "") return id;
	} catch {
		// Not base64url, or not UTF-8.
	}
	throw new KantelError("invalid", "The history cursor is not valid");
}

/** The request's limit, defaulted and cut to the most a page holds; `invalid` below 1. */
export function historyLimit(limit: number | undefined): number {
	if (limit === undefined) return SESSION_HISTORY_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw new KantelError("invalid", "limit must be a whole number from 1");
	return Math.min(limit, SESSION_HISTORY_MAX_LIMIT);
}

/** The item a request pages back from, or `undefined` for the latest page. */
export function historyAnchor(request: SessionHistoryRequest): string | undefined {
	if (request.cursor !== undefined && request.before !== undefined) {
		throw new KantelError("invalid", "Give a cursor or before, not both");
	}
	if (request.cursor !== undefined) return itemOfCursor(request.cursor);
	if (request.before !== undefined) {
		if (typeof request.before !== "string" || request.before === "") {
			throw new KantelError("invalid", "before must be an item ID");
		}
		return request.before;
	}
	return undefined;
}

function pageOf(sessionId: string, oldestFirst: readonly TranscriptItem[], hasEarlier: boolean): SessionHistoryPage {
	const oldest = oldestFirst[0];
	return {
		sessionId,
		items: [...oldestFirst].reverse(),
		...(hasEarlier && oldest !== undefined ? { nextCursor: historyCursor(oldest.id) } : {}),
	};
}

/** Up to `limit` items before `before`, oldest first; `not_found` when the stream has no such item. */
async function earlier(stream: Pick<SessionStream, "history">, before: string, limit: number) {
	try {
		return await stream.history(before, limit);
	} catch (error) {
		if (error instanceof ProtocolError && error.code === "unknown_item") {
			throw new KantelError("not_found", `No item ${before} in this session`);
		}
		throw error;
	}
}

/**
 * Reads one page from a session's stream. The latest page is the snapshot's newest items, with older ones from
 * `history` when the snapshot holds fewer than `limit`; it reads the snapshot first and pages back from its oldest
 * item, so an item published in between is in neither and never splits the page.
 */
export async function readHistory(
	stream: Pick<SessionStream, "snapshot" | "history">,
	sessionId: string,
	request: SessionHistoryRequest = {},
): Promise<SessionHistoryPage> {
	const limit = historyLimit(request.limit);
	const anchor = historyAnchor(request);
	if (anchor !== undefined) {
		const page = await earlier(stream, anchor, limit);
		return pageOf(sessionId, page.items, page.hasEarlier);
	}
	const snapshot = await stream.snapshot();
	const latest = snapshot.items;
	if (latest.length >= limit) {
		return pageOf(sessionId, latest.slice(latest.length - limit), snapshot.hasEarlier || latest.length > limit);
	}
	const first = latest[0];
	if (!snapshot.hasEarlier || first === undefined) return pageOf(sessionId, latest, false);
	const older = await earlier(stream, first.id, limit - latest.length);
	return pageOf(sessionId, [...older.items, ...latest], older.hasEarlier);
}
