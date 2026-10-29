import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { describe, expect, it } from "vitest";
import { framedHtml, HTML_FRAME_SANDBOX } from "./html-frame.ts";
import { fileToOpen, presentedFiles, presentedKey, presentedKind } from "./presented-file-model.ts";

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
