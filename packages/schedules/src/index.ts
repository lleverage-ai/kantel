/**
 * Portable schedule logic shared by every target: time-zone conversion with `Intl.DateTimeFormat`, recurrence and the
 * next due time. Pure: no storage and no clock here.
 */
import { KantelError, type Recurrence, type Schedule, type Timestamp, type Weekday } from "@kantel/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The fields of a schedule that decide when it is due. `createdAt` anchors `day` recurrence with an interval. */
export type ScheduleTiming = Pick<
	Schedule,
	"timezone" | "at" | "repeat" | "until" | "count" | "occurrences" | "createdAt"
>;

/** A wall-clock reading in a time zone. `month` is 1 to 12; `weekday` follows `Date.getUTCDay` (0 is Sunday). */
export interface ZonedDateTime {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly weekday: number;
}

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timezone);
	if (formatter === undefined) {
		try {
			formatter = new Intl.DateTimeFormat("en-US", {
				timeZone: timezone,
				hourCycle: "h23",
				year: "numeric",
				month: "numeric",
				day: "numeric",
				hour: "numeric",
				minute: "numeric",
				second: "numeric",
			});
		} catch {
			throw new KantelError("invalid", `"${timezone}" is not an IANA time zone`);
		}
		formatters.set(timezone, formatter);
	}
	return formatter;
}

/** Rejects with `invalid` unless `Intl.DateTimeFormat` knows `timezone`. */
export function assertValidTimeZone(timezone: string): void {
	if (timezone.trim().length === 0) throw new KantelError("invalid", "A schedule needs a time zone");
	formatterFor(timezone);
}

/** The hour and minute of an `HH:MM` local time; rejects with `invalid` otherwise. */
export function parseLocalTime(at: string): { readonly hour: number; readonly minute: number } {
	const match = LOCAL_TIME.exec(at);
	if (match === null) throw new KantelError("invalid", `"${at}" is not an HH:MM time`);
	return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The wall-clock reading of `ts` in `timezone`, to the second. */
export function utcToZoned(ts: Timestamp, timezone: string): ZonedDateTime {
	const fields: { [part: string]: number } = {};
	for (const part of formatterFor(timezone).formatToParts(ts)) {
		if (part.type !== "literal") fields[part.type] = Number(part.value);
	}
	const year = fields.year!;
	const month = fields.month!;
	const day = fields.day!;
	return {
		year,
		month,
		day,
		hour: fields.hour!,
		minute: fields.minute!,
		second: fields.second!,
		weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
	};
}

/** The wall-clock reading of `ts` as if it were UTC, to the millisecond. */
function localMs(ts: Timestamp, timezone: string): number {
	const zoned = utcToZoned(ts, timezone);
	const wholeSecond = Math.floor(ts / 1000) * 1000;
	return Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second) + (ts - wholeSecond);
}

/**
 * The instant of a local wall-clock time in `timezone`. A time that does not exist (the spring-forward gap) becomes
 * the first valid instant after the gap; an ambiguous time (fall back) becomes the first of its two instants.
 */
export function zonedToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timezone: string,
): Timestamp {
	const wanted = Date.UTC(year, month - 1, day, hour, minute);
	const offsets = new Set([wanted - DAY_MS, wanted, wanted + DAY_MS].map((probe) => localMs(probe, timezone) - probe));
	const exact = [...offsets]
		.map((offset) => wanted - offset)
		.filter((candidate) => localMs(candidate, timezone) === wanted)
		.sort((left, right) => left - right);
	if (exact.length > 0) return exact[0]!;
	// In a gap: the wall clock jumps over `wanted` somewhere between these two instants. Find where.
	let low = wanted - Math.max(...offsets);
	let high = wanted - Math.min(...offsets);
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if (localMs(middle, timezone) >= wanted) high = middle;
		else low = middle;
	}
	return high;
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Rejects with `invalid` unless the recurrence is well formed. */
export function assertValidRecurrence(repeat: Recurrence): void {
	switch (repeat.every) {
		case "minutes":
		case "hours":
			if (!isPositiveInteger(repeat.interval)) throw new KantelError("invalid", "interval must be a positive integer");
			if (!Number.isFinite(repeat.from)) throw new KantelError("invalid", "from must be a timestamp");
			return;
		case "day":
			parseLocalTime(repeat.at);
			if (repeat.interval !== undefined && !isPositiveInteger(repeat.interval)) {
				throw new KantelError("invalid", "interval must be a positive integer");
			}
			return;
		case "weekday":
			parseLocalTime(repeat.at);
			return;
		case "week":
			parseLocalTime(repeat.at);
			if (repeat.on.length === 0 || repeat.on.some((weekday) => !WEEKDAYS.includes(weekday))) {
				throw new KantelError("invalid", "A weekly recurrence needs days from mon to sun");
			}
			return;
		case "month":
			parseLocalTime(repeat.at);
			if (!Number.isInteger(repeat.day) || repeat.day < 1 || repeat.day > 31) {
				throw new KantelError("invalid", "A monthly day must be 1 to 31");
			}
			return;
		default:
			throw new KantelError("invalid", "Unknown recurrence");
	}
}

