// Class strings the console's shell and screens share, as Tailwind utilities on @kantel/ui's tokens
// (packages/ui/docs/tailwind.md). The phone layout follows `narrow` (NARROW_QUERY, 640px and under), the same query
// that decides which pane shows, rather than a `max-sm:` variant, which stops at 639px.

/**
 * Before the shell can show: one message or the sign-in, centred on the canvas, with `kt-app` for the base. Its muted
 * colour is `!` because `.kt-app` sets the text colour too, unlayered, and would beat a plain utility on the element.
 */
export const BOOT = "kt-app grid h-full place-items-center text-muted!";

/** The main area with one thing in it, centred: an empty state, a spinner, an error. */
export const SHELL_EMPTY = "grid h-full place-items-center p-gutter-narrow";

type Shell = {
	/** A phone: one pane at a time, the list or the open session (with Back). */
	readonly narrow: boolean;
	/** The sidebar is a rail. */
	readonly collapsed: boolean;
	/** Which pane a phone shows. */
	readonly pane: "list" | "main";
};

/**
 * The shell: the sidebar (@kantel/ui's Sidebar), and the open session or page beside it, as wide as the window, in the
 * dynamic viewport height, so a phone's browser bars and keyboard never cover the composer.
 */
export function shellClasses({ narrow, collapsed, pane }: Shell) {
	const columns = collapsed
		? "grid-cols-[var(--kt-rail-width)_minmax(0,1fr)]"
		: narrow
			? "grid-cols-[minmax(0,1fr)]"
			: "grid-cols-[var(--kt-sidebar-width)_minmax(0,1fr)]";
	return {
		shell: `kt-app grid h-dvh ${columns}`,
		// On a phone the sidebar is the list page, on the canvas with no edge. `!` because the Sidebar's own CSS sets
		// its edge, background and display, unlayered, and would beat plain utilities.
		sidebar: `min-h-0 ${narrow ? "border-r-0! bg-canvas!" : ""} ${narrow && pane === "main" ? "hidden!" : ""}`,
		main: `min-w-0 min-h-0 ${narrow && pane === "list" ? "hidden" : ""}`,
		// Who the console acts as, at the foot of the sidebar, under the pages; centred on the rail.
		actor: `flex items-center gap-1.5 pt-2 pb-0 border-t border-border text-muted text-sm ${collapsed ? "justify-center px-0" : "px-2.5"}`,
	};
}

/**
 * A page outside projects (skills, memory, schedules, the vault, the audit log, API keys): one scrolling column across
 * the whole main area. Each page keeps its own reading measure where it has prose or a form.
 */
export const shellPage = (narrow: boolean) =>
	`box-border h-full overflow-y-auto ${narrow ? "p-gutter-narrow" : "p-gutter"}`;

/** Back to sessions, above a page on a phone: pulled up and out to the page's corner. */
export const SHELL_PAGE_BAR = "-mt-2.5 mr-0 mb-2.5 -ml-1.5";

/** A session's screen, or a new one's: the header, then the main area. */
export const CONSOLE = "flex flex-col h-full";

/**
 * The main area: the transcript, with a presented file's viewer or the browser beside it. A named container, so the
 * file's viewer goes over the transcript when the area, not the screen, is narrow (styles.css).
 */
export const CONSOLE_MAIN = "@container/console-main relative flex flex-1 min-h-0";

/** The transcript takes what is left and scrolls on its own. */
export const CONSOLE_TRANSCRIPT = "relative flex-[1_1_0] min-w-0 min-h-0";
