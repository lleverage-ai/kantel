import type { ToolImage, ToolItem } from "@kantel/protocol";
import { createContext, useContext } from "react";
import { GlobeIcon } from "../primitives/icons.tsx";
import { BrowserEntry, type BrowserEntryState } from "./browser-entry.tsx";
import {
	BROWSER_TOOLS,
	browserStepFailed,
	browserStepLabel,
	browserStepReason,
	browsingRunSummary,
	siteOf,
} from "./browser-steps.ts";
import { openImage, retryToolImage, toolImageSize, toolImageSrc } from "./tool-call.tsx";
import type { ToolDetailProps, ToolRenderer, ToolRun, ToolRunUnderProps } from "./tool-renderer-model.ts";
import { ToolCard } from "./tool-views.tsx";
import { type BrowserCallPage, type BrowserViewSlot, browserPageOf } from "./transcript-model.ts";

// The browser's tools (`@kantel/browser`) in the tool renderer registry (tool-renderer-model.ts), as the file and
// shell tools are (tool-views.tsx): one entry, for every tool whose name starts `browser_`. Their calls form a run
// (`ToolRun`): one line in the turn that says how the run went ("Browsed kayak.co.uk for 2m 37s, 15 steps, 4
// failed"), with the browser's card under it for a host with a panel. Each step is the generic row, named by what it
// did from its own result ("Clicked “Reject all”", browser-steps.ts), a failed one with why under it, and its detail
// is a compact card: the page, what it did and its screenshot, with the raw arguments and output one switch away.

/** What the host knows of its browsers, for the browser's card under a run (`BrowsingCard`). */
export type BrowserRunHost = {
	/** Shows a browser in the host's one place for it (a panel). Without it, a run has no card. */
	readonly onShowBrowser?: ((browserSessionId: string) => void) | undefined;
	/** The browser the host's panel shows now: its card says it is in the panel. */
	readonly shownBrowser?: string | undefined;
	/** Where the run's browser is (live, or closed with a replay). Without it, the card goes by the calls. */
	readonly browserState?: BrowserEntryState | undefined;
	/**
	 * The browser's card as the whole transcript knows it (`browserEntrySlots`): its newest page and screenshot from
	 * every run. `null`: another run has this browser's card, so this one shows none. Without it, the card goes by this
	 * run's calls alone.
	 */
	readonly browserEntry?: BrowserViewSlot | null | undefined;
};

/** The host's browsers, for the run a row renders (transcript.tsx gives each run row its own). */
export const BrowserRunContext = createContext<BrowserRunHost>({});

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

/** The run's browser as a card under its line, for a host with a panel: its page, last screenshot and where it is. */
function BrowsingCard({ calls, busy }: ToolRunUnderProps) {
	const { onShowBrowser, shownBrowser, browserState, browserEntry } = useContext(BrowserRunContext);
	if (onShowBrowser === undefined || browserEntry === null) return null;
	if (browserEntry !== undefined) {
		const shown = browserEntry.browserSessionId === shownBrowser;
		return (
			<BrowserEntry
				page={browserEntry.page}
				{...(browserEntry.screenshot === undefined ? {} : { screenshot: browserEntry.screenshot })}
				state={browserState ?? (browserEntry.closed === true ? "ended" : busy ? "live" : "unknown")}
				shown={shown}
				onShow={shown ? () => {} : () => onShowBrowser(browserEntry.browserSessionId)}
			/>
		);
	}
	const browser = browsingBrowser(calls);
	if (browser === undefined) return null;
	const { page, screenshot } = browsingPage(calls);
	const closed = calls.some((call) => call.name === "browser_close" && call.status === "done");
	const shown = browser === shownBrowser;
	return (
		<BrowserEntry
			page={page}
			{...(screenshot === undefined ? {} : { screenshot })}
			state={browserState ?? (closed ? "ended" : busy ? "live" : "unknown")}
			shown={shown}
			onShow={shown ? () => {} : () => onShowBrowser(browser)}
		/>
	);
}

/** A section of a step's card: a quiet label over its words. */
const section = "kt-browser-step-section flex min-w-0 flex-col gap-0.5";
const sectionLabel = "text-xs text-faint";

/**
 * A browser step's detail: a compact card with the page it left (its title, and its address as a link), what the
 * step did or why it failed, the thought that led to it and its screenshot, with the raw arguments and output one
 * switch away.
 */
function BrowserStepDetail({ item, thought, raw, showRaw, onShowRawChange }: ToolDetailProps) {
	const page = browserPageOf(item);
	const site = siteOf(page?.url);
	const failed = browserStepFailed(item);
	const reason = browserStepReason(item);
	const screenshot = item.images?.at(-1);
	return (
		<ToolCard
			item={item}
			icon={<GlobeIcon size="sm" />}
			title={<span className="truncate text-fg">{page?.title ?? site ?? browserStepLabel(item)}</span>}
			meta={page?.title === undefined || site === undefined ? undefined : <span>{site}</span>}
			{...(page?.url === undefined ? {} : { copy: { text: page.url, label: "Copy the address" } })}
			raw={showRaw}
			onRawChange={onShowRawChange}
		>
			{showRaw ? (
				raw
			) : (
				<div className="kt-browser-step flex min-w-0 gap-3 px-3 py-2.5">
					{screenshot === undefined ? null : (
						<button
							type="button"
							className="kt-browser-step-shot kt-focusable block w-32 flex-none cursor-zoom-in self-start overflow-hidden rounded-sm border border-border-strong bg-sunken p-0 hover:border-faint"
							title="Open full size"
							onClick={() => openImage(screenshot)}
						>
							<img
								className="block h-auto w-full"
								src={toolImageSrc(screenshot)}
								{...toolImageSize(screenshot)}
								alt={`The page after ${browserStepLabel(item)}`}
								loading="lazy"
								decoding="async"
								onError={retryToolImage}
							/>
						</button>
					)}
					<div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
						<div className={section}>
							<div className={sectionLabel}>{item.status === "running" ? "Doing" : failed ? "Failed" : "Did"}</div>
							<p className={`m-0 wrap-anywhere ${failed ? "text-status-error" : "text-fg"}`}>
								{browserStepLabel(item)}
								{reason === undefined ? null : <span className="block text-xs">{reason}</span>}
							</p>
						</div>
						{page?.url === undefined ? null : (
							<div className={section}>
								<div className={sectionLabel}>Page</div>
								<a
									className="kt-browser-step-url kt-focusable truncate text-xs text-muted hover:text-fg"
									href={page.url}
									target="_blank"
									rel="noreferrer noopener"
									title={page.url}
								>
									{page.url}
								</a>
							</div>
						)}
						{thought === undefined ? null : (
							<div className={section}>
								<div className={sectionLabel}>Thought</div>
								<p className="kt-browser-step-thought m-0 text-xs leading-normal whitespace-pre-wrap text-muted wrap-anywhere">
									{thought}
								</p>
							</div>
						)}
					</div>
				</div>
			)}
		</ToolCard>
	);
}

/** A browsing run (`ToolRun`): its line, from every call (browser-steps.ts), and its browser's card under it. */
export const BROWSER_RUN: ToolRun = {
	id: "browser",
	summary: browsingRunSummary,
	icon: () => <GlobeIcon />,
	under: BrowsingCard,
};

/** The browser's tools' entry in the tool renderer registry. */
export const browserToolRenderers: readonly ToolRenderer[] = [
	{
		tools: BROWSER_TOOLS,
		run: BROWSER_RUN,
		label: browserStepLabel,
		note: browserStepReason,
		detail: (props) => <BrowserStepDetail {...props} />,
	},
];
