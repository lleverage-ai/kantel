import type { ToolImage, ToolItem } from "@harbour/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { ExternalLinkIcon, PlayIcon } from "../primitives/lucide.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { BrowserAddressBar, type BrowserPageInfo, BrowserTabs, BrowserWindow } from "./browser-window.tsx";
import { toolImageSrc } from "./tool-call.tsx";
import "./browser-live-view.css";

/**
 * Where a browser's view is:
 * - `connecting`: the host is getting a source; the last screenshot shows meanwhile.
 * - `live`: the source plays: the browser as it is now, or a replay of it.
 * - `ended`: the browser has closed; the last screenshot stays, said to be the last.
 * - `unavailable`: there is no view to have (no browser here, or no right to watch it): the last screenshot shows as
 *   it would without a live view, and nothing more is said.
 */
export type BrowserLiveStatus = "connecting" | "live" | "ended" | "unavailable";

/** One picture of the page, as a frames source sends it. */
export type BrowserFrame = ToolImage;

/** What a frames source tells the view: each new frame, and that the stream is over. */
export interface BrowserFrameSink {
	frame(frame: BrowserFrame): void;
	end(): void;
}

/**
 * What the view plays, whatever runs the browser. Two shapes, so the component never knows the provider:
 * - `embed`: a page that draws the browser itself, in a sandboxed iframe: a provider's watch-only share link today
 *   (brwsr's `/s/<token>`), or a browser runtime's own embed page. If the page posts `endMessage` to its parent when
 *   the stream is over, the view reports the end; it must never be able to take control.
 * - `frames`: pictures pushed to the view (a live screencast over the host's own socket, or a recording played back).
 *   `subscribe` starts the stream and returns how to stop it; the view stops it when it unmounts, so a source costs
 *   nothing while its view is off screen.
 *
 * `mode` says what the person is watching: `live` (the browser now, watch-only) or `replay` (a recording).
 */
export type BrowserLiveSource =
	| {
			readonly kind: "embed";
			readonly mode?: "live" | "replay";
			readonly url: string;
			/** The message the page posts to its parent once its stream is over. Without it, the view never ends itself. */
			readonly endMessage?: string;
	  }
	| {
			readonly kind: "frames";
			readonly mode?: "live" | "replay";
			subscribe(sink: BrowserFrameSink): () => void;
	  };

export type BrowserLiveViewProps = {
	status: BrowserLiveStatus;
	/** The newest tool call on the browser, whose label names the view for a screen reader. */
	item: ToolItem;
	/** What plays while `live`. */
	source?: BrowserLiveSource;
	/** The last screenshot of the browser, for every status but live, and a frames source's first picture. */
	screenshot?: ToolImage;
	/** The source said its stream is over (the browser went, or the link ran out). The host asks again, or ends. */
	onEnded?: () => void;
	/**
	 * The page the browser was on last, as the agent's calls said: its tab's title and the address bar's URL while the
	 * view draws neither itself (connecting, closed, before a replay plays). An embedded view's page draws its own.
	 */
	page?: BrowserPageInfo;
	/**
	 * The window's tabs, when the host has several browsers to pick between (`BrowserTabs`). Without them the window has
	 * one tab, this browser's page.
	 */
	tabs?: (end: ReactNode) => ReactNode;
};

/** Only a web page (or a story's inline page) goes in the iframe: never a `javascript:` URL. */
export function embeddable(url: string): boolean {
	try {
		return ["https:", "http:", "data:"].includes(resolved(url).protocol);
	} catch {
		return false;
	}
}

/** The link as an absolute URL: a relative one (Harbour's own view links, `/browser/<id>#<token>`) is this page's. */
function resolved(url: string): URL {
	return new URL(url, globalThis.location?.href ?? "http://localhost/");
}

function playable(source: BrowserLiveSource | undefined): source is BrowserLiveSource {
	return source !== undefined && (source.kind === "frames" || embeddable(source.url));
}

