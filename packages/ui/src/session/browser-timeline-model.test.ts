import type { ToolItem } from "@kantel/protocol";
import { describe, expect, it } from "vitest";
import {
	browserSteps,
	pageAtPosition,
	type ReplayManifest,
	type ReplayStep,
	replayAt,
	replayPlan,
	replayPosition,
	replayReal,
	stepAt,
} from "./browser-timeline-model.ts";
import { tool } from "./fixtures.ts";

const T0 = 1_800_000_000_000;

// One page, recorded for two minutes and 22 seconds, as in the session that asked for the timeline.
const manifest: ReplayManifest = {
	startedAt: T0,
	pages: [
		{
			pageId: "1",
			startMs: 1000,
			durationMs: 141_000,
			chunks: [
				{ index: 0, startMs: 0, durationMs: 60_000 },
				{ index: 1, startMs: 60_000, durationMs: 60_000 },
				{ index: 2, startMs: 120_000, durationMs: 21_000 },
			],
			navigations: [
				{ atMs: 0, url: "https://example.com/", title: "Example Domain" },
				{ atMs: 50_000, url: "https://www.iana.org/help/example-domains", title: "Example Domains" },
			],
		},
	],
};

const steps: ReplayStep[] = [
	{ id: "open", label: "Opening example.com", at: T0 + 500, endedAt: T0 + 3000 },
	{ id: "click", label: "Clicking More information", at: T0 + 50_000, endedAt: T0 + 51_000 },
	{ id: "close", label: "Closing the browser", at: T0 + 140_000, endedAt: T0 + 140_500, failed: true },
];

describe("a browser's timeline", () => {
	it("keeps what happened around each step and skips the rest", () => {
		const plan = replayPlan(manifest, steps);
		expect(plan.recorded).toBe(141_000);
		// Opening: from the page's first frame (1000) to 1.5 s after the step ended (4500), on the page's clock 0-3500.
		expect(plan.segments.map(({ from, to, at }) => [from, to, at])).toEqual([
			[0, 3500, 0],
			[48_600, 51_500, 3500],
			[138_600, 141_000, 6400],
		]);
		expect(plan.duration).toBe(8800);
		expect(plan.markers.map((marker) => [marker.id, marker.position])).toEqual([
			// Before the page's first frame: the first stretch's start.
			["open", 0],
			["click", 3900],
			["close", 6800],
		]);
	});

	it("plays everything without skipping, or with no steps to go by", () => {
		const whole = replayPlan(manifest, steps, { skipIdle: false });
		expect(whole.segments).toHaveLength(1);
		expect(whole.duration).toBe(141_000);
		expect(whole.markers.map((marker) => marker.position)).toEqual([0, 49_000, 139_000]);
		expect(replayPlan(manifest, []).duration).toBe(141_000);
	});

	it("finds the page and the step at a position, and maps the browser's clock both ways", () => {
		const plan = replayPlan(manifest, steps);
		expect(replayAt(plan, 4000)).toMatchObject({ segment: { from: 48_600 }, pageMs: 49_100 });
		expect(stepAt(plan.markers, 100)?.id).toBe("open");
		expect(stepAt(plan.markers, 3900)?.id).toBe("click");
		expect(stepAt(plan.markers, 8800)?.id).toBe("close");
		expect(replayReal(plan, 4000)).toBe(50_100);
		expect(replayPosition(plan, 50_100)).toBe(4000);
		// A moment that was skipped plays from the next stretch.
		expect(replayPosition(plan, 20_000)).toBe(3500);
	});

	it("names the page the recording shows at a position, not the last one the browser saw", () => {
		const plan = replayPlan(manifest, steps);
		expect(pageAtPosition(plan, manifest.pages, 0)).toEqual({ url: "https://example.com/", title: "Example Domain" });
		expect(pageAtPosition(plan, manifest.pages, 5000)).toEqual({
			url: "https://www.iana.org/help/example-domains",
			title: "Example Domains",
		});
	});

	it("falls back to what the steps said of the page when the recording kept no navigations", () => {
		const bare: ReplayManifest = {
			...manifest,
			pages: manifest.pages.map(({ navigations: _navigations, ...page }) => page),
		};
		const said: ReplayStep[] = [
			{ ...(steps[0] as ReplayStep), page: { url: "https://example.com/", title: "Example Domain" } },
			...steps.slice(1),
		];
		const plan = replayPlan(bare, said);
		expect(pageAtPosition(plan, bare.pages, 5000)).toEqual({ url: "https://example.com/", title: "Example Domain" });
	});

	it("plays pages one after another", () => {
		const two: ReplayManifest = {
			startedAt: T0,
			pages: [
				{ pageId: "1", startMs: 0, durationMs: 10_000, chunks: [{ index: 0, startMs: 0, durationMs: 10_000 }] },
				{ pageId: "2", startMs: 4000, durationMs: 6000, chunks: [{ index: 0, startMs: 0, durationMs: 6000 }] },
			],
		};
		const plan = replayPlan(two, [{ id: "a", label: "Opening a tab", at: T0 + 4000, endedAt: T0 + 4500 }]);
		expect(plan.segments.map(({ pageId, from, to }) => [pageId, from, to])).toEqual([
			["1", 0, 600],
			["1", 3600, 6000],
			["2", 0, 2000],
		]);
		// The newest page showing at the step's start.
		expect(plan.markers[0]?.position).toBe(3000);
	});

	it("takes a browser's steps from the transcript: its calls only, failed ones said", () => {
		const items: ToolItem[] = [
			{ ...tool("a", "browser_request", "Asking for a browser", {}) },
			{
				...tool("b", "browser_open", "Opening example.com", { output: "URL: https://example.com/\nTitle: Example" }),
				browserSessionId: "bs_1",
			},
			{ ...tool("c", "browser_act", "Clicking", { status: "error" }), browserSessionId: "bs_1" },
			{ ...tool("d", "browser_act", "Elsewhere", {}), browserSessionId: "bs_2" },
		];
		const found = browserSteps(items, "bs_1");
		expect(found.map((step) => [step.id, step.label, step.failed ?? false])).toEqual([
			["b", "Opening example.com", false],
			["c", "Clicking", true],
		]);
		expect(found[0]?.page).toEqual({ url: "https://example.com/", title: "Example" });
	});

	it("starts calls asked for in one answer one after another", () => {
		const items: ToolItem[] = [
			{ ...tool("a", "browser_act", "Reading", {}), at: 1000, endedAt: 1100, browserSessionId: "bs_1" },
			{ ...tool("b", "browser_act", "Clicking", {}), at: 1000, endedAt: 2000, browserSessionId: "bs_1" },
			{ ...tool("c", "browser_act", "Scrolling", {}), at: 3000, endedAt: 3500, browserSessionId: "bs_1" },
		];
		expect(browserSteps(items, "bs_1").map((step) => step.at)).toEqual([1000, 1100, 3000]);
	});
});
