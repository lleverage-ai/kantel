import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
import { IconButton } from "./button.tsx";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, SidebarIcon } from "./icons.tsx";
import "./sidebar.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md). The rail is a named group: the root is
// `group/sidebar` and carries `data-collapsed`, and what changes on the rail says so with a
// `group-data-collapsed/sidebar:` variant. sidebar.css keeps only the rail's rules on SignedInAs, another component.
// Every kt- class stays as a hook.

// The app's sidebar, after T3 Code's: a head with the product's name and the collapse button, a body that scrolls on
// its own with the projects and each project's sessions nested under it, and a foot that stays put with the pages
// that belong to no project and who is signed in. Collapsed, it is a rail of icons: every item keeps its accessible
// name and shows it as a tooltip. Every row shares one inset (step 1.5 from the edge, step 2.5 inside the row), so
// icons, names and headings line up down the column.

const Collapsed = createContext(false);

/** Whether the sidebar around this component is collapsed to its rail. */
export const useSidebarCollapsed = (): boolean => useContext(Collapsed);

/** The component's own classes, then the caller's. */
function withClass(base: string, className: string | undefined): string {
	return className ? `${base} ${className}` : base;
}

/** The frame: a column that fills its cell, on the panel colour, a hairline on its right. */
const sidebarFrame =
	"kt-sidebar group/sidebar flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-panel text-fg";

/**
 * The head: the brand and the toggle, the brand on the rows' inset (step 1.5 plus 2.5). On the rail only the toggle
 * shows, centred.
 */
const sidebarHead =
	"kt-sidebar-head flex min-h-control-lg flex-none items-center justify-between gap-2 py-2 pr-1.5 pl-[calc(var(--kt-step-1_5)_+_var(--kt-step-2_5))] group-data-collapsed/sidebar:justify-center group-data-collapsed/sidebar:pr-0 group-data-collapsed/sidebar:pl-0";

/** The body scrolls on its own, without handing the scroll on to the page. Closer together on the rail. */
const sidebarBody =
	"kt-sidebar-body flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-1.5 pt-1 pb-4 group-data-collapsed/sidebar:gap-2.5";

/** The foot stays put under a hairline. */
const sidebarFoot = "kt-sidebar-foot flex flex-none flex-col gap-2.5 border-t border-border px-1.5 pt-2.5 pb-2";

/**
 * A link's focus ring sits inside its fill, so neighbouring rows don't clip it. `!`: base.css's `.kt-focusable` offset
 * is unlayered and would beat a utility.
 */
const ringInside = "focus-visible:-outline-offset-(--kt-ring)!";

/**
 * A page link: muted until it is the page shown, which is filled and in full-strength text. On the rail, the icon
 * alone, centred.
 */
const item = `kt-sidebar-item kt-focusable flex min-h-control-md min-w-0 items-center gap-2 rounded-control px-2.5 py-0 text-sm leading-tight no-underline group-data-collapsed/sidebar:justify-center group-data-collapsed/sidebar:px-0 ${ringInside}`;

/**
 * The link's state. A row that isn't selected is the hover group its icon brightens in (`group-hover/item:` on the
 * icon); a selected row isn't one, and puts its icon in full-strength text, so the two never compete for the icon.
 */
const itemState = {
	selected: "kt-sidebar-item-selected bg-selected font-medium text-fg [&>.kt-sidebar-item-icon]:text-fg",
	idle: "group/item text-muted hover:bg-hover hover:text-fg",
};

/**
 * The project's chevron, hidden on the rail. As a button (the current project's) it fills under the pointer; the
 * button's own cursor and hover are added in SidebarProject.
 */
const projectToggle =
	"kt-sidebar-project-toggle ml-1 inline-grid size-control-xs flex-none place-items-center rounded-sm border-0 bg-transparent p-0 text-faint group-data-collapsed/sidebar:hidden";

/** The project's link: folder and name; on the rail, the mark alone, centred. */
const projectMain = `kt-sidebar-project-main kt-focusable flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-[inherit] py-0 pr-2.5 pl-1 text-md leading-tight no-underline group-data-collapsed/sidebar:justify-center group-data-collapsed/sidebar:pr-0 group-data-collapsed/sidebar:pl-0 ${ringInside}`;

/** Its first letter in a small square, on the rail only. */
const projectMark =
	"kt-sidebar-project-mark hidden size-control-xs place-items-center rounded-sm border bg-raised text-xs font-strong leading-none group-data-collapsed/sidebar:inline-grid";

/** The guide line runs down from the chevron's centre, so it's plain which project the sessions belong to. */
const projectChildren =
	"kt-sidebar-project-children mt-1 mr-0 mb-2 ml-[calc(var(--kt-step-1)_+_var(--kt-control-xs)*0.5)] flex min-w-0 flex-col gap-2 border-l border-border-strong pl-1.5";

