import { type CSSProperties, memo, type ReactNode, useId } from "react";
import "./breadcrumbs.css";

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
		<nav className="hb-breadcrumbs" aria-label={label}>
			<ol className="hb-breadcrumbs-list">
				{hidden.length === 0 ? null : <MoreItem crumbs={hidden} />}
				{parents.map((crumb, index) => (
					<CrumbItem key={crumb.key ?? `${index}:${crumb.label}`} crumb={crumb} outer={index < parents.length - 1} />
				))}
				<li className="hb-breadcrumbs-item hb-breadcrumbs-current" aria-current="page">
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
	const anchor = `--hb-crumbs-${id.replace(/[^\w-]/g, "")}`;
	const words = `${crumbs.length} ${crumbs.length === 1 ? "level" : "levels"} above`;
	return (
		<>
			<li className="hb-breadcrumbs-item hb-breadcrumbs-parent hb-breadcrumbs-more">
				<button
					type="button"
					className="hb-breadcrumbs-link hb-focusable"
					popoverTarget={menu}
					aria-label={`Show the ${words}`}
					title={words}
					style={{ anchorName: anchor } as CSSProperties}
				>
					<span className="hb-breadcrumbs-text">…</span>
				</button>
				<div
					id={menu}
					popover="auto"
					className="hb-breadcrumbs-menu"
					style={{ positionAnchor: anchor } as CSSProperties}
				>
					<ul aria-label={words}>
						{crumbs.map((crumb, index) => (
							<li key={crumb.key ?? `${index}:${crumb.label}`}>
								{crumb.href !== undefined ? (
									<a className="hb-breadcrumbs-menu-item hb-focusable" href={crumb.href}>
										{crumb.label}
									</a>
								) : (
									<button
										type="button"
										className="hb-breadcrumbs-menu-item hb-focusable"
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
			<li className="hb-breadcrumbs-separator hb-breadcrumbs-more" aria-hidden="true">
				/
			</li>
		</>
	);
}

function CrumbItem({ crumb, outer }: { crumb: Crumb; outer: boolean }) {
	const text = <span className="hb-breadcrumbs-text">{crumb.label}</span>;
	const fold = outer ? " hb-breadcrumbs-outer" : "";
	return (
		<>
			<li className={`hb-breadcrumbs-item hb-breadcrumbs-parent${fold}`}>
				{crumb.href !== undefined ? (
					<a className="hb-breadcrumbs-link hb-focusable" href={crumb.href} title={crumb.label}>
						{text}
					</a>
				) : crumb.onSelect !== undefined ? (
					<button
						type="button"
						className="hb-breadcrumbs-link hb-focusable"
						onClick={crumb.onSelect}
						title={crumb.label}
					>
						{text}
					</button>
				) : (
					text
				)}
			</li>
			<li className={`hb-breadcrumbs-separator${fold}`} aria-hidden="true">
				/
			</li>
		</>
	);
}
