import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
import { IconButton } from "./button.tsx";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, SidebarIcon } from "./icons.tsx";
import "./sidebar.css";

// The app's sidebar, after T3 Code's: a head with the product's name and the collapse button, a body that scrolls on
// its own with the projects and each project's sessions nested under it, and a foot that stays put with the pages
// that belong to no project and who is signed in. Collapsed, it is a rail of icons: every item keeps its accessible
// name and shows it as a tooltip.

const Collapsed = createContext(false);

/** Whether the sidebar around this component is collapsed to its rail. */
export const useSidebarCollapsed = (): boolean => useContext(Collapsed);

export type SidebarProps = Omit<ComponentProps<"div">, "children"> & {
	/** A rail of icons, `--hb-rail-width` wide, instead of the full sidebar. */
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
 * height; the host decides its width (`--hb-sidebar-width`, or `--hb-rail-width` collapsed) and its landmark role,
 * passed through as props.
 */
export function Sidebar({ collapsed = false, head, foot, children, className, ...rest }: SidebarProps) {
	return (
		<Collapsed.Provider value={collapsed}>
			<div
				{...rest}
				className={`hb-sidebar${className ? ` ${className}` : ""}`}
				data-collapsed={collapsed ? "" : undefined}
			>
				<div className="hb-sidebar-head">{head}</div>
				<div className="hb-sidebar-body">{children}</div>
				{foot === undefined ? null : <div className="hb-sidebar-foot">{foot}</div>}
			</div>
		</Collapsed.Provider>
	);
}

/** The head's product name. Hidden on the rail, where only the toggle shows. */
export function SidebarBrand({ children }: { children: ReactNode }) {
	return <span className="hb-sidebar-brand">{children}</span>;
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
			className="hb-sidebar-toggle"
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
		<nav className="hb-sidebar-section" aria-label={label}>
			{heading ? <h2 className="hb-sidebar-heading">{label}</h2> : null}
			<ul className="hb-sidebar-items">{children}</ul>
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
		<li className="hb-sidebar-item-slot">
			<a
				className={`hb-sidebar-item hb-focusable${selected ? " hb-sidebar-item-selected" : ""}`}
				href={href}
				aria-current={selected ? "page" : undefined}
				title={collapsed ? label : undefined}
			>
				<span className="hb-sidebar-item-icon">{icon}</span>
				<span className="hb-sidebar-item-label">{label}</span>
				{trailing === undefined ? null : <span className="hb-sidebar-item-trailing">{trailing}</span>}
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
	return (
		<li
			className={`hb-sidebar-project${current ? " hb-sidebar-project-current" : ""}${selected ? " hb-sidebar-project-selected" : ""}`}
		>
			<div className="hb-sidebar-project-row">
				{onToggle === undefined ? (
					<span className="hb-sidebar-project-toggle" aria-hidden="true">
						{chevron}
					</span>
				) : (
					<button
						type="button"
						className="hb-sidebar-project-toggle hb-focusable"
						aria-expanded={open}
						aria-label={open ? `Hide ${name}'s sessions` : `Show ${name}'s sessions`}
						title={open ? "Hide sessions" : "Show sessions"}
						onClick={onToggle}
					>
						{chevron}
					</button>
				)}
				<a
					className="hb-sidebar-project-main hb-focusable"
					href={href}
					aria-current={selected ? "page" : undefined}
					title={collapsed ? name : undefined}
				>
					<span className="hb-sidebar-project-mark" aria-hidden="true">
						{monogram(name)}
					</span>
					<span className="hb-sidebar-project-icon">
						<FolderIcon />
					</span>
					<span className="hb-sidebar-project-name">{name}</span>
				</a>
				{action === undefined ? null : <span className="hb-sidebar-project-action">{action}</span>}
			</div>
			{showChildren ? <div className="hb-sidebar-project-children">{children}</div> : null}
		</li>
	);
}
