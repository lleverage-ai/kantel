import { describe, expect, it } from "vitest";
import { lintPackage, lintSource } from "./token-lint.ts";

describe("token and copy lint", () => {
	it("passes on the whole package", () => {
		const findings = lintPackage(new URL("..", import.meta.url).pathname);
		expect(findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`)).toEqual([]);
	});

	it("finds raw colours and sizes in component CSS", () => {
		const css = [
			".a {",
			"  color: #fff;",
			"  background: rgb(0 0 0 / 0.5);",
			"  padding: 12px;",
			"  border-color: white;",
			"}",
		].join("\n");
		expect(lintSource("src/x.css", css).map((finding) => finding.line)).toEqual([2, 3, 4, 5]);
	});

	it("allows raw values in the tokens file, in comments and in media and container queries", () => {
		expect(lintSource("src/tokens/tokens.css", ":root { --x: #fff; --y: 12px; }")).toEqual([]);
		expect(lintSource("src/x.css", "/* was #fff and 12px */\n.a { color: var(--hb-text); }")).toEqual([]);
		expect(lintSource("src/x.css", "@media (max-width: 600px) {")).toEqual([]);
		expect(lintSource("src/x.css", "@container hb-form (min-width: 36rem) {")).toEqual([]);
		expect(lintSource("src/x.css", "  animation: hb-spin 0.9s linear infinite;")).toHaveLength(1);
		expect(lintSource("src/x.css", "  transition: opacity 120ms;")).toHaveLength(1);
		expect(lintSource("src/x.css", "  transition: opacity var(--hb-duration-fast) var(--hb-ease);")).toEqual([]);
		expect(lintSource("src/x.css", ".hb-icons { display: flex; }")).toEqual([]);
		expect(lintSource("src/x.css", '[data-label="2s"] { display: flex; }')).toEqual([]);
		expect(lintSource("src/x.css", "@keyframes hb-spin-2s {")).toEqual([]);
	});

	it("requires token font sizes and radii", () => {
		expect(lintSource("src/x.css", "  font-size: 1.2em;")).toHaveLength(1);
		expect(lintSource("src/x.css", "  border-radius: 50%;")).toHaveLength(1);
		expect(lintSource("src/x.css", "  border-radius: var(--hb-radius);")).toEqual([]);
	});

	it("refuses uppercase tracked labels", () => {
		expect(lintSource("src/x.css", "  text-transform: uppercase;\n  letter-spacing: 0.06em;")).toHaveLength(2);
	});

	it("refuses arrows and middle dots in rendered text, and raw values in TSX", () => {
		expect(lintSource("src/x.tsx", "<Button>Open in vault →</Button>")).toHaveLength(1);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the template is the source text under test.
		expect(lintSource("src/x.tsx", "<span>{`${a} · ${b}`}</span>")).toHaveLength(1);
		expect(lintSource("src/x.tsx", '<div style={{ color: "#0a0a0a" }} />')).toHaveLength(1);
		expect(lintSource("src/x.tsx", '<div style={{ width: "12px" }} />')).toHaveLength(1);
		expect(lintSource("src/x.tsx", '<div style={{ width: "var(--hb-card-width)" }} />')).toEqual([]);
		expect(lintSource("src/x.tsx", "<div style={{ padding: 12 }} />")).toHaveLength(1);
		expect(lintSource("src/x.tsx", "<div style={{ marginTop: 0.5, gap: 4 }} />")).toHaveLength(1);
		expect(lintSource("src/x.tsx", "<div style={{ margin: 0, lineHeight: 1.4, flex: 1 }} />")).toEqual([]);
		expect(lintSource("src/x.tsx", '<div style={{ transition: "opacity 200ms" }} />')).toHaveLength(1);
		expect(lintSource("src/x.tsx", "<div style={{ padding: 12.0 }} />")).toHaveLength(1);
		expect(lintSource("src/x.tsx", "<div style={{ opacity: 0.5, flex: 1 }} />")).toEqual([]);
		expect(lintSource("src/x.tsx", '<div style={{ animationName: "hb-spin-2s" }} />')).toEqual([]);
		expect(lintSource("src/x.ts", "const point = { left: 1, top: 2 };")).toEqual([]);
		expect(lintSource("src/x.tsx", "// a comment about 12px and → arrows")).toEqual([]);
	});
});
