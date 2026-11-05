// A sandbox's screen in the console: its desktop or its browser, on a page of its own (/sandboxes/<id>/desktop, /watch
// or /browser) that the sandbox's page opens in a new tab, with Control and Watch and full screen. Nothing streams
// anywhere else: the stream is this page's frame, and it goes when the page closes or has been hidden a while. Where
// there's nothing real to show (the sample data) a drawing of a desktop or a browser in the theme's colours stands in.

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Breadcrumbs } from "../primitives/breadcrumbs.tsx";
import { Button, buttonClass, buttonLabelClass, IconButton } from "../primitives/button.tsx";
import { SegmentedControl } from "../primitives/controls.tsx";
import { GlobeIcon } from "../primitives/icons.tsx";
import { DesktopIcon, FullScreenIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import { type SandboxAccess, screenUnavailable } from "./compute-model.ts";
import { messageOf } from "./parts.tsx";

/** What the viewer shows: the desktop to use, the desktop to watch only, or the browser. */
export type ScreenView = "desktop" | "watch" | "browser";

/** The size the stand-in is drawn at before it's scaled to fit. */
const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 800;

/** The address to frame for `view`, or undefined when there's nothing real to frame. */
export const embedUrl = (access: SandboxAccess, view: ScreenView): string | undefined =>
	access.embed?.[view === "watch" ? "watch" : view];

/** The address for a tab of its own. */
export const popOutUrl = (access: SandboxAccess, view: ScreenView): string =>
	view === "desktop" ? access.desktopUrl : view === "watch" ? access.desktopViewUrl : access.browserUrl;

/**
 * Opens `view` in a tab of its own. Call it from a click: the tab opens at once, while the click allows it, and goes
 * to the screen once fresh access is read (or closes if that fails). With no `fresh`, it goes straight to `ready`'s.
 */
export function popOut(view: ScreenView, ready: SandboxAccess | undefined, fresh?: () => Promise<SandboxAccess>) {
	if (fresh === undefined) {
		if (ready !== undefined) window.open(popOutUrl(ready, view), "_blank", "noopener");
		return;
	}
	const tab = window.open("about:blank", "_blank");
	if (tab === null) return;
	tab.opener = null;
	fresh().then(
		(access) => tab.location.replace(popOutUrl(access, view)),
		() => tab.close(),
	);
}

/** Tracks an element's size, for scaling what's inside it. */
function useSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
	const ref = useRef<T>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	useEffect(() => {
		const element = ref.current;
		if (element === null) return;
		setSize({ width: element.clientWidth, height: element.clientHeight });
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) =>
			setSize({ width: entry?.contentRect.width ?? 0, height: entry?.contentRect.height ?? 0 }),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, size];
}

/** How long the page may be hidden before its stream is closed; it opens again when the page is shown. */
export const HIDDEN_CLOSE_MS = 30_000;

/**
 * Whether the page has been hidden for `afterMs`: true from then until it's shown again, when `onShown` runs. Selkies'
 * own page stops its video the moment the tab hides; this closes the connection too, so nothing is held open for a
 * tab left in the background.
 */
export function useHiddenFor(afterMs: number, onShown?: () => void): boolean {
	const [asleep, setAsleep] = useState(false);
	const shown = useRef(onShown);
	shown.current = onShown;
	useEffect(() => {
		if (typeof document === "undefined") return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let slept = false;
		const change = () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			if (document.visibilityState === "hidden") {
				timer = setTimeout(() => {
					slept = true;
					setAsleep(true);
				}, afterMs);
			} else if (slept) {
				slept = false;
				shown.current?.();
				setAsleep(false);
			}
		};
		change();
		document.addEventListener("visibilitychange", change);
		return () => {
			if (timer !== undefined) clearTimeout(timer);
			document.removeEventListener("visibilitychange", change);
		};
	}, [afterMs]);
	return asleep;
}

