import { describe, expect, it } from "vitest";
import {
	AT_END_PX,
	FOLLOWING,
	type Follow,
	type FollowEvent,
	isAtEnd,
	nextFollow,
	releases,
	scrollKey,
	upwardScrollDetector,
} from "./transcript-follow.ts";

const run = (events: FollowEvent["type"][], from: Follow = FOLLOWING) =>
	events.reduce((state, type) => nextFollow(state, { type } as FollowEvent), from);

// A list 2,000px tall in an 800px view: the end is at 1,200.
const at = (top: number) => ({ top, height: 2_000, client: 800 });

describe("isAtEnd", () => {
	it("counts the band above the end", () => {
		expect(isAtEnd(at(1_200))).toBe(true);
		expect(isAtEnd(at(1_200 - AT_END_PX))).toBe(true);
		expect(isAtEnd(at(1_200 - AT_END_PX - 1))).toBe(false);
	});
});

describe("nextFollow", () => {
	it("keeps following as content grows, whatever the band says", () => {
		expect(run(["leftEnd", "reachedEnd", "leftEnd"])).toBe(FOLLOWING);
	});

	it("lets go at once on the reader's input", () => {
		expect(run(["navigated"])).toEqual({ mode: "released", atEnd: true });
	});

	it("follows again only after leaving the end band and coming back", () => {
		expect(run(["navigated", "reachedEnd"]).mode).toBe("released");
		expect(run(["navigated", "leftEnd", "reachedEnd"])).toBe(FOLLOWING);
	});

	it("follows again on Scroll to end, from anywhere", () => {
		expect(run(["navigated", "leftEnd", "followEnd"])).toBe(FOLLOWING);
	});

	it("lets go on a jump to a linked turn, and follows when the reader comes back to the end", () => {
		expect(run(["jumped"])).toEqual({ mode: "released", atEnd: false });
		expect(run(["jumped", "reachedEnd"])).toBe(FOLLOWING);
	});

	it("doesn't change state it needn't, so nothing re-renders", () => {
		const released = run(["navigated", "leftEnd"]);
		expect(nextFollow(released, { type: "navigated" })).toBe(released);
		expect(nextFollow(released, { type: "leftEnd" })).toBe(released);
		expect(nextFollow(FOLLOWING, { type: "reachedEnd" })).toBe(FOLLOWING);
	});
});

describe("releases", () => {
	it("lets go on a wheel up with content above, never on a wheel down", () => {
		expect(releases({ source: "wheel", up: true }, at(1_200))).toBe(true);
		expect(releases({ source: "wheel", up: true }, at(0))).toBe(false);
		expect(releases({ source: "wheel", up: false }, at(600))).toBe(false);
	});

	it("lets go on a key down only away from the end band, as a batch may have just grown the list", () => {
		expect(releases({ source: "key", up: false }, at(1_190))).toBe(false);
		expect(releases({ source: "key", up: false }, at(600))).toBe(true);
		expect(releases({ source: "key", up: true }, at(1_200))).toBe(true);
	});

	it("lets go on a press on the scrollbar, but a click in the text at the end keeps following", () => {
		expect(releases({ source: "pointer", onScrollbar: true }, at(1_200))).toBe(true);
		expect(releases({ source: "pointer", onScrollbar: false }, at(1_200))).toBe(false);
	});

	it("never lets go when there's nothing to scroll", () => {
		const short = { top: 0, height: 600, client: 800 };
		expect(releases({ source: "wheel", up: true }, short)).toBe(false);
		expect(releases({ source: "pointer", onScrollbar: true }, short)).toBe(false);
	});
});

describe("scrollKey", () => {
	it("knows the keys that scroll", () => {
		expect(scrollKey("PageUp")).toEqual({ up: true });
		expect(scrollKey("End")).toEqual({ up: false });
		expect(scrollKey("a")).toBeUndefined();
	});
});

describe("upwardScrollDetector", () => {
	it("notices the list moving up with no programmatic scroll", () => {
		const up = upwardScrollDetector({ top: 1_000, height: 2_000 });
		expect(up({ top: 900, height: 2_000, programmatic: false })).toBe(true);
	});

	it("ignores the virtualiser's corrections, which shrink the content, and the transcript's own scrolls", () => {
		const up = upwardScrollDetector({ top: 1_000, height: 2_000 });
		expect(up({ top: 960, height: 1_960, programmatic: false })).toBe(false);
		expect(up({ top: 500, height: 1_960, programmatic: true })).toBe(false);
	});

	it("adds up slow moves under a pixel", () => {
		const up = upwardScrollDetector({ top: 1_000, height: 2_000 });
		expect(up({ top: 999.4, height: 2_000, programmatic: false })).toBe(false);
		expect(up({ top: 998.8, height: 2_000, programmatic: false })).toBe(true);
	});
});
