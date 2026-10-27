import { memo, type ReactNode } from "react";
import "./list-row.css";

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
	const className = `hb-list-row hb-list-row-${density}${selected ? " hb-list-row-selected" : ""}${quiet ? " hb-list-row-quiet" : ""}${actions === undefined ? "" : " hb-list-row-has-actions"}`;
	const body = (
		<>
			{leading === undefined ? null : <span className="hb-list-row-leading">{leading}</span>}
			<span className="hb-list-row-text">
				{overline === undefined ? null : <span className="hb-list-row-overline">{overline}</span>}
				<span className="hb-list-row-title">{title}</span>
				{meta === undefined ? null : <span className="hb-list-row-meta">{meta}</span>}
			</span>
		</>
	);
	const side =
		trailing === undefined && actions === undefined ? null : (
			<span className="hb-list-row-side">
				{trailing === undefined ? null : <span className="hb-list-row-trailing">{trailing}</span>}
				{actions === undefined ? null : <span className="hb-list-row-actions">{actions}</span>}
			</span>
		);
	// The main target and the actions are siblings, never nested: a button inside a link is invalid and unreachable.
	return (
		<div className={className}>
			{href !== undefined ? (
				<a className="hb-list-row-main hb-focusable" href={href} aria-current={selected ? "page" : undefined}>
					{body}
				</a>
			) : onSelect !== undefined ? (
				<button
					type="button"
					className="hb-list-row-main hb-focusable"
					onClick={onSelect}
					aria-current={selected ? "true" : undefined}
				>
					{body}
				</button>
			) : (
				<div className="hb-list-row-main">{body}</div>
			)}
			{side}
		</div>
	);
});
