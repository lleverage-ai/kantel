import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoteMarkdown } from "./note-markdown.tsx";

const render = (text: string) => renderToStaticMarkup(createElement(NoteMarkdown, { text }));

describe("NoteMarkdown", () => {
	it("parses the note as one document, so a reference defined later resolves", () => {
		const html = render("See [the runbook][runbook].\n\nMore text.\n\n[runbook]: https://example.com/runbook\n");
		expect(html).toContain('href="https://example.com/runbook"');
		expect(html).toContain('target="_blank"');
	});

	it("names every task box, in a quote and a nested list too, and leaves code alone", () => {
		const html = render(
			[
				"- [x] Staging",
				"- [ ] Canary",
				"  - [ ] Half",
				"",
				"> - [ ] Quoted",
				"",
				"    - [ ] indented code",
				"",
				"```",
				"- [ ] fenced code",
				"```",
			].join("\n"),
		);
		const boxes = html.match(/<input[^>]*>/g) ?? [];
		expect(boxes).toHaveLength(4);
		for (const box of boxes) {
			expect(box).toMatch(/aria-label="(Done|Not done)"/);
			expect(box).toContain("disabled");
		}
		expect(boxes.filter((box) => box.includes('aria-label="Done"'))).toHaveLength(1);
		expect(html).toContain("- [ ] indented code");
		expect(html).toContain("- [ ] fenced code");
	});

	it("skips raw HTML and makes code blocks focusable", () => {
		const html = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n```\ncode\n```\n');
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).toMatch(/<pre[^>]*tabindex="0"/);
	});
});