/** A drawing of a desktop (a terminal and a window) or a browser (a page), in the theme's colours. */
function StandIn({ kind }: { kind: "desktop" | "browser" }) {
	if (kind === "browser") {
		return (
			<div className="flex size-full flex-col bg-raised">
				<div className="m-3 flex h-control-md items-center rounded-control bg-sunken px-4 font-mono text-md text-faint">
					localhost:3000
				</div>
				<div className="flex flex-col gap-5 px-12 pt-10">
					<span className="block h-8 w-[42%] rounded-xs bg-fg" />
					<span className="block h-3 w-[72%] rounded-xs bg-active" />
					<span className="block h-3 w-[56%] rounded-xs bg-active" />
					<span className="block h-3 w-[64%] rounded-xs bg-active" />
					<span className="mt-4 block h-6 w-[20%] rounded-xs bg-accent" />
				</div>
			</div>
		);
	}
	const lines = [
		"user@api-server:~/app$ pnpm dev",
		"> app@ dev node --watch src/server.ts",
		"listening on :3000",
		"GET / 200 4ms",
		"GET /health 200 1ms",
		"user@api-server:~/app$ docker compose ps",
		"db  postgres:17  Up 3 hours  5432/tcp",
		"user@api-server:~/app$ _",
	];
	return (
		<div className="relative size-full bg-active">
			<div className="absolute top-[12%] left-[9%] w-[58%] overflow-hidden rounded-panel bg-code-surface shadow-float">
				<div className="h-6 border-b border-border bg-sunken" />
				<pre className="m-0 px-6 py-5 font-mono text-display leading-normal text-muted">{lines.join("\n")}</pre>
			</div>
			<div className="absolute top-[30%] left-[52%] flex w-[38%] flex-col gap-4 rounded-panel bg-raised p-6 shadow-float">
				<span className="block h-4 w-[60%] rounded-xs bg-accent" />
				<span className="block h-3 w-[90%] rounded-xs bg-active" />
				<span className="block h-3 w-[75%] rounded-xs bg-active" />
				<span className="block h-3 w-[50%] rounded-xs bg-active" />
			</div>
		</div>
	);
}

export interface SandboxViewerProps {
	readonly name: string;
	readonly view: ScreenView;
	/** The access the page holds: being read, read, or failed. */
	readonly access: SandboxAccess | "loading" | Error;
	readonly sandboxesHref: string;
	readonly sandboxHref: string;
	/** The address of another view of this sandbox's screen. */
	readonly viewHref: (view: ScreenView) => string;
	/** Goes to another view in place; without it the links are followed. */
	readonly onView?: (view: ScreenView) => void;
	/** Reads the access again, after it failed. */
	readonly onRetry: () => void;
	/**
	 * The page is shown again after its stream was closed while it was hidden (`HIDDEN_CLOSE_MS`): access that's too old
	 * for a new connection is read again here.
	 */
	readonly onWake?: () => void;
	/** A phone: the controls wrap under the trail. */
	readonly narrow?: boolean;
}

/**
 * The desktop or the browser as a page of its own, the whole window. Control and Watch switch the desktop between
 * using it and watching only; Full screen fills the display. From the browser the desktop is a button away; not the
 * other way, since the browser runs on the desktop and shows the same picture there.
 */
