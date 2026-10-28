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

	it("leaves the list alone for a session it doesn't have", () => {
		expect(withLive(listed, { id: "z", status: "running" })).toBe(listed);
		expect(withLive(listed, undefined)).toBe(listed);
	});
});
