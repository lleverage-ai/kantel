// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/** The row: the tabs on one line over a hairline that runs the width of the page, scrolling sideways if they don't fit. */
const row = "kt-page-tabs flex min-w-0 gap-5 overflow-x-auto border-b border-border";

/**
 * A tab: a link the height of a control, its words muted until it is the view shown, which is in full-strength text
 * with a bar under it sitting on the row's hairline.
 */
const tab =
	"kt-page-tab kt-focusable relative -mb-px flex h-control-lg flex-none items-center gap-1.5 border-b-2 text-sm whitespace-nowrap no-underline focus-visible:-outline-offset-(--kt-ring)!";
const tabState = {
	selected: "border-fg font-medium text-fg",
	idle: "border-transparent text-muted hover:text-fg",
};

export type PageTab = {
	readonly id: string;
	readonly label: string;
	/** A count after the label, such as a page's nine rules. */
	readonly count?: number;
	readonly href: string;
	readonly selected?: boolean;
};

export type PageTabsProps = {
	/** The row's landmark name: "Egress". */
	readonly label: string;
	readonly tabs: readonly PageTab[];
	/** Asked to show a tab, in place of following its link; a modified click still follows it. */
	readonly onSelect?: (id: string) => void;
	readonly className?: string;
};

/**
 * A page's own views, one shown at a time: Egress's Log, Rules and Settings. Links, so each view has its address and
 * opens in a new tab with a modified click; the one shown is `aria-current="page"`. Not for the console's pages (the
 * sidebar and the TabBar) or for filters within a view (SegmentedControl).
 */
export function PageTabs({ label, tabs, onSelect, className }: PageTabsProps) {
	return (
		<nav aria-label={label} className={className === undefined ? row : `${row} ${className}`}>
			{tabs.map((item) => (
				<a
					key={item.id}
					className={`${tab} ${item.selected ? tabState.selected : tabState.idle}`}
					href={item.href}
					aria-current={item.selected ? "page" : undefined}
					onClick={(event) => {
						if (onSelect === undefined || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
							return;
						event.preventDefault();
						onSelect(item.id);
					}}
				>
					{item.label}
					{item.count === undefined ? null : <span className="text-xs text-faint tabular-nums">{item.count}</span>}
				</a>
			))}
		</nav>
	);
}
