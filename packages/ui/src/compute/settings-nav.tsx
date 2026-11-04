// Settings' own navigation (compute console): the account's settings pages, beside the page on a wide screen and in a
// row over it on a phone. The sidebar's Settings opens the first; each page is the one it was before the redesign, at
// the same address, so a link to one still works.

import type { ReactNode } from "react";

export type SettingsNavItem = {
	readonly id: string;
	readonly label: string;
	readonly href: string;
	readonly selected?: boolean;
};

/** A link: muted until it is the page shown, which is filled. */
const link =
	"kt-settings-nav-item kt-focusable flex h-control-md flex-none items-center rounded-control px-2.5 text-sm whitespace-nowrap no-underline focus-visible:-outline-offset-(--kt-ring)!";
const linkState = {
	selected: "bg-selected font-medium text-fg",
	idle: "text-muted hover:bg-hover hover:text-fg",
};

export interface SettingsFrameProps {
	readonly items: readonly SettingsNavItem[];
	/** The navigation's name: Settings, or Admin's on a phone. */
	readonly label?: string;
	/** A phone: the links in a row over the page, scrolling sideways when they don't fit. */
	readonly narrow?: boolean;
	/** The settings page shown. */
	readonly children: ReactNode;
}

/** A settings page with Settings' navigation beside it, or over it on a phone. */
export function SettingsFrame({ items, label = "Settings", narrow = false, children }: SettingsFrameProps) {
	const nav = (
		<nav
			aria-label={label}
			className={
				narrow
					? "-mx-gutter-narrow flex min-w-0 gap-1 overflow-x-auto px-gutter-narrow"
					: "sticky top-0 flex w-(--kt-menu-width) flex-none flex-col gap-0.5"
			}
		>
			{items.map((item) => (
				<a
					key={item.id}
					className={`${link} ${item.selected ? linkState.selected : linkState.idle}`}
					href={item.href}
					aria-current={item.selected ? "page" : undefined}
				>
					{item.label}
				</a>
			))}
		</nav>
	);
	// The same elements in both layouts, only their classes change: crossing the breakpoint (turning a phone) must not
	// remount the page, which would lose a draft or a new key's secret that hasn't been copied yet.
	return (
		<div className={narrow ? "flex min-w-0 flex-col gap-4" : "flex min-w-0 items-start gap-8"}>
			{nav}
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}
