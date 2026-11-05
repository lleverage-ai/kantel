import type { ReactNode } from "react";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/**
 * The bar: as tall as a tab, plus the home indicator's inset on a phone that has one, on the sidebar's panel colour
 * under a hairline, as the sidebar is beside the page on a wide screen.
 */
const bar =
	"kt-tab-bar grid flex-none auto-cols-fr grid-flow-col border-t border-border bg-panel pb-[env(safe-area-inset-bottom)]";

/** A tab: icon over a short label, the width of a thumb, muted until it is the page shown. */
const tab =
	"kt-tab-bar-item kt-focusable flex h-(--kt-tabbar-height) min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs leading-tight no-underline focus-visible:-outline-offset-(--kt-ring)!";

const tabState = {
	selected: "font-medium text-fg [&_.kt-icon]:text-accent-text",
	idle: "text-muted hover:text-fg",
};

export type TabBarItem = {
	readonly id: string;
	/** One short word: "Envs" rather than "Environments". */
	readonly label: string;
	/** A 16px line icon. */
	readonly icon: ReactNode;
	readonly href: string;
	readonly selected?: boolean;
};

export type TabBarProps = {
	/** The bar's landmark name: "Pages". */
	readonly label: string;
	/** Up to five. */
	readonly items: readonly TabBarItem[];
};

/**
 * A phone's main navigation: up to five pages along the bottom of the screen, in reach of a thumb, each an icon over
 * a one-word label. The page shown is in full-strength text with its icon in the highlight colour, and is
 * `aria-current="page"`. On a wide screen the same pages are in the sidebar instead.
 */
export function TabBar({ label, items }: TabBarProps) {
	return (
		<nav className={bar} aria-label={label}>
			{items.map((item) => (
				<a
					key={item.id}
					className={`${tab} ${item.selected ? tabState.selected : tabState.idle}`}
					href={item.href}
					aria-current={item.selected ? "page" : undefined}
				>
					<span className="inline-grid size-control-xs place-items-center" aria-hidden="true">
						{item.icon}
					</span>
					<span className="max-w-full truncate">{item.label}</span>
				</a>
			))}
		</nav>
	);
}
