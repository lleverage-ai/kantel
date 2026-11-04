// Settings (compute console): the title, Settings' own navigation and the page. On a wide screen the links sit beside
// the page; on a phone they are a row over it. The sidebar's Settings opens the first account page; each page is at the
// address it had before the redesign, so a link to one still works. A page heads itself with SettingsPageHeader: its
// name and its one action on a wide screen, the action alone on a phone, where the selected link already names it.

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
	/** The label as the title over the page: Settings has it; Admin's pages head themselves, so its row doesn't. */
	readonly titled?: boolean;
	/** A phone: the links in a row over the page, scrolling sideways when they don't fit. */
	readonly narrow?: boolean;
	/** The settings page shown. */
	readonly children: ReactNode;
}

/** Settings' title, then a settings page with Settings' navigation beside it, or over it on a phone. */
export function SettingsFrame({
	items,
	label = "Settings",
	titled = true,
	narrow = false,
	children,
}: SettingsFrameProps) {
	const nav = (
		<nav
			aria-label={label}
			className={
				narrow
					? // Sideways on a phone: the row fades at its end so a page past the edge reads as more to scroll to, and the
						// page shown scrolls into view.
						"-mx-gutter-narrow flex min-w-0 gap-1 overflow-x-auto px-gutter-narrow [scrollbar-width:none] mask-r-from-75% mask-r-to-100%"
					: "sticky top-0 flex w-(--kt-menu-width) flex-none flex-col gap-0.5"
			}
		>
			{items.map((item) => (
				<a
					key={item.id}
					className={`${link} ${item.selected ? linkState.selected : linkState.idle}`}
					href={item.href}
					aria-current={item.selected ? "page" : undefined}
					{...(item.selected && narrow
						? {
								ref: (element: HTMLAnchorElement | null) =>
									element?.scrollIntoView({ block: "nearest", inline: "nearest" }),
							}
						: {})}
				>
					{item.label}
				</a>
			))}
		</nav>
	);
	// The same elements in both layouts, only their classes change: crossing the breakpoint (turning a phone) must not
	// remount the page, which would lose a draft or a new key's secret that hasn't been copied yet.
	return (
		<div className="flex min-w-0 flex-col gap-5">
			{titled ? (
				<header
					className={`kt-page-header flex min-h-control-md min-w-0 items-center ${narrow ? "" : "border-b border-border pb-3"}`}
				>
					<h1 className={`kt-page-header-title m-0 truncate font-strong leading-tight text-fg text-heading`}>
						{label}
					</h1>
				</header>
			) : null}
			<div className={narrow ? "flex min-w-0 flex-col gap-4" : "flex min-w-0 items-start gap-8"}>
				{nav}
				<div className="min-w-0 flex-1">{children}</div>
			</div>
		</div>
	);
}

/**
 * A settings page's head: its name and its one action on a line. On a phone with no action the name is for screen
 * readers only, since the selected link over the page says it; with an action, the name stays beside it.
 */
export function SettingsPageHeader({
	title,
	actions,
	narrow = false,
	id,
}: {
	title: ReactNode;
	actions?: ReactNode;
	narrow?: boolean;
	/** For a section that labels itself by the title. */
	id?: string;
}) {
	if (narrow && actions === undefined) {
		return (
			<h2 id={id} className="kt-sr-only">
				{title}
			</h2>
		);
	}
	return (
		<div className="flex min-h-control-md min-w-0 items-center justify-between gap-3">
			{/* On a phone with an action, the name stays visible beside it, so the action isn't left on its own. */}
			<h2 id={id} className="m-0 truncate text-md font-strong leading-tight text-fg">
				{title}
			</h2>
			{actions === undefined ? null : <div className="ml-auto flex flex-none items-center gap-2">{actions}</div>}
		</div>
	);
}
