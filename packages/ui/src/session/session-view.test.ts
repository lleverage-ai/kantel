import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "./fixtures.ts";
import { SessionList } from "./session-list.tsx";
import type { SessionMenuActions } from "./session-menu.tsx";
import {
	arrangeSessions,
	defaultSessionListView,
	type SessionListView,
	type SessionSummary,
	sessionListViewOf,
} from "./session-model.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Noon, so "today" and "yesterday" don't hang on when the test runs.
const NOW = new Date(FIXTURE_NOW).setHours(12, 0, 0, 0);

const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
	id,
	title: `Session ${id}`,
	status: "idle",
	startedAt: NOW - HOUR,
	updatedAt: NOW - HOUR,
	...overrides,
});

const view = (overrides: Partial<SessionListView>): SessionListView => ({ ...defaultSessionListView, ...overrides });
const ids = (list: readonly { sessions: readonly SessionSummary[] }[]) => list.map((s) => s.sessions.map((x) => x.id));
const keys = (list: readonly { key: string }[]) => list.map((section) => section.key);

describe("arrangeSessions", () => {
	const list = [
		summary("old", { updatedAt: NOW - 40 * DAY, startedAt: NOW - 41 * DAY, title: "Alpha" }),
		summary("pinned", { pinned: true, updatedAt: NOW - 3 * DAY, title: "Pinned one" }),
		summary("archived", { archived: true, updatedAt: NOW - 2 * HOUR, title: "Beta" }),
		summary("waiting", { status: "waiting", needs: "approval", updatedAt: NOW - 5 * HOUR, title: "Gamma" }),
		summary("running", { status: "running", updatedAt: NOW - 3 * HOUR, title: "Delta" }),
		summary("recent", { updatedAt: NOW - 1000, startedAt: NOW - 10 * DAY, title: "Epsilon" }),
	];

	it("leaves archived sessions out of the default Active view and puts pinned ones first", () => {
		const sections = arrangeSessions(list, defaultSessionListView, NOW);
		expect(keys(sections)).toEqual(["pinned", "needs-you", "working", "done"]);
		expect(ids(sections)).toEqual([["pinned"], ["waiting"], ["running"], ["recent", "old"]]);
	});

	it("shows only archived sessions under Archived, and every session under All", () => {
		expect(ids(arrangeSessions(list, view({ status: "archived" }), NOW))).toEqual([["archived"]]);
		const all = arrangeSessions(list, view({ status: "all", groupBy: "none" }), NOW);
		expect(ids(all)).toEqual([["pinned"], ["recent", "archived", "running", "waiting", "old"]]);
	});

	it("keeps pinned sessions first however it groups and sorts, and filters them like the rest", () => {
		const byTitle = arrangeSessions(list, view({ groupBy: "none", sortBy: "title" }), NOW);
		expect(ids(byTitle)).toEqual([["pinned"], ["old", "running", "recent", "waiting"]]);
		const today = arrangeSessions(list, view({ activity: "today" }), NOW);
		expect(keys(today)).not.toContain("pinned");
	});

	it("filters by last activity", () => {
		const week = arrangeSessions(list, view({ activity: "week", groupBy: "none" }), NOW);
		expect(ids(week)).toEqual([["pinned"], ["recent", "running", "waiting"]]);
		const month = arrangeSessions(list, view({ activity: "month", groupBy: "none" }), NOW);
		expect(ids(month).flat()).not.toContain("old");
	});

	it("groups by date, on when it was created when sorted by that", () => {
		const byActivity = arrangeSessions(list, view({ groupBy: "date" }), NOW);
		expect(keys(byActivity)).toEqual(["pinned", "today", "older"]);
		const byCreated = arrangeSessions(list, view({ groupBy: "date", sortBy: "created" }), NOW);
		expect(keys(byCreated)).toEqual(["pinned", "today", "month", "older"]);
		expect(byCreated.find((section) => section.key === "month")?.sessions.map((s) => s.id)).toEqual(["recent"]);
	});

	it("sorts by creation", () => {
		const created = arrangeSessions(list, view({ groupBy: "none", sortBy: "created" }), NOW);
		expect(ids(created)[1]).toEqual(["running", "waiting", "recent", "old"]);
	});

	it("doesn't change what it's given", () => {
		const copy = [...list];
		arrangeSessions(list, view({ sortBy: "title" }), NOW);
		expect(list).toEqual(copy);
	});
});

describe("sessionListViewOf", () => {
	it("keeps known choices and falls back on anything else", () => {
		expect(sessionListViewOf({ status: "archived", sortBy: "title" })).toEqual(
			view({ status: "archived", sortBy: "title" }),
		);
		expect(sessionListViewOf({ status: "deleted", groupBy: 3 })).toEqual(defaultSessionListView);
		expect(sessionListViewOf(null)).toEqual(defaultSessionListView);
		expect(sessionListViewOf("active")).toEqual(defaultSessionListView);
	});
});

describe("the session list's filter and menu", () => {
	const actions: SessionMenuActions = {
		setUnread: async () => {},
		setPinned: async () => {},
		setArchived: async () => {},
		rename: async () => {},
		remove: async () => {},
	};
	const sessions = [summary("a", { pinned: true }), summary("b"), summary("c", { archived: true })];

	it("has Recents and its filter button, and a menu on each row shown", () => {
		const html = renderToStaticMarkup(
			createElement(SessionList, {
				sessions,
				view: defaultSessionListView,
				onViewChange: () => {},
				menuActions: actions,
			}),
		);
		expect(html).toContain(">Recents</h3>");
		expect(html).toContain('aria-label="Filter sessions"');
		expect(html).toContain('aria-label="Actions for Session a"');
		expect(html).toContain('aria-label="Actions for Session b"');
		expect(html).not.toContain("Session c");
		expect(html).toContain(">Pinned</span>");
	});

	it("says so when the filter leaves nothing", () => {
		const html = renderToStaticMarkup(
			createElement(SessionList, {
				sessions: [summary("b")],
				view: view({ status: "archived" }),
				onViewChange: () => {},
			}),
		);
		expect(html).toContain(">Archived</h3>");
		expect(html).toContain("No archived sessions");
	});

	it("has no heading, filter or menus without them", () => {
		const html = renderToStaticMarkup(createElement(SessionList, { sessions }));
		expect(html).not.toContain("Filter sessions");
		expect(html).not.toContain("Actions for");
		expect(html).toContain("Session c");
	});
});
