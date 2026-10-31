import { describe, expect, it } from "vitest";
import { advance, CATCH_UP_MS, DRAIN_MS, MIN_PER_MS, revealed } from "./smooth-text.ts";

describe("advance", () => {
	it("drains the backlog over the catch-up window while streaming", () => {
		// 480 characters behind: 2 a ms, so 16ms of frame reveals 32.
		expect(advance(0, 480, 16, true)).toBeCloseTo((480 / CATCH_UP_MS) * 16);
	});

	it("never trails far behind: a burst is mostly on screen within the window", () => {
		let shown = 0;
		for (let elapsed = 0; elapsed < CATCH_UP_MS * 2; elapsed += 16) shown = advance(shown, 2000, 16, true);
		expect(shown).toBeGreaterThan(2000 * 0.8);
	});

	it("keeps a floor pace for the last few characters", () => {
		expect(advance(0, 3, 16, true)).toBeCloseTo(Math.min(3, MIN_PER_MS * 16));
	});

	it("drains faster once the stream has ended", () => {
		expect(advance(0, 900, 16, false)).toBeCloseTo((900 / DRAIN_MS) * 16);
		expect(advance(0, 900, 16, false)).toBeGreaterThan(advance(0, 900, 16, true));
	});

	it("never passes the text, and counts a long gap as one short frame", () => {
		expect(advance(0, 5, 1000, true)).toBe(5);
		expect(advance(0, 10_000, 1000, true)).toBeCloseTo((10_000 / CATCH_UP_MS) * 50);
		expect(advance(12, 10, 16, true)).toBe(10);
	});
});

describe("revealed", () => {
	it("cuts at whole characters", () => {
		expect(revealed("Hello", 2.7)).toBe("He");
		expect(revealed("Hello", 99)).toBe("Hello");
	});

	it("never splits a surrogate pair", () => {
		const text = "a😀b";
		expect(revealed(text, 2)).toBe("a😀");
	});
});
