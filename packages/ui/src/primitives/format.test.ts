import { describe, expect, it } from "vitest";
import { compactAge, duration, timeLeft } from "./format.ts";

const now = Date.UTC(2026, 9, 27, 12, 0, 0);

describe("time formatting", () => {
	it("says ages compactly, without ago", () => {
		expect(compactAge(now - 10_000, now)).toBe("now");
		expect(compactAge(now - 4 * 60_000, now)).toBe("4m");
		expect(compactAge(now - 3 * 3_600_000, now)).toBe("3h");
		expect(compactAge(now - 2 * 86_400_000, now)).toBe("2d");
		expect(compactAge(now - 15 * 86_400_000, now)).toBe("2w");
		expect(compactAge(now + 5_000, now)).toBe("now");
	});

	it("says durations in the largest two units", () => {
		expect(duration(45_000)).toBe("45s");
		expect(duration(200_000)).toBe("3m 20s");
		expect(duration(180_000)).toBe("3m");
		expect(duration(3_900_000)).toBe("1h 5m");
		expect(duration(-5)).toBe("0s");
	});

	it("counts down to an expiry", () => {
		expect(timeLeft(now + 899_000, now)).toBe("14:59 left");
		expect(timeLeft(now + 5_000, now)).toBe("0:05 left");
		expect(timeLeft(now + 2 * 3_600_000 + 600_000, now)).toBe("2h 10m left");
		expect(timeLeft(now, now)).toBe("Expired");
	});
});
