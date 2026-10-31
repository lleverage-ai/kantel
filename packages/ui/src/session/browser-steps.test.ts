import type { ToolItem } from "@harbour/protocol";
import { describe, expect, it } from "vitest";
import {
	browserStepFailed,
	browserStepLabel,
	browserStepReason,
	browsingRunSummary,
	isBrowserCall,
	siteOf,
} from "./browser-steps.ts";
import { BROWSING_SESSION } from "./fixture-browsing-session.ts";
import { tool } from "./fixtures.ts";

const act = (args: object, output: string, status: ToolItem["status"] = "done"): ToolItem =>
	tool("b1", "browser_act", "Using the browser", { args, output, status });

const calls = BROWSING_SESSION.filter(isBrowserCall);

describe("browserStepLabel", () => {
	it("names a goal run by how it ended, where and in how many steps", () => {
		const run = (output: string, status: ToolItem["status"] = "done") =>
			tool("b2", "browser_run", "Using the browser", {
				args: { goal: "search flights", url: "https://www.kayak.co.uk/" },
				output,
				status,
			});
		const page = "\n\nURL: https://www.kayak.co.uk/flights/MAN-AMS\nTitle: MAN to AMS\n";
		expect(browserStepLabel(run(`The goal is met.\nSteps (7, 9 decisions, 12.0 s):\n1. filled${page}`))).toBe(
			"Met the goal on kayak.co.uk in 7 steps",
		);
		expect(
			browserStepLabel(run(`It handed back to you: it was not sure.\nSteps (1, 2 decisions, 1.0 s):${page}`)),
		).toBe("Handed back on kayak.co.uk in 1 step");
		expect(browserStepLabel(run("browser.run failed: goal mode is off", "error"))).toBe(
			"Couldn't run a goal on kayak.co.uk",
		);
	});

	it("names a step by what it did, from its result's Did: line", () => {
		const page = "URL: https://consent.google.com/m?x=1\nTitle: Before you continue\n";
		expect(browserStepLabel(act({ action: "click" }, `${page}Did: click button “Reject all”, in: “Cookies”`))).toBe(
			"Clicked “Reject all”",
		);
		expect(browserStepLabel(act({ action: "fill" }, `${page}Did: fill searchbox “Where to?” ← “Amsterdam”`))).toBe(
			"Typed “Amsterdam” into “Where to?”",
		);
		expect(browserStepLabel(act({ action: "goto" }, `${page}Did: goto https://www.google.com/travel/flights`))).toBe(
			"Went to consent.google.com",
		);
		expect(browserStepLabel(act({ action: "press" }, `${page}Did: press Enter`))).toBe("Pressed Enter");
		expect(browserStepLabel(act({ action: "scroll" }, `${page}Did: scroll`))).toBe("Scrolled down");
		expect(browserStepLabel(act({ action: "look" }, page))).toBe("Read “Before you continue”");
	});

	it("says what a failed step set out to do", () => {
		const failed = act({ action: "click", element: "[4]" }, "browser.act failed (unavailable): …", "error");
		expect(browserStepLabel(failed)).toBe("Couldn't click [4]");
		expect(browserStepLabel(act({ action: "wait" }, "browser.act failed", "error"))).toBe("Couldn't wait for the page");
		expect(browserStepLabel(act({ action: "click" }, "URL: https://a.example/\nFailed: click button “Next”"))).toBe(
			"Couldn't click “Next”",
		);
	});

	it("keeps the session's words while a step runs, and when its result says nothing of what it did", () => {
		const running = { ...act({ action: "click" }, "", "running"), label: "Clicking on the page" };
		expect(browserStepLabel(running)).toBe("Clicking on the page");
		expect(browserStepLabel({ ...act({ action: "click" }, "Done."), label: "Clicking on the page" })).toBe(
			"Clicking on the page",
		);
	});

	it("names every step of a real run by its target", () => {
		expect(calls.map(browserStepLabel)).toEqual([
			"Got a browser for google.com, skyscanner.net and kayak.co.uk",
			"Opened skyscanner.net",
			"Went to consent.google.com",
			"Waited for the page",
			"Couldn't click [4]",
			"Read “Before you continue”",
			"Couldn't click [4]",
			"Went to kayak.co.uk",
			"Couldn't wait for the page",
			"Read “MAN to AMS, 16/12 – 19/12”",
			"Couldn't type into [49]",
			"Read “MAN to AMS, 16/12 – 19/12”",
			"Scrolled down",
			"Read “MAN to AMS, 16/12 – 19/12”",
			"Closed the browser",
		]);
	});
});

describe("browserStepReason", () => {
	it("says why a step failed in a line, without the tool's prefixes, its advice or the whole address", () => {
		expect(calls.filter(browserStepFailed).map(browserStepReason)).toEqual([
			"No element [4] on consent.google.com",
			"No element [4] on consent.google.com",
			"The page did not answer within 60 s; it may still be loading. The browser is still open",
			"No element [49] on kayak.co.uk",
		]);
	});

	it("says nothing for a step that didn't fail", () => {
		expect(browserStepReason(act({ action: "look" }, "URL: https://a.example/"))).toBeUndefined();
	});
});

describe("browsingRunSummary", () => {
	it("says how a finished run went: where it ended, how long, how many steps and how many failed", () => {
		expect(browsingRunSummary(calls, { running: false })).toEqual({
			title: "Browsed kayak.co.uk for 2m 37s",
			detail: "15 steps",
			failed: 4,
		});
	});

	it("says where a run is and what it is doing while it runs, never its last call once done", () => {
		const live = calls.slice(0, 9).map((call, index) => (index === 8 ? { ...call, status: "running" as const } : call));
		expect(browsingRunSummary(live, { running: true })).toEqual({
			title: "Browsing kayak.co.uk",
			detail: "Waiting for the page",
		});
		expect(browsingRunSummary(calls, { running: false }).title).not.toContain("Closing");
	});
});

describe("siteOf", () => {
	it("names a page's host as a person would", () => {
		expect(siteOf("https://www.kayak.co.uk/flights")).toBe("kayak.co.uk");
		expect(siteOf("not a url")).toBeUndefined();
	});
});
