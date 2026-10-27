import type { ReactNode } from "react";
import { IconButton } from "../primitives/button.tsx";
import { ChevronRightIcon } from "../primitives/icons.tsx";
import { parentPath } from "./workspace-model.ts";
import "./viewer-header.css";

// The parts FileViewer and NoteViewer share. Internal to the workspace components; not exported from the library.

/** Whether a slot was given something to render. */
export const present = (node: ReactNode): boolean => node !== undefined && node !== null && node !== false;

/**
 * The bar at the top of a viewer: Back (when given, for a phone), the name, the folder it is in (muted) and its
 * facts as separate elements, and the viewer's actions.
 */
export function ViewerHeader({
	id,
	path,
	title,
	facts,
	onBack,
	actions,
}: {
	/** The heading's id, which names the viewer. */
	id: string;
	path: string;
	title: string;
	/** Facts after the folder: a size, when it was updated. Separate elements, never a middle-dot string. */
	facts?: ReactNode;
	onBack?: (() => void) | undefined;
	actions?: ReactNode;
}) {
	const parent = parentPath(path);
	return (
		<header className="hb-viewer-header">
			{onBack === undefined ? null : (
				<IconButton
					className="hb-viewer-back"
					variant="ghost"
					label="Back"
					icon={<ChevronRightIcon className="hb-viewer-back-icon" />}
					onClick={onBack}
				/>
			)}
			<div className="hb-viewer-heading">
				<h2 id={id} className="hb-viewer-title" title={path}>
					{title}
				</h2>
				{parent === "" && !present(facts) ? null : (
					<div className="hb-viewer-facts">
						{parent === "" ? null : (
							<span className="hb-viewer-parent" title={parent}>
								{parent}
							</span>
						)}
						{facts}
					</div>
				)}
			</div>
			{present(actions) ? <div className="hb-viewer-actions">{actions}</div> : null}
		</header>
	);
}

/**
 * The viewer's scrolling body. It takes focus, so a keyboard can scroll it, and is a region named for what it shows.
 */
export function ViewerScroll({
	label,
	className,
	children,
}: {
	label: string;
	className: string;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard.
		<section className={`${className} hb-focusable`} tabIndex={0} aria-label={label}>
			{children}
		</section>
	);
}
