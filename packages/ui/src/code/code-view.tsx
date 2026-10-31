import { type CSSProperties, memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CollapseIcon, ExpandIcon } from "../primitives/lucide.tsx";
import { useHighlightedLines } from "./lines.ts";
// Only the caret's breathing is left in this CSS; the rest is Tailwind utilities.
import "./code-view.css";
import "./syntax.css";

/** Lines a collapsed view shows before it scrolls and offers "Show all". */
export const COLLAPSED_LINES = 16;
/** The most lines a view renders: a 40,000 line log says how many more there are instead. */
export const MAX_RENDERED_LINES = 5_000;

const count = new Intl.NumberFormat("en-GB");

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md). A read-only code view: a gutter of line
// numbers held at the left and the code beside it, mono, never wrapping, on the code surface. Collapsed, it is a window
// `--kt-code-lines` lines tall that scrolls, with "Show all" under it. Token colours come from syntax.css, each a
// theme's --kt-syntax-* token. The diff view and the terminal reuse its parts below; the kt-code-* names stay as hooks.

/** The view's frame: the code surface in the theme's syntax text colour. */
export const codeView = "kt-code-view flex min-w-0 flex-col bg-code-surface text-(--kt-syntax-text)";

/**
 * The scrolling window. Collapsed, `--kt-code-lines` lines tall (set on the view) plus its padding: a line is
 * --kt-text-code at --kt-leading.
 */
export const codeScroll = (collapsed: boolean): string =>
	`kt-code-scroll kt-focusable min-w-0 overflow-auto overscroll-contain py-2 ${collapsed ? "max-h-[calc(var(--kt-text-code)*var(--kt-leading)*var(--kt-code-lines)_+_var(--kt-step-2)*2)]" : ""}`;

/**
 * The streaming caret, as an answer's: a soft block after the last character. Its breathing (kt-pulse) is in
 * code-view.css. Without its margin: the terminal's output caret sits flush (`ml-0`).
 */
export const codeCaretBase =
	"kt-code-caret inline-block h-[1.1em] w-1.5 rounded-xs bg-accent-text align-[-0.2em] opacity-60";
/** The caret after the text, a half step from its last character. */
export const codeCaret = `${codeCaretBase} ml-0.5`;

/** "Empty file", "No changes": in place of the code. */
export const codeEmpty = "kt-code-empty m-0 px-3 py-2.5 text-sm text-faint";

/** "Show all 240 lines": a quiet full-width bar under the window, as a code card's expander. */
export const codeMore =
	"kt-code-more kt-focusable flex min-h-control-xs w-full cursor-pointer items-center justify-center gap-1.5 border-0 border-t border-border bg-transparent px-3 py-1 [font-family:inherit] [font-feature-settings:inherit] [font-weight:inherit] text-xs [line-height:inherit] text-muted hover:bg-hover hover:text-fg";

/** The gutter and the code: mono, one line per line, never wrapping. */
const codeColumn = "m-0 py-0 font-mono text-code leading-normal whitespace-pre";

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
		<span className="kt-code-line inline">
			<HighlightedText html={html} />
			{caret ? <span className={codeCaret} aria-hidden="true" /> : null}
			{"\n"}
		</span>
	);
});

const PlainLine = memo(function PlainLine({ text, caret }: { text: string; caret: boolean }) {
	return (
		<span className="kt-code-line inline">
			{text}
			{caret ? <span className={codeCaret} aria-hidden="true" /> : null}
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
			<div className={`${codeView}${className ? ` ${className}` : ""}`}>
				<p className={codeEmpty}>{streaming ? <span className={codeCaret} aria-hidden="true" /> : empty}</p>
			</div>
		);
	}
	return (
		<div
			className={`${codeView}${collapsible && !expanded ? " kt-code-view-collapsed" : ""}${className ? ` ${className}` : ""}`}
			style={{ "--kt-code-lines": collapsedLines } as CSSProperties}
		>
			<section
				ref={scroller}
				className={codeScroll(collapsible && !expanded)}
				aria-label={label}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
				tabIndex={0}
				onScroll={(event) => {
					const element = event.currentTarget;
					pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
				}}
			>
				<div className="kt-code-grid grid w-max min-w-full grid-cols-[auto_minmax(0,1fr)]">
					{/* Held at the left while the code scrolls sideways; out of selection, so copying copies only the code. */}
					<pre
						className={`kt-code-gutter ${codeColumn} sticky left-0 z-1 bg-code-surface pr-2.5 pl-3 text-right text-faint tabular-nums select-none`}
						aria-hidden="true"
					>
						{numbers}
					</pre>
					<pre className={`kt-code-text kt-selectable ${codeColumn} pr-3 pl-1 select-text`}>
						{/* The browser gives <code> its own monospace; one with other metrics than the gutter's would make every
						    line a little taller than its number. */}
						<code className="kt-syntax [font:inherit]">{rows}</code>
					</pre>
				</div>
			</section>
			{hidden > 0 ? (
				<p className="kt-code-cap m-0 border-t border-border px-3 py-1.5 text-xs text-faint">
					Showing the first {count.format(shown)} lines. {count.format(hidden)} more{" "}
					{hidden === 1 ? "line isn't" : "lines aren't"} shown here.
				</p>
			) : null}
			{collapsible ? (
				<button
					type="button"
					className={codeMore}
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
