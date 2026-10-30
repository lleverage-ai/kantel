import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../../primitives/surface.tsx";
import { delimiterOf, parseDelimited } from "../preview-model.ts";
import type { PreviewBodyProps } from "../registry.ts";
import { TextEditor } from "./text-editor.tsx";

// CSV and TSV as a table, in Claude's table style: a quiet header row held at the top, hairline rules between rows,
// row numbers in a faint gutter, numbers right-aligned. Parsed here (RFC 4180 quoting) without loading a spreadsheet
// library. Cells never wrap, so every row is one height, and only the rows on screen (plus a margin) are in the page,
// between two spacer rows: a 100,000 row export opens and scrolls as a ten row one does, and the columns stay aligned
// because the rows are real table rows. Edit edits the file as text.

const count = new Intl.NumberFormat("en-GB");

/** The most columns shown. */
const MAX_COLUMNS = 200;
/** Rows rendered beyond each edge of the view. */
const OVERSCAN = 20;
/** A row's height until one has been measured: text-sm on the normal leading, py-2, a hairline. */
const ROW_GUESS = 37;
/** The view's height until it has been measured: enough rows for a tall window. */
const VIEW_GUESS = 800;

const numeric = /^-?[£$€]?\d[\d,]*(\.\d+)?%?$/;

export default function TableBody({ file, text, editing, onText, label, onFacts }: PreviewBodyProps) {
	const table = useMemo(() => {
		const rows = parseDelimited(text, delimiterOf(file));
		const [head = [], ...body] = rows;
		const sample = body.slice(0, 200);
		const columns = Math.min(MAX_COLUMNS, Math.max(head.length, ...sample.map((row) => row.length)));
		// A column is numeric when every sampled non-empty cell is a number: those are right-aligned.
		const numbers = Array.from({ length: columns }, (_, column) => {
			let seen = 0;
			for (const row of sample) {
				const cell = row[column]?.trim() ?? "";
				if (cell === "") continue;
				if (!numeric.test(cell)) return false;
				seen++;
			}
			return seen > 0;
		});
		return { head, body, columns, numbers };
	}, [text, file]);
	useEffect(() => {
		onFacts?.([
			`${count.format(table.body.length)} ${table.body.length === 1 ? "row" : "rows"}`,
			`${count.format(table.columns)} ${table.columns === 1 ? "column" : "columns"}`,
		]);
	}, [table, onFacts]);

	const scroller = useRef<HTMLElement>(null);
	const firstRow = useRef<HTMLTableRowElement>(null);
	const [view, setView] = useState({ top: 0, height: VIEW_GUESS });
	const [rowHeight, setRowHeight] = useState(ROW_GUESS);
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element === null) return;
		const update = () => setView({ top: element.scrollTop, height: element.clientHeight });
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useLayoutEffect(() => {
		const measured = firstRow.current?.getBoundingClientRect().height;
		if (measured !== undefined && measured > 0 && Math.abs(measured - rowHeight) > 0.5) setRowHeight(measured);
	});

	if (editing && onText !== undefined) return <TextEditor text={text} onText={onText} label={`Edit ${file.name}`} />;
	if (table.columns === 0) return <EmptyState title="This file is empty" />;
	const total = table.body.length;
	const start = Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN);
	const end = Math.min(total, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN);
	const indexes = Array.from({ length: table.columns }, (_, column) => column);
	const cell = "border-0 border-b border-border px-3 py-2 text-left align-top whitespace-nowrap";
	const rows = [];
	for (let at = start; at < end; at++) {
		const row = table.body[at] ?? [];
		rows.push(
			<tr key={at} ref={at === start ? firstRow : undefined} className="hover:bg-hover">
				<th
					scope="row"
					className={`${cell} pl-gutter text-right font-mono text-xs font-regular text-faint tabular-nums`}
				>
					{at + 1}
				</th>
				{indexes.map((column) => (
					<td
						key={column}
						className={`${cell} max-w-(--hb-card-width) truncate text-fg ${table.numbers[column] ? "text-right tabular-nums" : ""}`}
						title={row[column]}
					>
						{row[column] ?? ""}
					</td>
				))}
			</tr>,
		);
	}
	return (
		<section
			ref={scroller}
			className="hb-focusable hb-selectable h-full min-h-0 overflow-auto overscroll-contain focus-visible:-outline-offset-(--hb-ring)!"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard.
			tabIndex={0}
			aria-label={label}
			onScroll={(event) => {
				const top = event.currentTarget.scrollTop;
				// Re-render only when the window of rows would move.
				if (Math.abs(top - view.top) > rowHeight * (OVERSCAN / 2)) setView((current) => ({ ...current, top }));
			}}
		>
			<table className="min-w-full border-separate border-spacing-0 text-sm leading-normal" aria-rowcount={total + 1}>
				<thead className="sticky top-0 z-1 bg-canvas">
					<tr>
						<th scope="col" className={`${cell} w-0 pl-gutter text-right font-regular text-faint`}>
							<span className="hb-sr-only">Row</span>
						</th>
						{indexes.map((column) => (
							<th
								key={column}
								scope="col"
								className={`${cell} font-medium text-fg ${table.numbers[column] ? "text-right" : ""}`}
							>
								{table.head[column] ?? ""}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{/* Spacers standing in for the rows above and below the view: no cells, nothing to read. */}
					{start === 0 ? null : <tr style={{ height: start * rowHeight }} />}
					{rows}
					{end >= total ? null : <tr style={{ height: (total - end) * rowHeight }} />}
				</tbody>
			</table>
		</section>
	);
}
