import { BrowserAddressBar, type BrowserTabItem, BrowserTabs, PlayerControls, Spinner, StatusLabel } from "@harbour/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { frameAt, framePainter, type ReplayFrame, readFrames } from "./mkv.ts";

// The page a view link opens (`/browser/<browser>#<token>`): one of Harbour's own browsers, live or replayed, for
// whoever holds the link and nothing more. It needs no sign-in (the token is its auth), so the console's iframe and an
// outside app's embed show the same page. It reads only `/v1/browser/view/<browser>/…`
// (packages/browser/src/runtime/views.ts), sending the token as `Authorization: Bearer`, or for the live socket as its
// subprotocol. The token is in the link's fragment, so it is never in a URL a server sees or logs.
//
// - Live: the browser's frames on a canvas over a WebSocket, as brwsr's live page draws them (tvdavies/brwsr@0d22bf8,
//   web/live.js): each binary message is 8 bytes of timestamp then a JPEG, acknowledged as it comes so the browser keeps
//   sending, and the canvas's size goes up so frames are no bigger than shown. A watch-only link sends nothing else.
// - Replay: the recording's manifest, then its chunks (JPEG frames in Matroska, `mkv.ts`) as playing reaches them, each
//   frame drawn at its time. Pages (tabs) play one after another, on one timeline from the browser's start.
//
// Both are drawn as a browser window's inside: an address bar with the page's URL over the page, and a replay's
// controls under it. Live, the URL (and each tab's title) comes from the live socket's `targets` messages, sent as the
// browser's pages navigate. In a replay it comes from the navigations the recording kept with each page
// (`RecordingPage.navigations`), so the bar follows the page as the replay plays. Tabs show when the browser has more
// than one page, or when the page is opened on its own rather than inside the console's window, which draws its own.
//
// When the browser has gone or the link has run out, it tells its parent: the end message Harbour's view links carry
// (`HARBOUR_VIEW_END_MESSAGE` in @harbour/browser's runtime), brwsr's own `browserbase-disconnected`, which the
// console's `BrowserLiveView` already listens for. The message says nothing else, so any parent may hear it.

export const VIEW_API = "/v1/browser/view/";
export const VIEW_END_MESSAGE = "browserbase-disconnected";
const VIEW_PROTOCOL = "harbour-view.v1";
const VIEW_TOKEN_PROTOCOL = "harbour-view-token.";

/** Which browser a link shows, and the token that lets it. */
export type View = { readonly browser: string; readonly token: string };

const viewUrl = (view: View, rest = "") => `${VIEW_API}${encodeURIComponent(view.browser)}${rest}`;
const viewFetch = (view: View, rest: string, init: RequestInit = {}) =>
	fetch(viewUrl(view, rest), {
		...init,
		referrerPolicy: "no-referrer",
		headers: { authorization: `Bearer ${view.token}` },
	});

type ViewInfo = {
	readonly mode: "live" | "replay";
	readonly control: boolean;
	readonly expiresAt: number;
	readonly status: string;
};

type Manifest = {
	readonly status: "recording" | "complete" | "none";
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly pages: readonly {
		readonly pageId: string;
		readonly startMs: number;
		readonly durationMs: number;
		readonly width: number;
		readonly height: number;
		readonly chunks: readonly { readonly index: number; readonly startMs: number; readonly durationMs: number }[];
		/** Where the page went, by its own clock: kept by recordings since the browser image recorded them. */
		readonly navigations?: readonly Navigation[];
	}[];
};

/** The page went to `url` (and its title became `title`) `atMs` into its recording. */
export type Navigation = { readonly atMs: number; readonly url: string; readonly title?: string };

/** A page target as the live socket's `targets` message names it. */
type LiveTarget = { readonly id: string; readonly url?: string; readonly title?: string };

/** The page's address and title at a point on its own clock: its last navigation at or before it. */
export function pageAt(navigations: readonly Navigation[] | undefined, pageMs: number): Navigation | undefined {
	let found: Navigation | undefined;
	for (const navigation of navigations ?? []) {
		if (navigation.atMs > pageMs) break;
		found = navigation;
	}
	return found ?? navigations?.[0];
}

