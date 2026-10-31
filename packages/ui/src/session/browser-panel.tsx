import type { ReactNode } from "react";
import { IconButton } from "../primitives/button.tsx";
import { GlobeIcon, XIcon } from "../primitives/icons.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import "./browser-panel.css";

// The session's browser in one place, beside the transcript: the agent works in one browser, so a person watches one
// view of it, which stays put however many steps the agent takes. The view (usually a `BrowserLiveView`) is mounted
// once and never moves, so its live page is never reloaded between steps; once the browser closes, the same place
// plays its replay. The transcript keeps only a line per browsing run ("Browsing", `BrowsingGroup`).
//
// Styled with Tailwind utilities (src/tokens/tailwind.css). browser-panel.css keeps only the entrance (keyframes) on
// kt-browser-panel. kt-browser-panel-body stays for apps/console's styles.css, which sizes it on a narrow screen; the
// other kt- classes are names only.

/**
 * The panel: a one-line header, then the view at the panel's width. It fills the height the host gives it and
 * scrolls only if its content is taller.
 */
const panel = "kt-browser-panel flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto bg-canvas px-3 pt-2 pb-3";
/** The header: icon, "Browser", and the current step, muted. */
const head =
	"kt-browser-panel-head flex min-h-control-sm min-w-0 items-center gap-1.5 text-sm leading-tight text-muted";
/**
 * The view's box. In the panel the view starts at its edge, not in line with a tool row's label as it does in the
 * transcript: the live view's margin goes, and so does the screenshots' (`!`: tool-call.css's unlayered
 * `.kt-tool-images` margin beats a utility).
 */
const body = "kt-browser-panel-body flex min-w-0 flex-col [&>.kt-browser-live]:m-0 [&>.kt-tool-images]:m-0!";

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
	/** The view takes the panel's whole height (a `BrowserLiveView` with `fill`, or a `BrowserTimeline`). */
	fill?: boolean;
	className?: string;
};

/** A panel with the session's browser: a header saying what the agent is doing in it, then the view. */
export function BrowserPanel({
	step,
	running = false,
	onHide,
	picker,
	children,
	fill = false,
	className,
}: BrowserPanelProps) {
	return (
		<aside className={`${panel}${className ? ` ${className}` : ""}`} aria-label="Browser">
			<header className={head}>
				<span className="kt-browser-panel-icon inline-flex flex-none items-center text-faint">
					{running ? <Spinner size="sm" /> : <GlobeIcon size="sm" />}
				</span>
				<span className="kt-browser-panel-title flex-none font-medium text-fg">Browser</span>
				{/* Polite: a screen reader hears each step once, without being interrupted. It gives way first when the
				    panel is narrow. */}
				<span className="kt-browser-panel-step min-w-0 flex-1 truncate text-faint" aria-live="polite">
					{step ?? ""}
				</span>
				{onHide === undefined ? null : (
					<IconButton variant="ghost" size="xs" label="Hide the browser" icon={<XIcon size="sm" />} onClick={onHide} />
				)}
			</header>
			{picker === undefined ? null : <div className="kt-browser-panel-picker flex flex-wrap gap-1">{picker}</div>}
			<div className={fill ? `${body} min-h-0 flex-1` : body}>{children}</div>
		</aside>
	);
}
