import type { ToolImage, ToolItem } from "@harbour/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { ExternalLinkIcon, PlayIcon } from "../primitives/lucide.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { BrowserAddressBar, type BrowserPageInfo, BrowserTabs, BrowserWindow } from "./browser-window.tsx";
import { retryToolImage, toolImageSrc } from "./tool-call.tsx";
import "./browser-live-view.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css). browser-live-view.css keeps only the 30rem container query
// that hides "Watch only" in a narrow view (no utility for that size), on hb-browser-live-note. hb-browser-live stays
// for browsing-group.css, browser-panel.tsx and the console's browser demo, hb-browser-live-<state> and -poster for
// the demo and tests; the other hb- classes are names only. The view's classes are exported for the window's stories.
//
// The page keeps the browser's own shape (Harbour's browsers start at 1280 by 800, 10 / 16) at the view's width. An
// embedded view page draws its own address bar (a toolbar: a small control, twice the toolbar's 6px padding and its
// hairline), and a replay its controls too (a small control, twice the player's 4px padding and its hairline), inside
// the window: the page's box is that much taller, so the page itself keeps its shape.

/**
 * A browser's view, a container for its page's width (`100cqi`): in the session's browser panel (which takes its
 * margin away), or in the transcript under the newest call on it, in line with the call's label as its screenshots
 * are, or 16px in under a collapsible group of calls (tool-call.tsx's `.hb-tool-group-collapsible`).
 */
export const browserLive =
	"hb-browser-live mt-1 mr-0 mb-2 ml-[calc(var(--hb-icon-md)+var(--hb-step-2))] min-w-0 [container-type:inline-size] [.hb-tool-group-collapsible>&]:ml-4";
/** The page's box, without its height; its picture or embedded page fills it. */
const pageBox =
	"hb-browser-live-page relative w-full overflow-hidden [&>iframe]:block [&>iframe]:size-full [&>iframe]:border-0 [&>img]:block [&>img]:size-full [&>img]:border-0 [&>img]:object-contain";
/** The page's box at the browser's shape: the view's width by 10 / 16 of it. */
export const browserLivePage = `${pageBox} h-[calc(100cqi*10/16)]`;
/** An embedded page's box: the browser's shape, and its own address bar. */
const embedPage = `${pageBox} h-[calc(100cqi*10/16+var(--hb-control-sm)+var(--hb-step-3)+var(--hb-hairline))]`;
/** An embedded replay's box: the browser's shape, its own address bar and its player's controls. */
const embedReplayPage = `${pageBox} h-[calc(100cqi*10/16+var(--hb-control-sm)*2+var(--hb-step-3)+var(--hb-step-2)+var(--hb-hairline)*2)]`;
/** Connecting and closed: the last screenshot, dimmed. */
const dimmedPage = `${browserLivePage} [&>img]:opacity-55`;
/** Filling: the page takes the height the window has, its picture at its own shape inside. */
const fillPage = `${pageBox} min-h-0 flex-1`;
/** Filling: the view and its window take the height the host gives them, never less than a small page. */
const fillView = "flex min-h-40 flex-1 flex-col";
const fillWindow = "min-h-0 flex-1";
/** "Watch only", beside the view's status in the tab strip. browser-live-view.css hides it in a narrow view. */
export const browserLiveNote = "hb-browser-live-note whitespace-nowrap text-faint";
/** A status in the tab strip with its spinner: "Connecting to the live view", "Closed". */
const wait = "hb-browser-live-wait inline-flex items-center gap-1.5 whitespace-nowrap";
/** Open in a new tab: an icon a whole control high, so it is a touch target of its own. */
const openLink =
	"hb-browser-live-open hb-focusable inline-grid size-control-xs place-items-center rounded-sm text-muted transition-[background-color,color] duration-(--hb-duration-fast) hover:bg-hover hover:text-fg";

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

