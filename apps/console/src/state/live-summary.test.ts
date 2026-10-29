import type { SessionSummary } from "@harbour/ui";
import { describe, expect, it } from "vitest";
import { withLive } from "./live-summary.ts";

const row = (id: string, status: SessionSummary["status"]): SessionSummary => ({
	id,
	title: `Session ${id}`,
	status,
	startedAt: 1,
	updatedAt: 2,
});

describe("the open session's live row", () => {
	const listed = [row("a", "done"), row("b", "done")];

	it("says working the moment the stream does, before the next poll", () => {
		const next = withLive(listed, { id: "b", status: "running" });
		expect(next.map((session) => session.status)).toEqual(["done", "running"]);
		expect(next[0]).toBe(listed[0]);
	});

	it("lists an idle session as done, as the listing does, and keeps the list when nothing changed", () => {
		expect(withLive(listed, { id: "a", status: "idle" })).toBe(listed);
	});

	it("says what a waiting session needs, and drops it when it stops waiting", () => {
		const waiting = withLive(listed, { id: "a", status: "waiting", needs: "approval" });
		expect(waiting[0]).toMatchObject({ status: "waiting", needs: "approval" });
		expect(withLive(waiting, { id: "a", status: "running" })[0]).not.toHaveProperty("needs");
	});

	it("takes the stream's title once it has one", () => {
		expect(withLive(listed, { id: "a", status: "done", title: "Fix billing" })[0]?.title).toBe("Fix billing");
		expect(withLive(listed, { id: "a", status: "done", title: "" })).toBe(listed);
	});

	it("lists a working session the poll hasn't seen yet, first, until the poll has it", () => {
		const next = withLive(listed, { id: "z", status: "running", title: "Write about harbours" }, 50);
		expect(next[0]).toEqual({
			id: "z",
			title: "Write about harbours",
			status: "running",
			startedAt: 50,
			updatedAt: 50,
			workingSince: 50,
		});
		expect(next.slice(1)).toEqual(listed);
		expect(withLive(listed, { id: "z", status: "running" }, 50)[0]?.title).toBe("Untitled session");
		expect(withLive(listed, { id: "z", status: "waiting", needs: "answer" }, 50)[0]).toMatchObject({
			status: "waiting",
			needs: "answer",
		});
		const polled = [row("z", "done"), ...listed];
		expect(withLive(polled, { id: "z", status: "running" }, 50)).toHaveLength(3);
	});

	it("counts a working row from when the stream turned it running, unless the list knows when the run began", () => {
		const started = withLive(listed, { id: "a", status: "running" }, 70);
		expect(started[0]?.workingSince).toBe(70);
		const polled = [{ ...row("a", "running"), workingSince: 60 }];
		expect(withLive(polled, { id: "a", status: "running" }, 70)).toBe(polled);
		expect(withLive(started, { id: "a", status: "idle" }, 90)[0]).not.toHaveProperty("workingSince");
	});

	it("leaves the list alone for a settled session it doesn't have, or no session", () => {
		expect(withLive(listed, { id: "z", status: "done" })).toBe(listed);
		expect(withLive(listed, { id: "z", status: "idle" })).toBe(listed);
		expect(withLive(listed, undefined)).toBe(listed);
	});
});
