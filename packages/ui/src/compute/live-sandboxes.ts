// Following sandboxes live: the list and a sandbox's page read again as soon as the source says a sandbox changed
// (`SandboxesSource.watch`), whoever changed it, rather than only after their own changes. The source says which sandbox
// moved, or none when it (re)connects and anything may have; the page reads the sandbox again through the source as it
// always does, so what it shows is the source's answer, never the feed's.
//
// The feed keeps the page's reads few, as every one is answered by the same place on the hosted control plane
// (LLE-19729): a burst of changes is gathered for `WATCH_SETTLE_MS` and handed over once, saying which sandboxes changed
// and which were deleted, so a page can read just those (`SandboxBurst`); a (re)connection says "everything". Nothing is
// handed over while the tab is hidden: the burst is kept, growing, and handed over once when the tab is shown again.
// How often the list reads, and how many IDs it reads one by one, is the page's to decide (sandbox-reads.ts).

import { useEffect, useRef } from "react";
import type { SandboxesSource } from "./compute-model.ts";

/** How long a burst of changes (a bulk stop, starting then running) is gathered into one read. */
export const WATCH_SETTLE_MS = 150;

/**
 * What changed in one burst: everything (`all`, when the feed (re)connected during it), or the sandboxes in `changed`
 * and those `deleted`. A sandbox deleted in the burst is in `deleted` alone. `all` still carries the deletions it saw,
 * so a page can drop those rows before the read that would drop them anyway.
 */
export type SandboxBurst =
	| { readonly all: true; readonly deleted: ReadonlySet<string> }
	| { readonly all: false; readonly changed: ReadonlySet<string>; readonly deleted: ReadonlySet<string> };

/** Whether the tab is hidden, and a way to hear when that changes. The browser's, unless a test gives its own. */
export interface Visibility {
	hidden(): boolean;
	/** Calls `changed` each time the tab is hidden or shown; answers a function that stops. */
	listen(changed: () => void): () => void;
}

/** The document's visibility; outside a browser (the tests, a server render) never hidden. */
export const documentVisibility: Visibility = {
	hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
	listen(changed) {
		if (typeof document === "undefined") return () => {};
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	},
};

export interface FollowOptions {
	/** Only this sandbox's changes, and every reconnection; absent, every change of the account's. */
	readonly sandboxId?: string;
	/** With `sandboxId`: called at once when that sandbox is deleted, which a read would only answer as not found. */
	readonly onDeleted?: () => void;
	readonly settleMs?: number;
	readonly visibility?: Visibility;
}

/**
 * Watches `accountId`'s sandboxes through `source` and calls `changed` once per burst of changes it cares about, and
 * not while the tab is hidden (once when it's shown again, with what it missed). Answers a function that stops.
 * Nothing happens without `source.watch`.
 */
export function followSandboxes(
	source: Pick<SandboxesSource, "watch">,
	accountId: string,
	changed: (burst: SandboxBurst) => void,
	options: FollowOptions = {},
): () => void {
	if (source.watch === undefined) return () => {};
	const visibility = options.visibility ?? documentVisibility;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	// The burst being gathered, or held while the tab is hidden: undefined when there's none.
	let all = false;
	let ids: Set<string> | undefined;
	const deleted = new Set<string>();

	const handOver = () => {
		if (stopped || ids === undefined || visibility.hidden()) return;
		const burst: SandboxBurst = all
			? { all: true, deleted: new Set(deleted) }
			: { all: false, changed: ids, deleted: new Set(deleted) };
		all = false;
		ids = undefined;
		deleted.clear();
		changed(burst);
	};

	const stopWatching = source.watch(accountId, (sandboxId, wasDeleted) => {
		if (stopped) return;
		if (options.sandboxId !== undefined && sandboxId !== undefined && sandboxId !== options.sandboxId) return;
		if (wasDeleted === true && options.sandboxId !== undefined && options.onDeleted !== undefined) {
			options.onDeleted();
			return;
		}
		ids ??= new Set();
		if (sandboxId === undefined) all = true;
		else if (wasDeleted === true) {
			ids.delete(sandboxId);
			deleted.add(sandboxId);
		} else if (!deleted.has(sandboxId)) ids.add(sandboxId);
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			handOver();
		}, options.settleMs ?? WATCH_SETTLE_MS);
	});
	// A burst held while hidden goes when the tab is shown again, and only then.
	const stopListening = visibility.listen(() => {
		if (timer === undefined) handOver();
	});
	return () => {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
		stopListening();
		stopWatching();
	};
}

/**
 * `followSandboxes` for a page: `changed` while it shows `accountId` (and `sandboxId`, on a sandbox's page, with
 * `onDeleted` once it is deleted).
 */
export function useFollowSandboxes(
	source: SandboxesSource,
	accountId: string | undefined,
	changed: (burst: SandboxBurst) => void,
	sandbox?: { readonly id: string; readonly onDeleted: () => void },
): void {
	const latest = useRef({ changed, onDeleted: sandbox?.onDeleted });
	latest.current = { changed, onDeleted: sandbox?.onDeleted };
	const sandboxId = sandbox?.id;
	useEffect(() => {
		if (accountId === undefined) return;
		return followSandboxes(
			source,
			accountId,
			(burst) => latest.current.changed(burst),
			sandboxId === undefined ? {} : { sandboxId, onDeleted: () => latest.current.onDeleted?.() },
		);
	}, [source, accountId, sandboxId]);
}
