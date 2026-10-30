import type { AssistantItem, ToolImage, ToolItem } from "@harbour/protocol";
import { memo, type ReactNode, useEffect, useId, useState } from "react";
import { duration } from "../primitives/format.ts";
import { ChevronRightIcon, GlobeIcon } from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Spinner } from "../primitives/spinner.tsx";
import { BrowserEntry, type BrowserEntryState } from "./browser-entry.tsx";
import { AssistantMessage } from "./message.tsx";
import { ToolCallChip } from "./tool-call.tsx";
import { type BrowserCallPage, type BrowserViewSlot, type BrowsingStep, browserPageOf } from "./transcript-model.ts";
import "./browsing-group.css";

// A run of browser calls as one quiet line: "Browsing, 12 steps" and what the agent is doing now ("Scrolling the
// page"). It never grows while the agent works, so the transcript stays still: the browser itself is shown in one
// place by the host (a panel beside the transcript, see `BrowserLiveView`), not as a screenshot per step. Opening the
// line lists every step, with the words the agent said between them; a step's screenshots are in its own detail.
// For a host with a panel, the browser the run used is a card under the line (`BrowserEntry`): the page it was on,
// its last screenshot, live or replay; clicking it shows the browser in the panel. A transcript gives each browser one
// card, on the run that opened it (`browserEntrySlots`), with the browser's newest page.

const isCall = (step: BrowsingStep): step is ToolItem => step.kind === "tool";
const isFailed = (item: ToolItem): boolean => item.status === "error" || item.status === "interrupted";

/**
 * "Browsing, 12 steps" while it runs; "Browsed for 48s, 12 steps" once every call has finished. `active`: the run may
 * still take steps (its turn is working and nothing but the agent's words came after it), so it still reads as running
 * between two calls, while the agent thinks or narrates.
 */
export function browsingSummary(calls: readonly ToolItem[], active = false): string {
	const steps = calls.length === 1 ? "1 step" : `${calls.length} steps`;
	if (calls.length === 0) return "Browsing";
	if (active || calls.some((call) => call.status === "running")) return `Browsing, ${steps}`;
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const call of calls) {
		start = Math.min(start, call.at);
		end = Math.max(end, call.endedAt ?? call.at);
	}
	return `Browsed for ${duration(end - start)}, ${steps}`;
}

/** The page the run left its browser on, and the last screenshot it took, as far as its calls say. */
export function browsingPage(calls: readonly ToolItem[]): {
	page: BrowserCallPage | undefined;
	screenshot: ToolImage | undefined;
} {
	let page: BrowserCallPage | undefined;
	let screenshot: ToolImage | undefined;
	for (const call of calls) {
		page = browserPageOf(call) ?? page;
		screenshot = call.images?.at(-1) ?? screenshot;
	}
	return { page, screenshot };
}

/** The browser the run's calls used most recently, if any has said. */
export function browsingBrowser(calls: readonly ToolItem[]): string | undefined {
	for (let index = calls.length - 1; index >= 0; index--) {
		const id = calls[index]?.browserSessionId;
		if (id !== undefined) return id;
	}
	return undefined;
}

export type BrowsingGroupProps = {
	/** The browser calls, with the agent's words between them, in order (a `browsing` transcript row's items). */
	items: readonly BrowsingStep[];
	/**
	 * Shows the browser this run used in the host's one place for it (a panel): a "Show browser" button on the line.
	 * Without it, the line has none.
	 */
	onShowBrowser?: (browserSessionId: string) => void;
	/** The browser the host's panel shows now: when it is this run's, its card says it is showing. */
	shownBrowser?: string;
	/**
	 * Where this run's browser is, as the host knows (live, or closed with a replay): what its card says and offers.
	 * Without it, the card goes by the calls: closed after a `browser_close`, live while the run is running.
	 */
	browserState?: BrowserEntryState;
	/**
	 * The browser's card, as the whole transcript knows it: its newest page and screenshot from every run. `null`: another
	 * run has this browser's card, so this one shows none. Without it, the card goes by this run's calls alone.
	 */
	browserEntry?: BrowserViewSlot | null;
	/**
	 * A view of the browser under the line, for a host with no panel (usually a `BrowserLiveView`). It stays in the same
	 * place however many steps the run takes.
	 */
	browserView?: ReactNode;
	/** The ID of the call a link names (`#turn=`): the run opens to show it, and it stands out briefly. */
	focus?: string;
	/**
	 * The run may still take steps: its turn is working and only the agent's words came after it. It reads as running
	 * between calls too, so the line doesn't flip between "Browsing" and "Browsed for" at every step.
	 */
	active?: boolean;
};

