import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { rowsShown, SESSION_LIST_STEP, SessionList } from "./session-list.tsx";
import type { SessionSummary } from "./session-model.ts";

const many = (count: number): SessionSummary[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `s${index}`,
		title: `Session ${index}`,
		status: "done",
		startedAt: 1_000_000 - index,
		updatedAt: 1_000_000 - index,
	}));

describe("the session list's rows", () => {
	it("shows a group's newest rows first and offers the rest", () => {
		const html = renderToStaticMarkup(createElement(SessionList, { sessions: many(130), grouped: false }));
		expect(html.match(/<li /g)?.length).toBe(SESSION_LIST_STEP);
		expect(html).toContain(`Show ${SESSION_LIST_STEP} more`);
	});

	it("shows every row of a short group, with nothing to show more of", () => {
		const html = renderToStaticMarkup(createElement(SessionList, { sessions: many(12), grouped: false }));
		expect(html.match(/<li /g)?.length).toBe(12);
		expect(html).not.toContain("more</button>");
	});

	it("never hides the selected session", () => {
		const sessions = many(130);
		expect(rowsShown(sessions, SESSION_LIST_STEP)).toBe(SESSION_LIST_STEP);
		expect(rowsShown(sessions, SESSION_LIST_STEP, "s99")).toBe(100);
		expect(rowsShown(sessions, SESSION_LIST_STEP, "s3")).toBe(SESSION_LIST_STEP);
		expect(rowsShown(sessions, SESSION_LIST_STEP, "gone")).toBe(SESSION_LIST_STEP);
		expect(rowsShown(many(10), SESSION_LIST_STEP, "s9")).toBe(10);
		const html = renderToStaticMarkup(createElement(SessionList, { sessions, grouped: false, selectedId: "s120" }));
		expect(html.match(/<li /g)?.length).toBe(121);
		expect(html).toContain("Show 9 more");
	});
});