/** An embed source's page, sandboxed, reporting the end its page posts. Only this frame's own message counts. */
function EmbedFrame({
	url,
	endMessage,
	title,
	onEnded,
}: {
	url: string;
	endMessage: string | undefined;
	title: string;
	onEnded: () => void;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const ended = useRef(onEnded);
	ended.current = onEnded;
	useEffect(() => {
		if (endMessage === undefined) return;
		const origin = resolved(url).origin;
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
			if (event.data === endMessage) ended.current();
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [url, endMessage]);
	return (
		<iframe
			ref={frame}
			src={url}
			title={title}
			// The page draws the browser; the sandbox keeps it from navigating this one or opening windows.
			sandbox="allow-scripts allow-same-origin"
			referrerPolicy="no-referrer"
			loading="lazy"
		/>
	);
}

/** A replay's Play button, over the last screenshot: nothing loads (no recording is read) until a person asks for it. */
function ReplayPoster({ screenshot, onPlay }: { screenshot: ToolImage | undefined; onPlay: () => void }) {
	return (
		<>
			{screenshot === undefined ? null : (
				<img
					className="hb-browser-live-poster"
					src={toolImageSrc(screenshot)}
					alt="The last page the browser showed"
					decoding="async"
				/>
			)}
			<Button
				variant="primary"
				size="md"
				className="hb-browser-live-play"
				icon={<PlayIcon size="sm" />}
				onClick={onPlay}
			>
				Play the replay
			</Button>
		</>
	);
}

/** A frames source, drawn as the newest picture it sent (the last screenshot until the first arrives). */
function FramesView({
	source,
	first,
	alt,
	onEnded,
}: {
	source: Extract<BrowserLiveSource, { kind: "frames" }>;
	first: ToolImage | undefined;
	alt: string;
	onEnded: () => void;
}) {
	const [frame, setFrame] = useState<BrowserFrame | undefined>(first);
	const ended = useRef(onEnded);
	ended.current = onEnded;
	useEffect(
		() =>
			source.subscribe({
				frame: setFrame,
				end: () => ended.current(),
			}),
		[source],
	);
	return frame === undefined ? null : <img src={toolImageSrc(frame)} alt={alt} decoding="async" />;
}

/** The window's own tab, when the host gives it no tabs: this browser's page. */
function OneTab({ page, end, busy }: { page: BrowserPageInfo | undefined; end: ReactNode; busy: boolean }) {
	return <BrowserTabs label="The browser's tab" tabs={[{ id: "page", ...page, busy }]} active="page" end={end} />;
}

/**
 * A browser the agent is using, or used, drawn as a browser window: a tab per browser (the host's, or this one's), an
 * address bar with the page's URL, the page, and for a replay a player's controls. Provider-neutral: the host passes a
 * source (an embeddable page or a stream of frames, see `BrowserLiveSource`). An embedded page draws its own address
 * bar and controls inside the window (Harbour's view page does, following the page as it navigates); for everything
 * else (connecting, closed, a replay before it plays, frames) the window's address bar shows `page`, the last page the
 * agent's calls named. Watch-only: the view sends nothing to the browser. It costs the source's stream while it is on
 * screen, and nothing once it unmounts or the browser closes, when the last screenshot takes its place.
 */
export function BrowserLiveView({ status, item, source, screenshot, onEnded, page, tabs }: BrowserLiveViewProps) {
	const ended = () => onEnded?.();
	const [playing, setPlaying] = useState(false);
	const live = status === "live" && playable(source);
	const replay = live && source.mode === "replay";
	const title = `${replay ? "Replay" : "Live view"} of the browser: ${item.label}`;
	const strip = (end: ReactNode, busy = false) =>
		tabs === undefined ? <OneTab page={page} end={end} busy={busy} /> : tabs(end);
	const address = <BrowserAddressBar url={page?.url} placeholder="The address isn't known yet" />;

	if (status === "unavailable" || (status === "live" && !live)) {
		if (screenshot === undefined) return null;
		return (
			<figure className="hb-browser-live hb-browser-live-still">
				<BrowserWindow tabs={strip(null)} toolbar={address}>
					<div className="hb-browser-live-page">
						<img src={toolImageSrc(screenshot)} alt={`Screenshot after ${item.label}`} decoding="async" />
					</div>
				</BrowserWindow>
			</figure>
		);
	}
	if (status === "ended") {
		return (
			<figure className="hb-browser-live hb-browser-live-ended">
				<BrowserWindow
					tabs={strip(
						<span className="hb-browser-live-wait" role="status">
							Closed
						</span>,
					)}
					toolbar={address}
				>
					<div className="hb-browser-live-page">
						{screenshot === undefined ? null : (
							<img src={toolImageSrc(screenshot)} alt={`Screenshot after ${item.label}`} decoding="async" />
						)}
						<p className="hb-browser-live-caption">
							{screenshot === undefined
								? "The browser has closed."
								: "The browser has closed. This is the last page it showed."}
						</p>
					</div>
				</BrowserWindow>
			</figure>
		);
	}

	if (!live) {
		return (
			<figure className="hb-browser-live hb-browser-live-connecting" aria-busy="true">
				<BrowserWindow
					tabs={strip(
						<span className="hb-browser-live-wait" role="status">
							<Spinner size="sm" />
							Connecting to the live view
						</span>,
						true,
					)}
					toolbar={address}
				>
					<div className="hb-browser-live-page">
						{screenshot === undefined ? null : (
							<img src={toolImageSrc(screenshot)} alt={`Screenshot after ${item.label}`} decoding="async" />
						)}
					</div>
				</BrowserWindow>
			</figure>
		);
	}

	const embedded = source.kind === "embed" && (!replay || playing);
	const end = (
		<>
			{replay ? <StatusLabel status="idle">Replay</StatusLabel> : <StatusLabel status="working">Live</StatusLabel>}
			<span className="hb-browser-live-note">Watch only</span>
			{source.kind === "embed" ? (
				<a
					className="hb-browser-live-open hb-focusable"
					href={source.url}
					target="_blank"
					rel="noopener noreferrer"
					title="Open in a new tab"
				>
					<ExternalLinkIcon size="sm" />
					<span className="hb-sr-only">Open in a new tab</span>
				</a>
			) : null}
		</>
	);
	return (
		<figure className={`hb-browser-live hb-browser-live-${replay ? "replay" : "live"}`}>
			<BrowserWindow
				tabs={strip(end)}
				// An embedded page draws its own address bar and controls, following the page as it moves.
				{...(embedded ? {} : { toolbar: address })}
			>
				<div
					className={`hb-browser-live-page${embedded ? ` hb-browser-live-embed${replay ? " hb-browser-live-embed-replay" : ""}` : ""}`}
				>
					{source.kind === "frames" ? (
						<FramesView source={source} first={screenshot} alt={title} onEnded={ended} />
					) : embedded ? (
						<EmbedFrame url={source.url} endMessage={source.endMessage} title={title} onEnded={ended} />
					) : (
						<ReplayPoster screenshot={screenshot} onPlay={() => setPlaying(true)} />
					)}
				</div>
			</BrowserWindow>
		</figure>
	);
}
