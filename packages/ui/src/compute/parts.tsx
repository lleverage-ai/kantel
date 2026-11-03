// Pieces every compute page shares: the page frame, a table's classes, the usage sparkline and a capacity bar. Pages
// lay out their own tables from these, so the sandboxes, snapshots, keys and hosts tables line up and read alike.

import type { ReactNode } from "react";

/** A compute page: its header, notices and sections one under another, as wide as the main area allows. */
export const computePage =
	"kt-compute-page flex w-full max-w-[calc(var(--kt-content-width)_+_var(--kt-sidebar-width)_*_2)] min-w-0 flex-col gap-5 text-sm leading-normal text-fg";

/** A table's frame: a hairline round it, scrolling sideways on a narrow screen rather than squeezing its columns. */
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
}: {
	values: readonly number[];
	/** What it shows, for assistive tech: "CPU over the last hour, peak 82%". */
	label: string;
	tone?: "done" | "idle" | "working" | "error";
}) {
	const width = 64;
	const height = 16;
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
			className={`kt-sparkline block h-4 w-16 ${colour}`}
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
