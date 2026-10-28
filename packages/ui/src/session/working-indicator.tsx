import { memo } from "react";
import { StatusDot } from "../primitives/status.tsx";
import { Elapsed } from "../primitives/time.tsx";
import "./working-indicator.css";

// The turn's working state, after T3 Code's working row (TimelineWorkGroupRows.tsx:274-308): while the agent works on
// a turn, the transcript ends with "Working for 12s", from the moment the message is sent until the run settles, not
// only before the first word. The dot is the working status's pulsing dot, centred on the capitals of the words beside
// it; the words shimmer softly, so the row reads as live even when nothing else on screen has moved for a while.

export type WorkingIndicatorProps = {
	/** When the turn started (epoch ms): the timer counts from it. Without it the row says the label alone. */
	since?: number | undefined;
	/** What the agent is doing, in a word or two. Default "Working". */
	label?: string;
};

/**
 * A live "Working for 12s" row with the working dot. Only the `Elapsed` leaf renders each second, on the shared clock.
 * With a time it is a `role="timer"` named after the label, whose implicit aria-live is off, so screen readers can read
 * it but are not told every second; without one it is a polite status, announced once.
 */
export const WorkingIndicator = memo(function WorkingIndicator({ since, label = "Working" }: WorkingIndicatorProps) {
	const timed = since !== undefined;
	return (
		<div
			className="hb-working-indicator"
			{...(timed ? { role: "timer", "aria-label": label } : { role: "status" })}
			data-working=""
		>
			<StatusDot status="working" />
			<span className="hb-working-indicator-text">
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