/** The live socket's page targets, from a `targets` message: `undefined` for any other message. */
export function liveTargets(
	message: unknown,
): { readonly active: string | undefined; readonly targets: readonly LiveTarget[] } | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const { type, active, targets } = message as { type?: unknown; active?: unknown; targets?: unknown };
	if (type !== "targets" || !Array.isArray(targets)) return undefined;
	const out: LiveTarget[] = [];
	for (const target of targets) {
		const { id, url, title } = (target ?? {}) as { id?: unknown; url?: unknown; title?: unknown };
		if (typeof id !== "string") continue;
		out.push({
			id,
			...(typeof url === "string" ? { url } : {}),
			...(typeof title === "string" ? { title } : {}),
		});
	}
	return { active: typeof active === "string" ? active : undefined, targets: out };
}

/** The page is on its own (a new tab, a link), not inside another page's window: it draws its own tabs. */
const topLevel = () => {
	try {
		return window.parent === window;
	} catch {
		return false;
	}
};

/** The view in `/browser/<browser>#<token>`, or `undefined` on any other page. */
export function viewOf(pathname: string, hash: string): View | undefined {
	const browser = pathname.match(/^\/browser\/([A-Za-z0-9-]{1,64})\/?$/)?.[1];
	const token = hash.match(/^#([A-Za-z0-9_.-]{10,1024})$/)?.[1];
	return browser === undefined || token === undefined ? undefined : { browser, token };
}

function tellParent() {
	try {
		if (window.parent !== window) window.parent.postMessage(VIEW_END_MESSAGE, "*");
	} catch {}
}

// The page fills the window: a browser window's inside (an iframe, usually), the address bar (and tabs), the page, and a
// replay's controls under it. Its background, size and height are `!` because `hb-app` on the same element sets them
// too, unlayered, and would beat plain utilities.
const PAGE = "hb-viewer hb-app flex flex-col box-border h-dvh m-0 bg-sunken! text-sm! min-h-0!";
const WAIT = "hb-viewer-wait flex flex-1 items-center justify-center gap-1.5 text-muted";
const PANE = "flex flex-1 flex-col min-h-0";
const STAGE = "hb-viewer-stage relative flex flex-1 items-center justify-center min-h-0 overflow-hidden bg-sunken";
// The page at its own shape, as large as fits.
const CANVAS = "hb-viewer-canvas max-w-full max-h-full object-contain";
const OVERLAY = "hb-viewer-overlay absolute inset-0 flex items-center justify-center gap-1.5 bg-canvas text-muted";

function Ended({ title, detail }: { title: string; detail: string }) {
	return (
		<div
			className="hb-viewer-ended flex flex-1 flex-col items-center justify-center gap-1 p-3 text-muted text-center"
			role="status"
		>
			<strong className="text-fg font-strong">{title}</strong>
			<span>{detail}</span>
		</div>
	);
}

export function BrowserViewerPage({ view }: { view: View }) {
	const [info, setInfo] = useState<ViewInfo | "expired" | "failed" | undefined>();
	useEffect(() => {
		const abort = new AbortController();
		viewFetch(view, "", { cache: "no-store", signal: abort.signal })
			.then(async (response) => {
				if (response.status === 401) return setInfo("expired");
				if (!response.ok) return setInfo("failed");
				setInfo((await response.json()) as ViewInfo);
			})
			.catch(() => {
				if (!abort.signal.aborted) setInfo("failed");
			});
		return () => abort.abort();
	}, [view]);
	useEffect(() => {
		document.title =
			info !== undefined && typeof info === "object" && info.mode === "replay"
				? "Replay - Harbour"
				: "Live browser - Harbour";
	}, [info]);
	useEffect(() => {
		if (info === "expired") tellParent();
	}, [info]);

	if (info === undefined) {
		return (
			<main className={`${PAGE} ${WAIT} text-muted!`}>
				<Spinner size="sm" /> Opening the browser
			</main>
		);
	}
	if (info === "expired") {
		return (
			<main className={PAGE}>
				<Ended title="This link has expired" detail="Ask for a new one where you found it." />
			</main>
		);
	}
	if (info === "failed") {
		return (
			<main className={PAGE}>
				<Ended title="Harbour didn't answer" detail="Check your connection and reload the page." />
			</main>
		);
	}
	return (
		<main className={PAGE}>{info.mode === "live" ? <LiveView view={view} info={info} /> : <Replay view={view} />}</main>
	);
}

/**
 * The window's top: tabs, when there are several pages or the page is on its own, then the address bar. `status` goes
 * at the tabs' end, or the bar's when there are no tabs.
 */
function Chrome({
	tabs,
	active,
	url,
	status,
	onSelect,
}: {
	tabs: readonly BrowserTabItem[];
	active: string | undefined;
	url: string | undefined;
	status: ReactNode;
	onSelect?: (id: string) => void;
}) {
	// Inside the console's window, which says whether it is live and draws the session's tabs, only the page's own.
	const own = topLevel();
	const showTabs = tabs.length > 1 || own;
	return (
		<div className="hb-viewer-chrome flex flex-none flex-col min-w-0">
			{showTabs ? (
				<BrowserTabs
					label="The browser's tabs"
					tabs={tabs.length === 0 ? [{ id: "page" }] : tabs}
					active={tabs.length === 0 ? "page" : active}
					{...(own ? { end: status } : {})}
					{...(onSelect === undefined ? {} : { onSelect })}
				/>
			) : null}
			<BrowserAddressBar url={url} placeholder="No page yet" />
		</div>
	);
}

function LiveView({ view, info }: { view: View; info: ViewInfo }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"connecting" | "live" | "ended" | "expired">(
		info.status === "running" ? "connecting" : "ended",
	);
	// The browser's pages and the one on view, as the socket's `targets` messages say: each navigation sends them again.
	const [pages, setPages] = useState<{ active: string | undefined; targets: readonly LiveTarget[] }>({
		active: undefined,
		targets: [],
	});
	useEffect(() => {
		if (state === "ended" || state === "expired") tellParent();
	}, [state]);

	useEffect(() => {
		if (info.status !== "running") return;
		const box = stage.current!;
		const size = () => {
			const k = window.devicePixelRatio || 1;
			return { w: Math.round(Math.max(160, box.clientWidth * k)), h: Math.round(Math.max(120, box.clientHeight * k)) };
		};
		const { w, h } = size();
		const scheme = location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${scheme}://${location.host}${viewUrl(view, "/live")}?w=${w}&h=${h}`, [
			VIEW_PROTOCOL,
			`${VIEW_TOKEN_PROTOCOL}${view.token}`,
		]);
		ws.binaryType = "arraybuffer";
		const context = canvas.current!.getContext("2d")!;
		let pending: ArrayBuffer | null = null;
		let drawing = false;
		const draw = async (buffer: ArrayBuffer) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ack" }));
			pending = buffer;
			if (drawing) return;
			drawing = true;
			while (pending !== null) {
				const next: ArrayBuffer = pending;
				pending = null;
				try {
					const bitmap = await createImageBitmap(new Blob([new Uint8Array(next, 8)], { type: "image/jpeg" }));
					const target = canvas.current;
					if (target !== null) {
						if (target.width !== bitmap.width || target.height !== bitmap.height) {
							target.width = bitmap.width;
							target.height = bitmap.height;
						}
						context.drawImage(bitmap, 0, 0);
					}
					bitmap.close();
					setState("live");
				} catch {}
			}
			drawing = false;
		};
		ws.onmessage = (event) => {
			if (typeof event.data !== "string") return void draw(event.data as ArrayBuffer);
			try {
				const message = JSON.parse(event.data) as { type?: string };
				if (message.type === "ended") setState("ended");
				const targets = liveTargets(message);
				if (targets !== undefined) setPages(targets);
			} catch {}
		};
		ws.onclose = (event) => setState(event.code === 4001 ? "expired" : "ended");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const observer = new ResizeObserver(() => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "size", ...size() }));
			}, 250);
		});
		observer.observe(box);
		return () => {
			observer.disconnect();
			clearTimeout(timer);
			ws.close();
		};
	}, [view, info.status]);

	const active = pages.targets.find((target) => target.id === pages.active) ?? pages.targets[0];
	return (
		<div className={`hb-viewer-live ${PANE}`} data-state={state}>
			<Chrome
				tabs={pages.targets}
				active={active?.id}
				url={active?.url}
				status={
					state === "live" || state === "connecting" ? (
						<StatusLabel status="working">Live</StatusLabel>
					) : (
						<StatusLabel status="idle">Closed</StatusLabel>
					)
				}
			/>
			<div className={STAGE} ref={stage}>
				<canvas ref={canvas} className={CANVAS} aria-label="The browser, live" />
				{state === "connecting" ? (
					<div className={OVERLAY} role="status">
						<Spinner size="sm" /> Connecting
					</div>
				) : state === "ended" ? (
					<div className={OVERLAY}>
						<Ended title="The browser has closed" detail="Its replay is in the session." />
					</div>
				) : state === "expired" ? (
					<div className={OVERLAY}>
						<Ended title="This link has expired" detail="Ask for a new one where you found it." />
					</div>
				) : null}
			</div>
		</div>
	);
}

