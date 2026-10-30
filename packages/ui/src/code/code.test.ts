import { describe, expect, it } from "vitest";
import { hasAnsi, parseAnsi, stripAnsi } from "./ansi.ts";
import { languageForPath, loadHighlighter } from "./code.tsx";
import { codeLines } from "./code-view.tsx";
import { diffCounts, diffLines } from "./diff.ts";
import { highlightLines, languageName, splitHighlighted } from "./lines.ts";

const ESC = "\u001b";
const text = (lines: ReturnType<typeof parseAnsi>) => lines.map((line) => line.map((run) => run.text).join(""));

describe("parseAnsi", () => {
	it("keeps plain output as lines, a final newline ending the last", () => {
		expect(text(parseAnsi("one\ntwo\n"))).toEqual(["one", "two"]);
		expect(text(parseAnsi("one\r\n\ntwo"))).toEqual(["one", "", "two"]);
		expect(parseAnsi("")).toEqual([]);
	});

	it("styles runs with the 16 colours, bold and dim, and resets them", () => {
		const [line] = parseAnsi(
			`${ESC}[1;31mFAIL${ESC}[0m src/a.test.ts ${ESC}[2m(3 ms)${ESC}[22m ${ESC}[92mok${ESC}[39m`,
		);
		expect(line).toEqual([
			{ text: "FAIL", style: { bold: true, fg: 1 } },
			{ text: " src/a.test.ts ", style: {} },
			{ text: "(3 ms)", style: { dim: true } },
			{ text: " ", style: {} },
			{ text: "ok", style: { fg: 10 } },
		]);
	});

	it("keeps the 256-colour codes that name one of the 16 and drops the rest", () => {
		const [line] = parseAnsi(`${ESC}[38;5;2mgreen${ESC}[38;5;208morange${ESC}[38;2;1;2;3mrgb`);
		expect(line).toEqual([
			{ text: "green", style: { fg: 2 } },
			{ text: "orangergb", style: {} },
		]);
	});

	it("carries a style across lines, as a terminal does", () => {
		expect(parseAnsi(`${ESC}[33mwarn\nstill${ESC}[0m`)).toEqual([
			[{ text: "warn", style: { fg: 3 } }],
			[{ text: "still", style: { fg: 3 } }],
		]);
	});

	it("redraws a line after a carriage return, as a progress bar", () => {
		expect(text(parseAnsi("10%\r50%\r100%\ndone"))).toEqual(["100%", "done"]);
		// Split across escape codes too.
		expect(text(parseAnsi(`${ESC}[32m10%${ESC}[0m\r${ESC}[32m100%${ESC}[0m\n`))).toEqual(["100%"]);
	});

	it("drops cursor movement, screen clearing and titles", () => {
		const raw = `${ESC}]0;title${ESC}\\${ESC}[2K${ESC}[1Ghello${ESC}[?25l`;
		expect(text(parseAnsi(raw))).toEqual(["hello"]);
		expect(stripAnsi(raw)).toBe("hello");
		expect(hasAnsi(raw)).toBe(true);
		expect(hasAnsi("plain")).toBe(false);
	});
});

describe("diffLines", () => {
	it("keeps common lines and puts each change's removals before its additions", () => {
		const rows = diffLines("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
		expect(rows.map((row) => `${row.kind} ${row.text}`)).toEqual([
			"same a",
			"del b",
			"add B",
			"same c",
			"same d",
			"add e",
		]);
		expect(diffCounts(rows)).toEqual({ additions: 2, deletions: 1 });
	});

	it("numbers lines in each text", () => {
		const rows = diffLines("x\ny\nz", "x\nz");
		expect(rows).toEqual([
			{ kind: "same", text: "x", oldLine: 1, newLine: 1 },
			{ kind: "del", text: "y", oldLine: 2 },
			{ kind: "same", text: "z", oldLine: 3, newLine: 2 },
		]);
	});

	it("handles an empty side, as an insertion or a deletion", () => {
		expect(diffLines("", "new\n").map((row) => row.kind)).toEqual(["add"]);
		expect(diffLines("old", "").map((row) => row.kind)).toEqual(["del"]);
		expect(diffLines("", "")).toEqual([]);
	});
});

describe("codeLines", () => {
	it("splits at newlines without a phantom last line", () => {
		expect(codeLines("a\nb\n")).toEqual(["a", "b"]);
		expect(codeLines("a\r\nb")).toEqual(["a", "b"]);
		expect(codeLines("\n")).toEqual([""]);
		expect(codeLines("")).toEqual([]);
	});
});

describe("languageName", () => {
	it("names the language a file's name picks", () => {
		expect(languageName(languageForPath("notes/plan.py") ?? "")).toBe("Python");
		expect(languageName(languageForPath("src/App.tsx") ?? "")).toBe("TypeScript");
		expect(languageName(languageForPath("deploy/Dockerfile") ?? "")).toBe("Dockerfile");
		expect(languageName("bash")).toBe("Shell");
		expect(languageForPath("README")).toBeUndefined();
		expect(languageName("brainfuck")).toBeUndefined();
	});
});

describe("splitHighlighted", () => {
	it("closes a span at a newline and opens it again on the next line", () => {
		const html = '<span class="a">x\n<span class="b">y\nz</span></span>\nw';
		expect(splitHighlighted(html)).toEqual([
			'<span class="a">x</span>',
			'<span class="a"><span class="b">y</span></span>',
			'<span class="a"><span class="b">z</span></span>',
			"w",
		]);
	});

	it("counts lines as codeLines does: a final newline ends the last line", () => {
		expect(splitHighlighted("a\nb\n")).toEqual(["a", "b"]);
		expect(splitHighlighted('<span class="c">/*\n</span>')).toEqual(['<span class="c">/*</span>']);
		expect(splitHighlighted("a\n\nb")).toEqual(["a", "", "b"]);
	});
});

describe("highlightLines", () => {
	it("highlights each line on its own, a docstring's later lines still a string", async () => {
		await loadHighlighter();
		const source = 'import sys\n"""A docstring\nover lines"""\ndef main():\n    print("hi")  # say it\n';
		const lines = highlightLines(source, "python");
		expect(lines).toHaveLength(codeLines(source).length);
		expect(lines?.[0]).toContain('<span class="hljs-keyword">import</span>');
		expect(lines?.[2]).toBe('<span class="hljs-string">over lines&quot;&quot;&quot;</span>');
		expect(lines?.[4]).toContain('<span class="hljs-comment"># say it</span>');
		// Escaped text only: nothing in a file can become markup.
		expect(highlightLines("x = '<script>'\n", "python")?.[0]).toContain("&lt;script&gt;");
		expect(highlightLines("x", "no-such-language")).toBeUndefined();
	});
});
