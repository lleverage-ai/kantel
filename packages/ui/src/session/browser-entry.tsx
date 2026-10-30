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

/** Where the browser is, as far as the host knows: live now, closed with a replay, closed with none, or unknown. */
export type BrowserEntryState = "live" | "replay" | "ended" | "unknown";

export type BrowserEntryProps = {
	page: BrowserPageInfo | undefined;
	screenshot?: ToolImage;
	state: BrowserEntryState;
	/** The host's panel shows this browser now: the card says so, and does nothing. */
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
			className={`hb-browser-entry hb-focusable${shown ? " hb-browser-entry-shown" : ""}`}
			aria-pressed={shown}
			aria-label={`${action}: ${title}`}
			onClick={onShow}
		>
			<span className="hb-browser-entry-thumb" aria-hidden="true">
				{screenshot === undefined ? (
					<PageIcon url={page?.url} />
				) : (
					<img src={toolImageSrc(screenshot)} alt="" decoding="async" loading="lazy" />
				)}
				{state === "replay" ? (
					<span className="hb-browser-entry-play">
						<PlayIcon size="sm" />
					</span>
				) : null}
			</span>
			<span className="hb-browser-entry-text">
				<span className="hb-browser-entry-title">{title}</span>
				<span className="hb-browser-entry-url">{page?.url ?? host ?? "No page yet"}</span>
			</span>
			<span className="hb-browser-entry-side">
				{state === "live" ? (
					<StatusLabel status="working">Live</StatusLabel>
				) : state === "replay" ? (
					<StatusLabel status="idle">Replay</StatusLabel>
				) : state === "ended" ? (
					<StatusLabel status="idle">Closed</StatusLabel>
				) : null}
				<span className="hb-browser-entry-action">{shown ? "Showing" : action}</span>
			</span>
		</button>
	);
}
