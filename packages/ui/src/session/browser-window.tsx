import { type CSSProperties, type KeyboardEvent, type ReactNode, useRef } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { GlobeIcon, LockIcon } from "../primitives/icons.tsx";
import { PauseIcon, PlayIcon, ReplayIcon } from "../primitives/lucide.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import "./browser-window.css";

// A browser's window, drawn around a view of it (live or replayed), as brwsr's live page draws one: a strip of tabs,
// an address bar with the page's URL, the page, and for a replay a player's controls under it. Every piece is one of
// Harbour's own controls, so nothing falls back to the browser's default button, font or range input.
//
// The window is chrome only: it never fetches anything, not even a site's favicon (that would tell the site who is
// watching). A tab's icon is the first letter of its host, in a tile.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css). browser-window.css keeps only the scrubber: a range
// input's track and thumb are pseudo-elements, and a test pins its class attribute. The other hb- classes carry no
// style of their own; they stay as names: hb-browser-address is looked for by a test, and hb-browser-page-icon by the
// active tab here.

/** A page's icon: its host's first letter in a small tile. Add its background: a tile, or none for a spinner. */
const pageIcon =
	"hb-browser-page-icon inline-grid size-icon-md flex-none place-items-center rounded-xs text-2xs font-strong leading-none text-muted";
/** The strip of tabs, on the window's darker colour, the tabs sitting on its bottom edge. */
const tabsStrip = "hb-browser-tabs flex min-w-0 items-end gap-2 bg-panel px-1.5 pt-1.5 pb-0";
/** The tabs, scrolling sideways with no scrollbar when there are more than fit. */
const tabsList =
	"hb-browser-tabs-list flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
/**
 * A tab: icon and title, rounded on top. Only one tab, and nothing to pick: it reads as the window's title, not a
 * control. Its focus ring sits inside it (`!`: base.css's unlayered `.hb-focusable:focus-visible` sets the offset).
 */
const tabButton =
	"hb-browser-tab hb-focusable inline-flex h-control-sm max-w-48 min-w-18 flex-initial cursor-pointer items-center gap-1.5 rounded-t-control border-0 py-0 pr-2.5 pl-2 text-xs leading-tight whitespace-nowrap [font-family:inherit] [font-feature-settings:inherit] transition-[background-color,color] duration-(--hb-duration-fast) only:cursor-default focus-visible:outline-offset-[calc(var(--hb-ring)*-1)]!";
/** The tab on show, joined to the toolbar under it, its icon in full colour; the others light up on hover. */
const tabOnShow = "hb-browser-tab-active bg-raised text-fg [&_.hb-browser-page-icon]:text-fg";
const tabOther = "bg-transparent text-muted hover:bg-hover hover:text-fg";
/** At the strip's end: the view's status and links. */
const tabsEnd = "hb-browser-tabs-end flex min-h-control-sm flex-none items-center gap-1.5 pb-0.5 text-xs text-muted";
/** The toolbar under the tabs, on the active tab's colour. */
const toolbarRow =
	"hb-browser-toolbar flex min-w-0 items-center gap-2 border-b border-border bg-raised px-2 py-1.5 text-xs text-muted";
/** The address bar: a read-only pill on the sunken colour. */
const addressBar =
	"hb-browser-address flex h-control-sm min-w-0 flex-1 items-center gap-1.5 rounded-full border border-border bg-sunken py-0 pr-3 pl-2.5 text-xs leading-tight whitespace-nowrap text-muted";
/** The page: it fills the window, on the sunken colour. */
const viewport = "hb-browser-viewport relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sunken";
/** A replay's controls, in a row under the page. */
const playerRow =
	"hb-player flex min-w-0 flex-none items-center gap-2 border-t border-border bg-raised px-2 py-1 text-xs text-muted";

/** A page as a tab or the address bar shows it. */
export type BrowserPageInfo = {
	readonly url?: string | undefined;
	readonly title?: string | undefined;
};

/** The page's host without `www.`, for a tab with no title: "example.com". */
export function pageHost(url: string | undefined): string | undefined {
	if (url === undefined || url === "") return undefined;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return parsed.hostname.replace(/^www\./, "") || undefined;
	} catch {
		return undefined;
	}
}

