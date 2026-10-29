// The schedules page's logic, apart from React: what it reads from `Schedules` (bound to the viewer by the host), how a
// schedule's timing reads as a sentence, when it runs next, and how each run reads in its history.

import type {
	CallContext,
	JsonValue,
	Occurrence,
	Page,
	PageRequest,
	RaisedFinding,
	Recurrence,
	Schedule,
	ScheduleKind,
	Schedules,
	Timestamp,
	Weekday,
} from "@harbour/contracts";
import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import type { BadgeTone } from "../primitives/status.tsx";

/**
 * What the page reads and changes: `Schedules`' calls with the viewer's call context already bound, so the page never
 * holds one. `bindSchedules` makes one from any implementation, the in-memory store or the console's API client.
 */
export interface SchedulesSource {
	list(filter?: { readonly status?: Schedule["status"] }, page?: PageRequest): Promise<Page<Schedule>>;
	get(scheduleId: string): Promise<Schedule>;
	preview(scheduleId: string, n: number): Promise<readonly Timestamp[]>;
	listOccurrences(scheduleId: string, page?: PageRequest): Promise<Page<Occurrence>>;
	pause(scheduleId: string): Promise<Schedule>;
	resume(scheduleId: string): Promise<Schedule>;
	/**
	 * The findings a check raised, newest first. `Schedules` has no read for these yet: `reportCheck` returns them to
	 * the runner and the store audits each as `schedules.finding.raised`, so a host reads them from the audit log or
	 * leaves this out, and the page shows only each run's count.
	 */
	findings?(scheduleId: string): Promise<readonly RaisedFinding[]>;
}

export type SchedulesApi = Pick<Schedules, "list" | "get" | "preview" | "listOccurrences" | "pause" | "resume">;

/** The page's source over `Schedules`, as the viewer `ctx`. */
export function bindSchedules(
	schedules: SchedulesApi,
	ctx: CallContext,
	findings?: SchedulesSource["findings"],
): SchedulesSource {
	return {
		list: (filter, page) => schedules.list(ctx, filter, page),
		get: (id) => schedules.get(ctx, id),
		preview: (id, n) => schedules.preview(ctx, id, n),
		listOccurrences: (id, page) => schedules.listOccurrences(ctx, id, page),
		pause: (id) => schedules.pause(ctx, id),
		resume: (id) => schedules.resume(ctx, id),
		...(findings === undefined ? {} : { findings }),
	};
}

/** Pages read per list, at most: enough for any organisation's schedules, without reading forever. */
const MAX_PAGES = 20;

/** Every item a paged read returns, up to `MAX_PAGES` pages of `limit`. */
export async function readPages<T>(
	read: (page: PageRequest) => Promise<Page<T>>,
	limit = 100,
): Promise<{ readonly items: readonly T[]; readonly complete: boolean }> {
	const items: T[] = [];
	let cursor: string | undefined;
	for (let index = 0; index < MAX_PAGES; index += 1) {
		const page = await read(cursor === undefined ? { limit } : { limit, cursor });
		items.push(...page.items);
		if (page.nextCursor === undefined) return { items, complete: true };
		cursor = page.nextCursor;
	}
	return { items, complete: false };
}

export const KIND_LABELS: Readonly<Record<ScheduleKind, string>> = {
	reminder: "Reminder",
	task: "Task",
	summary: "Summary",
	check: "Check",
	heartbeat: "Heartbeat",
	program: "Program",
};

const WEEKDAYS: Readonly<Record<Weekday, string>> = {
	mon: "Monday",
	tue: "Tuesday",
	wed: "Wednesday",
	thu: "Thursday",
	fri: "Friday",
	sat: "Saturday",
	sun: "Sunday",
};
const WEEK_ORDER: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "a, b and c". */
export function listText(parts: readonly string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const ordinalRules = new Intl.PluralRules("en-GB", { type: "ordinal" });
const ORDINAL_SUFFIX: Readonly<Record<string, string>> = { one: "st", two: "nd", few: "rd", other: "th" };
const ordinal = (n: number) => `${n}${ORDINAL_SUFFIX[ordinalRules.select(n)] ?? "th"}`;

/** A recurrence as a sentence: "Every weekday at 09:00", "Every 15 minutes", "On the last day of every month at 18:00". */
export function recurrenceText(repeat: Recurrence): string {
	switch (repeat.every) {
		case "minutes":
			return repeat.interval === 1 ? "Every minute" : `Every ${repeat.interval} minutes`;
		case "hours":
			return repeat.interval === 1 ? "Every hour" : `Every ${repeat.interval} hours`;
		case "day":
			return repeat.interval === undefined || repeat.interval === 1
				? `Every day at ${repeat.at}`
				: `Every ${repeat.interval} days at ${repeat.at}`;
		case "weekday":
			return `Every weekday at ${repeat.at}`;
		case "week": {
			const days = WEEK_ORDER.filter((day) => repeat.on.includes(day));
			if (days.length === 7) return `Every day at ${repeat.at}`;
			return `Every ${listText(days.map((day) => WEEKDAYS[day]))} at ${repeat.at}`;
		}
		case "month":
			return repeat.day >= 31
				? `On the last day of every month at ${repeat.at}`
				: `On the ${ordinal(repeat.day)} of every month at ${repeat.at}`;
	}
}

/**
 * A moment in a schedule's own time zone, which the page names once beside it: "Wed 29 Oct, 09:00". Without the zone's
 * abbreviation, which browsers spell differently ("GMT", "GMT+0").
 */
export function zonedText(at: Timestamp, timezone: string): string {
	try {
		return new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			weekday: "short",
			day: "numeric",
			month: "short",
			hour: "2-digit",
			minute: "2-digit",
		}).format(at);
	} catch {
		return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(at);
	}
}