type Track = {
	readonly pageId: string;
	/** Where the page starts and ends on the replay's timeline. */
	readonly from: number;
	readonly to: number;
	readonly chunks: readonly { readonly index: number; readonly startMs: number; readonly durationMs: number }[];
	/** Where the page went, by its own clock, oldest first. */
	readonly navigations: readonly Navigation[];
};

/** The replay's timeline: each page after the last, without the gaps between them (an idle browser shows nothing). */
export function timeline(manifest: Manifest): { readonly tracks: readonly Track[]; readonly duration: number } {
	let at = 0;
	const tracks: Track[] = [];
	for (const page of [...manifest.pages].sort((a, b) => a.startMs - b.startMs)) {
		if (page.chunks.length === 0) continue;
		const length = Math.max(page.durationMs, ...page.chunks.map((chunk) => chunk.startMs + chunk.durationMs));
		const navigations = (page.navigations ?? [])
			.filter((each) => typeof each?.url === "string" && Number.isFinite(each.atMs))
			.sort((a, b) => a.atMs - b.atMs);
		tracks.push({ pageId: page.pageId, from: at, to: at + length, chunks: page.chunks, navigations });
		at += length;
	}
	return { tracks, duration: at };
}

function Replay({ view }: { view: View }) {
	const [manifest, setManifest] = useState<Manifest | "expired" | "none" | "failed" | undefined>();
	useEffect(() => {
		const abort = new AbortController();
		viewFetch(view, "/recording", { cache: "no-store", signal: abort.signal })
			.then(async (response) => {
				if (response.status === 401 || response.status === 410) return setManifest("expired");
				if (response.status === 404) return setManifest("none");
				if (!response.ok) return setManifest("failed");
				const body = (await response.json()) as Manifest;
				setManifest(body.status === "none" ? "none" : body);
			})
			.catch(() => {
				if (!abort.signal.aborted) setManifest("failed");
			});
		return () => abort.abort();
	}, [view]);

	if (manifest === undefined) {
		return (
			<div className={WAIT}>
				<Spinner size="sm" /> Loading the recording
			</div>
		);
	}
	if (manifest === "expired")
		return <Ended title="This recording has gone" detail="Recordings are kept for a short while only." />;
	if (manifest === "none") return <Ended title="Nothing was recorded" detail="This browser has no recording." />;
	if (manifest === "failed") return <Ended title="The recording didn't load" detail="Reload the page to try again." />;
	return <ReplayPlayer view={view} manifest={manifest} />;
}