/** What a tab says: the page's title, else its host, else "New tab". */
export function pageLabel(page: BrowserPageInfo): string {
	const title = page.title?.trim();
	if (title) return title;
	const host = pageHost(page.url);
	if (host !== undefined) return host;
	return page.url !== undefined && page.url !== "" && page.url !== "about:blank" ? page.url : "New tab";
}

/**
 * The address split as the bar shows it: whether it is https, its host (which stands out) and the rest (quieter).
 * `undefined` for no address. An address that isn't http(s) is all `rest`.
 */
export function addressParts(
	url: string | undefined,
): { readonly secure: boolean; readonly host: string; readonly rest: string } | undefined {
	if (url === undefined || url === "") return undefined;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
			return { secure: parsed.protocol === "https:", host: parsed.host, rest };
		}
	} catch {}
	return { secure: false, host: "", rest: url };
}

/** A page's icon: its host's first letter in a tile, or a globe without a host. */
export function PageIcon({ url }: { url: string | undefined }) {
	const host = pageHost(url);
	return (
		<span className={`${pageIcon} bg-active`} aria-hidden="true">
			{host === undefined ? <GlobeIcon size="sm" /> : host.charAt(0).toUpperCase()}
		</span>
	);
}

/** One tab: an id to pick it by, the page it shows, and whether something is loading in it. */
export type BrowserTabItem = BrowserPageInfo & {
	readonly id: string;
	/** Something is happening in it now (the agent's step): a spinner in place of its icon. */
	readonly busy?: boolean;
};

export type BrowserTabsProps = {
	readonly tabs: readonly BrowserTabItem[];
	/** The tab on show. */
	readonly active: string | undefined;
	/** Picks a tab. Without it the tabs only show which is on show. */
	readonly onSelect?: (id: string) => void;
	/** What the tabs are, for a screen reader: "The session's browsers". */
	readonly label?: string;
	/** At the strip's end, after the tabs: the view's status, a link to open it on its own. */
	readonly end?: ReactNode;
};

/**
 * A browser's strip of tabs: each its page's icon and title (or host), the one on show joined to the window under it.
 * Arrow keys move between tabs, as a tab list's do. A tab's full address is its tooltip.
 */
export function BrowserTabs({ tabs, active, onSelect, label = "Tabs", end }: BrowserTabsProps) {
	const strip = useRef<HTMLDivElement>(null);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (onSelect === undefined) return;
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		const edge = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
		if (step === 0 && edge === undefined) return;
		const at = tabs.findIndex((tab) => tab.id === active);
		const next = tabs[edge ?? (Math.max(0, at) + step + tabs.length) % tabs.length];
		if (next === undefined) return;
		event.preventDefault();
		onSelect(next.id);
		strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus();
	};
	return (
		<div className={tabsStrip}>
			<div className={tabsList} role="tablist" aria-label={label} ref={strip} onKeyDown={onKeyDown}>
				{tabs.map((tab) => {
					const selected = tab.id === active;
					const text = pageLabel(tab);
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							data-tab={tab.id}
							aria-selected={selected}
							tabIndex={selected || (active === undefined && tab === tabs[0]) ? 0 : -1}
							className={`${tabButton} ${selected ? tabOnShow : tabOther}`}
							title={tab.url && tab.url !== text ? `${text}\n${tab.url}` : text}
							onClick={onSelect === undefined ? undefined : () => onSelect(tab.id)}
						>
							{tab.busy ? (
								<span className={`${pageIcon} hb-browser-page-icon-busy bg-transparent`}>
									<Spinner size="sm" />
								</span>
							) : (
								<PageIcon url={tab.url} />
							)}
							<span className="hb-browser-tab-title min-w-0 overflow-hidden text-ellipsis">{text}</span>
						</button>
					);
				})}
			</div>
			{end === undefined ? null : <div className={tabsEnd}>{end}</div>}
		</div>
	);
}

export type BrowserAddressBarProps = {
	/** The page's address, as it is now (live) or was at that point (replay). */
	readonly url?: string | undefined;
	/** Shown in place of an address while there is none. */
	readonly placeholder?: string;
	/** Before the address: the view's status ("Live", "Replay"). */
	readonly start?: ReactNode;
	/** After the address: links and buttons for the view. */
	readonly end?: ReactNode;
};

