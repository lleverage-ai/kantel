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
		<span className="hb-browser-page-icon" aria-hidden="true">
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
		<div className="hb-browser-tabs">
			<div className="hb-browser-tabs-list" role="tablist" aria-label={label} ref={strip} onKeyDown={onKeyDown}>
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
							className={`hb-browser-tab hb-focusable${selected ? " hb-browser-tab-active" : ""}`}
							title={tab.url && tab.url !== text ? `${text}\n${tab.url}` : text}
							onClick={onSelect === undefined ? undefined : () => onSelect(tab.id)}
						>
							{tab.busy ? (
								<span className="hb-browser-page-icon hb-browser-page-icon-busy">
									<Spinner size="sm" />
								</span>
							) : (
								<PageIcon url={tab.url} />
							)}
							<span className="hb-browser-tab-title">{text}</span>
						</button>
					);
				})}
			</div>
			{end === undefined ? null : <div className="hb-browser-tabs-end">{end}</div>}
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
		<div className="hb-browser-toolbar">
			{start}
			<div className="hb-browser-address" title={url} translate="no">
				<span className="hb-sr-only">Address: </span>
				{parts === undefined ? (
					<span className="hb-browser-address-empty">{placeholder}</span>
				) : (
					<>
						<span className="hb-browser-address-icon">
							{parts.secure ? <LockIcon size="sm" label="Secure connection" /> : <GlobeIcon size="sm" />}
						</span>
						<span className="hb-browser-address-text">
							<span className="hb-browser-address-host">{parts.host}</span>
							<span className="hb-browser-address-rest">{parts.rest}</span>
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
		<div className={`hb-browser-window${className ? ` ${className}` : ""}`}>
			{tabs === undefined && toolbar === undefined ? null : (
				<div className="hb-browser-chrome">
					{tabs}
					{toolbar}
				</div>
			)}
			<div className="hb-browser-viewport">{children}</div>
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
}: PlayerControlsProps) {
	const over = !playing && duration > 0 && position >= duration;
	return (
		<div className="hb-player">
			<IconButton
				variant="ghost"
				size="sm"
				className="hb-player-toggle"
				label={playing ? "Pause" : over ? "Play again" : "Play"}
				icon={playing ? <PauseIcon /> : over ? <ReplayIcon /> : <PlayIcon />}
				onClick={onToggle}
			/>
			<Scrubber value={position} max={duration} onChange={onSeek} label="Position in the recording" />
			<span className="hb-player-time">
				{playerClock(position)} / {playerClock(duration)}
			</span>
			{speed === undefined || onSpeed === undefined ? null : (
				<Button
					variant="ghost"
					size="xs"
					className="hb-player-speed"
					aria-label={`Playback speed, ${speed} times`}
					onClick={onSpeed}
				>
					{`${speed}×`}
				</Button>
			)}
			{end === undefined ? null : <span className="hb-player-end">{end}</span>}
		</div>
	);
}
