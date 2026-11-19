/* The rules the Sandboxes page's selection and bulk actions keep, apart from React so they can be tested alone. */

/**
 * Whether a read failed because Kantel refused it outright (signed out, or no longer allowed into the account), not
 * because it couldn't answer: what was read before isn't the person's to see any more.
 */
export function isRefusal(error: unknown): boolean {
	const code = (error as { readonly code?: unknown } | null)?.code;
	return code === "forbidden" || code === "unauthenticated";
}

/** A sandbox whose create hasn't answered yet, shown under a temporary ID that no read will ever have. */
export const isPlaceholder = (id: string): boolean => id.startsWith("pending_");

/** The ticked IDs still shown: one a search, a filter or a delete hides is dropped, not kept for when it's back. */
export function keepShown(ticked: ReadonlySet<string>, shown: Iterable<string>): ReadonlySet<string> {
	const showing = new Set(shown);
	const kept = new Set([...ticked].filter((id) => showing.has(id)));
	return kept.size === ticked.size ? ticked : kept;
}

/** A bulk action's targets left after an attempt: only those that failed, so trying again doesn't repeat the rest. */
export function stillToDo<T>(targets: readonly T[], results: readonly PromiseSettledResult<unknown>[]): T[] {
	return targets.filter((_, at) => results[at]?.status === "rejected");
}

/**
 * What a confirmation asks about once an attempt on `attempted` has settled: the ones that failed, if it is still
 * asking about `attempted`; otherwise whatever it asks now. A confirmation closed while its attempt ran stays closed,
 * and one opened since keeps its own targets.
 */
export function retryTargets<T>(
	current: readonly T[] | undefined,
	attempted: readonly T[],
	results: readonly PromiseSettledResult<unknown>[],
): readonly T[] | undefined {
	return current === attempted ? stillToDo(attempted, results) : current;
}

/**
 * What the page knows of a sandbox ahead of the next read of the list: one it changed, made or deleted (`null`), or
 * one it read alone because the live feed said it changed. `seq` orders it among the page's reads: every read, of the
 * list or of one sandbox, and every change the page makes takes the next number as it starts, so whichever started
 * last wins, whatever order the answers come in.
 */
export interface LocalChange<T> {
	readonly box: T | null;
	readonly seq: number;
}

/** A list read's answer, with the number it took as it started. */
export interface ListRead<T> {
	readonly sandboxes: readonly T[];
	readonly seq: number;
}

/**
 * The page's changes still worth keeping once `read` answered. A read of the list that started after a change has the
 * whole truth about that sandbox, whether it lists it or not (a deletion the feed missed while it was away is the
 * list's leaving it out), so the change is forgotten either way. One the list started before is kept, and so is a new
 * one's placeholder, until its create answers. Answers `local` itself when nothing was forgotten, so React keeps the
 * same state.
 */
export function forgetRead<T>(
	local: ReadonlyMap<string, LocalChange<T>>,
	read: Pick<ListRead<T>, "seq">,
): ReadonlyMap<string, LocalChange<T>> {
	if (local.size === 0) return local;
	const next = new Map(local);
	for (const [id, change] of local) {
		if (change.seq < read.seq && !isPlaceholder(id)) next.delete(id);
	}
	return next.size === local.size ? local : next;
}

/**
 * `local` with what a read of one sandbox, or a change's answer, that started at `seq` found: `box`, or `null` when it
 * was deleted. Unless something newer is known of it already: a change or a read that started later, or a read of the
 * whole list that did (`listSeq`). Answers `local` itself when the answer is too old to matter.
 */
export function withRead<T>(
	local: ReadonlyMap<string, LocalChange<T>>,
	id: string,
	box: T | null,
	seq: number,
	listSeq: number,
): ReadonlyMap<string, LocalChange<T>> {
	if (seq <= listSeq) return local;
	const known = local.get(id);
	if (known !== undefined && known.seq >= seq) return local;
	return new Map(local).set(id, { box, seq });
}

/**
 * `local` with a sandbox a call made (a create, a fork), as of its answer (`seq`, taken then). Its ID is new, so
 * whatever is already known of it (a read, a deletion) came after the call and wins. A read of the list that started
 * before the answer may not have had it yet, so only one that starts after it can take it away (`forgetRead`).
 */
export function withMade<T>(
	local: ReadonlyMap<string, LocalChange<T>>,
	id: string,
	box: T,
	seq: number,
): ReadonlyMap<string, LocalChange<T>> {
	if (local.has(id)) return local;
	return new Map(local).set(id, { box, seq });
}

/** `read`'s sandboxes with the page's changes over them, newest first. */
export function withLocal<T extends { readonly id: string; readonly createdAt: number }>(
	sandboxes: readonly T[],
	local: ReadonlyMap<string, LocalChange<T>>,
): T[] {
	const byId = new Map(sandboxes.map((box) => [box.id, box]));
	for (const [id, change] of local) {
		if (change.box === null) byId.delete(id);
		else byId.set(id, change.box);
	}
	return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}
