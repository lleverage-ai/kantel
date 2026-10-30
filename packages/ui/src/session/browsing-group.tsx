import type { AssistantItem, ToolItem } from "@harbour/protocol";
import { memo, type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { duration } from "../primitives/format.ts";
import { ChevronRightIcon, GlobeIcon } from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Spinner } from "../primitives/spinner.tsx";
import { AssistantMessage } from "./message.tsx";
import { ToolCallChip } from "./tool-call.tsx";
import type { BrowsingStep } from "./transcript-model.ts";
import "./browsing-group.css";

// A run of browser calls as one quiet line: "Browsing, 12 steps" and what the agent is doing now ("Scrolling the
// page"). It never grows while the agent works, so the transcript stays still: the browser itself is shown in one
// place by the host (a panel beside the transcript, see `BrowserLiveView`), not as a screenshot per step. Opening the
// line lists every step, with the words the agent said between them; a step's screenshots are in its own detail.

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
	/** The browser the host's panel shows now: when it is this run's, the line has no "Show browser". */
	shownBrowser?: string;
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
				{onShowBrowser === undefined || browser === undefined || browser === shownBrowser ? null : (
					<Button variant="ghost" size="xs" className="hb-browsing-show" onClick={() => onShowBrowser(browser)}>
						Show browser
					</Button>
				)}
			</div>
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

/** What the agent said between two steps, as it said it, quieter than an answer. */
function BrowsingNote({ item }: { item: AssistantItem }) {
	return (
		<div className="hb-browsing-note">
			<AssistantMessage item={item} actions={false} />
		</div>
	);
}
