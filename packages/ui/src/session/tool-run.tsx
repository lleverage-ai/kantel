import type { AssistantItem, ToolItem } from "@harbour/protocol";
import { memo, type ReactNode, useEffect, useId, useState } from "react";
import { ChevronRightIcon, type IconProps } from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Spinner } from "../primitives/spinner.tsx";
import { AssistantMessage } from "./message.tsx";
import { ToolCallChip, toolIcon } from "./tool-call.tsx";
import type { ToolRun } from "./tool-renderer-model.ts";
import type { RunStep } from "./transcript-model.ts";
import "./tool-run.css";

// A run of calls that reads as one thing (`ToolRenderer.run`, tool-renderer-model.ts), such as a browsing run: one
// quiet line in the turn, as T3 Code's work log keeps a turn's work to lines a person scans (WorkLog.tsx). While it
// runs, the line says what the run is doing now ("Browsing kayak.co.uk, Reading the page"); once done, how it went
// ("Browsed kayak.co.uk for 2m 37s, 15 steps, 4 failed"), from every call, never from its last. It never grows while
// the agent works, so the transcript under the reader stays still.
//
// Opening the line lists the steps, one level under it: each call is the generic row (tool-call.tsx) with its entry's
// label, note and detail, so a step reads as what it did, a failed one says why under its row, and its detail is
// the entry's compact card with the raw arguments and output one switch away. The agent's words between two steps
// stay as it said them, in view among the steps; a thought with no words (a "Thought it through" row elsewhere) folds
// into the detail of the step it led to, so the steps stay the list's spine.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css): the line is a tool call's row, the same height and colours.
// The hb- class names stay as hooks for tests and other stylesheets; tool-run.css indents a view under the line.

/** The run: its line, what the run has under it, its steps when open, and a view. */
const runClass = "hb-run flex min-w-0 flex-col";
/** The line's button: the whole line opens and closes the steps. */
const lineClass =
	"hb-run-line hb-focusable -ml-1.5 flex min-h-control-xs w-[calc(100%_+_var(--hb-step-1_5)*2)] min-w-0 cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-1.5 py-0.5 text-left text-sm leading-tight text-muted [font-family:inherit] [font-feature-settings:inherit] [font-weight:inherit] hover:bg-hover hover:text-fg";
/**
 * One line of words, the title, then what it is doing or how many steps and how many failed, clipped at its end when
 * narrow. Trimmed to its capitals as a tool row's label is, so the icon, the words and the chevron share one centre.
 */
const lineText = "hb-run-text min-w-0 flex-1 truncate py-(--hb-trim-room) [text-box:trim-both_cap_alphabetic]";

const isCall = (step: RunStep): step is ToolItem => step.kind === "tool";

/** A step of the list: a call with the thought that led to it, or the agent's words between two calls. */
type ListStep =
	| { readonly kind: "call"; readonly item: ToolItem; readonly thought: string | undefined }
	| { readonly kind: "words"; readonly item: AssistantItem };

/**
 * The run's steps as the list shows them: each call with the thoughts since the call before it (a thought folds into
 * the step it led to), and the agent's words where it said them.
 */
export function runListSteps(items: readonly RunStep[]): readonly ListStep[] {
	const list: ListStep[] = [];
	let thoughts: string[] = [];
	for (const item of items) {
		if (item.kind === "tool") {
			const thought = thoughts.join("\n\n").trim();
			list.push({ kind: "call", item, thought: thought === "" ? undefined : thought });
			thoughts = [];
			continue;
		}
		if (item.thinking !== undefined && item.thinking.trim() !== "") thoughts.push(item.thinking.trim());
		if (item.text.trim() !== "" || item.document !== undefined)
			list.push({ kind: "words", item: withoutThought(item) });
	}
	return list;
}

/** The agent's words without its thought, which goes into the step it led to. */
function withoutThought(item: AssistantItem): AssistantItem {
	if (item.thinking === undefined) return item;
	const { thinking: _thought, ...words } = item;
	return words;
}

export type ToolRunRowProps = {
	/** The run's calls, with the agent's words between them, in order (a `run` transcript row's items). */
	items: readonly RunStep[];
	/** The run's entry (`ToolRun`): its line's words, its icon and what it has under the line. */
	run: ToolRun;
	/**
	 * The run may still take steps: its turn is working and only the agent's words came after it. It reads as running
	 * between calls too, so the line doesn't flip between running and done at every step.
	 */
	active?: boolean;
	/** The ID of the call a link names (`#turn=`): the run opens to show it, and it stands out briefly. */
	focus?: string;
	/** Under the line and anything the run has under it, open or not: a host's view (a browser's live view). */
	view?: ReactNode;
	/** The list starts open. */
	defaultOpen?: boolean;
};

/** A run of calls as one line, its steps one switch away. Memoised on `items`. */
export const ToolRunRow = memo(function ToolRunRow({
	items,
	run,
	active = false,
	focus,
	view,
	defaultOpen = false,
}: ToolRunRowProps) {
	const rowId = items[0]?.id ?? "";
	useRenderProbe("ToolRunRow", rowId);
	const [open, setOpen] = useState(defaultOpen || focus !== undefined);
	useEffect(() => {
		if (focus !== undefined) setOpen(true);
	}, [focus]);
	const id = useId();
	const calls = items.filter(isCall);
	const busy = active || calls.some((call) => call.status === "running");
	const { title, detail, failed } = run.summary(calls, { running: busy });
	const first = calls[0];
	const Icon: (props: IconProps) => ReactNode = run.icon ?? toolIcon(first?.name ?? "");
	const Under = run.under;
	return (
		<div className={`${runClass} hb-run-${run.id}${open ? " hb-run-open" : ""}${busy ? " hb-run-running" : ""}`}>
			<button
				type="button"
				className={lineClass}
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="hb-run-icon inline-flex size-icon-md flex-none items-center justify-center text-faint">
					{busy ? (
						<>
							<Spinner />
							<span className="hb-sr-only">Running</span>
						</>
					) : (
						<Icon />
					)}
				</span>
				<span className={lineText}>
					{/* Running, the title in the text colour, as a running call's label. */}
					<span className={`hb-run-title ${busy ? "text-fg" : ""}`}>{title}</span>
					{detail === undefined ? null : <span className="hb-run-detail text-faint">, {detail}</span>}
					{failed === undefined || failed === 0 ? null : (
						<span className="hb-run-failed text-status-error">, {failed} failed</span>
					)}
				</span>
				<ChevronRightIcon
					size="sm"
					className={`hb-run-chevron flex-none text-faint transition-transform ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{Under === undefined ? null : <Under rowId={rowId} calls={calls} busy={busy} />}
			{open ? (
				// One level under the line, the steps in line with its words.
				<div id={id} className="hb-run-steps flex min-w-0 flex-col pb-1 pl-6">
					{runListSteps(items).map((step) =>
						step.kind === "call" ? (
							<ToolCallChip
								key={step.item.id}
								item={step.item}
								images="detail"
								linked={step.item.id === focus}
								{...(step.thought === undefined ? {} : { thought: step.thought })}
							/>
						) : (
							<RunWords key={step.item.id} item={step.item} />
						),
					)}
				</div>
			) : null}
			{view}
		</div>
	);
});

/** What the agent said between two steps, as it said it, a size down and muted, so the steps stay the list's spine. */
function RunWords({ item }: { item: AssistantItem }) {
	return (
		<div className="hb-run-words py-1 text-sm text-muted">
			<AssistantMessage item={item} actions={false} />
		</div>
	);
}
