import { describe, expect, it } from "vitest";
import { ordersCsv } from "./fixtures.ts";
import {
	breadcrumbOf,
	clampWidth,
	delimiterOf,
	extensionOf,
	mediaTypeOf,
	neighbours,
	PREVIEW_WIDTH,
	parseDelimited,
	previewTitle,
	textOf,
} from "./preview-model.ts";
import { PREVIEW_RENDERERS, rendererFor } from "./registry.ts";

const kindOf = (name: string, mimeType?: string, contentType?: string) =>
	rendererFor({ name, ...(mimeType === undefined ? {} : { mimeType }) }, contentType).kind;

describe("which renderer draws a file", () => {
	it("goes by the name first", () => {
		expect(kindOf("report.md")).toBe("markdown");
		expect(kindOf("summary.json")).toBe("json");
		expect(kindOf("notebook.ipynb")).toBe("json");
		expect(kindOf("data.csv")).toBe("csv");
		expect(kindOf("data.tsv")).toBe("csv");
		expect(kindOf("chart.PNG")).toBe("image");
		expect(kindOf("report.pdf")).toBe("pdf");
		expect(kindOf("page.html")).toBe("html");
		expect(kindOf("memo.docx")).toBe("docx");
		expect(kindOf("budget.xlsx")).toBe("xlsx");
		expect(kindOf("deck.pptx")).toBe("pptx");
		expect(kindOf("clip.mp4")).toBe("video");
		expect(kindOf("voice.mp3")).toBe("audio");
		expect(kindOf("analysis.py")).toBe("code");
		expect(kindOf("Makefile")).toBe("code");
		expect(kindOf("Dockerfile")).toBe("code");
	});

	it("falls back to the media type, then the type the server answered with", () => {
		expect(kindOf("export", "text/csv")).toBe("csv");
		expect(kindOf("render", "image/webp")).toBe("image");
		expect(kindOf("recording", undefined, "audio/ogg; codecs=opus")).toBe("audio");
		expect(kindOf("notes", undefined, "text/markdown; charset=utf-8")).toBe("markdown");
	});

	it("shows anything else as a file to download, never as active content", () => {
		expect(kindOf("release.zip")).toBe("binary");
		expect(kindOf("unknown.blob", "application/octet-stream")).toBe("binary");
		// SVG can carry script: it is shown as its source, not drawn.
		expect(kindOf("logo.svg")).toBe("code");
	});

	it("has one renderer per kind, each with a label and a loader", () => {
		const kinds = PREVIEW_RENDERERS.map((renderer) => renderer.kind);
		expect(new Set(kinds).size).toBe(kinds.length);
		for (const renderer of PREVIEW_RENDERERS) {
			expect(renderer.label).not.toBe("");
			expect(typeof renderer.load).toBe("function");
		}
	});
});

describe("the preview model", () => {
	it("reads names, types and titles", () => {
		expect(extensionOf("out/Report.PDF")).toBe("pdf");
		expect(extensionOf(".gitignore")).toBe("");
		expect(extensionOf("Makefile")).toBe("");
		expect(mediaTypeOf("Text/CSV; charset=utf-8")).toBe("text/csv");
		expect(mediaTypeOf(undefined)).toBe("");
		expect(previewTitle({ name: "plan.md", title: "  Quarterly plan " })).toBe("Quarterly plan");
		expect(previewTitle({ name: "plan.md", title: " " })).toBe("plan.md");
		expect(breadcrumbOf("out/charts/a.png")).toEqual(["out", "charts"]);
		expect(breadcrumbOf("/project/README.md")).toEqual(["project"]);
	});

	it("tells text from binary", () => {
		expect(textOf(new TextEncoder().encode("héllo"))).toBe("héllo");
		expect(textOf(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
		expect(textOf(new Uint8Array([0x61, 0x00, 0x62]))).toBeUndefined();
	});

	it("finds Previous and Next", () => {
		expect(neighbours(["a", "b", "c"], "b")).toEqual({ previous: "a", next: "c", index: 1, count: 3 });
		expect(neighbours(["a", "b", "c"], "a")).toEqual({ next: "b", index: 0, count: 3 });
		expect(neighbours(["a", "b", "c"], "c")).toEqual({ previous: "b", index: 2, count: 3 });
		expect(neighbours(["a"], "z")).toEqual({ index: -1, count: 1 });
		expect(neighbours([], undefined)).toEqual({ index: -1, count: 0 });
	});

	it("keeps the panel's width within bounds", () => {
		expect(clampWidth(0.1)).toBe(PREVIEW_WIDTH.min);
		expect(clampWidth(0.95)).toBe(PREVIEW_WIDTH.max);
		expect(clampWidth(0.5)).toBe(0.5);
		expect(clampWidth(Number.NaN)).toBe(PREVIEW_WIDTH.initial);
	});
});

describe("CSV and TSV", () => {
	it("parses quoting, escaped quotes, either line ending and a missing final newline", () => {
		expect(parseDelimited('a,b\r\n"x, y","say ""hi"""\n1,2', ",")).toEqual([
			["a", "b"],
			["x, y", 'say "hi"'],
			["1", "2"],
		]);
		expect(parseDelimited("a\tb\n1\t2\n", "\t")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
		expect(parseDelimited('"multi\nline",z\n', ",")).toEqual([["multi\nline", "z"]]);
		expect(parseDelimited("", ",")).toEqual([]);
	});

	it("picks the delimiter from the name or type", () => {
		expect(delimiterOf({ name: "a.tsv" })).toBe("\t");
		expect(delimiterOf({ name: "export", mimeType: "text/tab-separated-values" })).toBe("\t");
		expect(delimiterOf({ name: "a.csv" })).toBe(",");
	});

	it("parses a large export quickly enough to open at once", () => {
		const text = ordersCsv(20_000);
		const started = performance.now();
		const rows = parseDelimited(text, ",");
		expect(rows).toHaveLength(20_001);
		expect(rows[1]?.[3]).toBe("Customer 1, Ltd");
		expect(performance.now() - started).toBeLessThan(500);
	});
});
