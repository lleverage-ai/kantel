import { type CSSProperties, memo, type ReactNode, useId } from "react";
import "./breadcrumbs.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md). The container query that folds the outer
// parents on a phone stays in breadcrumbs.css, on the kt-breadcrumbs-outer and kt-breadcrumbs-more hooks.

/** A trail of where you are: muted parents that go back, the current item emphasised. One line, no wrapping. */
const crumbsNav = "kt-breadcrumbs @container min-w-0 flex-[1_1_0]";

/** Every item sits on one baseline, so the slashes and the words line up whatever their boxes. */
const crumbsList =
	"kt-breadcrumbs-list m-0 flex min-w-0 list-none items-baseline gap-2 p-0 text-md font-medium leading-tight";

/**
 * A parent. Short of room, the current item gives way first (it shrinks a thousand times faster) down to a usable few
 * words, so a short parent such as the project keeps its whole name; only then do the parents shrink, each in
 * proportion to its length, so a long one goes to an ellipsis before a short one loses a letter. (No minimum width: one
 * would pad a name shorter than it, opening a gap before the slash; on a phone the outer parents are hidden instead.) A
 * long parent is capped, as T3 Code caps a parent thread's title in its header.
 */
const crumbParent =
	"kt-breadcrumbs-item kt-breadcrumbs-parent flex min-w-0 max-w-[14em] flex-[0_1_auto] items-baseline text-muted";

/** The "…" item: a parent, hidden while the whole trail fits (breadcrumbs.css shows it on a phone, flex: none). */
const crumbMore =
	"kt-breadcrumbs-item kt-breadcrumbs-parent kt-breadcrumbs-more hidden min-w-0 max-w-[14em] items-baseline text-muted";

/**
 * The current item, taking the room that's left. Its content is trimmed to its capitals (with room kept for
 * descenders), as button labels are, so a row that centres the trail centres its letters, not its line box.
 */
const crumbCurrent =
	"kt-breadcrumbs-item kt-breadcrumbs-current flex min-w-[min(8em,100%)] flex-[1_1000_auto] items-baseline text-fg *:py-(--kt-trim-room) *:[text-box:trim-both_cap_alphabetic]";

/** The slash between items, trimmed to its capitals as the words are. */
const crumbSeparator =
	"kt-breadcrumbs-separator flex-none py-(--kt-trim-room) font-regular text-faint [text-box:trim-both_cap_alphabetic]";

/** A crumb's words: one line, cut short with an ellipsis, trimmed to their capitals. */
const crumbText = "kt-breadcrumbs-text block min-w-0 truncate py-(--kt-trim-room) [text-box:trim-both_cap_alphabetic]";

/** A parent's link or button: no chrome, the parent's colour until hovered. */
const crumbLink =
	"kt-breadcrumbs-link kt-focusable m-0 flex max-w-full min-w-0 cursor-pointer items-baseline rounded-xs border-0 bg-transparent p-0 text-inherit no-underline [font:inherit] transition-colors duration-(--kt-duration-fast) hover:text-fg";

/**
 * The hidden levels' menu: under the "…" button where anchor positioning is supported (`supports-`), else under the
 * top bar.
 */
const crumbMenu =
	"kt-breadcrumbs-menu top-9 right-auto bottom-auto left-2.5 mx-0 mt-0 mb-0 min-w-[min(14em,calc(100vw_-_var(--kt-step-8)))] max-w-[calc(100vw_-_var(--kt-step-8))] rounded-panel border-0 bg-raised p-1 text-md font-regular text-fg shadow-float supports-[position-area:bottom]:top-auto supports-[position-area:bottom]:left-auto supports-[position-area:bottom]:mt-1.5 supports-[position-area:bottom]:[position-area:bottom_span-right] supports-[position-area:bottom]:[position-try-fallbacks:flip-inline]";

/** A level in the menu: a full-width row, one line. */
const crumbMenuItem =
	"kt-breadcrumbs-menu-item kt-focusable m-0 block w-full cursor-pointer truncate rounded-xs border-0 bg-transparent px-2.5 py-2 text-left text-inherit no-underline [font:inherit] hover:bg-hover";

/** One step up the trail: a project, a session, a subagent's parent. */
export type Crumb = {
	/** Stable key for the list; defaults to the label. */
	key?: string;
	label: string;
	/** Makes the crumb a link (preferred: it opens in a new tab too). */
	href?: string;
	/** Makes the crumb a button, when there's nowhere to link to. */
	onSelect?: () => void;
};

