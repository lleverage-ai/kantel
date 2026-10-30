import type { ToolItemStatus } from "@harbour/protocol";
import { memo, type ReactNode } from "react";
import { IconButton } from "../primitives/button.tsx";
import { duration } from "../primitives/format.ts";
import { ChevronRightIcon, StopIcon } from "../primitives/icons.tsx";
import { StatusDot } from "../primitives/status.tsx";
import { Elapsed } from "../primitives/time.tsx";
import type { Status } from "../tokens/tokens.ts";
import "./subagent-card.css";

// A subagent in the thread: the task an agent handed to a session of its own, as one card that opens that session.
// After T3 Code's subagent timeline link (V2LifecycleRow.tsx, SubagentTimelineLink): a status dot, the title, one
// line of detail (what it is doing now while it works, as T3's progress line, else its task; its answer once done), the status in words with how long it has taken, and
// a chevron when it opens. The card is the link: the whole of it goes to the subagent's own session, which streams.
// A working card can also be stopped, as T3 Code's agents list stops a subagent: a small ghost button with a filled
// square, before the chevron. A link can't hold a button, so a stoppable card lays its link over the whole card
// instead, with the button above it.
// Which calls are subagents, and what the card says about one, is in subagent-model.ts.

const STATUS: Record<ToolItemStatus, { readonly status: Status; readonly words: string }> = {
	running: { status: "working", words: "Working" },
	done: { status: "done", words: "Done" },
	error: { status: "error", words: "Failed" },
	interrupted: { status: "idle", words: "Stopped" },
};

export type SubagentCardProps = {
	readonly title: string;
	/** The task it was given: the detail line while it works, and when it ended without saying anything. */
	readonly task?: string | undefined;
	/** The opening of its answer, once it has one: the detail line then. */
	readonly summary?: string | undefined;
	/**
	 * What it is doing now, while it works (`subagentActivity` of its own session: "Reading billing/refund.ts", or
	 * "Waiting on its subagent: Partial refunds"): the detail line in place of the task. Ignored once it has ended.
	 */
	readonly activity?: string | undefined;
	readonly status: ToolItemStatus;
	/** When it started (the call's time), for "Working 1m 12s". */
	readonly startedAt: number;
	/** When it ended, for "Done in 1m 12s". */
	readonly endedAt?: number | undefined;
	/** Its session: the card is a link to it. Without it (or `onOpen`) the card can't be opened yet. */
	readonly href?: string | undefined;
	/** Opens its session, when there's no link. */
	readonly onOpen?: (() => void) | undefined;
	/**
	 * Stops the subagent (and any subagents of its own), while it works: the card shows a Stop button. Without it, or
	 * once it has ended, there's none.
	 */
	readonly onStop?: (() => void) | undefined;
	/** A stop has been asked for and hasn't landed yet: the button turns and can't be pressed again. */
	readonly stopping?: boolean | undefined;
};

function Timing({ status, startedAt, endedAt }: Pick<SubagentCardProps, "status" | "startedAt" | "endedAt">) {
	if (status === "running") return <Elapsed since={startedAt} />;
	if (endedAt === undefined) return null;
	return <span className="hb-time">{duration(endedAt - startedAt)}</span>;
}

/**
 * A subagent's card in the thread. Running, it says "Working" with a live timer and what it is doing now (its task
 * until it has started); done, its answer's opening; failed or stopped, which, with the task. It opens the subagent's session when given `href` or `onOpen`, and while it works it can be stopped when given `onStop`.
 */
export const SubagentCard = memo(function SubagentCard({
	title,
	task,
	summary,
	activity,
	status,
	startedAt,
	endedAt,
	href,
	onOpen,
	onStop,
	stopping = false,
}: SubagentCardProps) {
	const { status: tone, words } = STATUS[status];
	const detail =
		status === "done" ? (summary ?? task) : status === "running" ? (activity ?? task ?? summary) : (task ?? summary);
	const live = status === "running" && activity !== undefined;
	const opens = href !== undefined || onOpen !== undefined;
	const stoppable = status === "running" && onStop !== undefined;
	const openLabel = `Open subagent: ${title}, ${words.toLowerCase()}`;
	const body: ReactNode = (
		<>
			<span className="hb-subagent-head">
				<StatusDot status={tone} />
				<span className="hb-subagent-title">{title}</span>
				<span className={`hb-subagent-status hb-status-${tone}`}>
					<span className="hb-subagent-words">{words}</span>
					<Timing status={status} startedAt={startedAt} endedAt={endedAt} />
				</span>
				{stoppable ? (
					<IconButton
						className="hb-subagent-stop"
						label={`Stop subagent: ${title}`}
						title="Stop subagent"
						icon={<StopIcon />}
						variant="ghost"
						size="xs"
						busy={stopping}
						onClick={onStop}
					/>
				) : null}
				{opens ? <ChevronRightIcon className="hb-subagent-chevron" /> : null}
			</span>
			{detail === undefined ? null : (
				<span className={`hb-subagent-detail${live ? " hb-subagent-activity" : ""}`}>{detail}</span>
			)}
		</>
	);
	if (stoppable) {
		// The link lies over the card, under the Stop button: the card still opens from anywhere but the button.
		return (
			<div
				className={`hb-subagent-card hb-subagent-${status} hb-subagent-stoppable${opens ? " hb-subagent-opens" : ""}`}
			>
				{href !== undefined ? (
					<a className="hb-subagent-link hb-focusable" href={href}>
						<span className="hb-sr-only">{openLabel}</span>
					</a>
				) : onOpen !== undefined ? (
					<button type="button" className="hb-subagent-link hb-focusable" onClick={onOpen}>
						<span className="hb-sr-only">{openLabel}</span>
					</button>
				) : null}
				{body}
			</div>
		);
	}
	const className = `hb-subagent-card hb-subagent-${status}${opens ? " hb-subagent-opens hb-focusable" : ""}`;
	if (href !== undefined) {
		return (
			<a className={className} href={href} aria-label={openLabel}>
				{body}
			</a>
		);
	}
	if (onOpen !== undefined) {
		return (
			<button type="button" className={className} onClick={onOpen} aria-label={openLabel}>
				{body}
			</button>
		);
	}
	return <div className={className}>{body}</div>;
});