/**
 * A browser's address bar, read-only: a lock for https, the host in full colour and the rest of the address quieter,
 * cut short with an ellipsis when it doesn't fit (the whole address is its tooltip). Watch-only: nothing in it
 * navigates the browser.
 */
export function BrowserAddressBar({ url, placeholder = "No page yet", start, end }: BrowserAddressBarProps) {
	const parts = addressParts(url);
	return (
		<div className={toolbarRow}>
			{start}
			<div className={addressBar} title={url} translate="no">
				<span className="hb-sr-only">Address: </span>
				{parts === undefined ? (
					<span className="hb-browser-address-empty text-faint">{placeholder}</span>
				) : (
					<>
						<span className="hb-browser-address-icon inline-flex flex-none text-faint">
							{parts.secure ? <LockIcon size="sm" label="Secure connection" /> : <GlobeIcon size="sm" />}
						</span>
						<span className="hb-browser-address-text min-w-0 overflow-hidden text-ellipsis">
							<span className="hb-browser-address-host text-fg">{parts.host}</span>
							<span className="hb-browser-address-rest text-faint">{parts.rest}</span>
						</span>
					</>
				)}
			</div>
			{end}
		</div>
	);
}

export type BrowserWindowProps = {
	/** The strip of tabs (`BrowserTabs`), at the top. */
	readonly tabs?: ReactNode;
	/** The address bar (`BrowserAddressBar`), under the tabs. */
	readonly toolbar?: ReactNode;
	/** Under the page: a replay's controls (`PlayerControls`). */
	readonly footer?: ReactNode;
	/** The page: an iframe, a canvas or a screenshot. It fills the window's viewport. */
	readonly children: ReactNode;
	readonly className?: string;
};

/** A browser window around a view of a page: tabs, address bar, the page and its controls, in one framed box. */
export function BrowserWindow({ tabs, toolbar, footer, children, className }: BrowserWindowProps) {
	return (
		<div
			className={`hb-browser-window flex min-w-0 flex-col overflow-hidden rounded-panel border border-border-strong bg-panel${className ? ` ${className}` : ""}`}
		>
			{tabs === undefined && toolbar === undefined ? null : (
				<div className="hb-browser-chrome flex min-w-0 flex-none flex-col">
					{tabs}
					{toolbar}
				</div>
			)}
			<div className={viewport}>{children}</div>
			{footer}
		</div>
	);
}

/** A position on a player's clock: "1:05". */
export function playerClock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export type ScrubberProps = {
	/** Where the player is, in milliseconds. */
	readonly value: number;
	/** How long the recording is, in milliseconds. */
	readonly max: number;
	readonly onChange: (value: number) => void;
	readonly label?: string;
};

/**
 * A player's position, draggable: a thin track that fills in the accent up to a round thumb. A range input underneath,
 * so keyboard, touch and screen readers work as they would on any slider, drawn in Harbour's colours.
 */
export function Scrubber({ value, max, onChange, label = "Position" }: ScrubberProps) {
	const top = Math.max(1, Math.round(max));
	const at = Math.min(top, Math.max(0, Math.round(value)));
	return (
		<input
			className="hb-scrubber hb-focusable"
			type="range"
			min={0}
			max={top}
			step={100}
			value={at}
			aria-label={label}
			aria-valuetext={`${playerClock(at)} of ${playerClock(top)}`}
			style={{ "--hb-scrubber-fill": `${(at / top) * 100}%` } as CSSProperties}
			onChange={(event) => onChange(Number(event.currentTarget.value))}
		/>
	);
}

/** A point on a recording to jump to: one of the agent's steps on a browser's timeline. */
export type PlayerMarker = {
	readonly id: string;
	/** Where it is, in milliseconds. */
	readonly position: number;
	/** What happened there, for its tooltip and a screen reader: "Clicking Sign in". */
	readonly label: string;
	/** The step failed: drawn in the error colour. */
	readonly failed?: boolean;
};

/** A marker: a short bar across the track, in a hit area a control high. */
const markerButton =
	"hb-player-marker group absolute top-0 flex h-control-xs w-2 -translate-x-1/2 cursor-pointer items-center justify-center border-0 bg-transparent p-0";
const markerBar =
	"block h-3 w-0.5 rounded-full transition-transform duration-(--hb-duration-fast) group-hover:scale-y-125";

