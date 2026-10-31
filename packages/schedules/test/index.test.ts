import { isKantelError } from "@kantel/contracts";
import {
	assertValidTimeZone,
	nextDue,
	parseLocalTime,
	previewDue,
	type ScheduleTiming,
	utcToZoned,
	zonedToUtc,
} from "@kantel/schedules";
import { describe, expect, it } from "vitest";

const utc = (iso: string) => Date.parse(iso);

function codeOf(operation: () => unknown): string | undefined {
	try {
		operation();
	} catch (error) {
		return isKantelError(error) ? error.code : String(error);
	}
	return undefined;
}

function timing(extra: Partial<ScheduleTiming>): ScheduleTiming {
	return { timezone: "Europe/London", occurrences: 0, createdAt: utc("2026-01-01T00:00:00Z"), ...extra };
}

describe("utcToZoned", () => {
	it("reads London wall-clock time either side of the October 2026 change", () => {
		expect(utcToZoned(utc("2026-10-25T00:30:00Z"), "Europe/London")).toEqual({
			year: 2026,
			month: 10,
			day: 25,
			hour: 1,
			minute: 30,
			second: 0,
			weekday: 0,
		});
		expect(utcToZoned(utc("2026-10-25T01:30:00Z"), "Europe/London")).toMatchObject({ hour: 1, minute: 30 });
	});

	it("reads New York wall-clock time", () => {
		expect(utcToZoned(utc("2026-07-04T16:05:09Z"), "America/New_York")).toMatchObject({
			year: 2026,
			month: 7,
			day: 4,
			hour: 12,
			minute: 5,
			second: 9,
			weekday: 6,
		});
	});
});

describe("zonedToUtc", () => {
	it("converts ordinary London times in winter and summer", () => {
		expect(zonedToUtc(2026, 1, 15, 9, 0, "Europe/London")).toBe(utc("2026-01-15T09:00:00Z"));
		expect(zonedToUtc(2026, 7, 15, 9, 0, "Europe/London")).toBe(utc("2026-07-15T08:00:00Z"));
	});

	it("moves a time in London's March 2026 gap to the first valid instant after it", () => {
		expect(zonedToUtc(2026, 3, 29, 1, 30, "Europe/London")).toBe(utc("2026-03-29T01:00:00Z"));
		expect(zonedToUtc(2026, 3, 29, 1, 0, "Europe/London")).toBe(utc("2026-03-29T01:00:00Z"));
		expect(zonedToUtc(2026, 3, 29, 2, 0, "Europe/London")).toBe(utc("2026-03-29T01:00:00Z"));
	});

	it("takes the first instant of an ambiguous time in London's October 2026 change", () => {
		expect(zonedToUtc(2026, 10, 25, 1, 30, "Europe/London")).toBe(utc("2026-10-25T00:30:00Z"));
		expect(zonedToUtc(2026, 10, 25, 2, 0, "Europe/London")).toBe(utc("2026-10-25T02:00:00Z"));
	});

	it("handles New York's 2026 transitions", () => {
		expect(zonedToUtc(2026, 3, 8, 2, 30, "America/New_York")).toBe(utc("2026-03-08T07:00:00Z"));
		expect(zonedToUtc(2026, 11, 1, 1, 30, "America/New_York")).toBe(utc("2026-11-01T05:30:00Z"));
		expect(zonedToUtc(2026, 11, 1, 9, 0, "America/New_York")).toBe(utc("2026-11-01T14:00:00Z"));
	});
});

describe("nextDue", () => {
	it("counts interval recurrence from `from` in absolute milliseconds", () => {
		const from = utc("2026-10-24T22:00:00Z");
		const sixHourly = timing({ repeat: { every: "hours", interval: 6, from } });
		expect(nextDue(sixHourly, from - 1)).toBe(from);
		expect(nextDue(sixHourly, from)).toBe(from + 6 * 3_600_000);
		expect(nextDue(sixHourly, from + 6 * 3_600_000 + 1)).toBe(from + 12 * 3_600_000);
	});

	it("runs day 31 on the last day of February", () => {
		const monthly = timing({ repeat: { every: "month", day: 31, at: "09:00" } });
		expect(nextDue(monthly, utc("2026-02-01T00:00:00Z"))).toBe(utc("2026-02-28T09:00:00Z"));
		expect(nextDue(monthly, utc("2028-02-01T00:00:00Z"))).toBe(utc("2028-02-29T09:00:00Z"));
	});

	it("skips weekends for weekday recurrence", () => {
		const weekdays = timing({ repeat: { every: "weekday", at: "08:00" } });
		expect(nextDue(weekdays, utc("2026-01-09T08:00:00Z"))).toBe(utc("2026-01-12T08:00:00Z"));
		expect(nextDue(weekdays, utc("2026-01-12T08:00:00Z"))).toBe(utc("2026-01-13T08:00:00Z"));
	});

	it("runs a day interval every n local days from the creation date", () => {
		const everyThird = timing({ repeat: { every: "day", at: "07:00", interval: 3 } });
		expect(previewDue(everyThird, utc("2026-01-01T00:00:00Z"), 3)).toEqual([
			utc("2026-01-01T07:00:00Z"),
			utc("2026-01-04T07:00:00Z"),
			utc("2026-01-07T07:00:00Z"),
		]);
	});

	it("respects until, count and one-offs", () => {
		const hourly = { every: "hours", interval: 1, from: utc("2026-01-01T00:00:00Z") } as const;
		expect(nextDue(timing({ repeat: hourly, until: utc("2026-01-01T02:00:00Z") }), utc("2026-01-01T02:00:00Z"))).toBe(
			undefined,
		);
		expect(previewDue(timing({ repeat: hourly, count: 3, occurrences: 1 }), hourly.from, 5)).toHaveLength(2);
		expect(nextDue(timing({ repeat: hourly, count: 3, occurrences: 3 }), 0)).toBe(undefined);
		const at = utc("2026-05-01T10:00:00Z");
		expect(nextDue(timing({ at }), at - 1)).toBe(at);
		expect(nextDue(timing({ at }), at)).toBe(undefined);
	});
});

describe("validation helpers", () => {
	it("rejects unknown time zones and malformed HH:MM as invalid", () => {
		expect(codeOf(() => assertValidTimeZone("Europe/Atlantis"))).toBe("invalid");
		expect(codeOf(() => parseLocalTime("7:00"))).toBe("invalid");
		expect(parseLocalTime("23:59")).toEqual({ hour: 23, minute: 59 });
	});
});
