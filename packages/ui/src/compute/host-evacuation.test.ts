import { describe, expect, it } from "vitest";
import { evacuationCountsText, evacuationRowText } from "./host-evacuation.tsx";

describe("a host's evacuation in words", () => {
	it("says the counts that aren't nought, and nothing to move when all are", () => {
		expect(evacuationCountsText({ moved: 8, skipped: 1, failed: 0 })).toBe("8 moved, 1 skipped");
		expect(evacuationCountsText({ moved: 0, skipped: 0, failed: 2 })).toBe("2 failed");
		expect(evacuationCountsText({ moved: 1200, skipped: 0, failed: 0 })).toBe("1,200 moved");
		expect(evacuationCountsText({ moved: 0, skipped: 0, failed: 0 })).toBe("Nothing to move");
	});

	it("counts those moved and those to go in the host's row", () => {
		expect(evacuationRowText({ moved: 3, remaining: 5 })).toBe("Moving sandboxes off, 3 moved, 5 to go");
	});
});
