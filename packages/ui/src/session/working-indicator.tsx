import { memo, type ReactNode } from "react";
import { BrainIcon } from "../primitives/icons.tsx";
import { Elapsed } from "../primitives/time.tsx";
// Only the activity words' breathing (a keyframe animation) is left in CSS; see the file.
import "./working-indicator.css";

// A working turn's two live rows, after T3 Code's timeline (TimelineWorkGroupRows.tsx:277-309 and 360-420):
//
// - WorkingIndicator, the turn's header: right under the person's message, "Working for 12s" in muted type with a
//   hairline divider under it, from the moment the message is sent until the run settles. Still: only its timer moves.
// - LiveActivity, the turn's foot: what the agent is doing now, an icon and a word or two ("Thinking", with a brain),
//   whose words breathe softly, so the turn reads as live even when nothing else on screen has moved for a while.

export type WorkingIndicatorProps = {
	/** When the turn started (epoch ms): the timer counts from it. Without it the row says the label alone. */
	since?: number | undefined;
	/** What the agent is doing, in a word or two. Default "Working". */
	label?: string;
};

/**
 * The turn's "Working for 12s" header, with the divider under it. Only the `Elapsed` leaf renders each second, on the
 * shared clock. With a time it is a `role="timer"` named after the label, whose implicit aria-live is off, so screen
 * readers can read it but are not told every second; without one it is a polite status, announced once.
 */
export const WorkingIndicator = memo(function WorkingIndicator({ since, label = "Working" }: WorkingIndicatorProps) {
	const timed = since !== undefined;
	return (
		<div
			className="hb-working-indicator flex min-h-control-xs min-w-0 items-center border-b border-border-strong pt-0.5 pb-2 text-sm leading-tight whitespace-nowrap text-muted tabular-nums"
			{...(timed ? { role: "timer", "aria-label": label } : { role: "status" })}
			data-working=""
		>
			<span className="hb-working-indicator-text min-w-0 overflow-hidden text-ellipsis">
				{timed ? (
					<>
						{label} for <Elapsed since={since} />
					</>
				) : (
					label
				)}
			</span>
		</div>
	);
});

export type LiveActivityProps = {
	/** What the agent is doing now. Default "Thinking". */
	label?: ReactNode;
	/** The activity's icon, 16px. Default the brain. */
	icon?: ReactNode;
};

/**
 * The live activity row at the foot of a working turn: an icon and a word or two, the words breathing. "Thinking"
 * with a brain between steps and before the first word; the transcript leaves it out while a call runs or an answer
 * streams, since those show the activity themselves. A polite status, announced once, not on every breath.
 */
export const LiveActivity = memo(function LiveActivity({ label = "Thinking", icon }: LiveActivityProps) {
	return (
		<div
			className="hb-live-activity flex min-h-control-xs min-w-0 items-center gap-2 py-0.5 text-sm leading-tight whitespace-nowrap text-muted"
			role="status"
		>
			<span className="hb-live-activity-icon inline-flex size-icon-md flex-none items-center justify-center text-faint">
				{icon ?? <BrainIcon />}
			</span>
			<span className="hb-live-activity-text min-w-0 overflow-hidden py-(--hb-trim-room) text-ellipsis [text-box:trim-both_cap_alphabetic]">
				{label}
			</span>
		</div>
	);
});
