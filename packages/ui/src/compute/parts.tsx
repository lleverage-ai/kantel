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
	"kt-compute-page mx-auto flex w-full max-w-page min-w-0 flex-col gap-5 text-md leading-normal text-fg";

/**
 * A table's frame, as the Lleverage app's tables: a white card with a hairline round it, the first and last columns
 * inset from its edges, hairlines between rows and none under the last. Every list in the console sits in one. Where
 * it's too narrow for its columns it scrolls sideways; in a phone's column (table.css) TableFrame's rows become list
 * rows instead. For a placeholder in a table's place (a skeleton); a real table goes in TableFrame.
 */
export const tableFrame =
	"kt-compute-table min-w-0 overflow-x-auto rounded-panel border border-border bg-raised [&_:is(th,td):first-child]:pl-4 [&_:is(th,td):last-child]:pr-4 [&_tbody>tr:last-child>td]:border-b-0";
/** A table: body text at the body size, as every list in the console. */
export const table = "w-full border-collapse text-left text-md";
/** A header cell: muted, small, on one line. */
export const th = "h-control-md px-3 py-0 text-sm font-medium whitespace-nowrap text-muted border-b border-border";
/** A body cell: a hairline under every row (the frame drops the last). */
export const td = "px-3 py-2.5 align-middle whitespace-nowrap border-b border-border";
/** A row that opens something. */
export const rowHover = "hover:bg-hover";
/** A cell's second line: muted, smaller. */
export const cellSub = "block text-sm text-muted";
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

type LineTone = "done" | "idle" | "working" | "muted" | "error" | "warning";

const lineColour: Record<LineTone, string> = {
	done: "text-status-done",
	idle: "text-faint",
	muted: "text-muted",
	working: "text-status-working",
	error: "text-status-error",
	warning: "text-status-approval",
};

/**
 * The x and y of each value in a `width` by `height` box, 0 to `max` from the bottom up. With `slots`, each value has a
 * slot of its own and they end at the right edge, so a line that's still filling grows from the right as time does;
 * without, they spread across the whole width.
 */
export function linePoints(
	values: readonly number[],
	{ width, height, max = 1, slots }: { width: number; height: number; max?: number; slots?: number },
): readonly (readonly [number, number])[] {
	const count = Math.max(2, slots ?? values.length);
	const shown = values.slice(-count);
	const offset = count - shown.length;
	const top = max > 0 ? max : 1;
	return shown.map((value, at) => [
		((offset + at) / (count - 1)) * width,
		height - 1 - (Math.min(top, Math.max(0, value)) / top) * (height - 2),
	]);
}

/**
 * Where live readings are on the time axis: each value's time, beside it in `values`, and the span the line shows up to
 * the newest. A gap longer than `gapMs` between two readings breaks the line, so missing readings show as missing.
 */
export interface TimedLine {
	readonly times: readonly number[];
	readonly spanMs: number;
	readonly gapMs: number;
}

type Segment = readonly (readonly [number, number])[];

/**
 * The line's pieces in a `width` by `height` box, 0 to `max` from the bottom up. Timed, each value is where its time
 * is in the last `spanMs` before the newest, which is at the right edge; one before that is left out, and a gap breaks
 * the line. Untimed, it's one piece, as `linePoints` places it.
 */
export function lineSegments(
	values: readonly number[],
	{
		width,
		height,
		max = 1,
		slots,
		timed,
	}: { width: number; height: number; max?: number; slots?: number; timed?: TimedLine },
): readonly Segment[] {
	if (timed === undefined)
		return [linePoints(values, { width, height, max, ...(slots === undefined ? {} : { slots }) })];
	const newest = timed.times.at(-1);
	if (newest === undefined) return [];
	const top = max > 0 ? max : 1;
	const from = newest - timed.spanMs;
	const segments: [number, number][][] = [];
	let previous: number | undefined;
	values.forEach((value, index) => {
		const at = timed.times[index];
		if (at === undefined || at < from) return;
		const point: [number, number] = [
			((at - from) / timed.spanMs) * width,
			height - 1 - (Math.min(top, Math.max(0, value)) / top) * (height - 2),
		];
		const last = segments.at(-1);
		if (last === undefined || previous === undefined || at - previous > timed.gapMs) segments.push([point]);
		else last.push(point);
		previous = at;
	});
	// A lone reading between gaps is a short tick, so it's still seen.
	return segments.map((segment) => {
		const only = segment[0];
		return segment.length === 1 && only !== undefined ? [[Math.max(0, only[0] - 1), only[1]], only] : segment;
	});
}

/** How many of `values` a timed line shows: those in its span. */
const inSpan = (values: readonly number[], timed: TimedLine | undefined): number => {
	const newest = timed?.times.at(-1);
	if (timed === undefined || newest === undefined) return values.length;
	return timed.times.filter((at) => at >= newest - timed.spanMs).length;
};

const pointsText = (points: readonly (readonly [number, number])[]): string =>
	points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/**
 * A row of numbers as a line: a sandbox's CPU over the last few minutes. Drawn in a fixed box and stretched to its
 * width, 0 to 1 from the bottom up; a flat line for no use. It has no axes: the number beside it, or the label, says
 * what it means. `loading` is a faint line that breathes, while the first points are read.
 */