/** A time zone as people say it: "London", "Amsterdam", "UTC". */
export function zoneName(timezone: string): string {
	const city = timezone.split("/").at(-1) ?? timezone;
	return `${city.replaceAll("_", " ")} time`;
}

const dayText = (at: Timestamp, timezone: string) => {
	try {
		return new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			day: "numeric",
			month: "short",
			year: "numeric",
		}).format(at);
	} catch {
		return new Date(at).toISOString().slice(0, 10);
	}
};

/** When it runs, in one line: the recurrence, or the one-off's moment. */
export function timingText(schedule: Schedule): string {
	if (schedule.repeat !== undefined) return recurrenceText(schedule.repeat);
	if (schedule.at !== undefined)
		return `Once, ${zonedText(schedule.at, schedule.timezone)} ${zoneName(schedule.timezone)}`;
	return "No time set";
}

/** Its limits, if any: "Until 30 Nov 2026", "At most 20 runs, 12 so far". */
export function limitText(schedule: Schedule): string | undefined {
	const parts: string[] = [];
	if (schedule.until !== undefined) parts.push(`Until ${dayText(schedule.until, schedule.timezone)}`);
	if (schedule.count !== undefined) {
		parts.push(
			`${parts.length === 0 ? "At most" : "at most"} ${schedule.count} ${schedule.count === 1 ? "run" : "runs"}, ${schedule.occurrences} so far`,
		);
	}
	return parts.length === 0 ? undefined : parts.join(", ");
}

/** "in 4m", "in 3h", "in 2d", "now": how long until a due time, compact, as the list shows it. */
export function timeUntil(at: Timestamp, now: number): string {
	const left = at - now;
	if (left < MINUTE) return "now";
	if (left < HOUR) return `in ${Math.floor(left / MINUTE)}m`;
	if (left < DAY) return `in ${Math.floor(left / HOUR)}h`;
	if (left < 7 * DAY) return `in ${Math.floor(left / DAY)}d`;
	return `in ${Math.floor(left / (7 * DAY))}w`;
}

export interface StateText {
	readonly label: string;
	readonly tone: BadgeTone;
}

export const SCHEDULE_STATUS: Readonly<Record<Schedule["status"], StateText>> = {
	active: { label: "Active", tone: "done" },
	paused: { label: "Paused", tone: "waiting" },
	ended: { label: "Ended", tone: "neutral" },
};

/** What the list says about when it next runs: "Next in 3h", "Paused", "Ended". */
export function nextText(schedule: Schedule, now: number): string {
	if (schedule.status === "paused") return "Paused";
	if (schedule.status === "ended") return "Ended";
	return schedule.nextDueAt === undefined ? "Nothing due" : `Next ${timeUntil(schedule.nextDueAt, now)}`;
}

export type StatusFilter = "active" | "paused" | "ended" | "all";

export const STATUS_FILTERS: readonly { readonly value: StatusFilter; readonly label: string }[] = [
	{ value: "active", label: "Active" },
	{ value: "paused", label: "Paused" },
	{ value: "ended", label: "Ended" },
	{ value: "all", label: "All" },
];

const STATUS_ORDER: Readonly<Record<Schedule["status"], number>> = { active: 0, paused: 1, ended: 2 };

/** Active first, soonest due first; then paused and ended, most recently changed first. */
export function sortSchedules(schedules: readonly Schedule[]): Schedule[] {
	return [...schedules].sort((left, right) => {
		const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
		if (byStatus !== 0) return byStatus;
		if (left.status === "active") {
			const due = (left.nextDueAt ?? Number.POSITIVE_INFINITY) - (right.nextDueAt ?? Number.POSITIVE_INFINITY);
			if (due !== 0 && !Number.isNaN(due)) return due;
		}
		return right.updatedAt - left.updatedAt || left.title.localeCompare(right.title);
	});
}

export function filterSchedules(schedules: readonly Schedule[], filter: StatusFilter): Schedule[] {
	return filter === "all" ? [...schedules] : schedules.filter((schedule) => schedule.status === filter);
}

export function countByStatus(schedules: readonly Schedule[]): Readonly<Record<StatusFilter, number>> {
	const counts = { active: 0, paused: 0, ended: 0, all: schedules.length };
	for (const schedule of schedules) counts[schedule.status] += 1;
	return counts;
}

