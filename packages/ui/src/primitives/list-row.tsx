import { memo, type ReactNode } from "react";
import "./list-row.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

export type ListRowProps = {
	/** One line, truncated. The thing itself: a session's title, a skill's name, an audit event. */
	title: ReactNode;
	/** A line above the title in small muted text: the project, the actor. Optional. */
	overline?: ReactNode;
	/** A line under the title in small muted text: a branch, a path, a count. Optional. */
	meta?: ReactNode;
	/** An icon or dot before the text. */
	leading?: ReactNode;
	/** Top-right: a status or a time. */
	trailing?: ReactNode;
	/** Shown in place of `trailing` while the row is hovered or has focus inside it, as T3 Code swaps in actions. */
	actions?: ReactNode;
	selected?: boolean;
	/** Makes the row a link. */
	href?: string;
	/** Makes the row a button. */
	onSelect?: () => void;
	/** `compact` is one line, 36px; `comfortable` stacks overline, title and meta. */
	density?: "compact" | "comfortable";
	/** De-emphasise a row that needs nothing from anyone: settled, archived. */
	quiet?: boolean;
};

/** The row: the group its actions and trailing slot answer to (hover, focus inside, an open menu). */
const rowClass = "group/list-row relative flex min-w-0 items-stretch rounded-control text-fg";

/** The row's main target: a link, a button or a plain block. */
const mainClass =
	"flex min-w-0 flex-1 gap-2 rounded-[inherit] border-0 bg-transparent px-2.5 text-left text-inherit no-underline [font:inherit]";

const mainDensity = {
	compact: "min-h-control-lg items-center py-0",
	comfortable: "items-start py-2",
} as const;

/**
 * A link or a button. Its focus ring is drawn inside it, so a list that clips (content-visibility, overflow) never
 * cuts it off; `!` because base.css's `.hb-focusable:focus-visible` offset is unlayered and would beat a utility.
 */
const mainTarget = "hb-focusable cursor-pointer focus-visible:-outline-offset-(--hb-ring)!";

/*
 * One title line tall, with an invisible character in the title's type (list-row.css) to give it the title's
 * baseline. The dot or icon sits on that baseline, then moves up onto the middle of the capitals (see --hb-on-cap).
 * An icon is taller than the title's capitals, so on the baseline it would push the line, and that baseline, down
 * past the title's. Pulled up by its own height, it takes no room above the baseline and sits on the title's.
 */
const leadingClass =
	"hb-list-row-leading inline-flex h-[calc(var(--hb-text-md)_*_var(--hb-leading))] min-w-icon-md flex-none items-baseline justify-center text-md leading-normal text-faint *:translate-y-(--hb-on-cap) [&>.hb-icon-md]:-mt-icon-md [&>.hb-icon-sm]:-mt-icon-sm";

/** The overline and the meta: one small faint line each, truncated. */
const smallLine = "min-w-0 truncate text-xs leading-tight text-faint";

const sideDensity = {
	compact: "items-center",
	comfortable: "items-start pt-2",
} as const;

/*
 * The actions show while the row is hovered, has focus inside it or has a menu open from them (the menu floats
 * outside the row), and always on touch, which has no hover. A static row has no focusable main target for Tab to
 * land on and reveal them, so its actions always show, next to whatever is trailing.
 */
const actionsShown = "inline-flex";
const actionsOnDemand =
	"hidden group-hover/list-row:inline-flex group-focus-within/list-row:inline-flex group-has-aria-expanded/list-row:inline-flex pointer-coarse:inline-flex";

/** The trailing slot gives way to the actions while they show. A static row's is in list-row.css. */
const trailingGivesWay =
	"group-hover/list-row:hidden group-focus-within/list-row:hidden group-has-aria-expanded/list-row:hidden pointer-coarse:hidden";

/**
 * A row in a list of things: sessions, skills, schedules, memory concepts, audit events, inbox items. One component
 * so every list on the platform has the same height, padding, hover, selection and keyboard behaviour. Memoised:
 * a list re-renders only the rows whose props changed.
 */
export const ListRow = memo(function ListRow({
	title,
	overline,
	meta,
	leading,
	trailing,
	actions,
	selected = false,
	href,
	onSelect,
	density = "compact",
	quiet = false,
}: ListRowProps) {
	const hasActions = actions !== undefined;
	const isStatic = hasActions && href === undefined && onSelect === undefined;
	// The row you're on is lit and stays lit under the pointer; another is lit on hover, or while a menu opened from
	// its actions is open.
	const fill = selected ? "bg-selected" : "hover:bg-hover has-[.hb-list-row-actions_[aria-expanded=true]]:bg-hover";
	const className = `hb-list-row hb-list-row-${density}${selected ? " hb-list-row-selected" : ""}${quiet ? " hb-list-row-quiet" : ""}${hasActions ? " hb-list-row-has-actions" : ""}${isStatic ? " hb-list-row-static" : ""} ${rowClass} ${fill}`;
	// The row you're on is never quiet: a settled session that's open reads in full-strength text, not just a fill.
	const titleTone = selected ? "font-medium text-fg" : quiet ? "text-muted" : "";
	const main = `hb-list-row-main ${mainClass} ${mainDensity[density]}`;
	const body = (
		<>
			{leading === undefined ? null : <span className={leadingClass}>{leading}</span>}
			<span className="hb-list-row-text flex min-w-0 flex-1 flex-col gap-0.5">
				{overline === undefined ? null : <span className={`hb-list-row-overline ${smallLine}`}>{overline}</span>}
				<span className={`hb-list-row-title min-w-0 truncate text-md leading-normal ${titleTone}`}>{title}</span>
				{meta === undefined ? null : <span className={`hb-list-row-meta ${smallLine}`}>{meta}</span>}
			</span>
		</>
	);
	const side =
		trailing === undefined && actions === undefined ? null : (
			<span
				className={`hb-list-row-side relative flex flex-none pr-2.5 text-xs text-faint tabular-nums ${sideDensity[density]}`}
			>
				{trailing === undefined ? null : (
					<span className={`hb-list-row-trailing ${hasActions && !isStatic ? trailingGivesWay : ""}`}>{trailing}</span>
				)}
				{actions === undefined ? null : (
					<span className={`hb-list-row-actions items-center gap-0.5 ${isStatic ? actionsShown : actionsOnDemand}`}>
						{actions}
					</span>
				)}
			</span>
		);
	// The main target and the actions are siblings, never nested: a button inside a link is invalid and unreachable.
	return (
		<div className={className}>
			{href !== undefined ? (
				<a className={`${main} ${mainTarget}`} href={href} aria-current={selected ? "page" : undefined}>
					{body}
				</a>
			) : onSelect !== undefined ? (
				<button
					type="button"
					className={`${main} ${mainTarget}`}
					onClick={onSelect}
					aria-current={selected ? "true" : undefined}
				>
					{body}
				</button>
			) : (
				<div className={main}>{body}</div>
			)}
			{side}
		</div>
	);
});
