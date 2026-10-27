import { describe, expect, it } from "vitest";
import { FIXTURE_NOW, sessions } from "./fixtures.ts";
import type { SessionSummary } from "./session-model.ts";
import { attentionGroup, groupSessions, sessionStatus } from "./session-model.ts";

const summary = (overrides: Partial<SessionSummary>): SessionSummary => ({
	id: "x",
	title: "A session",
	status: "idle",
	startedAt: FIXTURE_NOW - 60_000,
	updatedAt: FIXTURE_NOW,
	...overrides,
});

describe("sessionStatus", () => {
	it("puts approval ahead of a plain wait", () => {
		expect(sessionStatus(summary({ status: "waiting", needs: "approval" }))).toBe("approval");
		expect(sessionStatus(summary({ status: "waiting", needs: "answer" }))).toBe("waiting");
		expect(sessionStatus(summary({ status: "waiting" }))).toBe("waiting");
	});

	it("maps running and failed", () => {
		expect(sessionStatus(summary({ status: "running" }))).toBe("working");
		expect(sessionStatus(summary({ status: "failed" }))).toBe("error");
	});

	it("shows Done only for an unseen completion", () => {
		expect(sessionStatus(summary({ status: "done", unread: true }))).toBe("done");
		expect(sessionStatus(summary({ status: "done", unread: false }))).toBeUndefined();
		expect(sessionStatus(summary({ status: "done" }))).toBeUndefined();
	});

	it("shows nothing for settled sessions you have seen", () => {
		expect(sessionStatus(summary({ status: "idle" }))).toBeUndefined();
		expect(sessionStatus(summary({ status: "cancelled" }))).toBeUndefined();
		expect(sessionStatus(summary({ status: "cancelled", unread: true }))).toBeUndefined();
	});
});

describe("attentionGroup", () => {
	it("groups by what the session needs", () => {
		expect(attentionGroup(summary({ status: "waiting", needs: "approval" }))).toBe("needs-you");
		expect(attentionGroup(summary({ status: "waiting", needs: "answer" }))).toBe("needs-you");
		expect(attentionGroup(summary({ status: "running" }))).toBe("working");
		expect(attentionGroup(summary({ status: "failed" }))).toBe("done");
		expect(attentionGroup(summary({ status: "done", unread: true }))).toBe("done");
		expect(attentionGroup(summary({ status: "idle" }))).toBe("done");
		expect(attentionGroup(summary({ status: "cancelled" }))).toBe("done");
	});
});

describe("groupSessions", () => {
	it("orders groups Needs you, Working, Done, each newest first", () => {
		const groups = groupSessions(sessions);
		expect(groups.map((group) => group.label)).toEqual(["Needs you", "Working", "Done"]);
		expect(groups.map((group) => group.group)).toEqual(["needs-you", "working", "done"]);
		expect(groups.map((group) => group.sessions.map((session) => session.id))).toEqual([
			["s1", "s2"],
			["s3"],
			["s5", "s4", "s6"],
		]);
	});

	it("sorts by updatedAt whatever the input order", () => {
		const shuffled = [...sessions].reverse();
		const done = groupSessions(shuffled).find((group) => group.group === "done");
		expect(done?.sessions.map((session) => session.id)).toEqual(["s5", "s4", "s6"]);
	});

	it("leaves out empty groups", () => {
		const groups = groupSessions([summary({ id: "a", status: "running" }), summary({ id: "b", status: "done" })]);
		expect(groups.map((group) => group.label)).toEqual(["Working", "Done"]);
		expect(groupSessions([])).toEqual([]);
	});

	it("does not change the input", () => {
		const input = [summary({ id: "old", updatedAt: 1 }), summary({ id: "new", updatedAt: 2 })];
		groupSessions(input);
		expect(input.map((session) => session.id)).toEqual(["old", "new"]);
	});
});
