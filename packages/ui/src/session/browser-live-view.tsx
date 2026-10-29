import type { ToolImage, ToolItem } from "@harbour/protocol";
import { useEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { ToolImages, toolImageSrc } from "./tool-call.tsx";
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

/**
 * A replay's page, behind *Play* over the last screenshot: nothing loads (no recording is read) until a person asks
 * for it.
 */
function ReplayFrame({
	url,
	endMessage,
	title,
	screenshot,
	onEnded,
}: {
	url: string;
	endMessage: string | undefined;
	title: string;
	screenshot: ToolImage | undefined;
	onEnded: () => void;
}) {
	const [playing, setPlaying] = useState(false);
	if (playing) return <EmbedFrame url={url} endMessage={endMessage} title={title} onEnded={onEnded} />;
	return (
		<>
			{screenshot === undefined ? null : (
				<img src={toolImageSrc(screenshot)} alt="The last page the browser showed" decoding="async" />
			)}
			<Button variant="primary" size="md" className="hb-browser-live-play" onClick={() => setPlaying(true)}>
				Play
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

/**
 * A browser the agent is using, inline in the transcript under the newest call on it: a person watches the page move
 * as the agent works, or plays it back, without opening anything. Provider-neutral: the host passes a source (an
 * embeddable page or a stream of frames, see `BrowserLiveSource`). Watch-only: the view sends nothing to the browser.
 * It costs the source's stream while it is on screen, and nothing once it scrolls away (the transcript unmounts it)
 * or the browser closes, when the last screenshot takes its place.
 */
export function BrowserLiveView({ status, item, source, screenshot, onEnded }: BrowserLiveViewProps) {
	const ended = () => onEnded?.();
	const live = status === "live" && playable(source);
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
	const replay = source?.mode === "replay";
	const title = `${replay ? "Replay" : "Live view"} of the browser: ${item.label}`;
	return (
		<figure
			className={`hb-browser-live hb-browser-live-${live && replay ? "replay" : status}`}
			aria-busy={live ? undefined : true}
		>
			<figcaption className="hb-browser-live-caption">
				{live ? (
					<>
						{replay ? (
							<StatusLabel status="idle">Replay</StatusLabel>
						) : (
							<StatusLabel status="working">Live</StatusLabel>
						)}
						<span className="hb-browser-live-note">Watch only</span>
						{source.kind === "embed" ? (
							<a
								className="hb-browser-live-open hb-focusable"
								href={source.url}
								target="_blank"
								rel="noopener noreferrer"
							>
								Open in a new tab
							</a>
						) : null}
					</>
				) : (
					<span className="hb-browser-live-wait" role="status">
						<Spinner size="sm" />
						Connecting to the live view
					</span>
				)}
			</figcaption>
			<div
				className={`hb-browser-live-frame${live && replay && source.kind === "embed" ? " hb-browser-live-frame-replay" : ""}`}
			>
				{!live ? (
					screenshot === undefined ? null : (
						<img src={toolImageSrc(screenshot)} alt={`Screenshot after ${item.label}`} decoding="async" />
					)
				) : source.kind === "embed" && replay ? (
					<ReplayFrame
						url={source.url}
						endMessage={source.endMessage}
						title={title}
						screenshot={screenshot}
						onEnded={ended}
					/>
				) : source.kind === "embed" ? (
					<EmbedFrame url={source.url} endMessage={source.endMessage} title={title} onEnded={ended} />
				) : (
					<FramesView source={source} first={screenshot} alt={title} onEnded={ended} />
				)}
			</div>
		</figure>
	);
}
