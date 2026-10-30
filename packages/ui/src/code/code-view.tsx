import { type CSSProperties, memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CollapseIcon, ExpandIcon } from "../primitives/lucide.tsx";
import { useHighlightedLines } from "./lines.ts";
import "./code-view.css";
import "./syntax.css";

/** Lines a collapsed view shows before it scrolls and offers "Show all". */
export const COLLAPSED_LINES = 16;
/** The most lines a view renders: a 40,000 line log says how many more there are instead. */
export const MAX_RENDERED_LINES = 5_000;

const count = new Intl.NumberFormat("en-GB");

/** A text's lines, split at "\n" (or "\r\n"). A final newline ends the last line rather than starting another. */
export function codeLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split(/\r?\n/);
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

/** A line's highlighted HTML: highlight.js escapes the text, so it is escaped text in class-only spans. */
export function HighlightedText({ html }: { html: string }) {
	// biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output, escaped text in class-only spans.
	return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

const HighlightedLine = memo(function HighlightedLine({ html, caret }: { html: string; caret: boolean }) {
	return (
		<span className="hb-code-line">
			<HighlightedText html={html} />
			{caret ? <span className="hb-code-caret" aria-hidden="true" /> : null}
			{"\n"}
		</span>
	);
});

const PlainLine = memo(function PlainLine({ text, caret }: { text: string; caret: boolean }) {
	return (
		<span className="hb-code-line">
			{text}
			{caret ? <span className="hb-code-caret" aria-hidden="true" /> : null}
			{"\n"}
		</span>
	);
});

export type CodeViewProps = {
	/** The text, whole or as far as it has streamed. */
	code: string;
	/** The highlighter's name for its language (`languageForPath`); plain text without one. */
	language?: string | undefined;
	/** The number of the first line: a read from line 120 starts there. */
	startLine?: number;
	/** The text is still arriving: a caret follows its end, and a collapsed view keeps the end in view. */
	streaming?: boolean;
	/** What a screen reader calls the scrolling region: "Contents of src/app.ts". */
	label: string;
	/** Lines shown collapsed. */
	collapsedLines?: number;
	/** Shown when there is no text: "Empty file". */
	empty?: ReactNode;
	className?: string;
};

/**
 * Code as an editor shows it, read-only: line numbers in a gutter held at the left, each line highlighted for its
 * language, long lines scrolling sideways rather than wrapping. Over `collapsedLines` lines it is a bounded window
 * with "Show all 240 lines" under it. While `streaming`, a caret sits at the end of the text and the window follows
 * it, unless the reader has scrolled up to read; the text arrives from the stream as it is written.
 */
export const CodeView = memo(function CodeView({
	code,
	language,
	startLine = 1,
	streaming = false,
	label,
	collapsedLines = COLLAPSED_LINES,
	empty = "Empty file",
	className,
}: CodeViewProps) {
	const highlighted = useHighlightedLines(code, language, streaming);
	const [expanded, setExpanded] = useState(false);
	const scroller = useRef<HTMLElement>(null);
	// Whether the window is at its end: while it is, a streaming view keeps the newest line in view.
	const pinned = useRef(true);
	const lines = useMemo(() => {
		const split = codeLines(code);
		// A newline just written starts a line the caret is on.
		if (streaming && code.endsWith("\n")) split.push("");
		return split;
	}, [code, streaming]);
	const shown = Math.min(lines.length, MAX_RENDERED_LINES);
	const hidden = lines.length - shown;
	const collapsible = shown > collapsedLines;
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!streaming || expanded || element === null || !pinned.current) return;
		element.scrollTop = element.scrollHeight;
	});
	const lastLine = shown - 1;
	const rows: ReactNode[] = [];
	for (let index = 0; index < shown; index++) {
		const caret = streaming && index === lastLine && hidden === 0;
		const html = highlighted?.[index];
		rows.push(
			html === undefined ? (
				<PlainLine key={index} text={lines[index] ?? ""} caret={caret} />
			) : (
				<HighlightedLine key={index} html={html} caret={caret} />
			),
		);
	}
	const numbers = useMemo(() => {
		let text = "";
		for (let index = 0; index < shown; index++) text += `${startLine + index}\n`;
		return text;
	}, [shown, startLine]);
	if (lines.length === 0) {
		return (
			<div className={`hb-code-view${className ? ` ${className}` : ""}`}>
				<p className="hb-code-empty">{streaming ? <span className="hb-code-caret" aria-hidden="true" /> : empty}</p>
			</div>
		);
	}
	return (
		<div
			className={`hb-code-view${collapsible && !expanded ? " hb-code-view-collapsed" : ""}${className ? ` ${className}` : ""}`}
			style={{ "--hb-code-lines": collapsedLines } as CSSProperties}
		>
			<section
				ref={scroller}
				className="hb-code-scroll hb-focusable"
				aria-label={label}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
				tabIndex={0}
				onScroll={(event) => {
					const element = event.currentTarget;
					pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
				}}
			>
				<div className="hb-code-grid">
					<pre className="hb-code-gutter" aria-hidden="true">
						{numbers}
					</pre>
					<pre className="hb-code-text hb-selectable">
						<code className="hb-syntax">{rows}</code>
					</pre>
				</div>
			</section>
			{hidden > 0 ? (
				<p className="hb-code-cap">
					Showing the first {count.format(shown)} lines. {count.format(hidden)} more{" "}
					{hidden === 1 ? "line isn't" : "lines aren't"} shown here.
				</p>
			) : null}
			{collapsible ? (
				<button
					type="button"
					className="hb-code-more hb-focusable"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? <CollapseIcon size="sm" /> : <ExpandIcon size="sm" />}
					<span>{expanded ? "Show less" : `Show all ${count.format(lines.length)} lines`}</span>
				</button>
			) : null}
		</div>
	);
});