/** What runs, as the page shows it: a message or brief as text, a command in mono, anything else as JSON. */
export type PayloadView =
	| { readonly kind: "text"; readonly label: string; readonly text: string }
	| { readonly kind: "command"; readonly label: string; readonly text: string }
	| { readonly kind: "json"; readonly label: string; readonly text: string };

const PAYLOAD_LABELS: Readonly<Record<ScheduleKind, string>> = {
	reminder: "Message",
	task: "Brief",
	summary: "Brief",
	check: "Command",
	heartbeat: "Payload",
	program: "Program",
};

const isStringArray = (value: JsonValue): value is readonly string[] =>
	Array.isArray(value) && value.every((part) => typeof part === "string");

/** The payload is opaque to the scheduler; the page shows the shapes it recognises and JSON otherwise. */
export function payloadView(schedule: Pick<Schedule, "kind" | "payload">): PayloadView {
	const label = PAYLOAD_LABELS[schedule.kind];
	const { payload } = schedule;
	if (typeof payload === "string") {
		return schedule.kind === "check" || schedule.kind === "program"
			? { kind: "command", label, text: payload }
			: { kind: "text", label, text: payload };
	}
	if (isStringArray(payload) && schedule.kind === "check") return { kind: "command", label, text: payload.join(" ") };
	return { kind: "json", label, text: JSON.stringify(payload, null, 2) };
}

export const OCCURRENCE_STATUS: Readonly<Record<Occurrence["status"], StateText>> = {
	due: { label: "Due", tone: "waiting" },
	running: { label: "Running", tone: "working" },
	succeeded: { label: "Succeeded", tone: "done" },
	failed: { label: "Failed", tone: "error" },
};

const field = (result: JsonValue | undefined, name: string): JsonValue | undefined =>
	result !== null && typeof result === "object" && !Array.isArray(result)
		? (result as { readonly [key: string]: JsonValue })[name]
		: undefined;

/**
 * How one run went, beyond its status. A check's result is `{ exitCode, raised }` (the store's `reportCheck`): exit 0
 * is healthy, 3 is findings, anything else failed. Other kinds' results are their handler's, shown when they are text.
 */
export function runState(occurrence: Occurrence, kind: ScheduleKind): StateText {
	if (kind === "check" && occurrence.status === "succeeded") {
		const exitCode = field(occurrence.result, "exitCode");
		if (exitCode === 3) {
			const raised = field(occurrence.result, "raised");
			return typeof raised === "number" && raised > 0
				? { label: raised === 1 ? "1 finding" : `${raised} findings`, tone: "approval" }
				: { label: "Findings, none new", tone: "neutral" };
		}
		return { label: "Healthy", tone: "done" };
	}
	return OCCURRENCE_STATUS[occurrence.status];
}

/** A line under a run: why it failed, what it said, how many due times it stood for and which attempt it was. */
export function runDetail(occurrence: Occurrence, kind: ScheduleKind): string | undefined {
	const parts: string[] = [];
	const exitCode = field(occurrence.result, "exitCode");
	if (kind === "check" && occurrence.status === "failed" && typeof exitCode === "number") {
		parts.push(`Exit code ${exitCode}`);
	} else if (typeof occurrence.result === "string") {
		parts.push(occurrence.result);
	} else {
		const message = field(occurrence.result, "message") ?? field(occurrence.result, "summary");
		if (typeof message === "string") parts.push(message);
	}
	if (occurrence.coalesced > 1) parts.push(`Stood for ${occurrence.coalesced} missed runs`);
	if (occurrence.attempt > 1) parts.push(`Attempt ${occurrence.attempt}`);
	return parts.length === 0 ? undefined : parts.join(". ");
}

/** A run worth a look: it failed, or a check found something. */
export function isProblem(occurrence: Occurrence, kind: ScheduleKind): boolean {
	return occurrence.status === "failed" || (kind === "check" && field(occurrence.result, "exitCode") === 3);
}

/** Runs newest first: `listOccurrences` reads oldest first, so the page reads them all and turns them round. */
export function newestFirst(occurrences: readonly Occurrence[]): Occurrence[] {
	return [...occurrences].sort((left, right) => right.dueAt - left.dueAt);
}

export const FINDING_REASON: Readonly<Record<RaisedFinding["reason"], string>> = {
	new: "New",
	escalated: "Got worse",
	reraise: "Still present",
	rising: "Rising",
	failures: "Repeated failures",
};

/** A free-text severity in sentence case, as a badge says it: "High". */
export function severityText(severity: string): string {
	return severity.length === 0 ? severity : `${severity[0]!.toUpperCase()}${severity.slice(1)}`;
}

/** The badge tone for a finding's free-text severity. */
export function severityTone(severity: string): BadgeTone {
	const value = severity.toLowerCase();
	if (value === "urgent" || value === "high" || value === "error" || value === "critical") return "error";
	if (value === "medium" || value === "warn" || value === "warning") return "approval";
	return "neutral";
}
