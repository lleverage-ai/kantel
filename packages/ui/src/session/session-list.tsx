import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { useNow } from "../primitives/clock.ts";
import { ListRow } from "../primitives/list-row.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { Elapsed, RelativeTime } from "../primitives/time.tsx";
import type { Status } from "../tokens/tokens.ts";
import {
	DeleteSessionDialog,
	RenameSessionDialog,
	type SessionAction,
	SessionFilterMenu,
	type SessionMenuActions,
	SessionRowMenu,
} from "./session-menu.tsx";
import {
	arrangeSessions,
	attentionGroup,
	defaultSessionListView,
	type SessionListView,
	type SessionSummary,
	sessionStatus,
} from "./session-model.ts";
import "./session-list.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css). session-list.css keeps only the rules that reach into
// ListRow's own elements (its side column, its hover and focus state) through `:has()` chains and a pointer query, with
// .hb-session-status as their hook. hb-session-rows-item stays for loop/measure.ts, hb-session-working and
// hb-session-working-text for loop/align.ts; the other hb- classes stay as names for the parts.

/** The list: its heading, notices and groups a block apart. */
const list = "hb-session-list flex min-w-0 flex-col gap-4";
/** The heading with the filter button at its end, after Claude.ai's Recents; pulled close to the first group. */
const listHead = "hb-session-list-head -mb-3 flex min-h-control-sm items-center justify-between gap-2 pr-1 pl-2.5";
/** A group: its shelf label over its rows. */
const group = "hb-session-group flex min-w-0 flex-col gap-1";
/** Small, muted, sentence case: a shelf label, not a banner. The count is its own element. */
const groupHeading =
	"hb-session-group-heading m-0 flex items-baseline gap-1.5 px-2.5 text-xs leading-tight font-medium text-muted";
/** The rows: a plain list, 2px apart. */
const rows = "hb-session-rows m-0 flex min-w-0 list-none flex-col gap-0.5 p-0";
/**
 * A list of hundreds of sessions: the browser skips styling, layout and paint for rows out of view, so selecting a
 * row restyles a screenful, not the whole list. The size estimate holds only until a row has rendered once (`auto`
 * then remembers its real height), so one estimate serves the one- and three-line rows. Paint containment cannot
 * clip the focus ring: ListRow draws it inset.
 */
const rowsItem =
	"hb-session-rows-item min-w-0 [content-visibility:auto] [contain-intrinsic-size:auto_var(--hb-step-12)]";
/**
 * A working session's status, after T3 Code's (text-info-foreground, a 16px spinner, gap 1): the spinner, "Working"
 * and its time in the accent's blue, medium weight, with tabular numbers so the row doesn't shift as it counts. The
 * spinner's moving arc takes the same blue (`!` beats the Spinner's own border-top-color utility).
 */
const working =
	"hb-session-working inline-flex items-center gap-1 text-xs leading-tight font-medium whitespace-nowrap text-accent-text tabular-nums [&>.hb-spinner]:[border-top-color:currentcolor]!";
/** Trimmed to the capitals, so the words sit on the spinner's middle. */
const workingText = "hb-session-working-text py-(--hb-trim-room) [text-box:trim-both_cap_alphabetic]";
/**
 * The project and the branch side by side, separated by a gap, never a dot. The project keeps its width (it is the
 * short, recognisable part) up to 60%; the branch gives way first.
 */
const where = "hb-session-where flex min-w-0 flex-auto items-baseline gap-2 overflow-hidden";

export type SessionListItemProps = {
	session: SessionSummary;
	selected?: boolean;
	/** Makes the row a link to the session. Wins over `onSelect`. */
	href?: string;
	/** Called with the session's id. Pass a stable function: rows are memoised on it. */
	onSelect?: (id: string) => void;
	/** Shown in place of the status or time while the row is hovered or focused: "Settle", a menu. */
	actions?: ReactNode;
	/**
	 * Gives the row Claude.ai's "…" menu (Mark as unread, Pin, Rename, Archive, Delete) in place of `actions`, calling
	 * this with the choice. Pass a stable function: rows are memoised on it.
	 */
	onAction?: (session: SessionSummary, action: SessionAction) => void;
};

/**
 * A working session's status, after T3 Code's sidebar (SidebarThreadRow.tsx:723-728 and 1478-1494): a spinner,
 * "Working" and how long the turn has run ("Working 12s") in the accent's blue, ticking on the shared clock, in place
 * of the session's age. The time is hidden from screen readers, as T3 Code's is: the list is no live region, and the
 * open session's transcript says how long it has worked.
 */
