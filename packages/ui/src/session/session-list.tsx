import { memo, type ReactNode, useCallback, useMemo } from "react";
import { ListRow } from "../primitives/list-row.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { Elapsed, RelativeTime } from "../primitives/time.tsx";
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

/** The project and the branch, as separate facts: no dot between them, a gap. */
function Overline({ project, branch }: { project?: string; branch?: string }) {
	if (project === undefined && branch === undefined) return null;
	return (
		<span className="hb-session-overline">
			{project === undefined ? null : <span className="hb-session-project">{project}</span>}
			{branch === undefined ? null : <span className="hb-session-branch">{branch}</span>}
		</span>
	);
}

/**
 * One session in the list, after T3 Code's sidebar cards and slim rows. Sessions that need you or are working get
 * three lines (project and branch, title, elapsed time) and their status at the top right; settled ones are one quiet
 * line with their time, unless they finished unseen (an emerald Done) or failed. Memoised on its props.
 */
export const SessionListItem = memo(function SessionListItem({
	session,
	selected = false,
	href,
	onSelect,
	actions,
}: SessionListItemProps) {
	const { id } = session;
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
		session.project === undefined && session.branch === undefined ? undefined : (
			<Overline project={session.project} branch={session.branch} />
		);
	return (
		<ListRow
			{...main}
			density="comfortable"
			overline={overline}
			title={session.title}
			meta={session.status === "running" ? <Elapsed since={session.startedAt} /> : undefined}
			trailing={status === undefined ? undefined : <StatusLabel status={status} />}
		/>
	);
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