export type BreadcrumbsProps = {
	/** What the trail is, for screen readers: "Session", "File". */
	label: string;
	/** The levels above the current one, outermost first. Muted, each a link or a button back to it. */
	parents: readonly Crumb[];
	/** The current level: emphasised, never a link. A heading or plain text; it truncates when the row is short. */
	current: ReactNode;
};

/**
 * Where you are, as a trail: `Default / Fix the billing worker / Write the tests`. The parents are muted and go back
 * to their level; the current item is emphasised and takes the room that's left, truncating before the parents do.
 * Separators are a slash, hidden from screen readers; the list is a `nav` with `aria-current="page"` on the current
 * item, as T3 Code's thread breadcrumb (`WorkspaceBreadcrumb`).
 *
 * However deep the trail (a subagent's subagent's session), every level stays one click away. Short of room (a
 * phone) only the nearest parent is shown; the levels above it fold into a "…" button whose menu lists them,
 * outermost first, each a link back to its level.
 */
export const Breadcrumbs = memo(function Breadcrumbs({ label, parents, current }: BreadcrumbsProps) {
	const hidden = parents.slice(0, -1);
	return (
		<nav className={crumbsNav} aria-label={label}>
			<ol className={crumbsList}>
				{hidden.length === 0 ? null : <MoreItem crumbs={hidden} />}
				{parents.map((crumb, index) => (
					<CrumbItem key={crumb.key ?? `${index}:${crumb.label}`} crumb={crumb} outer={index < parents.length - 1} />
				))}
				<li className={crumbCurrent} aria-current="page">
					{current}
				</li>
			</ol>
		</nav>
	);
});

/**
 * The levels a short trail hides, behind one button: shown only when the outer parents are (the container query in
 * breadcrumbs.css). Its menu is a native popover, so it closes on Escape or a click outside, and sits under the button.
 */
function MoreItem({ crumbs }: { crumbs: readonly Crumb[] }) {
	const id = useId();
	const menu = `${id}-levels`;
	// The menu sits under the button by CSS anchor positioning; the anchor's name must be a plain dashed ident.
	const anchor = `--kt-crumbs-${id.replace(/[^\w-]/g, "")}`;
	const words = `${crumbs.length} ${crumbs.length === 1 ? "level" : "levels"} above`;
	return (
		<>
			<li className={crumbMore}>
				<button
					type="button"
					className={crumbLink}
					popoverTarget={menu}
					aria-label={`Show the ${words}`}
					title={words}
					style={{ anchorName: anchor } as CSSProperties}
				>
					<span className={crumbText}>…</span>
				</button>
				<div id={menu} popover="auto" className={crumbMenu} style={{ positionAnchor: anchor } as CSSProperties}>
					<ul aria-label={words} className="m-0 flex list-none flex-col p-0">
						{crumbs.map((crumb, index) => (
							<li key={crumb.key ?? `${index}:${crumb.label}`}>
								{crumb.href !== undefined ? (
									<a className={crumbMenuItem} href={crumb.href}>
										{crumb.label}
									</a>
								) : (
									<button
										type="button"
										className={crumbMenuItem}
										onClick={crumb.onSelect}
										disabled={crumb.onSelect === undefined}
									>
										{crumb.label}
									</button>
								)}
							</li>
						))}
					</ul>
				</div>
			</li>
			<li className={`${crumbSeparator} kt-breadcrumbs-more hidden`} aria-hidden="true">
				/
			</li>
		</>
	);
}

function CrumbItem({ crumb, outer }: { crumb: Crumb; outer: boolean }) {
	const text = <span className={crumbText}>{crumb.label}</span>;
	const fold = outer ? " kt-breadcrumbs-outer" : "";
	return (
		<>
			<li className={`${crumbParent}${fold}`}>
				{crumb.href !== undefined ? (
					<a className={crumbLink} href={crumb.href} title={crumb.label}>
						{text}
					</a>
				) : crumb.onSelect !== undefined ? (
					<button type="button" className={crumbLink} onClick={crumb.onSelect} title={crumb.label}>
						{text}
					</button>
				) : (
					text
				)}
			</li>
			<li className={`${crumbSeparator}${fold}`} aria-hidden="true">
				/
			</li>
		</>
	);
}
