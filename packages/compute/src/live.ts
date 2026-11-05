/**
 * Sandboxes' changes of state, live (`GET /v1/events/live`): what lets an open console follow a sandbox the CLI, the
 * API, an SDK, an auto-stop or a host moved, without reading again on a timer.
 *
 * - **One place publishes:** every change of a sandbox's state is a write of its record, so the service's store is
 *   wrapped (`watchSandboxes`): a write that moves a record to another state, makes one or deletes one publishes a
 *   change. Nothing that moves a sandbox can go round it, whoever asked.
 * - **The feed** (`createLiveFeed`) hands each change to the watchers of its account in this process, and to a relay
 *   (`LiveRelay`) where gateways share a database, which brings theirs here. A relay that may have missed some (it
 *   reconnected) says so, and each watcher is sent a `hello` again, which tells it to read again.
 * - **A watcher** (`watchResponse`) is server-sent events: a `hello`, then a `sandbox` frame per change it may be sent,
 *   a comment line every 25 s so proxies keep it open, and an end after 10 minutes, so a sign-in that has ended doesn't
 *   watch for long. Each change is checked before it is sent (`mayWatch`): the watcher may still act in the account and
 *   may see the sandbox, as `listSandboxes` decides; one that may no longer watch at all is ended.
 *
 * A frame says which sandbox moved and to what state, nothing else: the console reads the sandbox through the API, as
 * it does anyway, so what it shows of one is always what the API answers it.
 */
import type { computeSchema } from "@kantel/api";
import type { Collection, StoredSandbox } from "./store.ts";

type SandboxState = computeSchema.SandboxState;

/** A sandbox's change of state: what a watcher is sent. */
export interface SandboxChange {
	readonly sandboxId: string;
	readonly accountId: string;
	readonly state: SandboxState;
	/** Absent for one just made. */
	readonly previousState?: SandboxState;
	readonly at: number;
}

/** A change as a watcher gets it, with the sandbox's record as it is now, read once however many watch. */
export interface PublishedChange {
	readonly change: SandboxChange;
	/** The record now; undefined once it is gone (a create that failed is deleted outright). */
	sandbox(): Promise<StoredSandbox | undefined>;
}

/** One watcher of an account, as the feed holds it. */
export interface LiveWatcher {
	change(published: PublishedChange): void;
	/** The feed may have missed changes (its relay reconnected): read again. */
	resync(): void;
	/** The feed is closing. */
	close(): void;
}

/**
 * Carries changes between gateways that share a database (Postgres's NOTIFY on a self-hosted install with replicas).
 * One process alone (the Cloudflare stack object, a gateway in memory) needs none.
 */
export interface LiveRelay {
	/** Passes a change made here to the other gateways. It must not come back here. */
	send(change: SandboxChange): void;
	/** Starts bringing theirs here: `receive` each, and `resync` when it may have missed some (it reconnected). */
	start(receive: (change: SandboxChange) => void, resync: () => void): void;
	stop(): Promise<void> | void;
}

export interface LiveFeed {
	/** Hands a change made here to its account's watchers, here and (through the relay) on the other gateways. */
	publish(change: SandboxChange): void;
	/** Adds a watcher of `accountId`'s changes; answers a function that removes it. */
	watch(accountId: string, watcher: LiveWatcher): () => void;
	/** How many watchers there are now, for tests. */
	readonly watchers: number;
	/** Ends every watcher and stops the relay. */
	close(): Promise<void>;
}

export interface LiveFeedOptions {
	/** Reads a sandbox's record, for the watchers' checks. */
	readonly read: (sandboxId: string) => Promise<StoredSandbox | undefined>;
	readonly relay?: LiveRelay;
}

export function createLiveFeed(options: LiveFeedOptions): LiveFeed {
	const byAccount = new Map<string, Set<LiveWatcher>>();
	let count = 0;
	const deliver = (change: SandboxChange) => {
		const watchers = byAccount.get(change.accountId);
		if (watchers === undefined || watchers.size === 0) return;
		let read: Promise<StoredSandbox | undefined> | undefined;
		const published: PublishedChange = {
			change,
			sandbox: () => {
				read ??= options.read(change.sandboxId).catch(() => undefined);
				return read;
			},
		};
		for (const watcher of watchers) watcher.change(published);
	};
	const resync = () => {
		for (const watchers of byAccount.values()) for (const watcher of watchers) watcher.resync();
	};
	options.relay?.start(deliver, resync);
	return {
		publish(change) {
			deliver(change);
			options.relay?.send(change);
		},
		watch(accountId, watcher) {
			let watchers = byAccount.get(accountId);
			if (watchers === undefined) {
				watchers = new Set();
				byAccount.set(accountId, watchers);
			}
			watchers.add(watcher);
			count += 1;
			let removed = false;
			return () => {
				if (removed) return;
				removed = true;
				count -= 1;
				const held = byAccount.get(accountId);
				held?.delete(watcher);
				if (held?.size === 0) byAccount.delete(accountId);
			};
		},
		get watchers() {
			return count;
		},
		async close() {
			const all = [...byAccount.values()].flatMap((watchers) => [...watchers]);
			byAccount.clear();
			count = 0;
			for (const watcher of all) watcher.close();
			await options.relay?.stop();
		},
	};
}