export type SidebarProps = Omit<ComponentProps<"div">, "children"> & {
	/** A rail of icons, `--kt-rail-width` wide, instead of the full sidebar. */
	collapsed?: boolean;
	/** The top row: the product's name and a `SidebarToggle`. */
	head: ReactNode;
	/** What stays at the bottom while the body scrolls: page links and who is signed in. */
	foot?: ReactNode;
	/** The body, which scrolls on its own: projects and their sessions. */
	children: ReactNode;
};

/**
 * The sidebar's frame: head, a body that scrolls by itself, and a fixed foot. It fills its grid cell or parent's
 * height; the host decides its width (`--kt-sidebar-width`, or `--kt-rail-width` collapsed) and its landmark role,
 * passed through as props.
 */
export function Sidebar({ collapsed = false, head, foot, children, className, ...rest }: SidebarProps) {
	return (
		<Collapsed.Provider value={collapsed}>
			<div {...rest} className={withClass(sidebarFrame, className)} data-collapsed={collapsed ? "" : undefined}>
				<div className={sidebarHead}>{head}</div>
				<div className={sidebarBody}>{children}</div>
				{foot === undefined ? null : <div className={sidebarFoot}>{foot}</div>}
			</div>
		</Collapsed.Provider>
	);
}

/** The head's product name. Hidden on the rail, where only the toggle shows. */
export function SidebarBrand({ children }: { children: ReactNode }) {
	return (
		<span className="kt-sidebar-brand min-w-0 truncate text-md font-strong group-data-collapsed/sidebar:hidden">
			{children}
		</span>
	);
}

export type SidebarToggleProps = {
	/** Whether the sidebar is collapsed now: the button says what pressing it does next. */
	collapsed: boolean;
	onToggle: () => void;
	/** The sidebar's element ID, for `aria-controls`. */
	controls?: string;
	/** A shortcut to mention in the tooltip, such as "Ctrl+B". */
	shortcut?: string;
};

/** Collapses the sidebar to its rail, or expands it again. */
export function SidebarToggle({ collapsed, onToggle, controls, shortcut }: SidebarToggleProps) {
	const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
	return (
		<IconButton
			// A hook only: the ghost button's own muted text is the toggle's colour.
			className="kt-sidebar-toggle"
			variant="ghost"
			label={label}
			title={shortcut === undefined ? label : `${label} (${shortcut})`}
			icon={<SidebarIcon />}
			aria-expanded={!collapsed}
			{...(controls === undefined ? {} : { "aria-controls": controls })}
			onClick={onToggle}
		/>
	);
}

export type SidebarSectionProps = {
	/** The section's name: its heading, and its navigation landmark's label. Hidden on the rail. */
	label: string;
	/** Shows the heading; without it the label only names the landmark. */
	heading?: boolean;
	/** `SidebarItem`s or `SidebarProject`s: each renders its own list item. */
	children: ReactNode;
};

/** A titled group of links: Projects, Agent, Organisation. A navigation landmark named after its label. */
export function SidebarSection({ label, heading = true, children }: SidebarSectionProps) {
	return (
		<nav className="kt-sidebar-section" aria-label={label}>
			{/* Small and muted, like the session list's group headings: a shelf label, not a banner. Read, not shown, on
			    the rail. */}
			{heading ? (
				<h2 className="kt-sidebar-heading mx-0 mt-0 mb-1 px-2.5 py-0 text-xs font-medium leading-tight text-faint group-data-collapsed/sidebar:sr-only">
					{label}
				</h2>
			) : null}
			<ul className="kt-sidebar-items m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">{children}</ul>
		</nav>
	);
}

export type SidebarItemProps = {
	/** A 16px line icon. On the rail it is all that shows. */
	icon: ReactNode;
	/** One line, truncated. The rail keeps it as the link's name and its tooltip. */
	label: string;
	href: string;
	/** The page shown now: filled, in full-strength text, and `aria-current="page"`. */
	selected?: boolean;
	/** A count or status at the right end. Hidden on the rail. */
	trailing?: ReactNode;
};

/** A link to a page in the sidebar: an icon and a label. */
export function SidebarItem({ icon, label, href, selected = false, trailing }: SidebarItemProps) {
	const collapsed = useSidebarCollapsed();
	return (
		<li className="kt-sidebar-item-slot min-w-0">
			<a
				className={`${item} ${selected ? itemState.selected : itemState.idle}`}
				href={href}
				aria-current={selected ? "page" : undefined}
				title={collapsed ? label : undefined}
			>
				{/*
				 * An icon beside a label sits on the middle of the label's capitals, as ListRow's leading slot does
				 * (components.md, "Centring on text"): the slot is one line of the label's type with an invisible character
				 * for a baseline, the icon rests on that baseline taking no room above it, then moves up by --kt-on-cap.
				 * Written out in full (and in SidebarProject) because `\200b` must reach Tailwind as it is in the DOM: a JSX
				 * attribute keeps the backslash, a JS string would need it escaped.
				 */}
				<span className="kt-sidebar-item-icon inline-flex h-[calc(1em*var(--kt-leading-tight))] min-w-icon-md flex-none items-baseline justify-center leading-tight text-faint group-hover/item:text-muted before:content-['\200b'] [&>.kt-icon-md]:-mt-icon-md [&>.kt-icon-md]:translate-y-(--kt-on-cap)">
					{icon}
				</span>
				<span className="kt-sidebar-item-label min-w-0 flex-1 truncate group-data-collapsed/sidebar:sr-only">
					{label}
				</span>
				{trailing === undefined ? null : (
					<span className="kt-sidebar-item-trailing flex-none text-xs text-faint tabular-nums group-data-collapsed/sidebar:hidden">
						{trailing}
					</span>
				)}
			</a>
		</li>
	);
}

