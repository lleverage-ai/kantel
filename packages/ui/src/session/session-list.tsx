import { memo, type ReactNode, useCallback, useMemo } from "react";
import { ListRow } from "../primitives/list-row.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { Elapsed, RelativeTime } from "../primitives/time.tsx";
import type { Status } from "../tokens/tokens.ts";
import { attentionGroup, groupSessions, type SessionSummary, sessionStatus } from "./session-model.ts";
import "./session-list.css";

export type SessionListItemProps = {
	session: SessionSummary;
	selected?: boolean;
	/** Makes the row a link to the session. Wins over `onSelect`. */
	href?: string;
	/** Called with the session's id. Pass a stable function: rows are memoised on it. */
	onSelect?: (id: string) => void;
	/** Shown in place of the status or time while the row is hovered or focused: "Settle", a menu. */
	actions?: ReactNode;
};

/**
 * A working session's status, after T3 Code's sidebar (SidebarThreadRow.tsx:723-728 and 1478-1494): a spinner,
 * "Working" and how long the turn has run ("Working 12s") in the accent's blue, ticking on the shared clock, in place
 * of the session's age. The time is hidden from screen readers, as T3 Code's is: the list is no live region, and the
 * open session's transcript says how long it has worked.
 */
function WorkingStatus({ since }: { since: number }) {
	return (
		<span className="hb-session-working">
			<Spinner size="sm" />
			<span className="hb-session-working-text">
				Working{" "}
				<span aria-hidden="true">
					<Elapsed since={since} />
				</span>
			</span>
		</span>
	);
}

/**
 * The line above the title: the project and the branch as separate facts (no dot between them, a gap), and the
 * status at the right end. The status lives on this line rather than in a column beside the title so the title gets
 * the row's full width; the project and branch truncate before the status does. A working session's status is its
 * spinner and running time (`WorkingStatus`), given as `since`.
 */
function Overline({
	project,
	branch,
	status,
	since,
}: {
	project?: string;
	branch?: string;
	status?: Status;
	since?: number;
}) {
	return (
		<span className="hb-session-overline">
			{project === undefined && branch === undefined ? null : (
				<span className="hb-session-where">
					{project === undefined ? null : <span className="hb-session-project">{project}</span>}
					{branch === undefined ? null : <span className="hb-session-branch">{branch}</span>}
				</span>
			)}
			{status === undefined ? null : (
				<span className="hb-session-status">
					{status === "working" && since !== undefined ? (
						<WorkingStatus since={since} />
					) : (
						<StatusLabel status={status} />
					)}
				</span>
			)}
		</span>
	);
}

/**
 * One session in the list, after T3 Code's sidebar cards and slim rows. Sessions that need you or are working get
 * two lines: project and branch with the status at the right end (a working one's spinner and "Working 12s", ticking),
 * then the title across the full width. Settled ones are one quiet line with their time, unless they finished unseen (an emerald Done) or failed.
 * Memoised on its props.
 */
export const SessionListItem = memo(function SessionListItem({
	session,
	selected = false,
	href,
	onSelect,
	actions,
}: SessionListItemProps) {
	const { id } = session;
	useRenderProbe("SessionListItem", id);
	const select = useCallback(() => onSelect?.(id), [onSelect, id]);
	const status = sessionStatus(session);
	const group = attentionGroup(session);
	const main = { selected, href, onSelect: onSelect === undefined ? undefined : select, actions };

	if (group === "done") {
		return (
			<ListRow
				{...main}
				density="compact"
				quiet={status === undefined}
				title={session.title}
				trailing={status === undefined ? <RelativeTime at={session.updatedAt} /> : <StatusLabel status={status} />}
			/>
		);
	}

	const overline =
		session.project === undefined && session.branch === undefined && status === undefined ? undefined : (
			<Overline
				project={session.project}
				branch={session.branch}
				status={status}
				{...(session.status === "running" ? { since: session.workingSince ?? session.startedAt } : {})}
			/>
		);
	// No trailing column: the status is in the overline, so nothing sits beside the title.
	return <ListRow {...main} density="comfortable" overline={overline} title={session.title} />;
});

export type SessionListProps = {
	sessions: readonly SessionSummary[];
	selectedId?: string;
	/** Called with the chosen session's id. Pass a stable function so rows skip re-rendering. */
	onSelect?: (id: string) => void;
	/** A link for each session; rows become links when given. */
	hrefFor?: (id: string) => string;
	/** Shows five placeholder rows while there are no sessions to show yet. */
	loading?: boolean;
	/** Why the list could not load, shown as an error notice above whatever sessions are known. */
	error?: ReactNode;
	/** Replaces the default empty state. */
	empty?: ReactNode;
	/** Groups as Needs you, Working and Done (the default). Ungrouped keeps the order given. */
	grouped?: boolean;
};

const skeletonWidths = ["72%", "56%", "64%", "48%", "60%"];

function Rows({
	sessions,
	selectedId,
	onSelect,
	hrefFor,
}: Pick<SessionListProps, "selectedId" | "onSelect" | "hrefFor"> & { sessions: readonly SessionSummary[] }) {
	return (
		<ul className="hb-session-rows">
			{sessions.map((session) => (
				<li key={session.id} className="hb-session-rows-item">
					<SessionListItem
						session={session}
						selected={session.id === selectedId}
						href={hrefFor?.(session.id)}
						onSelect={onSelect}
					/>
				</li>
			))}
		</ul>
	);
}

/**
 * The list of sessions: a navigation landmark labelled "Sessions", grouped by what each session needs from you.
 * Loading shows placeholder rows, an empty list says how to start one, and an error is a notice. Rows are memoised,
 * so a streaming update re-renders only the session that changed.
 */
export function SessionList({
	sessions,
	selectedId,
	onSelect,
	hrefFor,
	loading = false,
	error,
	empty,
	grouped = true,
}: SessionListProps) {
	const groups = useMemo(() => (grouped ? groupSessions(sessions) : []), [grouped, sessions]);
	const nothing = sessions.length === 0;
	const showSkeleton = loading && nothing;
	const hasError = error !== undefined && error !== null && error !== false;

	let content: ReactNode;
	if (showSkeleton) {
		content = (
			<div className="hb-session-skeleton">
				<span className="hb-sr-only">Loading sessions</span>
				{skeletonWidths.map((width) => (
					<ListRow key={width} title={<Skeleton width={width} />} />
				))}
			</div>
		);
	} else if (nothing) {
		content = hasError ? null : empty !== undefined ? (
			empty
		) : (
			<EmptyState title="No sessions yet">Start one from the composer or a schedule.</EmptyState>
		);
	} else if (grouped) {
		content = groups.map(({ group, label, sessions: members }) => (
			<div key={group} className="hb-session-group">
				<h3 className="hb-session-group-heading">
					<span>{label}</span> <span className="hb-session-group-count">{members.length}</span>
				</h3>
				<Rows sessions={members} selectedId={selectedId} onSelect={onSelect} hrefFor={hrefFor} />
			</div>
		));
	} else {
		content = <Rows sessions={sessions} selectedId={selectedId} onSelect={onSelect} hrefFor={hrefFor} />;
	}

	return (
		<nav className="hb-session-list" aria-label="Sessions" aria-busy={showSkeleton || undefined}>
			{hasError ? <Notice level="error">{error}</Notice> : null}
			{content}
		</nav>
	);
}