/**
 * A scrubber with markers over its track: each a button that seeks to it. Out of the tab order (a recording may have
 * dozens); the player's own step buttons move between them by keyboard. A marker sits where the range input draws
 * that value: the track runs from half a thumb in at each end.
 */
function MarkedScrubber({
	value,
	max,
	onChange,
	label,
	markers,
	current,
	onMarker,
}: ScrubberProps & {
	readonly markers: readonly PlayerMarker[];
	readonly current: string | undefined;
	readonly onMarker: (marker: PlayerMarker) => void;
}) {
	const top = Math.max(1, max);
	return (
		<div className="hb-player-track relative flex min-w-12 flex-1 items-center">
			<Scrubber value={value} max={max} onChange={onChange} {...(label === undefined ? {} : { label })} />
			{markers.map((marker, index) => {
				const fraction = Math.min(1, Math.max(0, marker.position / top));
				const on = marker.id === current;
				return (
					<button
						key={marker.id}
						type="button"
						tabIndex={-1}
						className={markerButton}
						style={{ left: `calc(var(--hb-step-3) / 2 + (100% - var(--hb-step-3)) * ${fraction})` }}
						title={`Step ${index + 1}: ${marker.label}`}
						aria-label={`Go to step ${index + 1}: ${marker.label}`}
						data-marker={marker.id}
						aria-current={on ? "step" : undefined}
						onClick={() => onMarker(marker)}
					>
						<span
							className={`${markerBar} ${marker.failed ? "bg-status-error" : on ? "bg-accent" : "bg-muted"}`}
							aria-hidden="true"
						/>
					</button>
				);
			})}
		</div>
	);
}

export type PlayerControlsProps = {
	readonly playing: boolean;
	/** In milliseconds. */
	readonly position: number;
	readonly duration: number;
	readonly onToggle: () => void;
	readonly onSeek: (position: number) => void;
	/** The playback speed, with `onSpeed` to change it: a "1×" button that steps through the speeds. */
	readonly speed?: number;
	readonly onSpeed?: () => void;
	/** After the time: anything else about the recording ("Tab 2 of 3"). */
	readonly end?: ReactNode;
	/** Points to jump to, drawn on the scrubber (a browser's steps), with the one playing now as `current`. */
	readonly markers?: readonly PlayerMarker[];
	readonly current?: string;
	/** A marker was picked. Without it a marker seeks to its position. */
	readonly onMarker?: (marker: PlayerMarker) => void;
	/** Before the scrubber, after play: more buttons (the previous and next step). */
	readonly start?: ReactNode;
};

/**
 * A recording's controls, in one row under it: play or pause (play again at the end), the scrubber, the time and the
 * speed.
 */
export function PlayerControls({
	playing,
	position,
	duration,
	onToggle,
	onSeek,
	speed,
	onSpeed,
	end,
	markers,
	current,
	onMarker,
	start,
}: PlayerControlsProps) {
	const over = !playing && duration > 0 && position >= duration;
	const label = "Position in the recording";
	return (
		<div className={playerRow}>
			<IconButton
				variant="ghost"
				size="sm"
				className="hb-player-toggle"
				label={playing ? "Pause" : over ? "Play again" : "Play"}
				icon={playing ? <PauseIcon /> : over ? <ReplayIcon /> : <PlayIcon />}
				onClick={onToggle}
			/>
			{start}
			{markers === undefined || markers.length === 0 ? (
				<Scrubber value={position} max={duration} onChange={onSeek} label={label} />
			) : (
				<MarkedScrubber
					value={position}
					max={duration}
					onChange={onSeek}
					label={label}
					markers={markers}
					current={current}
					onMarker={onMarker ?? ((marker) => onSeek(marker.position))}
				/>
			)}
			<span className="hb-player-time flex-none whitespace-nowrap text-muted tabular-nums">
				{playerClock(position)} / {playerClock(duration)}
			</span>
			{speed === undefined || onSpeed === undefined ? null : (
				<Button
					variant="ghost"
					size="xs"
					className="hb-player-speed min-w-control-md flex-none tabular-nums"
					aria-label={`Playback speed, ${speed} times`}
					onClick={onSpeed}
				>
					{`${speed}×`}
				</Button>
			)}
			{end === undefined ? null : <span className="hb-player-end flex-none whitespace-nowrap text-faint">{end}</span>}
		</div>
	);
}