/**
 * A browsing run, folded to one line by default, also while it runs. Failed and interrupted calls stay visible under
 * the line while it is folded, so a failure is never hidden. Memoised on `items`.
 */
export const BrowsingGroup = memo(function BrowsingGroup({
	items,
	onShowBrowser,
	shownBrowser,
	browserState,
	browserEntry,
	browserView,
	focus,
	active = false,
}: BrowsingGroupProps) {
	useRenderProbe("BrowsingGroup", items[0]?.id ?? "");
	const [open, setOpen] = useState(focus !== undefined);
	useEffect(() => {
		if (focus !== undefined) setOpen(true);
	}, [focus]);
	const id = useId();
	const calls = items.filter(isCall);
	const running = calls.findLast((call) => call.status === "running");
	const current = running ?? calls.at(-1);
	const busy = running !== undefined || active;
	const browser = browsingBrowser(calls);
	const failed = calls.filter(isFailed);
	const chip = (call: ToolItem) => (
		<ToolCallChip key={call.id} item={call} images="detail" linked={call.id === focus} />
	);
	return (
		<div className={`hb-browsing${open ? " hb-browsing-open" : ""}${busy ? " hb-browsing-running" : ""}`}>
			<div className="hb-browsing-line">
				<button
					type="button"
					className="hb-browsing-summary hb-focusable"
					aria-expanded={open}
					aria-controls={open ? id : undefined}
					onClick={() => setOpen((value) => !value)}
				>
					<span className="hb-browsing-icon">
						{busy ? (
							<>
								<Spinner />
								<span className="hb-sr-only">Running</span>
							</>
						) : (
							<GlobeIcon />
						)}
					</span>
					<span className="hb-browsing-text">
						<span className="hb-browsing-title">{browsingSummary(calls, active)}</span>
						{current === undefined ? null : <span className="hb-browsing-current">{current.label}</span>}
					</span>
					<ChevronRightIcon size="sm" className="hb-browsing-chevron" />
				</button>
			</div>
			{onShowBrowser === undefined || browserEntry === null ? null : browserEntry !== undefined ? (
				<SlotBrowser
					slot={browserEntry}
					busy={busy}
					shown={browserEntry.browserSessionId === shownBrowser}
					state={browserState}
					onShow={() => onShowBrowser(browserEntry.browserSessionId)}
				/>
			) : browser === undefined ? null : (
				<RunBrowser
					calls={calls}
					busy={busy}
					shown={browser === shownBrowser}
					state={browserState}
					onShow={() => onShowBrowser(browser)}
				/>
			)}
			{open ? (
				<div id={id} className="hb-browsing-steps">
					{items.map((step) => (isCall(step) ? chip(step) : <BrowsingNote key={step.id} item={step} />))}
				</div>
			) : failed.length > 0 ? (
				<div className="hb-browsing-failed">{failed.map(chip)}</div>
			) : null}
			{browserView}
		</div>
	);
});

/** The run's browser as a card: its page and last screenshot from the run's calls, and where it is now. */
function RunBrowser({
	calls,
	busy,
	shown,
	state,
	onShow,
}: {
	calls: readonly ToolItem[];
	busy: boolean;
	shown: boolean;
	state: BrowserEntryState | undefined;
	onShow: () => void;
}) {
	const { page, screenshot } = browsingPage(calls);
	const closed = calls.some((call) => call.name === "browser_close" && call.status === "done");
	const known = state ?? (closed ? "ended" : busy ? "live" : "unknown");
	return (
		<BrowserEntry
			page={page}
			{...(screenshot === undefined ? {} : { screenshot })}
			state={known}
			shown={shown}
			onShow={shown ? () => {} : onShow}
		/>
	);
}

/** A browser's card from what the whole transcript says of it: its newest page and screenshot, and where it is now. */
function SlotBrowser({
	slot,
	busy,
	shown,
	state,
	onShow,
}: {
	slot: BrowserViewSlot;
	busy: boolean;
	shown: boolean;
	state: BrowserEntryState | undefined;
	onShow: () => void;
}) {
	const known = state ?? (slot.closed === true ? "ended" : busy ? "live" : "unknown");
	return (
		<BrowserEntry
			page={slot.page}
			{...(slot.screenshot === undefined ? {} : { screenshot: slot.screenshot })}
			state={known}
			shown={shown}
			onShow={shown ? () => {} : onShow}
		/>
	);
}

/** What the agent said between two steps, as it said it, quieter than an answer. */
function BrowsingNote({ item }: { item: AssistantItem }) {
	return (
		<div className="hb-browsing-note">
			<AssistantMessage item={item} actions={false} />
		</div>
	);
}
