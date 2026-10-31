import type { ToolItem } from "@harbour/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowsingGroup, browsingSummary } from "./browsing-group.tsx";
import { tool } from "./fixtures.ts";
import { ToolCallGroup, workSummary } from "./tool-call.tsx";
import { turnFoldSummary } from "./transcript.tsx";

// The headers of collapsed sections of work (a turn's "Worked for" line, a group's) say how long the work took and
// nothing more: no step count and no failed count. A failed step shows only as an alert mark. A browsing run is one
// line of the turn of its own, not a section a fold hides, so its line says how it went: how many steps, how many
// failed.

const calls = (failed?: ToolItem["status"]): ToolItem[] => [
	tool("t1", "read", "Read a.py", { secondsAgo: 90, seconds: 2 }),
	tool("t2", "bash", "Ran pytest", { secondsAgo: 80, seconds: 3, ...(failed ? { status: failed } : {}) }),
	tool("t3", "bash", "Ran ls", { secondsAgo: 70, seconds: 1 }),
];
const browsing = (failed?: ToolItem["status"]): ToolItem[] => [
	tool("b1", "browser_navigate", "Opened example.com", { secondsAgo: 60, seconds: 2 }),
	tool("b2", "browser_click", "Clicked Sign in", { secondsAgo: 50, seconds: 1, ...(failed ? { status: failed } : {}) }),
];
const mark = 'aria-label="A step failed"';

describe("work section headers", () => {
	it("say the time and never a step count", () => {
		expect(workSummary(calls())).toBe("Worked for 21s");
		expect(turnFoldSummary({ elapsed: 72_000 })).toBe("Worked for 1m 12s");
	});

	it("say how a browsing run went once it is done, and what it is doing while it runs", () => {
		expect(browsingSummary(browsing())).toBe("Browsed for 11s, 2 steps");
		expect(browsingSummary(browsing("error"))).toBe("Browsed for 11s, 2 steps, 1 failed");
		expect(browsingSummary(browsing(), true)).toBe("Browsing, Clicked Sign in");
		expect(browsingSummary([...browsing(), tool("b3", "browser_type", "Typing", { status: "running" })])).toBe(
			"Browsing, Typing",
		);
	});

	it("mark a closed group with a failed or interrupted step, with no count", () => {
		for (const status of ["error", "interrupted"] as const) {
			const html = renderToStaticMarkup(createElement(ToolCallGroup, { items: calls(status) }));
			expect(html).toContain("Worked for 21s");
			expect(html.split(mark).length - 1).toBe(1);
			expect(html).toContain('title="A step failed"');
			expect(html).toContain('role="img"');
			expect(html).not.toMatch(/\d+ (steps?|failed)/);
		}
	});

	it("leave a closed group whose steps all succeeded unmarked", () => {
		const html = renderToStaticMarkup(createElement(ToolCallGroup, { items: calls() }));
		expect(html).toContain("Worked for 21s");
		expect(html).not.toContain("hb-step-failed");
		expect(html).not.toMatch(/\d+ (steps?|failed)/);
	});

	it("count a browsing run's failed steps on its line, and say nothing of failure when none failed", () => {
		const failed = renderToStaticMarkup(createElement(BrowsingGroup, { items: browsing("error") }));
		expect(failed).toContain("Browsed for 11s");
		expect(failed).toMatch(/hb-run-failed[^>]*>.*1 failed/);
		const clean = renderToStaticMarkup(createElement(BrowsingGroup, { items: browsing() }));
		expect(clean).toContain("Browsed for 11s");
		expect(clean).not.toContain("failed");
	});
});
