import type { ReactNode } from "react";
import { IconButton } from "../primitives/button.tsx";
import { GlobeIcon, XIcon } from "../primitives/icons.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import "./browser-panel.css";

// The session's browser in one place, beside the transcript: the agent works in one browser, so a person watches one
// view of it, which stays put however many steps the agent takes. The view (usually a `BrowserLiveView`) is mounted
// once and never moves, so its live page is never reloaded between steps; once the browser closes, the same place
// plays its replay. The transcript keeps only a line per browsing run ("Browsing", `BrowsingGroup`).

export type BrowserPanelProps = {
	/** What the agent is doing in the browser now (the running call's label, "Scrolling the page"), or what it did last. */
	step?: string;
	/** A browser call is running: the step shows a spinner. */
	running?: boolean;
	/** Hides the panel; a browsing run's "Show browser" brings it back. Without it the panel can't be hidden. */
	onHide?: () => void;
	/** Above the view: a way to pick between the session's browsers, when it used more than one. */
	picker?: ReactNode;
	/** The browser's view. Keep its element in the same place, so the view isn't mounted again on every step. */
	children: ReactNode;
	className?: string;
};

/** A panel with the session's browser: a header saying what the agent is doing in it, then the view. */
export function BrowserPanel({ step, running = false, onHide, picker, children, className }: BrowserPanelProps) {
	return (
		<aside className={`hb-browser-panel${className ? ` ${className}` : ""}`} aria-label="Browser">
			<header className="hb-browser-panel-head">
				<span className="hb-browser-panel-icon">{running ? <Spinner size="sm" /> : <GlobeIcon size="sm" />}</span>
				<span className="hb-browser-panel-title">Browser</span>
				{/* Polite: a screen reader hears each step once, without being interrupted. */}
				<span className="hb-browser-panel-step" aria-live="polite">
					{step ?? ""}
				</span>
				{onHide === undefined ? null : (
					<IconButton variant="ghost" size="xs" label="Hide the browser" icon={<XIcon size="sm" />} onClick={onHide} />
				)}
			</header>
			{picker === undefined ? null : <div className="hb-browser-panel-picker">{picker}</div>}
			<div className="hb-browser-panel-body">{children}</div>
		</aside>
	);
}
