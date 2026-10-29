import type { ToolImage, ToolItem } from "@harbour/protocol";
import { useEffect, useRef } from "react";
import { Spinner } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { ToolImages, toolImageSrc } from "./tool-call.tsx";
import "./browser-live-view.css";

/**
 * Where a browser's live view is:
 * - `connecting`: the host is asking for a link; the last screenshot shows meanwhile.
 * - `live`: the browser, as it is now, in a watch-only frame.
 * - `ended`: the browser has closed; the last screenshot stays, said to be the last.
 * - `unavailable`: there is no live view to have (no browser here, or no right to watch it): the last screenshot
 *   shows as it would without a live view, and nothing more is said.
 */
export type BrowserLiveStatus = "connecting" | "live" | "ended" | "unavailable";

/** The message brwsr's live page posts to its parent once the browser it shows has gone, or its link has run out. */
export const BROWSER_DISCONNECTED_MESSAGE = "browserbase-disconnected";

export type BrowserLiveViewProps = {
	status: BrowserLiveStatus;
	/** The newest tool call on the browser, whose label names the frame for a screen reader. */
	item: ToolItem;
	/** The watch-only link the frame shows while live: a brwsr share link, never one that can take control. */
	url?: string;
	/** The last screenshot of the browser, for every status but live. */
	screenshot?: ToolImage;
	/** The frame said the browser has gone (or the link ran out). The host asks again, or settles on `ended`. */
	onDisconnected?: () => void;
};

/** The link as the frame loads it: without brwsr's address bar, which a watch-only viewer has no use for. */
export function liveFrameSrc(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return url;
		parsed.searchParams.set("navbar", "false");
		return parsed.toString();
	} catch {
		return url;
	}
}

/** Only a web page (or a story's inline page) goes in the frame: never a `javascript:` URL. */
function frameable(url: string): boolean {
	try {
		return ["https:", "http:", "data:"].includes(new URL(url).protocol);
	} catch {
		return false;
	}
}

/**
 * A browser the agent is using, live, inline in the transcript under the newest call on it: a person watches the
 * page move as the agent works, without opening anything. The frame is watch-only (the link can't take control) and
 * sandboxed; it costs a WebSocket of JPEG frames while it is on screen, and nothing once it scrolls away (the
 * transcript unmounts it) or the browser closes, when the last screenshot takes its place.
 */
export function BrowserLiveView({ status, item, url, screenshot, onDisconnected }: BrowserLiveViewProps) {
	const frame = useRef<HTMLIFrameElement>(null);
	const disconnected = useRef(onDisconnected);
	disconnected.current = onDisconnected;
	const liveUrl = status === "live" && url !== undefined && frameable(url) ? url : undefined;
	const live = liveUrl !== undefined;

	// brwsr's page tells its parent when the browser has gone. Only this frame's own message counts.
	useEffect(() => {
		if (liveUrl === undefined) return;
		const origin = new URL(liveUrl).origin;
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
			if (event.data === BROWSER_DISCONNECTED_MESSAGE) disconnected.current?.();
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [liveUrl]);

	if (status === "unavailable" || (status === "live" && !live)) {
		return screenshot === undefined ? null : <ToolImages item={item} images={[screenshot]} />;
	}
	if (status === "ended") {
		return (
			<div className="hb-browser-live hb-browser-live-ended">
				<p className="hb-browser-live-caption">
					{screenshot === undefined
						? "The browser has closed."
						: "The browser has closed. This is the last page it showed."}
				</p>
				{screenshot === undefined ? null : <ToolImages item={item} images={[screenshot]} />}
			</div>
		);
	}
	return (
		<figure className={`hb-browser-live hb-browser-live-${status}`} aria-busy={live ? undefined : true}>
			<figcaption className="hb-browser-live-caption">
				{liveUrl !== undefined ? (
					<>
						<StatusLabel status="working">Live</StatusLabel>
						<span className="hb-browser-live-note">Watch only</span>
						<a className="hb-browser-live-open hb-focusable" href={liveUrl} target="_blank" rel="noopener noreferrer">
							Open in a new tab
						</a>
					</>
				) : (
					<span className="hb-browser-live-wait" role="status">
						<Spinner size="sm" />
						Connecting to the live view
					</span>
				)}
			</figcaption>
			<div className="hb-browser-live-frame">
				{liveUrl !== undefined ? (
					<iframe
						ref={frame}
						src={liveFrameSrc(liveUrl)}
						title={`Live view of the browser: ${item.label}`}
						// Watch-only already; the sandbox keeps the page from navigating this one or opening windows.
						sandbox="allow-scripts allow-same-origin"
						referrerPolicy="no-referrer"
						loading="lazy"
					/>
				) : screenshot === undefined ? null : (
					<img src={toolImageSrc(screenshot)} alt={`Screenshot after ${item.label}`} decoding="async" />
				)}
			</div>
		</figure>
	);
}
