import type { ReactNode } from "react";
import { IconButton } from "../primitives/button.tsx";
import { useNow } from "../primitives/clock.ts";
import { ChevronRightIcon } from "../primitives/icons.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import type { Status } from "../tokens/tokens.ts";
import "./session-header.css";

/** The link to the session host: up, coming up, or down with a retry scheduled at `retryAt` (epoch ms). */
export type ConnectionStateValue = { state: "open" } | { state: "connecting" } | { state: "offline"; retryAt: number };

export type SessionHeaderProps = {
	/** The session's title. Empty or missing shows "New session". */
	title?: string;
	status: Status;
	connection: ConnectionStateValue;
	/** Facts about the session: project, branch, a DiffStat, "Working for" an Elapsed. Inline on desktop, a second
	 * line on mobile. Separate facts go in separate elements, never a middle-dot string. */
	meta?: ReactNode;
	/** Buttons at the right end: session options, open the diff. */
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
	return (
		<span className={`hb-connection hb-connection-${connection.state}`} role="status">
			{connection.state === "open" ? (
				<span className="hb-sr-only">Connected</span>
			) : connection.state === "connecting" ? (
				<>
					<Spinner size="sm" />
					<span>Connecting</span>
				</>
			) : (
				<OfflineText seconds={secondsUntil(connection.retryAt, now)} />
			)}
		</span>
	);
}

function OfflineText({ seconds }: { seconds: number }) {
	if (seconds === 0) return <span>Reconnecting</span>;
	return (
		<>
			<span className="hb-sr-only">Offline, retrying soon</span>
			<span aria-hidden="true">Offline, retrying in {seconds}s</span>
		</>
	);
}

/**
 * The bar at the top of a session: Back (when given), the status in words, the title, the session's facts, the
 * connection when it isn't healthy, and the session's actions. One compact row with a hairline under it; on a
 * phone the facts move to a second line so the title keeps its room.
 */
export function SessionHeader({ title, status, connection, meta, actions, onBack, loading = false }: SessionHeaderProps) {
	const shown = title === undefined || title.trim() === "" ? "New session" : title;
	return (
		<header className="hb-session-header">
			{onBack === undefined ? null : (
				<IconButton
					className="hb-session-header-back"
					variant="ghost"
					label="Back"
					icon={<ChevronRightIcon className="hb-session-header-back-icon" />}
					onClick={onBack}
				/>
			)}
			<span className="hb-session-header-status">
				<StatusLabel status={status} />
			</span>
			<h1 className="hb-session-header-title" title={loading ? undefined : shown}>
				{loading ? (
					<>
						<span className="hb-session-header-skeleton">
							<Skeleton width="100%" />
						</span>
						<span className="hb-sr-only">Loading the session</span>
					</>
				) : (
					shown
				)}
			</h1>
			{meta === undefined || meta === null ? null : <div className="hb-session-header-meta">{meta}</div>}
			<ConnectionState connection={connection} />
			{actions === undefined || actions === null ? null : (
				<div className="hb-session-header-actions">{actions}</div>
			)}
		</header>
	);
}