export function Sparkline({
	values,
	label,
	tone = "done",
	size = "sm",
	slots,
	timed,
	loading = false,
}: {
	values: readonly number[];
	/** What it shows, for assistive tech: "CPU over the last hour, peak 82%". */
	label: string;
	tone?: LineTone;
	/** `sm`, a row's: 64 by 16. `lg`, a sandbox page's: as wide as its column, 28 high. */
	size?: "sm" | "lg";
	/** How many values fill it, so a line still filling ends at the right. Default: as many as there are. */
	slots?: number;
	/** Live readings' times: each value is drawn where its time is, and `slots` is ignored. */
	timed?: TimedLine;
	loading?: boolean;
}) {
	const width = size === "lg" ? 320 : 64;
	const height = size === "lg" ? 28 : 16;
	const empty = inSpan(values, timed) < 2;
	const segments = empty
		? [linePoints([0, 0], { width, height })]
		: lineSegments(values, {
				width,
				height,
				...(slots === undefined ? {} : { slots }),
				...(timed === undefined ? {} : { timed }),
			});
	const colour = lineColour[loading || empty ? "idle" : tone];
	return (
		<svg
			className={`kt-sparkline block flex-none ${size === "lg" ? "h-7 w-full" : "h-4 w-16"} ${colour} ${loading ? breathe : ""}`}
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			role="img"
			aria-label={label}
			{...(loading ? { "aria-busy": true } : {})}
		>
			{segments.map((points) => (
				<polyline
					key={points[0]?.[0] ?? 0}
					points={pointsText(points)}
					fill="none"
					stroke="currentColor"
					strokeWidth="1.25"
					strokeLinejoin="round"
					vectorEffect="non-scaling-stroke"
					{...(loading ? { strokeDasharray: "2 3" } : {})}
				/>
			))}
		</svg>
	);
}

/** A loading line's breathing: opacity only, as the status dots do. */
const breathe = "animate-[kt-pulse_var(--kt-duration-pulse)_var(--kt-ease-breathe)_infinite]";

/**
 * A live graph, larger than a row's sparkline: a filled line, 0 to `max` from the bottom up, over a faint line at
 * half, with its name and latest figure over it. Live readings are `timed`: each is where its time is, the newest at
 * the right, and a gap in them breaks the line; untimed values each have a slot of `slots`. `loading` breathes until
 * the first points are read; with no values it's a flat line.
 */
export function UsageGraph({
	title,
	value,
	values,
	label,
	slots,
	timed,
	max = 1,
	tone = "done",
	loading = false,
	ends,
}: {
	title: ReactNode;
	/** The latest figure, beside the title: "12%", "1.2 of 8 GB". */
	value?: ReactNode;
	values: readonly number[];
	/** What it shows, for assistive tech: "CPU over the last 10 minutes, peak 82%". */
	label: string;
	/** How many values fill it, for untimed values. */
	slots?: number;
	/** Live readings' times: each value is drawn where its time is, and `slots` is ignored. */
	timed?: TimedLine;
	/** The value at the top: 1 for a share, a limit for memory. */
	max?: number;
	tone?: LineTone;
	loading?: boolean;
	/** The times at its two edges, under it: "10m ago" and "Now". */
	ends?: readonly [ReactNode, ReactNode];
}) {
	const width = 320;
	const height = 64;
	const empty = inSpan(values, timed) < 2;
	const segments = empty
		? [linePoints([0, 0], { width, height })]
		: lineSegments(values, {
				width,
				height,
				max,
				...(slots === undefined ? {} : { slots }),
				...(timed === undefined ? {} : { timed }),
			});
	const areaOf = (points: Segment): string | undefined => {
		const first = points[0];
		const last = points.at(-1);
		return first === undefined || last === undefined || empty
			? undefined
			: `${pointsText(points)} ${last[0].toFixed(1)},${height} ${first[0].toFixed(1)},${height}`;
	};
	const colour = lineColour[loading || empty ? "idle" : tone];
	return (
		<figure className="kt-usage-graph m-0 flex min-w-0 flex-col gap-1.5">
			<figcaption className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
				<span className="text-muted">{title}</span>
				{loading ? (
					<None className="text-faint" />
				) : (
					<span className="truncate text-fg tabular-nums">{value ?? <None className="text-faint" />}</span>
				)}
			</figcaption>
			<svg
				className={`block h-16 w-full overflow-visible rounded-xs bg-sunken ${colour} ${loading ? breathe : ""}`}
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				role="img"
				aria-label={label}
				{...(loading ? { "aria-busy": true } : {})}
			>
				<line
					className="text-border"
					x1="0"
					x2={width}
					y1={height / 2}
					y2={height / 2}
					stroke="currentColor"
					strokeDasharray="3 3"
					vectorEffect="non-scaling-stroke"
				/>
				{segments.map((points) => {
					const area = areaOf(points);
					return (
						<g key={points[0]?.[0] ?? 0}>
							{area === undefined ? null : (
								<polygon points={area} fill="currentColor" fillOpacity="0.14" stroke="none" />
							)}
							<polyline
								points={pointsText(points)}
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinejoin="round"
								vectorEffect="non-scaling-stroke"
								{...(loading ? { strokeDasharray: "2 3" } : {})}
							/>
						</g>
					);
				})}
			</svg>
			{ends === undefined ? null : (
				<span className="flex justify-between text-xs text-faint tabular-nums" aria-hidden="true">
					<span>{ends[0]}</span>
					<span>{ends[1]}</span>
				</span>
			)}
		</figure>
	);
}

/** How much of something is used: a thin bar, amber past 75%, red past 90%, with the words beside it. */
export function CapacityBar({ share, children }: { share: number; children: ReactNode }) {
	const clamped = Math.min(1, Math.max(0, share));
	const tone = clamped >= 0.9 ? "bg-status-error" : clamped >= 0.75 ? "bg-status-approval" : "bg-status-done";
	return (
		<span className="kt-capacity flex min-w-0 flex-col gap-1">
			<span className="text-sm text-muted">{children}</span>
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
			<h2 id={id} className="m-0 text-lg font-strong leading-tight text-fg">
				{title}
			</h2>
			{actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
