import type { ToolItem } from "@harbour/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowsingGroup, browsingSummary } from "./browsing-group.tsx";
import { tool } from "./fixtures.ts";
import { ToolCallGroup, workSummary } from "./tool-call.tsx";
import { turnFoldSummary } from "./transcript.tsx";

// The headers of collapsed sections of work (a turn's "Worked for" line, a group's, a browsing run's) say how long the
// work took and nothing more: no step count and no failed count. A failed step shows only as an alert mark.

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
		expect(browsingSummary(browsing())).toBe("Browsed for 11s");
		expect(browsingSummary(browsing(), true)).toBe("Browsing");
		expect(browsingSummary([...browsing(), tool("b3", "browser_type", "Typing", { status: "running" })])).toBe(
			"Browsing",
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

	it("mark a closed browsing run with a failed step, and leave a clean one unmarked", () => {
		const failed = renderToStaticMarkup(createElement(BrowsingGroup, { items: browsing("error") }));
		expect(failed).toContain("Browsed for 11s");
		expect(failed.split(mark).length - 1).toBe(1);
		expect(failed).not.toMatch(/\d+ (steps?|failed)/);
		const clean = renderToStaticMarkup(createElement(BrowsingGroup, { items: browsing() }));
		expect(clean).toContain("Browsed for 11s");
		expect(clean).not.toContain("hb-step-failed");
	});
});
