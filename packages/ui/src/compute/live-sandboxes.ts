// Following sandboxes live: the list and a sandbox's page read again as soon as the source says a sandbox changed
// (`SandboxesSource.watch`), whoever changed it, rather than only after their own changes. The source says which sandbox
// moved, or none when it (re)connects and anything may have; the page reads the sandbox again through the source as it
// always does, so what it shows is the source's answer, never the feed's.

import { useEffect, useRef } from "react";
import type { SandboxesSource } from "./compute-model.ts";

/** How long a burst of changes (a bulk stop, starting then running) is gathered into one read. */
export const WATCH_SETTLE_MS = 150;

export interface FollowOptions {
	/** Only this sandbox's changes, and every reconnection; absent, every change of the account's. */
	readonly sandboxId?: string;
	/** With `sandboxId`: called at once when that sandbox is deleted, which a read would only answer as not found. */
	readonly onDeleted?: () => void;
	readonly settleMs?: number;
}

/**
 * Watches `accountId`'s sandboxes through `source` and calls `changed` once per burst of changes it cares about.
 * Answers a function that stops. Nothing happens without `source.watch`.
 */
export function followSandboxes(
	source: Pick<SandboxesSource, "watch">,
	accountId: string,
	changed: () => void,
	options: FollowOptions = {},
): () => void {
	if (source.watch === undefined) return () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const stopWatching = source.watch(accountId, (sandboxId, deleted) => {
		if (stopped) return;
		if (options.sandboxId !== undefined && sandboxId !== undefined && sandboxId !== options.sandboxId) return;
		if (deleted === true && options.sandboxId !== undefined && options.onDeleted !== undefined) {
			options.onDeleted();
			return;
		}
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (!stopped) changed();
		}, options.settleMs ?? WATCH_SETTLE_MS);
	});
	return () => {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
		stopWatching();
	};
}

/**
 * `followSandboxes` for a page: `reload` while it shows `accountId` (and `sandboxId`, on a sandbox's page, with
 * `onDeleted` once it is deleted).
 */
export function useFollowSandboxes(
	source: SandboxesSource,
	accountId: string | undefined,
	reload: () => void,
	sandbox?: { readonly id: string; readonly onDeleted: () => void },
): void {
	const latest = useRef({ reload, onDeleted: sandbox?.onDeleted });
	latest.current = { reload, onDeleted: sandbox?.onDeleted };
	const sandboxId = sandbox?.id;
	useEffect(() => {
		if (accountId === undefined) return;
		return followSandboxes(
			source,
			accountId,
			() => latest.current.reload(),
			sandboxId === undefined ? {} : { sandboxId, onDeleted: () => latest.current.onDeleted?.() },
		);
	}, [source, accountId, sandboxId]);
}
