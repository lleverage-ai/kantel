import { describe, expect, it } from "vitest";
import { clockTime, compactAge, duration, timeLeft } from "./format.ts";

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

	it("says when by the clock, naming the day once it is not today", () => {
		// Local times, so the test holds in any time zone.
		const local = (month: number, day: number, hour: number, minute: number, year = 2026) =>
			new Date(year, month, day, hour, minute).getTime();
		const today = local(9, 27, 16, 40);
		expect(clockTime(local(9, 27, 16, 38), today)).toBe("16:38");
		expect(clockTime(local(9, 27, 0, 5), today)).toBe("00:05");
		expect(clockTime(local(9, 26, 23, 59), today)).toBe("Yesterday at 23:59");
		expect(clockTime(local(9, 3, 9, 15), today)).toBe("03/10 09:15");
		expect(clockTime(local(11, 30, 9, 15, 2025), today)).toBe("30/12/2025 09:15");
		// A clock a little ahead of the server still says today.
		expect(clockTime(local(9, 27, 16, 41), today)).toBe("16:41");
	});

	it("counts down to an expiry", () => {
		expect(timeLeft(now + 899_000, now)).toBe("14:59 left");
		expect(timeLeft(now + 5_000, now)).toBe("0:05 left");
		expect(timeLeft(now + 2 * 3_600_000 + 600_000, now)).toBe("2h 10m left");
		expect(timeLeft(now, now)).toBe("Expired");
	});
});
