import type { ToolItemStatus } from "@harbour/protocol";
import { memo, type ReactNode } from "react";
import { IconButton } from "../primitives/button.tsx";
import { duration } from "../primitives/format.ts";
import { ChevronRightIcon, StopIcon } from "../primitives/icons.tsx";
import { BotIcon } from "../primitives/lucide.tsx";
import { Badge, StatusDot } from "../primitives/status.tsx";
import { Elapsed } from "../primitives/time.tsx";
import type { Status } from "../tokens/tokens.ts";

// A subagent in the thread: the task an agent handed to a session of its own, as one card that opens that session.
// After T3 Code's subagent timeline link (V2LifecycleRow.tsx, SubagentTimelineLink, with its SubagentAvatar): a round
// avatar with a bot in it and the status as a dot on its corner, a "Subagent" tag so it can't be mistaken for any other
// card, the title, one line of detail (what it is doing now while it works, as T3's progress line, else its task; its
// answer once done), the status in words with how long it has taken, and a chevron when it opens. The card is the
// link: the whole of it goes to the subagent's own session, which streams.
// A working card can also be stopped, as T3 Code's agents list stops a subagent: a small ghost button with a filled
// square, before the chevron. A link can't hold a button, so a stoppable card lays its link over the whole card
// instead, with the button above it.
// Which calls are subagents, and what the card says about one, is in subagent-model.ts.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css). The hb- class names stay as hooks (the console's scripts find
// `.hb-subagent-card.hb-subagent-done` and the like); the hb-status-* classes set the status colour the avatar reads.

/**
 * The card: a quiet framed block, the width of the column. --hb-subagent-surface is what the avatar's status dot is cut
 * out of, so it follows the card's hover. `font: inherit` as its parts, as the card may be a button.
 */
const cardFrame =
	"hb-subagent-card m-0 flex w-full min-w-0 flex-col gap-1 rounded-panel border border-border bg-(--hb-subagent-surface) px-3 py-2.5 text-left text-sm leading-tight text-fg no-underline [--hb-subagent-surface:var(--hb-panel)] [font-family:inherit] [font-feature-settings:inherit] [font-weight:inherit]";
/** A card that opens: the raised surface and the strong border on hover, and the chevron lights up. */
const cardOpens =
	"hb-subagent-opens group/subagent cursor-pointer transition-[background-color,border-color] duration-(--hb-duration-fast) hover:border-border-strong hover:[--hb-subagent-surface:var(--hb-raised)]";
/**
 * The avatar: a bot in a ring, the status as a dot on its lower right, cut out of the card's surface. `!` on the dot's
 * size: .hb-status-dot's own (primitives/status.css) is unlayered and would beat a plain utility.
 */
const avatar =
	"hb-subagent-avatar relative inline-flex size-control-xs flex-none items-center justify-center rounded-full border [&>.hb-status-dot]:absolute [&>.hb-status-dot]:right-[calc(-1*var(--hb-hairline))] [&>.hb-status-dot]:bottom-[calc(-1*var(--hb-hairline))] [&>.hb-status-dot]:size-[calc(var(--hb-dot)_+_var(--hb-step-0_5))]! [&>.hb-status-dot]:[box-shadow:0_0_0_var(--hb-ring)_var(--hb-subagent-surface)]";
/**
 * The words are trimmed to their capitals, as a Button's label is, so the head centres the letters rather than their
 * line boxes: the dot, the title, the status and the chevron share one centre. The padding keeps descenders inside.
 */
const trimmed = "py-(--hb-trim-room) [text-box:trim-both_cap_alphabetic]";
/** The status in words and its time (Elapsed's or Timing's `hb-time`, trimmed and faint). */
const statusWords =
	"hb-subagent-status flex flex-none items-center gap-1.5 text-xs tabular-nums [&>.hb-time]:py-(--hb-trim-room) [&>.hb-time]:text-faint [&>.hb-time]:[text-box:trim-both_cap_alphabetic]";
/**
 * A working card that can be stopped: its link lies over the whole card (a link can't hold the Stop button), and the
 * button sits above the link. The link's ring is the card's outline.
 */
const cardLink =
	"hb-subagent-link hb-focusable absolute inset-[calc(var(--hb-hairline)*-1)] m-0 cursor-pointer rounded-panel border-0 bg-transparent p-0";