/** The view's boxes, at the browser's shape or filling the host (`fill`). */
function boxes(fill: boolean) {
	return fill
		? {
				view: `${browserLive} ${fillView}`,
				window: fillWindow,
				page: fillPage,
				dimmed: `${fillPage} [&>img]:opacity-55`,
				embed: fillPage,
				embedReplay: fillPage,
			}
		: {
				view: browserLive,
				window: undefined,
				page: browserLivePage,
				dimmed: dimmedPage,
				embed: embedPage,
				embedReplay: embedReplayPage,
			};
}

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
	/**
	 * Fill the height the host gives the view (the session's browser panel), the page at its own shape inside it, rather
	 * than taking the page's shape at the view's width.
	 */
	fill?: boolean;
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

/** The screenshot after a step, asked for again while one by reference isn't stored yet. */
function Shot({ screenshot, label }: { screenshot: ToolImage; label: string }) {
	return (
		<img src={toolImageSrc(screenshot)} alt={`Screenshot after ${label}`} decoding="async" onError={retryToolImage} />
	);
}

/** A replay's Play button, over the last screenshot: nothing loads (no recording is read) until a person asks for it. */
function ReplayPoster({ screenshot, onPlay }: { screenshot: ToolImage | undefined; onPlay: () => void }) {
	return (
		<>
			{screenshot === undefined ? null : (
				<img
					className="hb-browser-live-poster opacity-55"
					src={toolImageSrc(screenshot)}
					alt="The last page the browser showed"
					decoding="async"
					onError={retryToolImage}
				/>
			)}
			<Button
				variant="primary"
				size="md"
				className="hb-browser-live-play absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
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
export function BrowserLiveView({
	status,
	item,
	source,
	screenshot,
	onEnded,
	page,
	tabs,
	fill = false,
}: BrowserLiveViewProps) {
	const ended = () => onEnded?.();
	const box = boxes(fill);
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
			<figure className={`${box.view} hb-browser-live-still`}>
				<BrowserWindow className={box.window} tabs={strip(null)} toolbar={address}>
					<div className={box.page}>
						<Shot screenshot={screenshot} label={item.label} />
					</div>
				</BrowserWindow>
			</figure>
		);
	}
	if (status === "ended") {
		return (
			<figure className={`${box.view} hb-browser-live-ended`}>
				<BrowserWindow
					className={box.window}
					tabs={strip(
						<span className={wait} role="status">
							Closed
						</span>,
					)}
					toolbar={address}
				>
					<div className={box.dimmed}>
						{screenshot === undefined ? null : <Shot screenshot={screenshot} label={item.label} />}
						<p className="hb-browser-live-caption absolute inset-x-2 top-auto bottom-2 m-0 text-center text-xs leading-tight text-muted">
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
			<figure className={`${box.view} hb-browser-live-connecting`} aria-busy="true">
				<BrowserWindow
					className={box.window}
					tabs={strip(
						<span className={wait} role="status">
							<Spinner size="sm" />
							Connecting to the live view
						</span>,
						true,
					)}
					toolbar={address}
				>
					<div className={box.dimmed}>
						{screenshot === undefined ? null : <Shot screenshot={screenshot} label={item.label} />}
					</div>
				</BrowserWindow>
			</figure>
		);
	}

	const embedded = source.kind === "embed" && (!replay || playing);
	const end = (
		<>
			{replay ? <StatusLabel status="idle">Replay</StatusLabel> : <StatusLabel status="working">Live</StatusLabel>}
			<span className={browserLiveNote}>Watch only</span>
			{source.kind === "embed" ? (
				<a className={openLink} href={source.url} target="_blank" rel="noopener noreferrer" title="Open in a new tab">
					<ExternalLinkIcon size="sm" />
					<span className="hb-sr-only">Open in a new tab</span>
				</a>
			) : null}
		</>
	);
	return (
		<figure className={`${box.view} hb-browser-live-${replay ? "replay" : "live"}`}>
			<BrowserWindow
				className={box.window}
				tabs={strip(end)}
				// An embedded page draws its own address bar and controls, following the page as it moves.
				{...(embedded ? {} : { toolbar: address })}
			>
				<div
					className={
						embedded
							? replay
								? `${box.embedReplay} hb-browser-live-embed hb-browser-live-embed-replay`
								: `${box.embed} hb-browser-live-embed`
							: box.page
					}
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