export type SidebarProjectProps = {
	name: string;
	/** The project's page: its sessions. */
	href: string;
	/** The project you're in: its name in full-strength text, and its sessions shown under it when `open`. */
	current?: boolean;
	/** The project's own page is the one shown (no session open): filled, as a selected item. */
	selected?: boolean;
	/** Its sessions are shown under it. Only the current project's can be. */
	open?: boolean;
	/** Shows and hides the sessions under the current project. Without it the chevron is only a picture. */
	onToggle?: () => void;
	/** An icon button at the right end, such as New session. Hidden on the rail. */
	action?: ReactNode;
	/** What's nested under the project while it is open: New session and its session list. */
	children?: ReactNode;
};

/** The first letter of a project's name, for its mark on the rail. */
const monogram = (name: string): string => [...name.trim()][0]?.toUpperCase() ?? "?";

/**
 * A project in the sidebar, with its sessions nested under it: a chevron, a folder and the name, truncated, and an
 * optional action at the right end. On the rail it is a square with the name's first letter, named in a tooltip.
 */
export function SidebarProject({
	name,
	href,
	current = false,
	selected = false,
	open = false,
	onToggle,
	action,
	children,
}: SidebarProjectProps) {
	const collapsed = useSidebarCollapsed();
	const chevron = open ? <ChevronDownIcon size="sm" /> : <ChevronRightIcon size="sm" />;
	const showChildren = open && !collapsed && children !== undefined;
	const projectClass = [
		"kt-sidebar-project flex min-w-0 flex-col",
		// The project you're in reads as the heading of the sessions under it: its folder a step brighter too.
		current ? "kt-sidebar-project-current [&_.kt-sidebar-project-icon]:text-muted" : undefined,
		selected ? "kt-sidebar-project-selected" : undefined,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<li className={projectClass}>
			{/* The row is the hover group for the link's text and the action. */}
			<div
				className={`kt-sidebar-project-row group/project flex min-h-control-lg min-w-0 items-center rounded-control ${selected ? "bg-selected" : "hover:bg-hover"}`}
			>
				{onToggle === undefined ? (
					<span className={projectToggle} aria-hidden="true">
						{chevron}
					</span>
				) : (
					<button
						type="button"
						className={`${projectToggle} kt-focusable cursor-pointer hover:bg-active hover:text-fg`}
						aria-expanded={open}
						aria-label={open ? `Hide ${name}'s sessions` : `Show ${name}'s sessions`}
						title={open ? "Hide sessions" : "Show sessions"}
						onClick={onToggle}
					>
						{chevron}
					</button>
				)}
				<a
					className={`${projectMain} ${current ? "font-medium text-fg" : "text-muted group-hover/project:text-fg"}`}
					href={href}
					aria-current={selected ? "page" : undefined}
					title={collapsed ? name : undefined}
				>
					<span
						className={`${projectMark} ${current ? "border-faint text-fg" : "border-border-strong text-muted"}`}
						aria-hidden="true"
					>
						{monogram(name)}
					</span>
					{/* On the label's capitals, as SidebarItem's icon. Hidden on the rail, where the mark stands in. */}
					<span className="kt-sidebar-project-icon inline-flex h-[calc(1em*var(--kt-leading-tight))] min-w-icon-md flex-none items-baseline justify-center leading-tight text-faint before:content-['\200b'] group-data-collapsed/sidebar:hidden [&>.kt-icon-md]:-mt-icon-md [&>.kt-icon-md]:translate-y-(--kt-on-cap)">
						<FolderIcon />
					</span>
					<span className="kt-sidebar-project-name min-w-0 flex-1 truncate group-data-collapsed/sidebar:sr-only">
						{name}
					</span>
				</a>
				{/* The action shows with the pointer or focus on the row, on a touch screen, and always on the current
				    project. Hidden on the rail. */}
				{action === undefined ? null : (
					<span
						className={`kt-sidebar-project-action inline-flex flex-none items-center pr-1 group-data-collapsed/sidebar:hidden ${current ? "visible" : "invisible group-focus-within/project:visible group-hover/project:visible pointer-coarse:visible"}`}
					>
						{action}
					</span>
				)}
			</div>
			{showChildren ? <div className={projectChildren}>{children}</div> : null}
		</li>
	);
}
