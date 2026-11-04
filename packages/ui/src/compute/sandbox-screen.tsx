// A sandbox's screen in the console: its desktop or its browser, as a live preview on its page and full size in the
// viewer, with Control and Watch, full screen and a pop-out to a tab of its own. Where there's nothing real to show
// (the sample data) a drawing of a desktop or a browser in the theme's colours stands in.

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Breadcrumbs } from "../primitives/breadcrumbs.tsx";
import { Button, buttonClass, buttonLabelClass, IconButton } from "../primitives/button.tsx";
import { SegmentedControl } from "../primitives/controls.tsx";
import { GlobeIcon } from "../primitives/icons.tsx";
import { DesktopIcon, ExternalLinkIcon, FullScreenIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { StatusDot } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import type { SandboxAccess } from "./compute-model.ts";
import { messageOf } from "./parts.tsx";

/** What the viewer shows: the desktop to use, the desktop to watch only, or the browser. */
export type ScreenView = "desktop" | "watch" | "browser";

/** The size a preview is drawn at before it's scaled down to its tile, so the sandbox's screen isn't resized to it. */
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

/**
 * A screen drawn at 1280 by 800 and scaled to fit the width it's given: a live frame, view only, or the stand-in. The
 * frame takes no pointer or keyboard, so a click lands on what wraps it.
 */
export function ScreenPreview({ kind, url, label }: { kind: "desktop" | "browser"; url?: string; label: string }) {
	const [ref, { width }] = useSize<HTMLDivElement>();
	const scale = width / PREVIEW_WIDTH;
	return (
		<div ref={ref} className="kt-screen-preview relative aspect-[16/10] w-full overflow-hidden bg-sunken">
			<div
				className="absolute top-0 left-0 origin-top-left"
				style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, transform: `scale(${scale})` }}
				aria-hidden={url === undefined ? true : undefined}
			>
				{url === undefined ? (
					<StandIn kind={kind} />
				) : (
					<iframe
						className="pointer-events-none size-full border-0"
						src={url}
						title={label}
						tabIndex={-1}
						width={PREVIEW_WIDTH}
						height={PREVIEW_HEIGHT}
					/>
				)}
			</div>
			{url === undefined ? null : (
				<span className="absolute right-2 bottom-2 inline-flex items-center gap-1.5 rounded-sm bg-glass px-1.5 py-0.5 text-2xs text-fg">
					<StatusDot status="done" />
					Live
				</span>
			)}
		</div>
	);
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
	 * Access young enough for a new connection, read again when the page's is old, for the pop-out. The screen already
	 * open keeps its own. Without it the pop-out uses `access`.
	 */
	readonly freshAccess?: () => Promise<SandboxAccess>;
	/** A phone: the controls wrap under the trail. */
	readonly narrow?: boolean;
}

/**
 * The desktop or the browser full size in the console, as tall as the window allows. Control and Watch switch the
 * desktop between using it and watching only; the other screen is a button away; Full screen fills the display and
 * the pop-out opens it in a tab of its own.
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
	freshAccess,
	narrow = false,
}: SandboxViewerProps) {
	const frame = useRef<HTMLDivElement>(null);
	const ready = access !== "loading" && !(access instanceof Error) ? access : undefined;
	const url = ready === undefined ? undefined : embedUrl(ready, view);
	const go = (next: ScreenView) => (onView === undefined ? window.location.assign(viewHref(next)) : onView(next));
	const other: ScreenView = view === "browser" ? "desktop" : "browser";
	const otherButton = (
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
	if (access === "loading") body = <Skeleton lines={3} />;
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
		// As tall as the window less the console's bars and padding: the top bar's height twice on a wide screen, and on a
		// phone four times, for its top bar, its tab bar and the trail's own line.
		<div
			className={`kt-sandbox-viewer flex min-h-0 w-full min-w-0 flex-col gap-3 ${narrow ? "h-[calc(100dvh_-_var(--kt-topbar-height)_*_4)]" : "h-[calc(100dvh_-_var(--kt-topbar-height)_*_2)]"}`}
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
					{view === "browser" ? null : (
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
						onClick={() => void frame.current?.requestFullscreen?.()}
					/>
					<IconButton
						size="sm"
						variant="ghost"
						label="Open in a new tab"
						icon={<ExternalLinkIcon size="sm" />}
						disabled={ready === undefined}
						onClick={() => {
							if (ready !== undefined) popOut(view, ready, freshAccess);
						}}
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