/**
 * Stop, after T3 Code's: a ghost square with a filled stop mark, red on hover. It is the avatar's height, so the head
 * keeps its height; on a touch screen it is taller and gives the difference back above and below, so the mark still
 * sits on the head's one centre. `!` on the hover: .hb-button-ghost's own (primitives/button.css) is unlayered and
 * would beat a plain utility.
 */
const stopButton =
	"hb-subagent-stop relative z-1 flex-none hover:enabled:bg-status-error-soft! hover:enabled:text-status-error! pointer-coarse:my-[calc((var(--hb-control-xs)_-_var(--hb-control-lg))/2)]";
/** Under the tag: indented past the avatar and the gap after it. One line; the whole of it is in the session. */
const detailLine =
	"hb-subagent-detail block min-w-0 truncate pl-[calc(var(--hb-control-xs)+var(--hb-step-2))] leading-normal text-muted";

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
	/** When it ended, for "Done 1m 12s". */
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
	// Styled by its row (`statusWords`), as Elapsed's is.
	return <span className="hb-time">{duration(endedAt - startedAt)}</span>;
}

/**
 * Who is working: a bot in a ring, after T3 Code's SubagentAvatar, with the status as a dot on its corner (pulsing while
 * it works). Working, the ring takes the working tone too, so a live subagent stands out from finished ones.
 */
function SubagentAvatar({ tone }: { tone: Status }) {
	const ring =
		tone === "working"
			? "border-(--hb-status-current) bg-(--hb-status-current-soft) text-(--hb-status-current)"
			: "border-border-strong bg-active text-muted";
	return (
		<span className={`${avatar} hb-status-${tone} ${ring}`} aria-hidden>
			<BotIcon size="sm" />
			<StatusDot status={tone} />
		</span>
	);
}

/**
 * A subagent's card in the thread. Running, it says "Working" with a live timer and what it is doing now (its task
 * until it has started); done, its answer's opening; failed or stopped, which, with the task. It opens the subagent's
 * session when given `href` or `onOpen`, and while it works it can be stopped when given `onStop`.
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
	const opens = href !== undefined || onOpen !== undefined;
	const stoppable = status === "running" && onStop !== undefined;
	const openLabel = `Open subagent: ${title}, ${words.toLowerCase()}`;
	const body: ReactNode = (
		<>
			<span className="hb-subagent-head flex min-w-0 items-center gap-2">
				<SubagentAvatar tone={tone} />
				<Badge>Subagent</Badge>
				<span className={`hb-subagent-title min-w-0 flex-[1_1_auto] truncate font-medium ${trimmed}`}>{title}</span>
				<span className={`${statusWords} hb-status-${tone} ${tone === "error" ? "text-status-error" : "text-muted"}`}>
					<span className={`hb-subagent-words ${trimmed}`}>{words}</span>
					<Timing status={status} startedAt={startedAt} endedAt={endedAt} />
				</span>
				{stoppable ? (
					<IconButton
						className={stopButton}
						label={`Stop subagent: ${title}`}
						title="Stop subagent"
						icon={<StopIcon />}
						variant="ghost"
						size="xs"
						busy={stopping}
						onClick={onStop}
					/>
				) : null}
				{opens ? (
					<ChevronRightIcon className="hb-subagent-chevron flex-none text-faint transition-[color] duration-(--hb-duration-fast) group-hover/subagent:text-fg" />
				) : null}
			</span>
			{detail === undefined ? null : (
				// One line; the whole of it on hover, and in the subagent's session.
				<span className={detailLine} title={detail}>
					{detail}
				</span>
			)}
		</>
	);
	if (stoppable) {
		// The link lies over the card, under the Stop button: the card still opens from anywhere but the button.
		return (
			<div className={`${cardFrame} hb-subagent-${status} hb-subagent-stoppable relative ${opens ? cardOpens : ""}`}>
				{href !== undefined ? (
					<a className={cardLink} href={href}>
						<span className="hb-sr-only">{openLabel}</span>
					</a>
				) : onOpen !== undefined ? (
					<button type="button" className={cardLink} onClick={onOpen}>
						<span className="hb-sr-only">{openLabel}</span>
					</button>
				) : null}
				{body}
			</div>
		);
	}
	const className = `${cardFrame} hb-subagent-${status} ${opens ? `${cardOpens} hb-focusable` : ""}`;
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
