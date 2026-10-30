import { describe, expect, it } from "vitest";
import { renderMarkdown, renderMissingShare, renderSharedPage } from "../src/shared-page.ts";

const file = (path: string, contentType: string, text: string) => ({
	share: { path, title: "Quarterly plan", updatedAt: Date.UTC(2026, 9, 30, 9, 0) },
	name: path.split("/").pop() ?? path,
	contentType,
	size: text.length,
	content: new TextEncoder().encode(text),
	rawUrl: "/shared/abc/raw",
});

describe("the shared page", () => {
	it("renders a document's Markdown with tables, and no markup or script of its own", () => {
		const html = renderMarkdown(
			"# Plan\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [good](https://example.com) ![p](http://example.com/a.png)",
		);
		expect(html).toContain("<h1>Plan</h1>");
		expect(html).toContain("<table>");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("onerror");
		expect(html).not.toContain("javascript:");
		expect(html).toContain('<a href="https://example.com" rel="noopener noreferrer">good</a>');
		// Only https images load.
		expect(html).not.toContain("http://example.com/a.png");
	});

	it("is one page under a CSP that runs no script", async () => {
		const response = renderSharedPage(file("documents/plan.md", "text/markdown; charset=utf-8", "# Plan\n\nHello."));
		expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(response.headers.get("cache-control")).toBe("no-store");
		const html = await response.text();
		expect(html).toContain("<title>Quarterly plan</title>");
		expect(html).toContain("<p>Hello.</p>");
		expect(html).toContain('href="/shared/abc/raw"');
	});

	it("shows a PDF in the browser's viewer, text as text, and anything else as a download", async () => {
		expect(await renderSharedPage(file("a.pdf", "application/pdf", "%PDF")).text()).toContain("<iframe");
		expect(await renderSharedPage(file("a.txt", "text/plain; charset=utf-8", "<b>x</b>")).text()).toContain(
			"&lt;b&gt;x&lt;/b&gt;",
		);
		expect(await renderSharedPage(file("a.docx", "application/octet-stream", "PK")).text()).toContain(
			"Download the file",
		);
		expect(renderMissingShare().status).toBe(404);
	});
});