type IntervalRecurrence = Extract<Recurrence, { readonly from: Timestamp }>;
type CalendarRecurrence = Exclude<Recurrence, IntervalRecurrence>;

function isInterval(repeat: Recurrence): repeat is IntervalRecurrence {
	return repeat.every === "minutes" || repeat.every === "hours";
}

/** Whether a calendar recurrence is due on `date`, a local date held as UTC midnight. */
function calendarMatches(repeat: CalendarRecurrence, date: Date, anchorDay: number): boolean {
	const weekday = date.getUTCDay();
	switch (repeat.every) {
		case "day": {
			const interval = repeat.interval ?? 1;
			const elapsed = Math.round(date.getTime() / DAY_MS) - anchorDay;
			return ((elapsed % interval) + interval) % interval === 0;
		}
		case "weekday":
			return weekday >= 1 && weekday <= 5;
		case "week":
			return repeat.on.includes(WEEKDAYS[weekday]!);
		case "month": {
			const year = date.getUTCFullYear();
			const month = date.getUTCMonth() + 1;
			return date.getUTCDate() === Math.min(repeat.day, daysInMonth(year, month));
		}
	}
}

function nextRecurrence(timing: ScheduleTiming, repeat: Recurrence, after: Timestamp): Timestamp | undefined {
	if (isInterval(repeat)) {
		const step = repeat.interval * (repeat.every === "minutes" ? MINUTE_MS : HOUR_MS);
		if (after < repeat.from) return repeat.from;
		return repeat.from + (Math.floor((after - repeat.from) / step) + 1) * step;
	}
	const { hour, minute } = parseLocalTime(repeat.at);
	const start = utcToZoned(after, timing.timezone);
	const anchor = utcToZoned(timing.createdAt, timing.timezone);
	const anchorDay = Date.UTC(anchor.year, anchor.month - 1, anchor.day) / DAY_MS;
	const firstDay = Date.UTC(start.year, start.month - 1, start.day) - DAY_MS;
	const span = 400 + (repeat.every === "day" ? (repeat.interval ?? 1) : 0);
	for (let index = 0; index < span; index += 1) {
		const date = new Date(firstDay + index * DAY_MS);
		if (!calendarMatches(repeat, date, anchorDay)) continue;
		const due = zonedToUtc(
			date.getUTCFullYear(),
			date.getUTCMonth() + 1,
			date.getUTCDate(),
			hour,
			minute,
			timing.timezone,
		);
		if (due > after) return due;
	}
	return undefined;
}

/**
 * The first due time strictly after `after`, or undefined when there is none: a one-off already past, a due time
 * after `until`, or `count` occurrences already materialised. Interval recurrence counts from `from` in absolute
 * milliseconds; calendar recurrence is at a local time in the schedule's time zone.
 */
export function nextDue(timing: ScheduleTiming, after: Timestamp): Timestamp | undefined {
	if (timing.count !== undefined && timing.occurrences >= timing.count) return undefined;
	let due: Timestamp | undefined;
	if (timing.at !== undefined) due = timing.at > after ? timing.at : undefined;
	else if (timing.repeat !== undefined) due = nextRecurrence(timing, timing.repeat, after);
	if (due === undefined || (timing.until !== undefined && due > timing.until)) return undefined;
	return due;
}

/** Up to `n` due times at or after `from`, never more than the occurrences `count` still allows. */
export function previewDue(timing: ScheduleTiming, from: Timestamp, n: number): Timestamp[] {
	const remaining = timing.count === undefined ? n : Math.min(n, timing.count - timing.occurrences);
	const due: Timestamp[] = [];
	let after = from - 1;
	while (due.length < remaining) {
		const next = nextDue(timing, after);
		if (next === undefined) break;
		due.push(next);
		after = next;
	}
	return due;
}
