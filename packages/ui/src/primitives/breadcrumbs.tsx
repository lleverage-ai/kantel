import { memo, type ReactNode } from "react";
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
 */
export const Breadcrumbs = memo(function Breadcrumbs({ label, parents, current }: BreadcrumbsProps) {
	return (
		<nav className="hb-breadcrumbs" aria-label={label}>
			<ol className="hb-breadcrumbs-list">
				{parents.map((crumb, index) => (
					<CrumbItem key={crumb.key ?? `${index}:${crumb.label}`} crumb={crumb} />
				))}
				<li className="hb-breadcrumbs-item hb-breadcrumbs-current" aria-current="page">
					{current}
				</li>
			</ol>
		</nav>
	);
});

function CrumbItem({ crumb }: { crumb: Crumb }) {
	const text = <span className="hb-breadcrumbs-text">{crumb.label}</span>;
	return (
		<>
			<li className="hb-breadcrumbs-item hb-breadcrumbs-parent">
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
			<li className="hb-breadcrumbs-separator" aria-hidden="true">
				/
			</li>
		</>
	);
}
