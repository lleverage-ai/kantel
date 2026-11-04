// Pieces every compute page shares: the page's column, a table's frame and classes, the usage sparkline and a capacity
// bar. Pages lay out their own tables from these, so the sandboxes, snapshots, keys and hosts tables line up and read
// alike, and turn into the same stacked cards on a phone.

import { type ComponentProps, type ReactNode, useLayoutEffect, useRef } from "react";
import "./table.css";

/**
 * A compute page: its header, notices and sections one under another, in one column at most --kt-page-width wide,
 * centred in the room beside the sidebar. The header's title and actions sit on its edges, and its tables fill it.
 */
export const computePage =
	"kt-compute-page mx-auto flex w-full max-w-page min-w-0 flex-col gap-5 text-sm leading-normal text-fg";

/**
 * A table's frame: a hairline round it. Where it's too narrow for its columns it scrolls sideways; in a phone's
 * column (table.css) TableFrame's rows become stacked cards instead. For a placeholder in a table's place (a skeleton);
 * a real table goes in TableFrame.
 */
export const tableFrame = "kt-compute-table min-w-0 overflow-x-auto rounded-panel border border-border bg-panel";
export const table = "w-full border-collapse text-left text-sm";
/** A header cell: muted, small, on one line. */
export const th = "h-control-md px-3 py-0 text-xs font-medium whitespace-nowrap text-muted border-b border-border";
/** A body cell: a hairline under every row but the last. */
export const td =
	"px-3 py-2 align-middle whitespace-nowrap [tr:not(:last-child)>&]:border-b [tr:not(:last-child)>&]:border-border";
/** A row that opens something. */
export const rowHover = "hover:bg-hover";
/** A cell's second line: muted, smaller. */
export const cellSub = "block text-xs text-muted";
/** An id or a command in a cell. */
export const cellMono = "font-mono text-code text-muted";

/** What a header cell says to a reader: its text, without what only assistive tech reads. */
function headText(cell: Element): string {
	let text = "";
	for (const node of cell.childNodes) {
		if (node.nodeType === 3) text += node.textContent ?? "";
		else if (node instanceof Element && !node.classList.contains("kt-sr-only")) text += headText(node);
	}
	return text.trim();
}

/**
 * The dash a table shows for a value it doesn't have. A card leaves a cell holding only this out; a value that is
 * itself a dash (a variable set to "-") is real text, so it stays.
 */
export function None({ className }: { className?: string }) {
	return (
		<span className={className} data-none="">
			–
		</span>
	);
}

/** The parts of a node `cellText` reads: a DOM node, or a stand-in for one in a test. */
export interface TextNode {
	readonly nodeType: number;
	readonly textContent: string | null;
	readonly childNodes: ArrayLike<TextNode>;
	hasAttribute?(name: string): boolean;
}

/** A cell's text without its `None` placeholders. */
export function cellText(node: TextNode): string {
	let text = "";
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === 3) text += child.textContent ?? "";
		else if (child.nodeType === 1 && child.hasAttribute?.("data-none") !== true) text += cellText(child);
	}
	return text;
}

/**
 * A cell with nothing to show and no picture or control: no text at all, or a `None` placeholder and nothing else but
 * the space round it. Text that is only spaces without a placeholder (a variable set to " ") is a value, so it stays.
 */
export function emptyText(node: TextNode, marked: boolean): boolean {
	if ((node.textContent ?? "") === "") return true;
	return marked && cellText(node).trim() === "";
}

const emptyCell = (cell: Element): boolean =>
	emptyText(cell, cell.querySelector("[data-none]") !== null) &&
	cell.querySelector("svg, img, input, button, a, select") === null;

const setData = (cell: HTMLElement, name: string, value: string | undefined) => {
	if (value === undefined) {
		if (cell.hasAttribute(`data-${name}`)) cell.removeAttribute(`data-${name}`);
	} else if (cell.getAttribute(`data-${name}`) !== value) cell.setAttribute(`data-${name}`, value);
};

/**
 * Marks every body cell for the phone's cards (table.css): `data-label`, its column's heading, shown beside the value;
 * `data-cell`, `primary` for the row's name (the first column after any checkbox), `select` for a checkbox column,
 * `actions` for one whose heading is only read (a row's menu); and `data-empty` on a cell with nothing to show, which
 * a card leaves out rather than showing a lone dash.
 */
