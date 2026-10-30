import { type CSSProperties, memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CollapseIcon, ExpandIcon } from "../primitives/lucide.tsx";
import { COLLAPSED_LINES, HighlightedText } from "./code-view.tsx";
import { type DiffRow, diffLines } from "./diff.ts";
import { useHighlightedLines } from "./lines.ts";
import "./code-view.css";
import "./diff-view.css";
import "./syntax.css";

const count = new Intl.NumberFormat("en-GB");

/** One replacement: the text that was there and the text that took its place. */
export type DiffEdit = { readonly oldText: string; readonly newText: string };

const MARK = { same: " ", del: "\u2212", add: "+" } as const;
const SPOKEN = { same: "", del: "Removed: ", add: "Added: " } as const;

const Row = memo(function Row({ row, html, caret }: { row: DiffRow; html?: string; caret: boolean }) {
	return (
		<div className={`hb-diff-row hb-diff-row-${row.kind}`}>
			<span className="hb-diff-mark" aria-hidden="true">
				{MARK[row.kind]}
			</span>
			<span className="hb-diff-code">
				{SPOKEN[row.kind] === "" ? null : <span className="hb-sr-only">{SPOKEN[row.kind]}</span>}
				{html === undefined ? row.text : <HighlightedText html={html} />}
				{caret ? <span className="hb-code-caret" aria-hidden="true" /> : null}
				{row.text === "" && !caret ? "\u200b" : null}
			</span>
		</div>
	);
});

function Hunk({ edit, language, caret }: { edit: DiffEdit; language: string | undefined; caret: boolean }) {
	const rows = useMemo(() => diffLines(edit.oldText, edit.newText), [edit.oldText, edit.newText]);
	const before = useHighlightedLines(edit.oldText, language);
	const after = useHighlightedLines(edit.newText, language, caret);
	const last = rows.length - 1;
	return (
		<div className="hb-diff-hunk">
			{rows.map((row, index) => {
				const html = row.kind === "del" ? before?.[row.oldLine - 1] : after?.[row.newLine - 1];
				return (
					<Row
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are derived from the edit and replaced with it.
						key={index}
						row={row}
						{...(html === undefined ? {} : { html })}
						caret={caret && index === last}
					/>
				);
			})}
			{rows.length === 0 && caret ? (
				<div className="hb-diff-row hb-diff-row-same">
					<span className="hb-diff-mark" aria-hidden="true" />
					<span className="hb-diff-code">
						<span className="hb-code-caret" aria-hidden="true" />
					</span>
				</div>
			) : null}
		</div>
	);
}

export type DiffViewProps = {
	/** The replacements, in order. */
	edits: readonly DiffEdit[];
	/** The highlighter's name for its language (`languageForPath`). */
	language?: string | undefined;
	/** What a screen reader calls the region: "Changes to src/app.ts". */
	label: string;
	/** The edits are still arriving: a caret follows the last one and the window keeps it in view. */
	streaming?: boolean;
	collapsedLines?: number;
	/** Shown when there is nothing to compare yet. */
	empty?: ReactNode;
};

/**
 * Each edit's old text against its new text, as a unified diff: removed lines in red with a minus, added lines in
 * green with a plus, unchanged lines between them, every line highlighted for its language. Edits are separated by a
 * rule. Long diffs collapse to a window with "Show all", as a code view does.
 */
export const DiffView = memo(function DiffView({
	edits,
	language,
	label,
	streaming = false,
	collapsedLines = COLLAPSED_LINES,
	empty = "No changes",
}: DiffViewProps) {
	const [expanded, setExpanded] = useState(false);
	const scroller = useRef<HTMLElement>(null);
	const pinned = useRef(true);
	const total = useMemo(
		() => edits.reduce((sum, edit) => sum + diffLines(edit.oldText, edit.newText).length, 0),
		[edits],
	);
	const collapsible = total > collapsedLines;
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!streaming || expanded || element === null || !pinned.current) return;
		element.scrollTop = element.scrollHeight;
	});
	if (edits.length === 0) {
		return (
			<div className="hb-code-view">
				<p className="hb-code-empty">{streaming ? <span className="hb-code-caret" aria-hidden="true" /> : empty}</p>
			</div>
		);
	}
	return (
		<div
			className={`hb-code-view hb-diff-view${collapsible && !expanded ? " hb-code-view-collapsed" : ""}`}
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
				<div className="hb-diff-body hb-syntax hb-selectable">
					{edits.map((edit, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: edits arrive in order and are never reordered.
						<Hunk key={index} edit={edit} language={language} caret={streaming && index === edits.length - 1} />
					))}
				</div>
			</section>
			{collapsible ? (
				<button
					type="button"
					className="hb-code-more hb-focusable"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? <CollapseIcon size="sm" /> : <ExpandIcon size="sm" />}
					<span>{expanded ? "Show less" : `Show all ${count.format(total)} lines`}</span>
				</button>
			) : null}
		</div>
	);
});