function WorkingStatus({ since }: { since: number }) {
	return (
		<span className={working}>
			<Spinner size="sm" />
			<span className={workingText}>
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
		// Where the session is on the left, its status at the right end. The status never shrinks; the project and branch
		// truncate first, so the title below has the row's whole width to itself.
		<span className="hb-session-overline flex min-w-0 items-center gap-2">
			{project === undefined && branch === undefined ? null : (
				<span className={where}>
					{project === undefined ? null : (
						<span className="hb-session-project min-w-0 max-w-[60%] flex-none truncate text-muted">{project}</span>
					)}
					{branch === undefined ? null : (
						<span className="hb-session-branch min-w-0 flex-initial truncate font-mono text-2xs text-faint">
							{branch}
						</span>
					)}
				</span>
			)}
			{status === undefined ? null : (
				<span className="hb-session-status ml-auto inline-flex flex-none">
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
	onAction,
}: SessionListItemProps) {
	const { id } = session;
	useRenderProbe("SessionListItem", id);
	const select = useCallback(() => onSelect?.(id), [onSelect, id]);
	const status = sessionStatus(session);
	const group = attentionGroup(session);
	const main = {
		selected,
		href,
		onSelect: onSelect === undefined ? undefined : select,
		actions: onAction === undefined ? actions : <SessionRowMenu session={session} onAction={onAction} />,
	};

	if (group === "done") {
		return (
			<ListRow
				{...main}
				density="compact"
				quiet={status === undefined || session.archived === true}
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
	/** Groups as Needs you, Working and Done (the default). Ungrouped keeps the order given. Ignored with `view`. */
	grouped?: boolean;
	/**
	 * How the list is filtered, grouped and sorted (`arrangeSessions`), with Pinned first. Without it every session is
	 * shown, grouped as `grouped` says.
	 */
	view?: SessionListView;
	/** Shows the list's heading (Recents, Archived or All sessions) with Claude.ai's filter button, which calls this. */
	onViewChange?: (view: SessionListView) => void;
	/** Gives each row its "…" menu, which calls these. Pass a stable object. */
	menuActions?: SessionMenuActions;
};

/** The list's heading for each status filter. */
const headings: Record<SessionListView["status"], string> = {
	active: "Recents",
	archived: "Archived",
	all: "All sessions",
};

/** What the list says when the filter leaves nothing to show. */
const filteredEmpty: Record<SessionListView["status"], string> = {
	active: "No active sessions match",
	archived: "No archived sessions",
	all: "No sessions match",
};

const skeletonWidths = ["72%", "56%", "64%", "48%", "60%"];

/**
 * How many rows a group shows at first, and how many more each "Show more" adds. Rendering every row cost the console
 * most of a second on each session it opened once an organisation had a thousand sessions (17,000 of the page's 17,600
 * elements were the list), so a group shows its newest rows and the rest on request, as Claude.ai's Recents does.
 */
export const SESSION_LIST_STEP = 50;

/** How many of a group's rows to show: `shown`, or as many as reach the selected session so it is never hidden. */
export function rowsShown(sessions: readonly Pick<SessionSummary, "id">[], shown: number, selectedId?: string): number {
	const selected = selectedId === undefined ? -1 : sessions.findIndex((session) => session.id === selectedId);
	return Math.min(sessions.length, Math.max(shown, selected + 1));
}

function Rows({
	sessions,
	selectedId,
	onSelect,
	hrefFor,
	onAction,
}: Pick<SessionListProps, "selectedId" | "onSelect" | "hrefFor"> & {
	sessions: readonly SessionSummary[];
	onAction?: (session: SessionSummary, action: SessionAction) => void;
}) {
	const [shown, setShown] = useState(SESSION_LIST_STEP);
	const count = rowsShown(sessions, shown, selectedId);
	const left = sessions.length - count;
	const visible = left > 0 ? sessions.slice(0, count) : sessions;
	return (
		<>
			<ul className={rows}>
				{visible.map((session) => (
					<li key={session.id} className={rowsItem}>
						<SessionListItem
							session={session}
							selected={session.id === selectedId}
							href={hrefFor?.(session.id)}
							onSelect={onSelect}
							{...(onAction === undefined ? {} : { onAction })}
						/>
					</li>
				))}
			</ul>
			{left > 0 ? (
				<Button
					variant="ghost"
					size="sm"
					className="hb-session-more self-start text-muted! hover:enabled:text-fg!"
					onClick={() => setShown(count + SESSION_LIST_STEP)}
				>
					{`Show ${Math.min(left, SESSION_LIST_STEP)} more`}
				</Button>
			) : null}
		</>
	);
}

/**
 * The list of sessions: a navigation landmark labelled "Sessions", grouped by what each session needs from you.
 * Loading shows placeholder rows, an empty list says how to start one, and an error is a notice. Rows are memoised,
 * so a streaming update re-renders only the session that changed.
 *
 * After Claude.ai's sidebar, with `view` and `onViewChange` it has a heading (Recents) and a filter button, and with
 * `menuActions` each row has a "…" menu to mark it unread, pin, rename, archive or delete it. Pinned sessions come
 * first; archived ones only show when the filter asks for them.
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
	view,
	onViewChange,
	menuActions,
}: SessionListProps) {
	const arrangement = view ?? legacyView;
	// Last activity and date groups move on with the day; a minute is close enough.
	const now = useNow(60_000, view !== undefined && (view.activity !== "all" || view.groupBy === "date"));
	const sections = useMemo(
		() =>
			view === undefined && !grouped
				? [{ key: "sessions", sessions: [...sessions] }]
				: arrangeSessions(sessions, arrangement, now),
		[view, grouped, sessions, arrangement, now],
	);
	const [renaming, setRenaming] = useState<SessionSummary>();
	const [deleting, setDeleting] = useState<SessionSummary>();
	const [actionError, setActionError] = useState<string>();
	const onAction = useMemo(() => {
		if (menuActions === undefined) return undefined;
		const run = (work: Promise<void>) =>
			work.then(
				() => setActionError(undefined),
				(reason: unknown) => setActionError(reason instanceof Error ? reason.message : String(reason)),
			);
		return (session: SessionSummary, action: SessionAction) => {
			if (action === "unread") void run(menuActions.setUnread(session.id, session.unread !== true));
			else if (action === "pin") void run(menuActions.setPinned(session.id, session.pinned !== true));
			else if (action === "archive") void run(menuActions.setArchived(session.id, session.archived !== true));
			else if (action === "rename") setRenaming(session);
			else setDeleting(session);
		};
	}, [menuActions]);
	const nothing = sessions.length === 0;
	const showSkeleton = loading && nothing;
	const hasError = error !== undefined && error !== null && error !== false;
	const filteredOut = !nothing && sections.length === 0;

	let content: ReactNode;
	if (showSkeleton) {
		content = (
			<div className="hb-session-skeleton flex flex-col gap-0.5">
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
	} else if (filteredOut) {
		content = (
			<EmptyState title={filteredEmpty[arrangement.status]}>
				{arrangement.status === "archived"
					? "Sessions you archive show up here."
					: "Change the filter to see more sessions."}
			</EmptyState>
		);
	} else {
		content = sections.map(({ key, label, sessions: members }) =>
			label === undefined ? (
				<Rows
					key={key}
					sessions={members}
					selectedId={selectedId}
					onSelect={onSelect}
					hrefFor={hrefFor}
					{...(onAction === undefined ? {} : { onAction })}
				/>
			) : (
				<div key={key} className={group}>
					<h3 className={groupHeading}>
						<span>{label}</span>{" "}
						<span className="hb-session-group-count font-regular text-faint tabular-nums">{members.length}</span>
					</h3>
					<Rows
						sessions={members}
						selectedId={selectedId}
						onSelect={onSelect}
						hrefFor={hrefFor}
						{...(onAction === undefined ? {} : { onAction })}
					/>
				</div>
			),
		);
	}

	return (
		<nav className={list} aria-label="Sessions" aria-busy={showSkeleton || undefined}>
			{onViewChange === undefined ? null : (
				<div className={listHead}>
					<h3 className="hb-session-list-title m-0 text-sm leading-tight font-medium text-muted">
						{headings[arrangement.status]}
					</h3>
					<SessionFilterMenu view={arrangement} onViewChange={onViewChange} />
				</div>
			)}
			{hasError ? <Notice level="error">{error}</Notice> : null}
			{actionError === undefined ? null : <Notice level="error">{actionError}</Notice>}
			{content}
			{menuActions === undefined ? null : (
				<>
					<RenameSessionDialog
						session={renaming}
						onRename={menuActions.rename}
						onClose={() => setRenaming(undefined)}
					/>
					<DeleteSessionDialog
						session={deleting}
						onDelete={menuActions.remove}
						onClose={() => setDeleting(undefined)}
					/>
				</>
			)}
		</nav>
	);
}

/** Without a view: every session, grouped as Needs you, Working and Done (or, ungrouped, in the order given). */
const legacyView: SessionListView = { ...defaultSessionListView, status: "all" };