function labelCells(frame: HTMLElement): void {
	for (const tableElement of frame.querySelectorAll("table")) {
		const heads = [...tableElement.querySelectorAll(":scope > thead > tr:last-child > th")].flatMap((head) => {
			const kind =
				head.querySelector("input[type=checkbox]") !== null ? "select" : headText(head) === "" ? "actions" : undefined;
			const entry = { label: headText(head), kind };
			return Array.from({ length: (head as HTMLTableCellElement).colSpan || 1 }, () => entry);
		});
		const primary = heads.findIndex((head) => head.kind === undefined);
		for (const row of tableElement.querySelectorAll(":scope > tbody > tr")) {
			let at = 0;
			for (const cell of row.children) {
				if (!(cell instanceof HTMLTableCellElement)) continue;
				const head = heads[at];
				const whole = cell.colSpan > 1 && cell.colSpan >= heads.length;
				const kind = whole ? "whole" : at === primary ? "primary" : head?.kind;
				setData(cell, "cell", kind);
				setData(cell, "label", kind === undefined && head !== undefined && head.label !== "" ? head.label : undefined);
				setData(cell, "empty", kind === undefined && emptyCell(cell) ? "" : undefined);
				at += cell.colSpan || 1;
			}
		}
	}
}

/**
 * A table's frame, for every table on a compute page: a hairline round it, the table as wide as the page's column. In
 * a column narrower than a phone's table needs (table.css, 40rem), the header goes and each row is a card: its name
 * on top with its menu on the right, a checkbox before it where the table has them, and every other cell under them as
 * its heading and value, with the empty ones left out. `bar` sits over the table inside the same container, for what
 * acts on the rows (a selection's actions, Select all for the cards).
 *
 * The cards read their labels from the table's own header (`labelCells`), so a page writes a plain table.
 */
export function TableFrame({ children, bar, className, ...rest }: ComponentProps<"div"> & { bar?: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const frame = ref.current;
		if (frame === null) return;
		labelCells(frame);
		// Rows come and go, and cells change, as the page updates: label them again. Attributes aren't watched, so
		// labelling doesn't wake itself.
		const observer = new MutationObserver(() => labelCells(frame));
		observer.observe(frame, { childList: true, subtree: true, characterData: true });
		return () => observer.disconnect();
	}, []);
	return (
		<div ref={ref} className="kt-table-cards flex min-w-0 flex-col gap-2">
			{bar}
			<div {...rest} className={className === undefined ? tableFrame : `${tableFrame} ${className}`}>
				{children}
			</div>
		</div>
	);
}

export const messageOf = (caught: unknown, fallback: string): string =>
	caught instanceof Error ? caught.message : fallback;

/**
 * A row of numbers as a line: a sandbox's CPU over the last hour. Drawn in a fixed box and stretched to its width;
 * a flat line for no use. It has no axes: the number beside it, or the label, says what it means.
 */
export function Sparkline({
	values,
	label,
	tone = "done",
	size = "sm",
}: {
	values: readonly number[];
	/** What it shows, for assistive tech: "CPU over the last hour, peak 82%". */
	label: string;
	tone?: "done" | "idle" | "working" | "error";
	/** `sm`, a row's: 64 by 16. `lg`, a sandbox page's: as wide as its column, 28 high. */
	size?: "sm" | "lg";
}) {
	const width = size === "lg" ? 320 : 64;
	const height = size === "lg" ? 28 : 16;
	const count = Math.max(2, values.length);
	const max = Math.max(1, ...values);
	const points = (values.length === 0 ? [0, 0] : values)
		.map((value, at) => {
			const x = (at / (count - 1)) * width;
			const y = height - 1 - (Math.max(0, value) / max) * (height - 2);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
	const colour = {
		done: "text-status-done",
		idle: "text-faint",
		working: "text-status-working",
		error: "text-status-error",
	}[tone];
	return (
		<svg
			className={`kt-sparkline block ${size === "lg" ? "h-7 w-full" : "h-4 w-16"} ${colour}`}
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			role="img"
			aria-label={label}
		>
			<polyline
				points={points}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.25"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

/** How much of something is used: a thin bar, amber past 75%, red past 90%, with the words beside it. */
export function CapacityBar({ share, children }: { share: number; children: ReactNode }) {
	const clamped = Math.min(1, Math.max(0, share));
	const tone = clamped >= 0.9 ? "bg-status-error" : clamped >= 0.75 ? "bg-status-approval" : "bg-status-done";
	return (
		<span className="kt-capacity flex min-w-0 flex-col gap-1">
			<span className="text-xs text-muted">{children}</span>
			<span className="block h-1 w-24 overflow-hidden rounded-full bg-active" aria-hidden="true">
				<span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.round(clamped * 100)}%` }} />
			</span>
		</span>
	);
}

/** A heading over a section of a page, with its own actions on the right. */
export function SectionHeading({ title, actions, id }: { title: ReactNode; actions?: ReactNode; id?: string }) {
	return (
		<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
			<h2 id={id} className="m-0 text-sm font-strong leading-tight text-fg">
				{title}
			</h2>
			{actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
