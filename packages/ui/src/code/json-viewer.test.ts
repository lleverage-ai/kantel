import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JSON_PAGE, JsonViewer, jsonSummary } from "./json-viewer.tsx";

const render = (value: unknown, openDepth?: number) =>
	renderToStaticMarkup(
		createElement(JsonViewer, { value, label: "The response", ...(openDepth === undefined ? {} : { openDepth }) }),
	);

describe("JsonViewer", () => {
	it("opens the first level and folds what is under it, each fold a button", () => {
		const html = render({ total_count: 2, items: [{ number: 61 }, { number: 60 }] });
		expect(html).toContain('aria-label="The response"');
		expect(html).toContain("total_count");
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("2 items");
		expect(html).not.toContain("&quot;number&quot;");
	});

	it("opens as many levels as asked", () => {
		expect(render({ items: [{ number: 61 }] }, 3)).toContain("&quot;number&quot;");
	});

	it("shows a page of a long list, then a button for the rest", () => {
		const html = render(
			Array.from({ length: JSON_PAGE + 5 }, (_, index) => index),
			1,
		);
		expect(html).toContain("Show 5 more");
	});

	it("says what a fold holds", () => {
		expect(jsonSummary([1])).toBe("1 item");
		expect(jsonSummary({ a: 1, b: 2 })).toBe("2 keys");
	});
});
