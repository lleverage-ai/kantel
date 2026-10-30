import { useMemo, useRef } from "react";
import { HIGHLIGHT_LIMIT, highlightCode, useHighlighter } from "./code.tsx";

// Highlighted code one line at a time, for the views that number their lines (code-view.tsx, diff-view.tsx). It uses
// the transcript's highlighter (code.tsx: highlight.js, `hljs-*` classes coloured by the theme's --hb-syntax-* tokens
// in syntax.css) and cuts its HTML at each newline, closing the spans open there and opening them again on the next
// line, so every line stands alone and a memoised line renders only when its own HTML changes.

/** What a file's name says to highlight it as, on screen: "TypeScript", "Shell". */
const languageNames: Readonly<Record<string, string>> = {
	bash: "Shell",
	c: "C",
	cpp: "C++",
	css: "CSS",
	diff: "Diff",
	dockerfile: "Dockerfile",
	go: "Go",
	ini: "Config",
	java: "Java",
	javascript: "JavaScript",
	json: "JSON",
	markdown: "Markdown",
	python: "Python",
	ruby: "Ruby",
	rust: "Rust",
	shell: "Shell",
	sql: "SQL",
	typescript: "TypeScript",
	xml: "XML",
	yaml: "YAML",
};

/** What a language is called on screen, or undefined for one without a name here. */
export function languageName(language: string): string | undefined {
	return languageNames[language];
}

const PIECE = /<span class="[^"]*">|<\/span>|\n|[^<\n]+/g;

/**
 * highlight.js's HTML for some code, as one HTML string per line. A span that runs over a newline (a block comment,
 * a template string) is closed at the end of the line and opened again at the start of the next. A final newline
 * ends the last line rather than starting another, as `codeLines` counts them.
 */
export function splitHighlighted(html: string): string[] {
	const lines: string[] = [];
	const open: string[] = [];
	let line = "";
	for (const [piece] of html.matchAll(PIECE)) {
		if (piece === "\n") {
			lines.push(line + "</span>".repeat(open.length));
			line = open.join("");
		} else if (piece === "</span>") {
			open.pop();
			line += piece;
		} else {
			if (piece.startsWith("<span")) open.push(piece);
			line += piece;
		}
	}
	// After a final newline the last "line" holds only tags (spans reopened, then closed): it isn't a line.
	if (line.replace(/<[^>]*>/g, "") !== "" || lines.length === 0) lines.push(line + "</span>".repeat(open.length));
	return lines;
}

/** Highlighted lines for `code`, or undefined when it can't be (no language, unknown to the highlighter, too long). */
export function highlightLines(code: string, language: string | undefined): string[] | undefined {
	if (code === "") return [];
	const html = highlightCode(code.replace(/\r\n/g, "\n"), language);
	return html === undefined ? undefined : splitHighlighted(html);
}

/**
 * Each line of `code` as highlighted HTML, or undefined while the highlighter loads (and for no language, or code too
 * long to highlight), when the view shows plain text.
 *
 * Text still `streaming` grows at its end: its complete lines (up to the last newline) are highlighted together once
 * per newline and kept, and only the unfinished last line is highlighted again on each delta, on its own. When the
 * text is final it is highlighted whole, so a construct that spans the last line is coloured right.
 */
export function useHighlightedLines(
	code: string,
	language: string | undefined,
	streaming = false,
): readonly string[] | undefined {
	const loaded = useHighlighter(language !== undefined);
	const done = useRef<{ text: string; language: string | undefined; lines: string[] | undefined }>(undefined);
	return useMemo(() => {
		if (!loaded || language === undefined || code.length > HIGHLIGHT_LIMIT) return undefined;
		if (!streaming) return highlightLines(code, language);
		const end = code.lastIndexOf("\n");
		const complete = end < 0 ? "" : code.slice(0, end + 1);
		if (done.current?.text !== complete || done.current.language !== language) {
			done.current = { text: complete, language, lines: highlightLines(complete, language) };
		}
		const lines = done.current.lines;
		if (lines === undefined) return undefined;
		const rest = code.slice(complete.length);
		if (rest === "") return lines;
		const tail = highlightLines(rest, language);
		return tail === undefined ? undefined : [...lines, ...tail];
	}, [code, language, streaming, loaded]);
}
