// What the session list shows for a session, as pure functions so the list, the inbox and tests agree.
//
// After T3 Code's sidebar (pingdotgg/t3code@1152e9171a9ce6ede20e0cc1f16ed0dbe103da9b,
// apps/web/src/components/Sidebar.logic.ts:871-898): approval wins, then an answer, then working, then failed or an
// unseen completion. A settled session you have already seen shows no status at all, only its time.

import type { SessionStatus } from "@kantel/protocol";
import type { Status } from "../tokens/tokens.ts";

/**
 * A session as the session list shows it. Not in the protocol yet: the list API arrives later, and this is the
 * shape the list needs from it.
 */
export type SessionSummary = {
	id: string;
	title: string;
	project?: string;
	branch?: string;
	status: SessionStatus;
	/** What the session is waiting on, when status is "waiting". */
	needs?: "approval" | "answer";
	startedAt: number;
	updatedAt: number;
	/**
	 * When the run under way started, while status is "running": the row's "Working 12s" counts from it. Without it the
	 * row counts from `startedAt`.
	 */
	workingSince?: number;
	/** Finished since you last opened it, or marked unread. */
	unread?: boolean;
	/** Pinned: it sits at the top of the list, under Pinned. */
	pinned?: boolean;
	/** Archived: out of the list's default (Active) view, still open to read and use. */
	archived?: boolean;
};

/** Where the list puts a session: waiting on you, still working, or settled. */
export type AttentionGroup = "needs-you" | "working" | "done";

/** The groups in the order the list shows them, with their headings. */
export const attentionGroups: readonly { group: AttentionGroup; label: string }[] = [
	{ group: "needs-you", label: "Needs you" },
	{ group: "working", label: "Working" },
	{ group: "done", label: "Done" },
];

/**
 * The status a session's row shows, or undefined for a settled session you have already seen (done and read, idle,
 * cancelled), which shows just its time.
 */
export function sessionStatus(summary: SessionSummary): Status | undefined {
	switch (summary.status) {
		case "waiting":
			return summary.needs === "approval" ? "approval" : "waiting";
		case "running":
			return "working";
		case "failed":
			return "error";
		case "done":
			return summary.unread === true ? "done" : undefined;
		default:
			return undefined;
	}
}

/** Which group a session belongs in: waiting sessions need you, running ones are working, the rest are done. */
export function attentionGroup(summary: SessionSummary): AttentionGroup {
	if (summary.status === "waiting") return "needs-you";
	if (summary.status === "running") return "working";
	return "done";
}

export type SessionGroup = { group: AttentionGroup; label: string; sessions: SessionSummary[] };

const newestFirst = (a: SessionSummary, b: SessionSummary): number => b.updatedAt - a.updatedAt;

/**
 * Sessions grouped as Needs you, Working, Done, in that order, each newest first by `updatedAt`. Empty groups are
 * left out. The input is not changed.
 */
export function groupSessions(list: readonly SessionSummary[]): SessionGroup[] {
	const buckets: Record<AttentionGroup, SessionSummary[]> = { "needs-you": [], working: [], done: [] };
	for (const summary of list) buckets[attentionGroup(summary)].push(summary);
	return attentionGroups
		.map(({ group, label }) => ({ group, label, sessions: buckets[group].sort(newestFirst) }))
		.filter((entry) => entry.sessions.length > 0);
}

// The list's filter, after Claude.ai's (the filter button by Recents): which sessions by status and last activity, how
// they're grouped and how they're sorted. Pinned sessions always come first, under Pinned.

export type SessionStatusFilter = "active" | "archived" | "all";
export type SessionActivityFilter = "all" | "today" | "week" | "month";
export type SessionGroupBy = "status" | "date" | "none";
export type SessionSortBy = "activity" | "created" | "title";

/** How the session list is filtered, grouped and sorted. A console remembers it in the browser. */
export type SessionListView = {
	readonly status: SessionStatusFilter;
	readonly activity: SessionActivityFilter;
	readonly groupBy: SessionGroupBy;
	readonly sortBy: SessionSortBy;
};

/** Active sessions of any age, grouped by what they need from you, the latest activity first. */
export const defaultSessionListView: SessionListView = {
	status: "active",
	activity: "all",
	groupBy: "status",
	sortBy: "activity",
};

