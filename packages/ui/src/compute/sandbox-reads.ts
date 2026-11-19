// When the Sandboxes page reads its sandboxes: one scheduler for every read it makes by itself, whether of the whole
// list or of a few sandboxes by ID, whoever asks (the live feed, the page's backstop poll, its own changes).
//
// Every one of those reads is answered by the same place on the hosted control plane (one Durable Object answers every
// request), and an account with dozens of sandboxes, GitHub runners among them, changes state every few seconds all
// day. Two tabs open on the Sandboxes page once read the whole list about every 2 seconds each, at 1.3 to 1.75 seconds
// a read, and that alone was enough to have it shed load and drop every host's connection (LLE-19729). So the page
// makes its reads through this, which keeps to a budget whatever is asked of it:
//
// - At most one read at a time, and at most one every `READ_GAP_MS`: the first ask after a quiet gap reads at once, and
//   everything asked during a gap is gathered into one read at its end.
// - A read is of one sandbox, by ID, while at most `READ_MAX_IDS` are waiting to be read: each is its own request, so
//   each takes its own turn, oldest asked first. More waiting, or a (re)connection of the live feed, reads the whole
//   list, which covers them all.
// - Nothing is read while the tab is hidden; what was asked meanwhile is read once when it's shown again. The page's
//   first read waits for the tab too, so a page opened in the background reads nothing until it's looked at.
// - Once a read of the whole list has failed, the next read of any kind is of the whole list, whenever what it reads
//   was asked, so the page recovers on the next change rather than only on the next poll; a failure with nothing
//   asked reads nothing more. A failed read of one sandbox reads the whole list next.

import { documentVisibility, type Visibility } from "./live-sandboxes.ts";

/** The shortest time between two reads the page makes by itself, in one tab. */
export const READ_GAP_MS = 5_000;

/** The most sandboxes waiting to be read one by one; more is one read of the whole list rather than many. */
export const READ_MAX_IDS = 5;

export interface SandboxReadCalls {
	/** Reads the whole list. Rejects when it couldn't. */
	list(): Promise<void>;
	/** Reads one sandbox, by ID. Rejects when it couldn't. */
	get(id: string): Promise<void>;
}

export interface SandboxReads {
	/** Read the whole list at the next read; `now` reads as soon as none is under way, without waiting out the gap. */
	all(now?: boolean): void;
	/** Read these sandboxes at the next read. */
	changed(ids: Iterable<string>): void;
	stop(): void;
}

export interface SandboxReadsOptions {
	readonly gapMs?: number;
	readonly maxIds?: number;
	readonly visibility?: Visibility;
	/** For tests. */
	readonly now?: () => number;
}

/** Makes the page's reads through `calls`, starting with a read of the whole list. */
export function sandboxReads(calls: SandboxReadCalls, options: SandboxReadsOptions = {}): SandboxReads {
	const gapMs = options.gapMs ?? READ_GAP_MS;
	const maxIds = options.maxIds ?? READ_MAX_IDS;
	const visibility = options.visibility ?? documentVisibility;
	const now = options.now ?? Date.now;
	// What the next read is to cover. It starts as the page's first read, of everything.
	let all = true;
	const ids = new Set<string>();
	let urgent = false;
	let listFailed = false;
	let busy = false;
	let last: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const owed = () => all || ids.size > 0;

	const fire = () => {
		timer = undefined;
		if (stopped || busy || !owed() || visibility.hidden()) return;
		// The oldest asked, unless the whole list is to be read; the rest wait their own turns.
		const [oldest] = ids;
		const id = all || listFailed || ids.size > maxIds ? undefined : oldest;
		const whole = id === undefined;
		if (whole) {
			all = false;
			ids.clear();
		} else ids.delete(id);
		urgent = false;
		busy = true;
		last = now();
		const read = whole ? calls.list() : calls.get(id);
		read
			.then(
				() => {
					if (whole) listFailed = false;
				},
				() => {
					if (whole) listFailed = true;
					else all = true;
				},
			)
			.finally(() => {
				busy = false;
				pump();
			});
	};

	function pump() {
		if (stopped || busy || timer !== undefined || !owed() || visibility.hidden()) return;
		const wait = urgent || last === undefined ? 0 : last + gapMs - now();
		if (wait <= 0) fire();
		else timer = setTimeout(fire, wait);
	}

	const stopListening = visibility.listen(() => {
		if (visibility.hidden() && timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		pump();
	});
	pump();

	return {
		all(atOnce = false) {
			all = true;
			if (atOnce) {
				urgent = true;
				if (timer !== undefined) clearTimeout(timer);
				timer = undefined;
			}
			pump();
		},
		changed(changed) {
			for (const id of changed) ids.add(id);
			pump();
		},
		stop() {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			stopListening();
		},
	};
}
