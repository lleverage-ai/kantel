import type { ToolItem } from "@kantel/protocol";
import { memo, type ReactNode, useContext, useMemo } from "react";
import type { BrowserEntryState } from "./browser-entry.tsx";
import { browsingRunSummary } from "./browser-steps.ts";
import { BROWSER_RUN, BrowserRunContext, type BrowserRunHost } from "./browser-tools.tsx";
import { ToolRenderersContext } from "./tool-renderer-model.ts";
import { DEFAULT_TOOL_RENDERERS } from "./tool-renderers.tsx";
import { ToolRunRow } from "./tool-run.tsx";
import type { BrowserViewSlot, RunStep } from "./transcript-model.ts";

// A browsing run on its own, outside a transcript (a story, a host's own list): the transcript's run row
// (`ToolRunRow`, tool-run.tsx) with the browser's entry in the renderer registry (browser-tools.tsx). A transcript
// renders its runs itself, from the registry; nothing about a browser's calls is special-cased there.

export { browsingBrowser, browsingPage } from "./browser-tools.tsx";

/**
 * A browsing run's line, in words: "Browsing kayak.co.uk, Reading the page" while it runs, "Browsed kayak.co.uk for
 * 2m 37s, 15 steps, 4 failed" once done. `active`: the run may still take steps.
 */
export function browsingSummary(calls: readonly ToolItem[], active = false): string {
	const running = active || calls.some((call) => call.status === "running");
	const { title, detail, failed } = browsingRunSummary(calls, { running });
	return [title, detail, failed === undefined ? undefined : `${failed} failed`]
		.filter((part) => part !== undefined)
		.join(", ");
}

export type BrowsingGroupProps = {
	/** The browser calls, with the agent's thoughts between them, in order (a `run` transcript row's items). */
	items: readonly RunStep[];
	/** Shows the browser this run used in the host's one place for it (a panel): its card. Without it, no card. */
	onShowBrowser?: (browserSessionId: string) => void;
	/** The browser the host's panel shows now: when it is this run's, its card says it is in the panel. */
	shownBrowser?: string;
	/** Where this run's browser is, as the host knows (live, or closed with a replay). */
	browserState?: BrowserEntryState;
	/** The browser's card as the whole transcript knows it; `null` when another run has it. */
	browserEntry?: BrowserViewSlot | null;
	/** A view of the browser under the line, for a host with no panel (usually a `BrowserLiveView`). */
	browserView?: ReactNode;
	/** The ID of the call a link names (`#turn=`): the run opens to show it, and it stands out briefly. */
	focus?: string;
	/** The run may still take steps: its turn is working and only the agent's words came after it. */
	active?: boolean;
	/** The list starts open. */
	defaultOpen?: boolean;
};

/** A browsing run as one line, its steps one switch away. Memoised on `items`. */
export const BrowsingGroup = memo(function BrowsingGroup({
	items,
	onShowBrowser,
	shownBrowser,
	browserState,
	browserEntry,
	browserView,
	focus,
	active = false,
	defaultOpen = false,
}: BrowsingGroupProps) {
	const renderers = useContext(ToolRenderersContext) ?? DEFAULT_TOOL_RENDERERS;
	const host = useMemo<BrowserRunHost>(
		() => ({ onShowBrowser, shownBrowser, browserState, browserEntry }),
		[onShowBrowser, shownBrowser, browserState, browserEntry],
	);
	return (
		<ToolRenderersContext.Provider value={renderers}>
			<BrowserRunContext.Provider value={host}>
				<ToolRunRow
					items={items}
					run={BROWSER_RUN}
					active={active}
					defaultOpen={defaultOpen}
					{...(focus === undefined ? {} : { focus })}
					{...(browserView === undefined ? {} : { view: browserView })}
				/>
			</BrowserRunContext.Provider>
		</ToolRenderersContext.Provider>
	);
});
