import type { TranscriptItem } from "@kantel/protocol";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { isBrowserCall } from "./browser-steps.ts";
import { BrowsingGroup } from "./browsing-group.tsx";
import { BROWSING_SESSION } from "./fixture-browsing-session.ts";
import { tool } from "./fixtures.ts";
import { toolRenderers } from "./tool-renderer-model.ts";
import { DEFAULT_TOOL_RENDERERS, defaultToolRenderers } from "./tool-renderers.tsx";
import { Transcript, type TranscriptProps } from "./transcript.tsx";
import { groupTranscript, turnFolds } from "./transcript-model.ts";

// A real browsing session (fixture-browsing-session.ts) as the transcript renders it: the browser's tools through the
// one renderer registry, each browsing run one line of the turn, the agent's words about it in view, and no browser
// call shown twice.

// The virtualiser renders no rows on a server; here every row renders, in order.
vi.mock("virtua", () => ({
	VList: ({ data, children }: { data: readonly unknown[]; children: (entry: unknown, index: number) => ReactNode }) =>
		createElement("div", null, ...data.map((entry, index) => children(entry, index))),
}));

const render = (props: TranscriptProps) => renderToStaticMarkup(createElement(Transcript, props));
const count = (html: string, text: string) => html.split(text).length - 1;
const rows = () =>
	groupTranscript(
		BROWSING_SESSION,
		undefined,
		DEFAULT_TOOL_RENDERERS.inPlace,
		(item) => DEFAULT_TOOL_RENDERERS.run(item)?.id,
	);

describe("a browsing session", () => {
	it("puts every browser call in a run, through the registry, and none in a group of generic rows", () => {
		const grouped = rows();
		const inRuns = grouped.flatMap((row) => (row.kind === "run" ? row.items.filter(isBrowserCall) : []));
		expect(inRuns).toHaveLength(BROWSING_SESSION.filter(isBrowserCall).length);
		for (const row of grouped) if (row.kind === "tools") expect(row.items.some(isBrowserCall)).toBe(false);
		expect(grouped.filter((row) => row.kind === "run").map((row) => row.run)).toEqual([
			"browser",
			"browser",
			"browser",
			"browser",
		]);
	});

	it("shows each run as one line with how it went, and the agent's words about it out of the turn's fold", () => {
		const html = render({ items: BROWSING_SESSION });
		expect(count(html, "kt-run-line")).toBe(4);
		expect(html).toContain("Browsed skyscanner.net for 20s");
		expect(html).toContain("8 steps");
		expect(html).toContain("3 failed");
		// No run's line is its last call's words.
		expect(html).not.toContain("Closing the browser");
		// Closed runs list no steps: a step is one switch away.
		expect(html).not.toContain("kt-tool-row");
		// The agent's words between runs are in view.
		expect(html).toContain("Skyscanner is showing a bot check.");
		expect(html).toContain("The Kayak results are loading");
		// Only the work before the browsing folds: the connections call and the thought before it.
		const folds = [...new Set(turnFolds(rows(), false).values())];
		expect(folds).toHaveLength(1);
		expect(folds[0]?.rows).toHaveLength(2);
	});

	const open = (index: number) => {
		const run = rows().filter((row) => row.kind === "run")[index];
		if (run?.kind !== "run") throw new Error("No run");
		return renderToStaticMarkup(createElement(BrowsingGroup, { items: run.items, defaultOpen: true }));
	};

	it("lists an open run's steps by what they did, with why a step failed and its thought folded in", () => {
		const html = open(1);
		expect(html).toContain("Went to consent.google.com");
		expect(count(html, "Couldn&#x27;t click [4]")).toBe(2);
		expect(count(html, "No element [4] on consent.google.com")).toBe(2);
		expect(html).toContain("Read “Before you continue”");
		// The thought between two steps is in the step it led to, not a row of its own in the run.
		expect(html).not.toContain("Thought it through");
		expect(count(html, "kt-tool-row")).toBe(8);
	});

	it("never renders a browser call twice: one row per step, under its run's one line", () => {
		const html = open(0);
		expect(count(html, "kt-run-line")).toBe(1);
		expect(count(html, "kt-tool-row")).toBe(2);
		expect(count(html, "Got a browser for google.com, skyscanner.net and kayak.co.uk")).toBe(1);
		expect(html).not.toContain("Asking for a browser");
	});

	it("leaves browser calls as generic rows for a registry with no browser entry", () => {
		const coding = toolRenderers(defaultToolRenderers.filter((entry) => entry.run === undefined));
		const items: TranscriptItem[] = [tool("b1", "browser_act", "Reading the page", { args: { action: "look" } })];
		const html = render({ items, toolRenderers: coding });
		expect(html).not.toContain("kt-run-line");
		expect(html).toContain("Reading the page");
	});
});
