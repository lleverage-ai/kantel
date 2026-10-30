import type { ToolItemStatus } from "@harbour/protocol";
import { memo, type ReactNode } from "react";
import { duration } from "../primitives/format.ts";
import { BotIcon, ChevronRightIcon } from "../primitives/icons.tsx";
import { Badge, StatusDot } from "../primitives/status.tsx";
import { Elapsed } from "../primitives/time.tsx";
import type { Status } from "../tokens/tokens.ts";
import "./subagent-card.css";

// A subagent in the thread: the task an agent handed to a session of its own, as one card that opens that session.
// After T3 Code's subagent timeline link (V2LifecycleRow.tsx, SubagentTimelineLink, with its SubagentAvatar): a round
// avatar with a bot in it and the status as a dot on its corner, a "Subagent" tag so it can't be mistaken for any other
// card, the title, one line of detail (the task while it works, its answer once done), the status in words with how
// long it has taken, and a chevron when it opens. The card is the link: the whole of it goes to the subagent's own
// session, which streams. Which calls are subagents, and what the card says about one, is in subagent-model.ts.

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
	readonly status: ToolItemStatus;
	/** When it started (the call's time), for "Working 1m 12s". */
	readonly startedAt: number;
	/** When it ended, for "Done 1m 12s". */
	readonly endedAt?: number | undefined;
	/** Its session: the card is a link to it. Without it (or `onOpen`) the card can't be opened yet. */
	readonly href?: string | undefined;
	/** Opens its session, when there's no link. */
	readonly onOpen?: (() => void) | undefined;
};

function Timing({ status, startedAt, endedAt }: Pick<SubagentCardProps, "status" | "startedAt" | "endedAt">) {
	if (status === "running") return <Elapsed since={startedAt} />;
	if (endedAt === undefined) return null;
	return <span className="hb-time">{duration(endedAt - startedAt)}</span>;
}

/**
 * Who is working: a bot in a ring, after T3 Code's SubagentAvatar, with the status as a dot on its corner (pulsing while
 * it works). Working, the ring takes the working tone too, so a live subagent stands out from finished ones.
 */
function SubagentAvatar({ tone }: { tone: Status }) {
	return (
		<span className={`hb-subagent-avatar hb-status-${tone}`} aria-hidden>
			<BotIcon size="sm" />
			<StatusDot status={tone} />
		</span>
	);
}

/**
 * A subagent's card in the thread. Running, it says "Working" with a live timer and its task; done, its answer's
 * opening; failed or stopped, which, with the task. It opens the subagent's session when given `href` or `onOpen`.
 */
export const SubagentCard = memo(function SubagentCard({
	title,
	task,
	summary,
	status,
	startedAt,
	endedAt,
	href,
	onOpen,
}: SubagentCardProps) {
	const { status: tone, words } = STATUS[status];
	const detail = status === "done" ? (summary ?? task) : (task ?? summary);
	const opens = href !== undefined || onOpen !== undefined;
	const body: ReactNode = (
		<>
			<span className="hb-subagent-head">
				<SubagentAvatar tone={tone} />
				<Badge>Subagent</Badge>
				<span className="hb-subagent-title">{title}</span>
				<span className={`hb-subagent-status hb-status-${tone}`}>
					<span className="hb-subagent-words">{words}</span>
					<Timing status={status} startedAt={startedAt} endedAt={endedAt} />
				</span>
				{opens ? <ChevronRightIcon className="hb-subagent-chevron" /> : null}
			</span>
			{detail === undefined ? null : (
				// One line; the whole of it on hover, and in the subagent's session.
				<span className="hb-subagent-detail" title={detail}>
					{detail}
				</span>
			)}
		</>
	);
	const className = `hb-subagent-card hb-subagent-${status}${opens ? " hb-subagent-opens hb-focusable" : ""}`;
	const label = `Open subagent: ${title}, ${words.toLowerCase()}`;
	if (href !== undefined) {
		return (
			<a className={className} href={href} aria-label={label}>
				{body}
			</a>
		);
	}
	if (onOpen !== undefined) {
		return (
			<button type="button" className={className} onClick={onOpen} aria-label={label}>
				{body}
			</button>
		);
	}
	return <div className={className}>{body}</div>;
});
