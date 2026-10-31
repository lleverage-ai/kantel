// When the session screen opens a presented file's viewer on its own: the first time a call presents that file, as
// the call finishes while the screen is open. Files in the session when it loads, and those in older pages the reader
// scrolls back to, open only when their card is pressed. The pure part of the session view, so it can be tested.

import type { PresentedFile, TranscriptItem } from "@kantel/protocol";
import { presentedKey } from "@kantel/ui";

export interface AutoOpen {
	/**
	 * Takes the transcript's items as they change and answers the file to open now, if any: the first file of the newest
	 * call that has just finished presenting a file no earlier call presented.
	 */
	next(items: readonly TranscriptItem[]): PresentedFile | undefined;
}

export function createAutoOpen(): AutoOpen {
	/** Every file a finished call has presented, by key. */
	const presented = new Set<string>();
	/** Calls seen while still running: when one finishes, it is new. */
	const running = new Set<string>();
	/** Every item seen, by ID. */
	const known = new Set<string>();
	let started = false;

	return {
		next(items) {
			// The newest item seen before: anything after it in this list arrived since.
			let lastKnown = -1;
			for (let index = items.length - 1; index >= 0; index--) {
				if (known.has(items[index]?.id ?? "")) {
					lastKnown = index;
					break;
				}
			}
			let open: PresentedFile | undefined;
			items.forEach((item, index) => {
				const fresh = started && (running.has(item.id) || (!known.has(item.id) && index > lastKnown));
				known.add(item.id);
				if (item.kind !== "tool") return;
				if (item.status === "running") {
					running.add(item.id);
					return;
				}
				running.delete(item.id);
				if (item.status !== "done" || item.files === undefined) return;
				let first: PresentedFile | undefined;
				for (const file of item.files) {
					const key = presentedKey(file);
					if (!presented.has(key) && first === undefined) first = file;
					presented.add(key);
				}
				if (fresh && first !== undefined) open = first;
			});
			started = true;
			return open;
		},
	};
}
