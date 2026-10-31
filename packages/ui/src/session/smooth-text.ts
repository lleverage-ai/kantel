import { useEffect, useReducer, useRef } from "react";

// Streamed text, shown smoothly. A model's words arrive in bursts (a few characters, then forty at once, then a pause),
// and drawn as they land the answer jumps forward a line at a time. Claude lets text flow in instead: what has arrived
// is revealed at a steady pace that speeds up with the backlog, so the reader sees a smooth stream that is never more
// than a moment behind the model. The pace is the backlog over a fixed window, so a big burst drains as fast as a small
// one, and once the stream ends what is left drains in a shorter window still. Nothing is replayed: an answer that is
// already on screen when this mounts (a reload, a row scrolled back into view) shows as it is.

/** While streaming, the backlog drains over this window: the most the text on screen trails the model, in ms. */
export const CATCH_UP_MS = 240;
/** Once the stream has ended, what is left drains over this shorter window. */
export const DRAIN_MS = 90;
/** The slowest pace, in characters per ms (120 a second), so the last few characters of a burst don't crawl. */
export const MIN_PER_MS = 0.12;
/** The longest step counted in one frame, so a background tab coming back doesn't jump as if no time had passed. */
const MAX_FRAME_MS = 50;

/** Where the reveal stands after `elapsed` ms, from `shown` characters towards `target`. Pure, for tests. */
export function advance(shown: number, target: number, elapsed: number, streaming: boolean): number {
	const backlog = target - shown;
	if (backlog <= 0) return target;
	const perMs = Math.max(MIN_PER_MS, backlog / (streaming ? CATCH_UP_MS : DRAIN_MS));
	return Math.min(target, shown + perMs * Math.min(elapsed, MAX_FRAME_MS));
}

/** The first `shown` characters of `text`, never splitting a surrogate pair. */
export function revealed(text: string, shown: number): string {
	let end = Math.min(text.length, Math.floor(shown));
	const code = text.charCodeAt(end - 1);
	if (end < text.length && code >= 0xd800 && code <= 0xdbff) end += 1;
	return text.slice(0, end);
}

function reducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * `text` as it should be on screen while it streams: revealed smoothly up to what has arrived, and once the stream
 * ends, the rest drains quickly. A text that changes while not streaming, or doesn't continue what is on screen
 * (rewritten, or another message), shows at once, as does everything under reduced motion.
 * `interval`: the fewest ms between renders, for a host whose render is dearer than a frame (a whole document).
 */
export function useSmoothText(text: string, streaming: boolean, interval = 0): string {
	const progress = useRef({ text, shown: text.length });
	const [, render] = useReducer((count: number) => count + 1, 0);
	const current = progress.current;
	if (current.text !== text) {
		// Only what arrives while streaming flows in: a change after the stream (the person's own edit, a saved
		// version) or one that doesn't continue what is on screen shows at once.
		if (!streaming || !text.startsWith(revealed(current.text, current.shown))) current.shown = text.length;
		current.text = text;
	}

	useEffect(() => {
		const state = progress.current;
		if (state.shown >= text.length) return;
		if (reducedMotion()) {
			state.shown = text.length;
			render();
			return;
		}
		let last = performance.now();
		let drawn = last;
		let frame = requestAnimationFrame(function tick(now) {
			state.shown = advance(state.shown, text.length, now - last, streaming);
			last = now;
			const done = state.shown >= text.length;
			if (done || now - drawn >= interval) {
				drawn = now;
				render();
			}
			if (!done) frame = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(frame);
	}, [text, streaming, interval]);

	return revealed(text, current.shown);
}
