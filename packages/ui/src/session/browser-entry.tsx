import type { ToolImage } from "@harbour/protocol";
import { PlayIcon } from "../primitives/lucide.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { type BrowserPageInfo, PageIcon, pageHost, pageLabel } from "./browser-window.tsx";
import { toolImageSrc } from "./tool-call.tsx";
import "./browser-entry.css";

// A browser in the session's timeline: a small card under a browsing run with the page it was on (its title and
// address), the last screenshot it left as a thumbnail when there is one, and whether it is live or has a replay. The
// whole card is one button that shows the browser in the host's one place for it (a panel). It never grows while the
// agent works, so the transcript stays still.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css). The hb- classes carry no style of their own except
// hb-browser-entry and hb-browser-entry-action, the hooks for browser-entry.css's 30rem breakpoint, which the theme
// has no utility for; the rest stay as names for tests and stories.

/**
 * The card: one button, a thumbnail, the title over the address and the state on the right, at most a card wide and
 * in line with a tool row's label. Its border lifts on hover.
 */
const card =
	"hb-browser-entry hb-focusable group/entry mt-0.5 mr-0 mb-1 ml-4 flex w-full max-w-card min-w-0 items-center gap-2 rounded-panel border bg-raised py-1 pr-2 pl-1 text-left text-sm leading-tight text-fg [font-family:inherit] [font-feature-settings:inherit] transition-[background-color,border-color] duration-(--hb-duration-fast) hover:border-border-strong hover:bg-hover";
/** The page at the browser's shape (16 by 10), from the top, as the browser shows it. */
const thumb =
	"hb-browser-entry-thumb relative grid w-24 flex-none place-items-center overflow-hidden rounded-sm border border-border bg-sunken aspect-[16/10]";
/** A replay's play mark, a scrim circle over the thumbnail. */
const play =
	"hb-browser-entry-play absolute grid size-control-xs place-items-center rounded-full bg-thumb-scrim text-on-solid";
/** Whether it is live, over what a click does, on the right. */
const side = "hb-browser-entry-side flex flex-none flex-col items-end gap-1 text-xs text-muted";

/** Where the browser is, as far as the host knows: live now, closed with a replay, closed with none, or unknown. */
export type BrowserEntryState = "live" | "replay" | "ended" | "unknown";

export type BrowserEntryProps = {
	page: BrowserPageInfo | undefined;
	screenshot?: ToolImage;
	state: BrowserEntryState;
	/** The host's panel shows this browser now: the card says it is "In panel", and does nothing. */
	shown?: boolean;
	onShow: () => void;
};

const ACTION: Record<BrowserEntryState, string> = {
	live: "Watch live",
	replay: "Watch the replay",
	ended: "Show the last page",
	unknown: "Show the browser",
};

export function BrowserEntry({ page, screenshot, state, shown = false, onShow }: BrowserEntryProps) {
	const title = page === undefined ? "Browser" : pageLabel(page);
	const host = pageHost(page?.url);
	const action = ACTION[state];
	return (
		<button
			type="button"
			className={`${card} ${shown ? "hb-browser-entry-shown cursor-default border-border-strong" : "cursor-pointer border-border"}`}
			aria-pressed={shown}
			aria-label={`${action}: ${title}`}
			onClick={onShow}
		>
			<span className={thumb} aria-hidden="true">
				{screenshot === undefined ? (
					<PageIcon url={page?.url} />
				) : (
					<img
						className="size-full object-cover object-top"
						src={toolImageSrc(screenshot)}
						alt=""
						decoding="async"
						loading="lazy"
					/>
				)}
				{state === "replay" ? (
					<span className={play}>
						<PlayIcon size="sm" />
					</span>
				) : null}
			</span>
			<span className="hb-browser-entry-text flex min-w-0 flex-1 flex-col gap-1">
				<span className="hb-browser-entry-title truncate font-medium">{title}</span>
				<span className="hb-browser-entry-url truncate text-xs text-faint">{page?.url ?? host ?? "No page yet"}</span>
			</span>
			<span className={side}>
				{state === "live" ? (
					<StatusLabel status="working">Live</StatusLabel>
				) : state === "replay" ? (
					<StatusLabel status="idle">Replay</StatusLabel>
				) : state === "ended" ? (
					<StatusLabel status="idle">Closed</StatusLabel>
				) : null}
				<span className="hb-browser-entry-action whitespace-nowrap text-muted group-hover/entry:text-fg">
					{shown ? "In panel" : action}
				</span>
			</span>
		</button>
	);
}
