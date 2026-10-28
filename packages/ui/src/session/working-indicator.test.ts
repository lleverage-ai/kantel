import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assistant } from "./fixtures.ts";
import { AssistantMessage } from "./message.tsx";
import { WorkingIndicator } from "./working-indicator.tsx";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("the working indicator", () => {
	it("counts from when the turn started, as a timer named after its label", () => {
		const html = renderToStaticMarkup(createElement(WorkingIndicator, { since: Date.now() - 12_000 }));
		// The shared clock reads the time when it first ticks, so the count may lag by a second or so here.
		expect(text(html)).toMatch(/^Working for 1\ds$/);
		expect(html).toContain('role="timer"');
		expect(html).toContain('aria-label="Working"');
		expect(html).toContain("hb-status-dot hb-status-working");
	});

	it("says the label alone, as a status, without a start", () => {
		const html = renderToStaticMarkup(createElement(WorkingIndicator, { label: "Compacting" }));
		expect(text(html)).toBe("Compacting");
		expect(html).toContain('role="status"');
	});
});

describe("an answer as it streams", () => {
	const render = (item: ReturnType<typeof assistant>) =>
		renderToStaticMarkup(createElement(AssistantMessage, { item, turnStartedAt: Date.now() - 5_000 }));

	it("shows the working row before its first word or thought", () => {
		expect(text(render(assistant("a", "", { streaming: true })))).toMatch(/^Working for \ds$/);
	});

	it("shows its thought live, not behind a disclosure, before its first word", () => {
		const html = render(assistant("a", "", { streaming: true, thinking: "Checking the retry path" }));
		expect(html).toContain("hb-assistant-message-thinking-live");
		expect(text(html)).toContain("Checking the retry path");
		expect(html).not.toContain("aria-expanded");
		expect(text(html)).not.toContain("Working");
	});

	it("folds its thought behind Thought it through once words arrive", () => {
		const html = render(assistant("a", "The suite", { streaming: true, thinking: "Checking the retry path" }));
		expect(html).toContain("aria-expanded");
		expect(text(html)).toContain("Thought it through");
		expect(html).not.toContain("hb-assistant-message-thinking-live");
	});
});
