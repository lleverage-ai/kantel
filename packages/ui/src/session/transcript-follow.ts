// Whether the transcript follows its end, after T3 Code's thread (pingdotgg/t3code, apps/web/src/components/chat/
// timelineViewport.ts and timelineScrollTarget.ts). Following stops only on the reader's own input that can take the
// list away from its end (a wheel or key up, a drag on the scrollbar, a finger, or an upward scroll that isn't the
// transcript's own), never because content changed height. It starts again when the reader comes back to the end
// after leaving it, or presses Scroll to end. Pure, so the rules are tested without a browser; transcript.tsx wires
// them to the list's events.

/** How close to the end still counts as at the end, in CSS pixels (T3 Code's TIMELINE_FOLLOW_REARM_THRESHOLD_PX). */
export const AT_END_PX = 40;

export type ScrollMetrics = { readonly top: number; readonly height: number; readonly client: number };

/** Within AT_END_PX of the end. */
export function isAtEnd(scroll: ScrollMetrics): boolean {
	return scroll.height - scroll.client - scroll.top <= AT_END_PX;
}

/** The list has content above what it shows: a move up can take it away from the end. */
export function canScrollUp(scroll: ScrollMetrics): boolean {
	return scroll.top > 0 && scroll.height > scroll.client;
}

/**
 * Following the end, or let go. Once let go, `atEnd` says whether the list is still in the end band: the reader must
 * leave it and come back before following starts again, so a key pressed at the end can't re-arm it at once.
 */
export type Follow = { readonly mode: "following" } | { readonly mode: "released"; readonly atEnd: boolean };

export type FollowEvent =
	/** The reader's input that can take the list away from its end. */
	| { readonly type: "navigated" }
	/** Scroll to end, or a new session opening at its end. */
	| { readonly type: "followEnd" }
	/** A scroll landed in the end band. */
	| { readonly type: "reachedEnd" }
	/** A scroll landed outside it. */
	| { readonly type: "leftEnd" }
	/** The transcript moved the list away itself: to a linked turn or a browser's view. */
	| { readonly type: "jumped" };

export const FOLLOWING: Follow = { mode: "following" };

export function nextFollow(state: Follow, event: FollowEvent): Follow {
	switch (event.type) {
		case "navigated":
			return state.mode === "released" ? state : { mode: "released", atEnd: true };
		case "followEnd":
			return FOLLOWING;
		case "reachedEnd":
			return state.mode === "released" && !state.atEnd ? FOLLOWING : state;
		case "leftEnd":
			// While following, a batch that has just grown the list leaves the end band until the list is pinned again.
			return state.mode === "released" && state.atEnd ? { mode: "released", atEnd: false } : state;
		case "jumped":
			return state.mode === "released" && !state.atEnd ? state : { mode: "released", atEnd: false };
	}
}

/** One input from the reader that may move the list. */
export type Navigation =
	| { readonly source: "wheel"; readonly up: boolean }
	| { readonly source: "key"; readonly up: boolean }
	| { readonly source: "pointer"; readonly onScrollbar: boolean }
	| { readonly source: "touch" }
	/** An upward scroll the transcript didn't make, with no input seen: an embedded frame's scroll chaining out. */
	| { readonly source: "scroll" };

/**
 * Whether an input lets go of the end. Up counts when there is content above; down only away from the end band, as a
 * batch that has just grown the list puts it outside the band for a frame and a wheel down then must not let go.
 */
export function releases(navigation: Navigation, scroll: ScrollMetrics): boolean {
	switch (navigation.source) {
		case "wheel":
			return navigation.up && canScrollUp(scroll);
		case "key":
			return navigation.up ? canScrollUp(scroll) : !isAtEnd(scroll);
		case "pointer":
			return navigation.onScrollbar ? canScrollUp(scroll) : !isAtEnd(scroll);
		case "touch":
			// A finger's direction isn't known from the event; an upward flick leaves the end band within a few moves.
			return !isAtEnd(scroll);
		case "scroll":
			return true;
	}
}

const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);
const DOWN_KEYS = new Set(["PageDown", "End", "ArrowDown", " "]);

/** A key that scrolls the list, and which way; undefined for any other key. */
export function scrollKey(key: string): { up: boolean } | undefined {
	if (UP_KEYS.has(key)) return { up: true };
	if (DOWN_KEYS.has(key)) return { up: false };
	return undefined;
}

/**
 * Notices an upward scroll that isn't the transcript's own: the list moved up while its content didn't shrink (a
 * virtualiser's correction for rows measured shorter above the view shrinks it) and no programmatic scroll was under
 * way. Slow scrolls that move under a pixel per event add up.
 */
export function upwardScrollDetector(initial: { top: number; height: number }) {
	let baseline = initial;
	return (next: { top: number; height: number; programmatic: boolean }): boolean => {
		if (next.programmatic || next.height < baseline.height || next.top > baseline.top) {
			baseline = { top: next.top, height: next.height };
			return false;
		}
		if (next.top < baseline.top - 1) {
			baseline = { top: next.top, height: next.height };
			return true;
		}
		baseline = { top: baseline.top, height: next.height };
		return false;
	};
}
