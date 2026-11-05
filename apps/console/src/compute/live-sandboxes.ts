// The console's live feed of sandboxes' changes (`GET /v1/events/live`, server-sent events), behind
// `SandboxesSource.watch`. One stream per account however many pages watch it, opened while any does and closed when
// the last stops. A dropped stream is opened again after a pause that grows while it keeps failing; each `hello` (the
// first and every reconnection's) tells the watchers to read again, as the feed carries nothing from while it was closed.

import type { KantelClient, LiveFrame, StreamHandle } from "@kantel/api/sdk";

/** What a watcher is told: a sandbox's ID (and whether it was deleted), or none for "read everything again". */
export type SandboxChanged = (sandboxId?: string, deleted?: boolean) => void;

export interface LiveSandboxesOptions {
	/** The pauses before each reconnection while it keeps failing; the last repeats. */
	readonly retryMs?: readonly number[];
	/** For tests. */
	readonly setTimeout?: (run: () => void, ms: number) => unknown;
	readonly clearTimeout?: (timer: unknown) => void;
}

export interface LiveSandboxes {
	watch(accountId: string, changed: SandboxChanged): () => void;
}

/** 1 s, 2 s, 5 s, 10 s, then every 30 s. */
export const RETRY_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** The pause after the server ended a stream that had opened (its 10-minute end): just enough not to spin. */
const AFTER_END_MS = 250;

interface Feed {
	readonly watchers: Set<SandboxChanged>;
	handle?: StreamHandle;
	timer?: unknown;
	/** Failed attempts in a row. */
	failures: number;
}

export function liveSandboxes(
	api: Pick<KantelClient, "watchEvents">,
	options: LiveSandboxesOptions = {},
): LiveSandboxes {
	const retry = options.retryMs ?? RETRY_MS;
	const later = options.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
	const cancel = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
	const feeds = new Map<string, Feed>();

	const tell = (feed: Feed, sandboxId?: string, deleted?: boolean) => {
		for (const changed of [...feed.watchers]) changed(sandboxId, deleted);
	};

	const open = (accountId: string, feed: Feed) => {
		let opened = false;
		const handle = api.watchEvents(
			{
				onFrames(frames: readonly LiveFrame[]) {
					if (feeds.get(accountId) !== feed || feed.handle !== handle) return;
					for (const frame of frames) {
						if (frame.type === "hello") {
							opened = true;
							feed.failures = 0;
							tell(feed);
						} else if (frame.type === "sandbox") tell(feed, frame.sandboxId, frame.state === "deleted");
					}
				},
				onClose() {
					if (feeds.get(accountId) !== feed || feed.handle !== handle) return;
					feed.handle = undefined;
					const wait = opened ? AFTER_END_MS : (retry[Math.min(feed.failures, retry.length - 1)] ?? AFTER_END_MS);
					if (!opened) feed.failures += 1;
					feed.timer = later(() => {
						feed.timer = undefined;
						if (feeds.get(accountId) === feed) open(accountId, feed);
					}, wait);
				},
			},
			{ account: accountId },
		);
		feed.handle = handle;
	};

	return {
		watch(accountId, changed) {
			let feed = feeds.get(accountId);
			if (feed === undefined) {
				feed = { watchers: new Set(), failures: 0 };
				feeds.set(accountId, feed);
				feed.watchers.add(changed);
				open(accountId, feed);
			} else feed.watchers.add(changed);
			const held = feed;
			let stopped = false;
			return () => {
				if (stopped) return;
				stopped = true;
				held.watchers.delete(changed);
				if (held.watchers.size > 0 || feeds.get(accountId) !== held) return;
				feeds.delete(accountId);
				if (held.timer !== undefined) cancel(held.timer);
				const handle = held.handle;
				held.handle = undefined;
				handle?.close();
			};
		},
	};
}