/** The filter menu's options, in its order, with their labels. */
export const sessionViewChoices = {
	status: [
		{ value: "active", label: "Active" },
		{ value: "archived", label: "Archived" },
		{ value: "all", label: "All" },
	],
	activity: [
		{ value: "all", label: "All" },
		{ value: "today", label: "Today" },
		{ value: "week", label: "Past 7 days" },
		{ value: "month", label: "Past 30 days" },
	],
	groupBy: [
		{ value: "status", label: "Status" },
		{ value: "date", label: "Date" },
		{ value: "none", label: "None" },
	],
	sortBy: [
		{ value: "activity", label: "Last activity" },
		{ value: "created", label: "Date created" },
		{ value: "title", label: "Title" },
	],
} as const satisfies {
	readonly [Key in keyof SessionListView]: readonly { value: SessionListView[Key]; label: string }[];
};

/** A stored view, or any part of one, made whole: anything unknown falls back to the default. */
export function sessionListViewOf(value: unknown): SessionListView {
	const stored = typeof value === "object" && value !== null ? (value as { [key: string]: unknown }) : {};
	const pick = <Key extends keyof SessionListView>(key: Key): SessionListView[Key] => {
		const known = sessionViewChoices[key].find((choice) => choice.value === stored[key]);
		return (known?.value ?? defaultSessionListView[key]) as SessionListView[Key];
	};
	return { status: pick("status"), activity: pick("activity"), groupBy: pick("groupBy"), sortBy: pick("sortBy") };
}

/** A run of the arranged list: a heading (none for the list's main run when ungrouped) and its sessions. */
export type SessionSection = { readonly key: string; readonly label?: string; readonly sessions: SessionSummary[] };

const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (at: number): number => {
	const day = new Date(at);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
};

/** The earliest last activity `activity` keeps, or undefined for all. */
function activitySince(activity: SessionActivityFilter, now: number): number | undefined {
	if (activity === "today") return startOfDay(now);
	if (activity === "week") return now - 7 * DAY;
	if (activity === "month") return now - 30 * DAY;
	return undefined;
}

const comparators: Record<SessionSortBy, (a: SessionSummary, b: SessionSummary) => number> = {
	activity: (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
	created: (a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id),
	title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id),
};

/** Date groups, newest first: the first whose start a session's time is on or after takes it. */
function dateGroups(now: number): readonly { key: string; label: string; from: number }[] {
	const today = startOfDay(now);
	return [
		{ key: "today", label: "Today", from: today },
		{ key: "yesterday", label: "Yesterday", from: today - DAY },
		{ key: "week", label: "Previous 7 days", from: today - 7 * DAY },
		{ key: "month", label: "Previous 30 days", from: today - 30 * DAY },
		{ key: "older", label: "Older", from: Number.NEGATIVE_INFINITY },
	];
}

/**
 * The sessions as the list shows them under `view`: filtered by status and last activity, Pinned first, then grouped
 * (by what each needs from you, by date, or not at all) and sorted. Empty sections are left out; the input is not
 * changed.
 */
export function arrangeSessions(
	list: readonly SessionSummary[],
	view: SessionListView,
	now: number = Date.now(),
): SessionSection[] {
	const since = activitySince(view.activity, now);
	const compare = comparators[view.sortBy];
	const kept = list.filter(
		(session) =>
			(view.status === "all" || (view.status === "archived") === (session.archived === true)) &&
			(since === undefined || session.updatedAt >= since),
	);
	const pinned = kept.filter((session) => session.pinned === true).sort(compare);
	const rest = kept.filter((session) => session.pinned !== true);
	const sections: SessionSection[] = [{ key: "pinned", label: "Pinned", sessions: pinned }];
	if (view.groupBy === "status") {
		for (const { group, label } of attentionGroups) {
			sections.push({
				key: group,
				label,
				sessions: rest.filter((session) => attentionGroup(session) === group).sort(compare),
			});
		}
	} else if (view.groupBy === "date") {
		const groups = dateGroups(now);
		const timeOf = (session: SessionSummary) => (view.sortBy === "created" ? session.startedAt : session.updatedAt);
		const buckets = new Map<string, SessionSummary[]>(groups.map((group) => [group.key, []]));
		for (const session of rest) {
			const group = groups.find((candidate) => timeOf(session) >= candidate.from) ?? groups[groups.length - 1];
			if (group !== undefined) buckets.get(group.key)?.push(session);
		}
		for (const { key, label } of groups)
			sections.push({ key, label, sessions: (buckets.get(key) ?? []).sort(compare) });
	} else {
		sections.push({ key: "sessions", sessions: rest.sort(compare) });
	}
	return sections.filter((section) => section.sessions.length > 0);
}
