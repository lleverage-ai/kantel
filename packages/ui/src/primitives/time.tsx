import { useNow } from "./clock.ts";
import { compactAge, DAY, duration, MINUTE } from "./format.ts";

const absolute = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

/**
 * A compact age ("4m") with the full date and time on hover. It re-renders once a minute, on the page's one shared
 * clock, and only while the age is under a day; older times never change and cost nothing.
 */
export function RelativeTime({ at }: { at: number }) {
	const now = useNow(MINUTE, Date.now() - at < DAY);
	return (
		<time className="hb-time" dateTime={new Date(at).toISOString()} title={absolute.format(at)}>
			{compactAge(at, now)}
		</time>
	);
}

/** Elapsed time since `since`, ticking each second until `until` is set: "3m 20s". */
export function Elapsed({ since, until }: { since: number; until?: number }) {
	const now = useNow(1000, until === undefined);
	return <span className="hb-time">{duration((until ?? now) - since)}</span>;
}
