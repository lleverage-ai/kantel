import { describe, expect, it } from "vitest";
import { placePopover } from "./popover-placement.ts";

// A 900px window with a 48px header: the clipping column runs from 48 to 900.
const column = { top: 48, bottom: 900 };

describe("placePopover", () => {
	it("opens upward when the popover fits above, as a docked composer's does", () => {
		const docked = { top: 820, bottom: 848 };
		expect(placePopover(docked, column, 392)).toEqual({ side: "top", room: 820 - 6 - 48 - 8 });
	});

	it("opens downward when it doesn't fit above and there's more room below, as a new session's centred composer", () => {
		// The model button of a composer in the middle of the window: 300px above it, 400px below.
		const centred = { top: 362, bottom: 390 };
		expect(placePopover(centred, column, 392)).toEqual({ side: "bottom", room: 900 - 8 - 390 - 6 });
	});

	it("stays on the preferred side, capped, when that side still has the more room", () => {
		const low = { top: 600, bottom: 628 };
		const place = placePopover(low, column, 700);
		expect(place.side).toBe("top");
		expect(place.room).toBe(600 - 6 - 48 - 8);
	});

	it("keeps the preferred side on a tie", () => {
		expect(placePopover({ top: 400, bottom: 400 }, { top: 0, bottom: 800 }, 1_000).side).toBe("top");
	});

	it("can prefer downward", () => {
		expect(placePopover({ top: 100, bottom: 128 }, column, 200, "bottom").side).toBe("bottom");
		expect(placePopover({ top: 800, bottom: 828 }, column, 200, "bottom").side).toBe("top");
	});

	it("never offers negative room", () => {
		const place = placePopover({ top: 50, bottom: 896 }, column, 300);
		expect(place.room).toBeGreaterThanOrEqual(0);
	});
});
