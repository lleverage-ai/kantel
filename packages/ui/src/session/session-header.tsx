import type { ReactNode } from "react";
import { Breadcrumbs, type Crumb } from "../primitives/breadcrumbs.tsx";
import { IconButton } from "../primitives/button.tsx";
import { useNow } from "../primitives/clock.ts";
import { ChevronRightIcon } from "../primitives/icons.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css). The kt-session-header, kt-session-header-actions,
// kt-session-header-back and kt-connection classes carry no style of their own: loop/align.ts finds the bar, its
// buttons and the connection's words by them. The rest stay as names for the parts.

/**
 * The bar: one compact row, its sides the narrow gutter at every width (as the file viewer's bar beside it), clear of a
 * notch at the top, with a hairline under it. Tighter gaps on a phone (`max-sm:` is under 640px).
 */
const header =
	"kt-session-header flex min-h-[calc(var(--kt-control-md)+var(--kt-step-2)*2)] min-w-0 items-center gap-2.5 border-b border-border bg-canvas px-gutter-narrow py-2 pt-[max(var(--kt-step-2),env(safe-area-inset-top))] max-sm:gap-1.5";
/** The trail's current item: the breadcrumbs' type, so it reads as one line with its parents. Truncates first. */
const headerTitle = "kt-session-header-title m-0 min-w-0 flex-auto truncate [font:inherit]";
/** The icon buttons at the right end, pulled out so the last icon, not its box, meets the gutter. */
const headerActions = "kt-session-header-actions -mr-1.5 flex flex-none items-center gap-1";
/** The connection's line: small, muted, tabular figures, never wrapping. */
const connectionLine =
	"kt-connection inline-flex flex-none items-center gap-1.5 text-xs leading-tight whitespace-nowrap tabular-nums";
/** Its words, trimmed to their capitals as the trail is, so they sit on the trail's line and the buttons' centre. */
const connectionWords = "py-(--kt-trim-room) [text-box:trim-both_cap_alphabetic]";

/** The link to the session host: up, coming up, or down with a retry scheduled at `retryAt` (epoch ms). */
export type ConnectionStateValue = { state: "open" } | { state: "connecting" } | { state: "offline"; retryAt: number };

export type SessionHeaderProps = {
	/** The session's title, the trail's current item. Empty or missing shows "New session". */
	title?: string;
	/**
	 * The levels above the session, outermost first: its project, then for a subagent the sessions that started it.
	 * Each is muted and goes back to its level. None shows the title alone.
	 */
	parents?: readonly Crumb[];
	connection: ConnectionStateValue;
	/** Icon buttons at the right end, kept few, as T3 Code's: the session's files, its options. */
	actions?: ReactNode;
	/** Shows a Back button at the left, for a session opened from a list on mobile. */
	onBack?: () => void;
	/** The title is still loading: a skeleton in its place. */
	loading?: boolean;
};

/** Whole seconds until `retryAt`, never negative. */
export function secondsUntil(retryAt: number, now: number): number {
	return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/**
 * The connection to the session host, said only when it matters: nothing visible while connected (a healthy link
 * isn't news), "Connecting" with a spinner, or "Offline, retrying in 4s" counting down on the page's shared
 * one-second clock, then "Reconnecting" once the retry is due. The countdown is not announced each second.
 */
export function ConnectionState({ connection }: { connection: ConnectionStateValue }) {
	const offline = connection.state === "offline";
	const now = useNow(1000, offline);
	// Offline in the error colour, else muted. Connected says nothing on screen, so it takes no space in the row either.
	const state = offline ? "text-status-error" : connection.state === "open" ? "absolute text-muted" : "text-muted";
	return (
		<span className={`${connectionLine} kt-connection-${connection.state} ${state}`} role="status">
			{connection.state === "open" ? (
				<span className="kt-sr-only">Connected</span>
			) : connection.state === "connecting" ? (
				<>
					<Spinner size="sm" />
					<span className={connectionWords}>Connecting</span>
				</>
			) : (
				<OfflineText seconds={secondsUntil(connection.retryAt, now)} />
			)}
		</span>
	);
}

function OfflineText({ seconds }: { seconds: number }) {
	if (seconds === 0) return <span className={connectionWords}>Reconnecting</span>;
	return (
		<>
			<span className="kt-sr-only">Offline, retrying soon</span>
			<span className={connectionWords} aria-hidden="true">
				Offline, retrying in {seconds}s
			</span>
		</>
	);
}

/**
 * The bar at the top of a session, as T3 Code's: breadcrumbs only (`Default / Fix the billing worker`, and a subagent's
 * session one level deeper), the connection when it isn't healthy, and a few icon buttons at the right end. No status,
 * no facts: whether the agent is working shows in the thread, the composer and the sidebar, never here. One compact
 * row with a hairline under it.
 */
export function SessionHeader({
	title,
	parents = [],
	connection,
	actions,
	onBack,
	loading = false,
}: SessionHeaderProps) {
	const shown = title === undefined || title.trim() === "" ? "New session" : title;
	return (
		<header className={header}>
			{onBack === undefined ? null : (
				<IconButton
					className="kt-session-header-back -ml-1.5"
					variant="ghost"
					label="Back"
					// The chevron points right everywhere else; mirrored, it says "back" without an arrow glyph.
					icon={<ChevronRightIcon className="kt-session-header-back-icon -scale-x-100" />}
					onClick={onBack}
				/>
			)}
			<Breadcrumbs
				label="Session"
				parents={parents}
				current={
					<h1 className={headerTitle} title={loading ? undefined : shown}>
						{loading ? (
							<>
								{/* 252px, as the 18em it was at the title's 14px; capped at the room there is. */}
								<span className="kt-session-header-skeleton block w-63 max-w-full">
									<Skeleton width="100%" />
								</span>
								<span className="kt-sr-only">Loading the session</span>
							</>
						) : (
							shown
						)}
					</h1>
				}
			/>
			<ConnectionState connection={connection} />
			{actions === undefined || actions === null ? null : <div className={headerActions}>{actions}</div>}
		</header>
	);
}
