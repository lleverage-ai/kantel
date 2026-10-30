import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { describe, expect, it } from "vitest";
import { framedHtml, HTML_FRAME_SANDBOX } from "./html-frame.ts";
import { columnName, safeHref } from "./office-view.tsx";
import {
	fileToOpen,
	presentedFiles,
	presentedKey,
	presentedKind,
	presentedSubtitle,
	presentedTitle,
} from "./presented-file-model.ts";

const file = (path: string, mimeType = "application/octet-stream"): PresentedFile => ({
	workspaceId: "ws-1",
	path,
	name: path.split("/").at(-1) ?? path,
	mimeType,
	size: 10,
});

const call = (id: string, files: PresentedFile[], status: ToolItem["status"] = "done"): ToolItem => ({
	kind: "tool",
	id,
	callId: id,
	at: 0,
	name: "present_files",
	label: "Presenting files",
	status,
	files,
});

describe("presentedKind", () => {
	it("goes by the name first, then the media type", () => {
		expect(presentedKind(file("a/report.PDF"))).toBe("pdf");
		expect(presentedKind(file("notes.md"))).toBe("markdown");
		expect(presentedKind(file("page.htm"))).toBe("html");
		expect(presentedKind(file("data.tsv"))).toBe("csv");
		expect(presentedKind(file("deck.pptx"))).toBe("pptx");
		expect(presentedKind(file("download", "application/pdf"))).toBe("pdf");
		expect(presentedKind(file("picture", "image/png"))).toBe("image");
		expect(presentedKind(file("Makefile"))).toBe("text");
		expect(presentedKind(file("archive.zip"))).toBe("other");
	});
});

describe("presentedTitle and presentedSubtitle", () => {
	const card = (path: string, mimeType?: string) => {
		const presented = file(path, mimeType);
		return [presentedTitle(presented), presentedSubtitle(presented, presentedKind(presented))];
	};

	it("titles a card with the name less its extension, and says what kind of file it is", () => {
		expect(card("out/The colours of the rainbow.pdf")).toEqual(["The colours of the rainbow", "PDF document"]);
		expect(card("notes.md")).toEqual(["notes", "Markdown document"]);
		expect(card("review.docx")).toEqual(["review", "Word document"]);
		expect(card("chart.png")).toEqual(["chart", "PNG image"]);
		expect(card("data.tsv")).toEqual(["data", "TSV spreadsheet"]);
		expect(card("config.json")).toEqual(["config", "JSON file"]);
		expect(card("archive.zip")).toEqual(["archive", "ZIP file"]);
	});

	it("keeps a name with no extension, or a leading dot, whole", () => {
		expect(card("Makefile")).toEqual(["Makefile", "Text file"]);
		expect(card(".env")).toEqual([".env", "Text file"]);
	});

	it("titles a document with its own title, and calls it a document", () => {
		const document = { ...file("documents/colours.md"), title: "The colours of the rainbow", document: true };
		expect(presentedTitle(document)).toBe("The colours of the rainbow");
		expect(presentedSubtitle(document, presentedKind(document))).toBe("Document");
	});
});

describe("presentedFiles and fileToOpen", () => {
	it("lists the files finished calls presented, oldest first", () => {
		const items = [call("t1", [file("a.md")]), call("t2", [file("b.pdf")], "running"), call("t3", [file("c.pdf")])];
		expect(presentedFiles(items).map(({ file }) => file.path)).toEqual(["a.md", "c.pdf"]);
	});

	it("opens the first new file of the newest call that presents one", () => {
		const items = [call("t1", [file("a.md")]), call("t2", [file("b.pdf"), file("c.html")])];
		expect(fileToOpen(items, new Set())?.file.path).toBe("b.pdf");
		expect(fileToOpen(items, new Set([presentedKey(file("b.pdf"))]))?.file.path).toBe("c.html");
		const seen = new Set(presentedFiles(items).map(({ file }) => presentedKey(file)));
		expect(fileToOpen(items, seen)).toBeUndefined();
	});
});

describe("the Office views' helpers", () => {
	it("names columns as a spreadsheet does", () => {
		expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
			"A",
			"B",
			"Z",
			"AA",
			"AB",
			"AZ",
			"BA",
			"ZZ",
			"AAA",
		]);
	});

	it("keeps only web and mail links in a rendered document", () => {
		expect(safeHref("https://example.com")).toBe(true);
		expect(safeHref("mailto:a@example.com")).toBe(true);
		expect(safeHref("javascript:alert(1)")).toBe(false);
		expect(safeHref(" JavaScript:alert(1)")).toBe(false);
		expect(safeHref("data:text/html,hi")).toBe(false);
		expect(safeHref("file:///etc/passwd")).toBe(false);
	});
});

describe("framedHtml", () => {
	it("puts its policy first, after any doctype, so it holds before the page's own scripts", () => {
		expect(framedHtml("<h1>Hi</h1>")).toMatch(/^<meta http-equiv="Content-Security-Policy" content="[^"]+"><h1>/);
		const page = framedHtml("<!-- made by the agent -->\n<!DOCTYPE html><html><script>1</script></html>");
		expect(page.indexOf("Content-Security-Policy")).toBeGreaterThan(page.indexOf("<!DOCTYPE html>"));
		expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("<script>"));
		expect(page).toContain("connect-src 'none'");
		expect(page).toContain("form-action 'none'");
	});

	it("never lets the frame share the console's origin", () => {
		expect(HTML_FRAME_SANDBOX).not.toContain("allow-same-origin");
		expect(HTML_FRAME_SANDBOX).not.toContain("allow-top-navigation");
		expect(HTML_FRAME_SANDBOX).not.toContain("allow-forms");
	});
});
