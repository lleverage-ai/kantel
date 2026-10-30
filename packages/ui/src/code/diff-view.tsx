import { type CSSProperties, memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CollapseIcon, ExpandIcon } from "../primitives/lucide.tsx";
import {
	COLLAPSED_LINES,
	codeCaret,
	codeEmpty,
	codeMore,
	codeScroll,
	codeView,
	HighlightedText,
} from "./code-view.tsx";
import { type DiffRow, diffLines } from "./diff.ts";
import { useHighlightedLines } from "./lines.ts";
// The code caret's breathing (code-view.css).
import "./code-view.css";
import "./syntax.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md). A unified diff of an edit: a one-character
// mark column and the code, removed lines on a red wash and added lines on a green one, as T3 Code's and GitHub's
// diffs. Lines never wrap; the view scrolls sideways. The frame, window, caret and "Show all" are the code view's.

/** A row's wash and its mark's colour, by kind; an unchanged row's mark is disabled text. */
const ROW_WASH = { same: "", del: "bg-(--hb-diff-del-soft)", add: "bg-(--hb-diff-add-soft)" } as const;
const MARK_TONE = { same: "text-disabled", del: "text-diff-del", add: "text-diff-add" } as const;
/** The mark column, a step 6 wide, and the code. */
const rowCells = "hb-diff-row grid grid-cols-[var(--hb-step-6)_minmax(0,1fr)] whitespace-pre";
const markCell = "hb-diff-mark text-center select-none";
const codeCell = "hb-diff-code pr-3";

const count = new Intl.NumberFormat("en-GB");

/** One replacement: the text that was there and the text that took its place. */
export type DiffEdit = { readonly oldText: string; readonly newText: string };

const MARK = { same: " ", del: "\u2212", add: "+" } as const;
const SPOKEN = { same: "", del: "Removed: ", add: "Added: " } as const;

const Row = memo(function Row({ row, html, caret }: { row: DiffRow; html?: string; caret: boolean }) {
	return (
		<div className={`${rowCells} hb-diff-row-${row.kind} ${ROW_WASH[row.kind]}`}>
			<span className={`${markCell} ${MARK_TONE[row.kind]}`} aria-hidden="true">
				{MARK[row.kind]}
			</span>
			<span className={codeCell}>
				{SPOKEN[row.kind] === "" ? null : <span className="hb-sr-only">{SPOKEN[row.kind]}</span>}
				{html === undefined ? row.text : <HighlightedText html={html} />}
				{caret ? <span className={codeCaret} aria-hidden="true" /> : null}
				{row.text === "" && !caret ? "\u200b" : null}
			</span>
		</div>
	);
});

function Hunk({
	edit,
	language,
	caret,
	first,
}: {
	edit: DiffEdit;
	language: string | undefined;
	caret: boolean;
	/** The first edit; each after it stands under a dashed rule. */
	first: boolean;
}) {
	const rows = useMemo(() => diffLines(edit.oldText, edit.newText), [edit.oldText, edit.newText]);
	const before = useHighlightedLines(edit.oldText, language);
	const after = useHighlightedLines(edit.newText, language, caret);
	const last = rows.length - 1;
	return (
		<div className={`hb-diff-hunk ${first ? "" : "mt-2 border-0 border-t border-dashed border-border-strong pt-2"}`}>
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
				<div className={`${rowCells} hb-diff-row-same`}>
					<span className={`${markCell} ${MARK_TONE.same}`} aria-hidden="true" />
					<span className={codeCell}>
						<span className={codeCaret} aria-hidden="true" />
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
			<div className={codeView}>
				<p className={codeEmpty}>{streaming ? <span className={codeCaret} aria-hidden="true" /> : empty}</p>
			</div>
		);
	}
	return (
		<div
			className={`${codeView} hb-diff-view${collapsible && !expanded ? " hb-code-view-collapsed" : ""}`}
			style={{ "--hb-code-lines": collapsedLines } as CSSProperties}
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
				<div className="hb-diff-body hb-syntax hb-selectable flex w-max min-w-full flex-col font-mono text-code leading-normal">
					{edits.map((edit, index) => (
						<Hunk
							// biome-ignore lint/suspicious/noArrayIndexKey: edits arrive in order and are never reordered.
							key={index}
							edit={edit}
							language={language}
							caret={streaming && index === edits.length - 1}
							first={index === 0}
						/>
					))}
				</div>
			</section>
			{collapsible ? (
				<button
					type="button"
					className={codeMore}
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