/**
 * The sandboxes' collection, publishing each change of a record's state to `publish`: an update that moves a record to
 * another state (or another step of its lifecycle), a put or an insert (a new sandbox), and a delete. Reads, and updates
 * that leave the state as it was (usage, ports, labels), publish nothing.
 */
export function watchSandboxes(
	sandboxes: Collection<StoredSandbox>,
	publish: (change: SandboxChange) => void,
	now: () => number,
): Collection<StoredSandbox> {
	const changed = (record: StoredSandbox, before: StoredSandbox | undefined) => {
		if (before !== undefined && before.state === record.state && before.lifecycle === record.lifecycle) return;
		publish({
			sandboxId: record.id,
			accountId: record.accountId,
			state: record.state,
			...(before === undefined ? {} : { previousState: before.state }),
			at: now(),
		});
	};
	const gone = (before: StoredSandbox) =>
		publish({
			sandboxId: before.id,
			accountId: before.accountId,
			state: "deleted",
			previousState: before.state,
			at: now(),
		});
	return {
		get: (id) => sandboxes.get(id),
		list: (where) => sandboxes.list(where),
		// A put is how a sandbox is made (a create, a fork, each with a new ID): it is published as made, without reading
		// first, which a create would pay for in a statement. Changes go through `update`.
		async put(record) {
			await sandboxes.put(record);
			changed(record, undefined);
		},
		async insert(record) {
			const inserted = await sandboxes.insert(record);
			if (inserted) changed(record, undefined);
			return inserted;
		},
		async update(id, change, expected) {
			// `change` may run more than once: the last run is the one written.
			let before: StoredSandbox | undefined;
			const written = await sandboxes.update(
				id,
				(current) => {
					before = current;
					return change(current);
				},
				expected,
			);
			if (written !== undefined) changed(written, before);
			return written;
		},
		async delete(id) {
			const before = await sandboxes.get(id);
			const deleted = await sandboxes.delete(id);
			if (deleted && before !== undefined) gone(before);
			return deleted;
		},
		async deleteIf(id, should) {
			let before: StoredSandbox | undefined;
			const deleted = await sandboxes.deleteIf(id, (current) => {
				before = current;
				return should(current);
			});
			if (deleted && before !== undefined) gone(before);
			return deleted;
		},
	};
}

/** What a watcher may be sent: the change, nothing (it may not see that sandbox), or the end (it may watch no more). */
export type WatchVerdict = "send" | "skip" | "end";

export interface WatchOptions {
	readonly feed: LiveFeed;
	readonly accountId: string;
	/** Whether this watcher may be sent `published` now. */
	readonly mayWatch: (published: PublishedChange) => Promise<WatchVerdict>;
	/** The request's signal: the stream ends with its connection. */
	readonly signal?: AbortSignal;
	readonly now: () => number;
	/** Between keep-alive comments. Default 25 s, inside the 100 s a proxy (Cloudflare's) lets a quiet answer be. */
	readonly keepAliveMs?: number;
	/** How long before the server ends it, for the client to sign in again. Default 10 minutes. */
	readonly lifetimeMs?: number;
}

export const LIVE_KEEP_ALIVE_MS = 25_000;
export const LIVE_LIFETIME_MS = 10 * 60_000;

const encoder = new TextEncoder();

/** One frame as a server-sent event, named after its type. */
export const eventText = (frame: computeSchema.LiveFrame): string =>
	`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;

/** A watcher of an account's changes, answered as server-sent events. */
export function watchResponse(options: WatchOptions): Response {
	const { feed, accountId, now } = options;
	let stop: (() => void) | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let ended = false;
			// Checks run one after another, so the frames go in the order the changes came.
			let queue: Promise<void> = Promise.resolve();
			const write = (text: string) => {
				if (ended) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					end();
				}
			};
			const hello = () => write(eventText({ type: "hello", at: now() }));
			const keepAlive = setInterval(() => write(": keep-alive\n\n"), options.keepAliveMs ?? LIVE_KEEP_ALIVE_MS);
			const lifetime = setTimeout(() => end(), options.lifetimeMs ?? LIVE_LIFETIME_MS);
			const unwatch = feed.watch(accountId, {
				change(published) {
					queue = queue.then(async () => {
						if (ended) return;
						const verdict = await options.mayWatch(published).catch((): WatchVerdict => "skip");
						if (verdict === "end") return end();
						if (verdict === "skip") return;
						const { change } = published;
						write(
							eventText({
								type: "sandbox",
								sandboxId: change.sandboxId,
								accountId: change.accountId,
								state: change.state,
								...(change.previousState === undefined ? {} : { previousState: change.previousState }),
								at: change.at,
							}),
						);
					});
				},
				resync: () => {
					queue = queue.then(hello);
				},
				close: () => end(),
			});
			function end() {
				if (ended) return;
				ended = true;
				clearInterval(keepAlive);
				clearTimeout(lifetime);
				unwatch();
				options.signal?.removeEventListener("abort", end);
				try {
					controller.close();
				} catch {
					// Cancelled already.
				}
			}
			stop = end;
			if (options.signal?.aborted === true) return end();
			options.signal?.addEventListener("abort", end, { once: true });
			hello();
		},
		cancel() {
			stop?.();
		},
	});
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			// nginx and its kind: send each event as it is written, not when a buffer fills.
			"x-accel-buffering": "no",
		},
	});
}