export function SandboxViewer({
	name,
	view,
	access,
	sandboxesHref,
	sandboxHref,
	viewHref,
	onView,
	onRetry,
	onWake,
	narrow = false,
}: SandboxViewerProps) {
	const frame = useRef<HTMLDivElement>(null);
	// A tab left hidden lets its stream go, and opens it again when it's shown.
	const asleep = useHiddenFor(HIDDEN_CLOSE_MS, onWake);
	const ready = access !== "loading" && !(access instanceof Error) ? access : undefined;
	const unavailable = ready === undefined ? undefined : screenUnavailable(ready, view);
	const url = ready === undefined || unavailable !== undefined ? undefined : embedUrl(ready, view);
	const go = (next: ScreenView) => (onView === undefined ? window.location.assign(viewHref(next)) : onView(next));
	const other: ScreenView = view === "browser" ? "desktop" : "browser";
	const otherUnavailable = ready === undefined ? undefined : screenUnavailable(ready, other);
	const otherButton =
		view !== "browser" ? null : otherUnavailable !== undefined ? (
			<Button
				size="sm"
				variant="ghost"
				icon={other === "browser" ? <GlobeIcon size="sm" /> : <DesktopIcon size="sm" />}
				disabled
				title={otherUnavailable}
			>
				{other === "browser" ? "Browser" : "Desktop"}
			</Button>
		) : (
			<a
				className={`${buttonClass("ghost", "sm")} no-underline`}
				href={viewHref(other)}
				onClick={(event) => {
					if (onView === undefined || event.metaKey || event.ctrlKey || event.shiftKey) return;
					event.preventDefault();
					onView(other);
				}}
			>
				{other === "browser" ? <GlobeIcon size="sm" /> : <DesktopIcon size="sm" />}
				<span className={buttonLabelClass}>{other === "browser" ? "Browser" : "Desktop"}</span>
			</a>
		);
	let body: ReactNode;
	if (asleep)
		body = (
			<div className="flex size-full items-center justify-center p-4 text-muted" role="status">
				Paused while this tab is hidden
			</div>
		);
	else if (access === "loading") body = <Skeleton lines={3} />;
	else if (access instanceof Error)
		body = (
			<div className="p-4">
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={onRetry}>
							Try again
						</Button>
					}
				>
					{messageOf(access, "Kantel couldn't reach the sandbox.")}
				</Notice>
			</div>
		);
	else if (unavailable !== undefined)
		body = (
			<div className="flex size-full items-center justify-center p-4 text-muted" role="status">
				{unavailable}
			</div>
		);
	else if (url === undefined) body = <ScaledStandIn kind={view === "browser" ? "browser" : "desktop"} />;
	else
		body = (
			<iframe
				key={url}
				className="size-full border-0"
				src={url}
				title={`${name}: ${view === "browser" ? "Browser" : "Desktop"}`}
				allow="clipboard-read; clipboard-write; fullscreen"
			/>
		);
	return (
		// The whole window: the page has no console bars around it.
		<div
			className={`kt-sandbox-viewer flex h-dvh min-h-0 w-full min-w-0 flex-col gap-3 ${narrow ? "p-gutter-narrow" : "px-gutter py-3"}`}
		>
			<div className={`flex min-w-0 items-center gap-2 ${narrow ? "flex-wrap" : ""}`}>
				{/* On a phone the trail has a line of its own, the controls under it. */}
				<div className={narrow ? "w-full min-w-0" : "min-w-0 flex-1"}>
					<Breadcrumbs
						label="Sandbox"
						parents={[
							{ key: "sandboxes", label: "Sandboxes", href: sandboxesHref },
							{ key: "sandbox", label: name, href: sandboxHref },
						]}
						current={<span>{view === "browser" ? "Browser" : "Desktop"}</span>}
					/>
				</div>
				<div className="flex flex-none items-center gap-1">
					{view === "browser" || unavailable !== undefined ? null : (
						<SegmentedControl
							label="Desktop"
							options={[
								{ value: "desktop", label: "Control" },
								{ value: "watch", label: "Watch" },
							]}
							value={view}
							onChange={go}
						/>
					)}
					{otherButton}
					<IconButton
						size="sm"
						variant="ghost"
						label="Full screen"
						icon={<FullScreenIcon size="sm" />}
						disabled={unavailable !== undefined}
						onClick={() => void frame.current?.requestFullscreen?.()}
					/>
				</div>
			</div>
			<div ref={frame} className="relative min-h-0 flex-1 overflow-hidden rounded-panel border border-border bg-sunken">
				{body}
			</div>
		</div>
	);
}

/** The stand-in at its drawn size, scaled to fit the viewer both ways and centred in it. */
function ScaledStandIn({ kind }: { kind: "desktop" | "browser" }) {
	const [ref, { width, height }] = useSize<HTMLDivElement>();
	const scale = Math.min(width / PREVIEW_WIDTH, height / PREVIEW_HEIGHT);
	return (
		<div ref={ref} className="relative size-full overflow-hidden" aria-hidden="true">
			<div
				className="absolute top-1/2 left-1/2"
				style={{
					width: PREVIEW_WIDTH,
					height: PREVIEW_HEIGHT,
					transform: `translate(-50%, -50%) scale(${scale})`,
				}}
			>
				<StandIn kind={kind} />
			</div>
		</div>
	);
}