const SPEEDS = [1, 2, 4] as const;

function ReplayPlayer({ view, manifest }: { view: View; manifest: Manifest }) {
	const { tracks, duration } = useMemo(() => timeline(manifest), [manifest]);
	const canvas = useRef<HTMLCanvasElement>(null);
	const [position, setPosition] = useState(0);
	const [playing, setPlaying] = useState(true);
	const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
	const [waiting, setWaiting] = useState(false);
	// Chunks loaded (or loading), by `<page>/<index>`.
	const chunks = useRef(new Map<string, Promise<ReplayFrame[]>>());
	const loaded = useRef(new Map<string, ReplayFrame[]>());
	const show = useMemo(
		() =>
			framePainter(
				(frame: ReplayFrame) =>
					createImageBitmap(new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })),
				(bitmap: ImageBitmap) => {
					const target = canvas.current;
					if (target === null) return;
					if (target.width !== bitmap.width || target.height !== bitmap.height) {
						target.width = bitmap.width;
						target.height = bitmap.height;
					}
					target.getContext("2d")!.drawImage(bitmap, 0, 0);
				},
				(bitmap: ImageBitmap) => bitmap.close(),
			),
		[],
	);

	const load = useCallback(
		(pageId: string, index: number) => {
			const key = `${pageId}/${index}`;
			let chunk = chunks.current.get(key);
			if (chunk === undefined) {
				chunk = viewFetch(view, `/recording/${pageId}/${index}`)
					.then((response) =>
						response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status))),
					)
					.then((buffer) => readFrames(new Uint8Array(buffer)))
					.then((frames) => {
						loaded.current.set(key, frames);
						return frames;
					});
				chunk.catch(() => chunks.current.delete(key));
				chunks.current.set(key, chunk);
			}
			return chunk;
		},
		[view],
	);

	/** The page and chunk at a point on the timeline, and the point on that page's own clock. */
	const locate = useCallback(
		(at: number) => {
			const track = tracks.find((each) => at < each.to) ?? tracks[tracks.length - 1];
			if (track === undefined) return undefined;
			const pageMs = Math.max(0, at - track.from);
			const chunk = [...track.chunks].reverse().find((each) => each.startMs <= pageMs) ?? track.chunks[0];
			return chunk === undefined ? undefined : { track, chunk, pageMs };
		},
		[tracks],
	);

	// Draw the frame at the position, loading its chunk (and the next) if they're not here yet.
	useEffect(() => {
		const where = locate(position);
		if (where === undefined) return;
		const key = `${where.track.pageId}/${where.chunk.index}`;
		const next = where.track.chunks.find((each) => each.index > where.chunk.index);
		if (next !== undefined) void load(where.track.pageId, next.index).catch(() => undefined);
		const frames = loaded.current.get(key);
		if (frames === undefined) {
			// Loading already: this runs again once it's done (`waiting` goes back to false).
			if (waiting) return;
			setWaiting(true);
			void load(where.track.pageId, where.chunk.index)
				.then(() => setWaiting(false))
				.catch(() => setWaiting(false));
			return;
		}
		// Not cancelled when the position moves on: while playing it moves every animation frame, often before a frame
		// has decoded, and cancelling then would show nothing until playing stops.
		const frame = frameAt(frames, where.pageMs);
		if (frame !== undefined) show(frame);
	}, [position, locate, load, waiting, show]);

	// Play: move the position on with the clock, unless a chunk is still loading.
	useEffect(() => {
		if (!playing || waiting) return;
		let last = performance.now();
		let frame = 0;
		const step = (now: number) => {
			const elapsed = (now - last) * speed;
			last = now;
			setPosition((at) => {
				const next = Math.min(duration, at + elapsed);
				if (next >= duration) setPlaying(false);
				return next;
			});
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [playing, waiting, speed, duration]);

	if (tracks.length === 0) return <Ended title="Nothing was recorded" detail="The browser showed no page." />;
	const current = locate(position);
	// Each page as a tab, at where it is at this point of the replay: the one playing now at the position, the others
	// where they were last (or will be first).
	const tabs = tracks.map((track): BrowserTabItem => {
		const at = track === current?.track ? current.pageMs : position < track.from ? 0 : Number.POSITIVE_INFINITY;
		const page = pageAt(track.navigations, at);
		return {
			id: track.pageId,
			...(page === undefined ? {} : { url: page.url }),
			...(page?.title === undefined ? {} : { title: page.title }),
		};
	});
	const here = current === undefined ? undefined : tabs[tracks.indexOf(current.track)];
	return (
		<div className={`hb-viewer-replay ${PANE}`}>
			<Chrome
				tabs={tabs}
				active={current?.track.pageId}
				url={here?.url}
				status={<StatusLabel status="idle">Replay</StatusLabel>}
				onSelect={(pageId) => {
					const track = tracks.find((each) => each.pageId === pageId);
					if (track !== undefined) setPosition(track.from);
				}}
			/>
			<div className={STAGE}>
				<canvas ref={canvas} className={CANVAS} aria-label="The browser, replayed" />
				{waiting ? (
					// In a corner, over the last frame, while the next chunk loads.
					<div
						className="hb-viewer-overlay absolute bottom-2 left-2 flex items-center justify-center gap-1.5 py-1 px-2 rounded-xs bg-canvas text-muted"
						role="status"
					>
						<Spinner size="sm" /> Loading
					</div>
				) : null}
			</div>
			<PlayerControls
				playing={playing}
				position={position}
				duration={duration}
				onToggle={() => {
					if (position >= duration) setPosition(0);
					setPlaying((on) => !on);
				}}
				onSeek={setPosition}
				speed={speed}
				onSpeed={() => setSpeed((now) => SPEEDS[(SPEEDS.indexOf(now) + 1) % SPEEDS.length]!)}
			/>
		</div>
	);
}
