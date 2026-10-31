import type { Occurrence, OwnerRef, RaisedFinding, Schedule, ScheduleKind } from "@kantel/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuditDirectory, actorName } from "../audit/audit-model.ts";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { PlusIcon } from "../primitives/icons.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import { useLoad } from "../primitives/load.ts";
import { ownerName } from "../primitives/owner.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Field, FieldList, Notice, Panel } from "../primitives/surface.tsx";
import { ClockTime } from "../primitives/time.tsx";
import { ScheduleForm } from "./form/schedule-form.tsx";
import { payloadEditable, type ScheduleAgent } from "./form/schedule-form-model.ts";
import { isFormKind } from "./form/schedule-writes.ts";
import {
	countByStatus,
	FINDING_REASON,
	filterSchedules,
	isProblem,
	KIND_LABELS,
	limitText,
	newestFirst,
	nextText,
	payloadView,
	readPages,
	runDetail,
	runSession,
	runState,
	SCHEDULE_STATUS,
	type SchedulesSource,
	STATUS_FILTERS,
	type StatusFilter,
	severityText,
	severityTone,
	sortSchedules,
	timeUntil,
	timingText,
	zonedText,
	zoneName,
} from "./schedules-model.ts";
// Styled with Tailwind utilities (src/tokens/tailwind.css); only the phone layout and the run rows' columns are left in
// CSS, which says why.
import "./schedules-page.css";

/** The open schedule, or the form: its head, then a panel for each part. */
const frame = "flex min-w-0 flex-col gap-4";
const loading = "flex flex-col gap-4";
/** A panel's heading. */
const section = "m-0 text-sm font-medium";
const note = "m-0 text-muted";
const faint = "text-xs text-faint";
const flatList = "m-0 flex list-none flex-col p-0";
/** Which agent a task asks, over its prompt. */
const payloadAgent = "m-0 text-muted";
/** The ghost button's label lines up with the page's edge. Shown under 900px only (schedules-page.css). */
const back = "kt-schedules-back -ml-2.5";

/** Where the page links. An absent builder, or undefined from one (a record the host can't open), leaves it unlinked. */
export interface ScheduleLinks {
	/** The session a task's run started, to open in the host's session view. */
	session?(sessionId: string, schedule: Schedule): string | undefined;
}

/** What the schedule form needs from the host, to create and edit tasks and checks on the page. */
export interface ScheduleFormSettings {
	/** The agents a task can ask, by name. */
	readonly agents: readonly ScheduleAgent[];
	/** Who owns a new schedule: the project the person is in. */
	readonly owner: OwnerRef;
	/** A new schedule's time zone. Default the browser's. */
	readonly timezone?: string;
}

/** The form open in the detail pane: a new schedule, or one being edited. */
type Editing = { readonly kind: "new" } | { readonly kind: "edit"; readonly schedule: Schedule };

export interface SchedulesPageProps {
	/** `Schedules`, bound to the viewer (see `bindSchedules`). */
	readonly source: SchedulesSource;
	/**
	 * Create, edit and end tasks and checks on the page. Absent, the page reads and pauses only: no New schedule or Edit.
	 */
	readonly form?: ScheduleFormSettings;
	readonly links?: ScheduleLinks;
	/** Names for people, agents and projects, from the host's directories. */
	readonly directory?: AuditDirectory;
	/** The time the page measures from, for stories and screenshots. Default `Date.now()` when it renders. */
	readonly now?: number;
	/** The schedule open when the page loads. */
	readonly initialSelected?: string;
	readonly initialFilter?: StatusFilter;
	/** How many next runs the detail previews. Default 5. */
	readonly previewCount?: number;
	/** Called when a schedule is opened or closed, for a host that keeps it in the URL. */
	readonly onSelect?: (scheduleId: string | undefined) => void;
	/** Open the form for a new schedule when the page loads, with `form`: for a host's `/schedules/new`, and stories. */
	readonly initialNew?: boolean;
}

/**
 * The organisation's schedules: what runs on its own, when it runs next and how its runs went. The list alone, with a
 * status filter, until a schedule or the form opens; then the detail beside the list. On a phone the detail replaces
 * the list, with a way back. Pause and resume act on the store and read the schedule again.
 *
 * No timers: "Next in 3h" is read when the page renders, and the page reads again after each change.
 */
export function SchedulesPage({
	source,
	directory = {},
	now: fixedNow,
	initialSelected,
	initialFilter = "active",
	previewCount = 5,
	onSelect,
	form,
	links,
	initialNew = false,
}: SchedulesPageProps) {
	const [filter, setFilter] = useState<StatusFilter>(initialFilter);
	const [selected, setSelected] = useState<string | undefined>(initialSelected);
	const [editing, setEditing] = useState<Editing | undefined>(
		initialNew && form !== undefined ? { kind: "new" } : undefined,
	);
	const { state, reload } = useLoad(
		async () => (await readPages((page) => source.list(undefined, page))).items,
		[source],
	);
	const now = fixedNow ?? Date.now();
	const all = state.status === "ready" ? sortSchedules(state.value) : [];
	const counts = countByStatus(all);
	const shown = filterSchedules(all, filter);
	const open = useCallback(
		(id: string | undefined) => {
			setEditing(undefined);
			setSelected(id);
			onSelect?.(id);
		},
		[onSelect],
	);
	// After a save or an end: show the schedule as it now is, under a filter that lists it.
	const saved = (schedule: Schedule) => {
		if (filter !== "all" && filter !== schedule.status) setFilter("all");
		open(schedule.id);
		reload();
	};
	const formNow = fixedNow === undefined ? undefined : () => fixedNow;
	const view = selected === undefined && editing === undefined ? "list" : "detail";
	// No schedules at all: the page is the empty state, which carries New schedule, so the header doesn't repeat it.
	const empty = state.status === "ready" && all.length === 0;
	const newButton =
		form === undefined ? undefined : (
			<Button
				variant="primary"
				icon={<PlusIcon size="sm" />}
				disabled={editing?.kind === "new"}
				onClick={() => setEditing({ kind: "new" })}
			>
				New schedule
			</Button>
		);

	return (
		// Linear's list then detail: with nothing open the list is the page, one column at the reading width (the header
		// with it, so its action lines up with the list's edge); opening a schedule or the form puts the detail beside the
		// list (the columns are in schedules-page.css).
		<div
			className={`kt-schedules flex w-full min-w-0 flex-col gap-6 text-sm leading-normal text-fg ${view === "list" ? "max-w-content" : ""}`}
			data-view={view}
		>
			<PageHeader
				className="kt-schedules-head"
				title="Schedules"
				{...(newButton === undefined || (empty && view === "list") ? {} : { actions: newButton })}
			/>
			<div className="kt-schedules-body grid min-w-0 items-start gap-6">
				{/* The status filter keeps its own width, as the memory page's does, rather than a frame stretched past its
				    options. With no schedules and the form open there is no list to show beside it, so the form is alone. */}
				{empty && view === "detail" ? null : (
					<section
						className="kt-schedules-list flex min-w-0 flex-col gap-4 [&>.kt-segmented]:max-w-full [&>.kt-segmented]:self-start"
						aria-label="Schedules"
					>
						{state.status === "ready" && all.length > 0 ? (
							<SegmentedControl
								label="Show"
								value={filter}
								onChange={setFilter}
								options={STATUS_FILTERS.map((option) => ({ ...option, count: counts[option.value] }))}
							/>
						) : null}
						{state.status === "loading" ? (
							<div className={loading}>
								<span className="kt-sr-only">Loading schedules</span>
								<Skeleton lines={2} />
								<Skeleton lines={2} />
								<Skeleton lines={2} />
							</div>
						) : state.status === "error" ? (
							<Notice
								level="error"
								action={
									<Button size="xs" onClick={reload}>
										Try again
									</Button>
								}
							>
								Couldn't read the schedules. Nothing has changed; try again.
							</Notice>
						) : all.length === 0 ? (
							<EmptyState title="No schedules yet" {...(newButton === undefined ? {} : { action: newButton })}>
								Reminders, recurring tasks and checks show here.
							</EmptyState>
						) : shown.length === 0 ? (
							<EmptyState title={`No ${filter} schedules`}>Pick another filter to see the rest.</EmptyState>
						) : (
							<ul className={`${flatList} gap-0.5`}>
								{shown.map((schedule) => (
									<li key={schedule.id}>
										<ListRow
											density="comfortable"
											overline={`${KIND_LABELS[schedule.kind]}, ${ownerName(schedule.owner, directory)}`}
											title={schedule.title}
											meta={timingText(schedule)}
											trailing={
												schedule.status === "active" ? (
													<span className="text-xs whitespace-nowrap text-muted">{nextText(schedule, now)}</span>
												) : (
													<Badge tone={SCHEDULE_STATUS[schedule.status].tone}>
														{SCHEDULE_STATUS[schedule.status].label}
													</Badge>
												)
											}
											quiet={schedule.status === "ended"}
											selected={schedule.id === selected}
											onSelect={() => open(schedule.id)}
										/>
									</li>
								))}
							</ul>
						)}
					</section>
				)}
				{view === "list" ? null : (
					<section className="kt-schedules-detail min-w-0" aria-label="Schedule">
						{editing !== undefined && form !== undefined ? (
							<div className={frame}>
								<div className={back}>
									<Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
										{editing.kind === "new" ? "All schedules" : "Back to the schedule"}
									</Button>
								</div>
								<ScheduleForm
									key={editing.kind === "new" ? "new" : editing.schedule.id}
									writes={source}
									agents={form.agents}
									owner={form.owner}
									{...(form.timezone === undefined ? {} : { timezone: form.timezone })}
									{...(editing.kind === "edit" ? { schedule: editing.schedule } : {})}
									{...(formNow === undefined ? {} : { now: formNow })}
									onSaved={saved}
									onEnded={saved}
									onCancel={() => setEditing(undefined)}
								/>
							</div>
						) : selected === undefined ? null : (
							<ScheduleDetail
								key={selected}
								scheduleId={selected}
								source={source}
								directory={directory}
								now={now}
								previewCount={previewCount}
								onBack={() => open(undefined)}
								onChanged={reload}
								{...(form === undefined
									? {}
									: { agents: form.agents, onEdit: (schedule: Schedule) => setEditing({ kind: "edit", schedule }) })}
								{...(links === undefined ? {} : { links })}
							/>
						)}
					</section>
				)}
			</div>
		</div>
	);
}

interface DetailData {
	readonly schedule: Schedule;
	readonly next: readonly number[];
	readonly runs: readonly Occurrence[];
	readonly complete: boolean;
	readonly findings?: readonly RaisedFinding[];
}

/** How many runs the history shows before Show older. */
const RUNS_SHOWN = 12;

export interface ScheduleDetailProps {
	readonly scheduleId: string;
	readonly source: SchedulesSource;
	readonly directory?: AuditDirectory;
	readonly now: number;
	readonly previewCount?: number;
	/** Shows a Back button, for the phone layout where the detail replaces the list. */
	readonly onBack?: () => void;
	/** After pause or resume, so the host's list reads again. */
	readonly onChanged?: () => void;
	/** Shows Edit on a task or check the form can edit. */
	readonly onEdit?: (schedule: Schedule) => void;
	/** The agents a task's prompt names, by name. */
	readonly agents?: readonly ScheduleAgent[];
	readonly links?: ScheduleLinks;
}

/** One schedule: its timing and next runs, what it runs, its findings and its run history, newest first. */
export function ScheduleDetail({
	scheduleId,
	source,
	directory = {},
	now,
	previewCount = 5,
	onBack,
	onChanged,
	onEdit,
	agents = [],
	links,
}: ScheduleDetailProps) {
	const { state, reload } = useLoad<DetailData>(async () => {
		const [schedule, runs, findings] = await Promise.all([
			source.get(scheduleId),
			readPages((page) => source.listOccurrences(scheduleId, page)),
			source.findings?.(scheduleId),
		]);
		const next = schedule.status === "active" ? await source.preview(scheduleId, previewCount) : [];
		return {
			schedule,
			next,
			runs: newestFirst(runs.items),
			complete: runs.complete,
			...(findings === undefined ? {} : { findings }),
		};
	}, [source, scheduleId, previewCount]);
	const [changing, setChanging] = useState(false);
	const [changeFailed, setChangeFailed] = useState(false);
	const [shown, setShown] = useState(RUNS_SHOWN);
	const [runFilter, setRunFilter] = useState<"all" | "problems">("all");
	const heading = useRef<HTMLHeadingElement>(null);
	// Opening a schedule from the list moves focus to its heading, so a screen reader reads where it landed.
	const ready = state.status === "ready";
	useEffect(() => {
		if (ready) heading.current?.focus({ preventScroll: true });
	}, [ready]);

	const change = async (schedule: Schedule) => {
		setChanging(true);
		setChangeFailed(false);
		try {
			if (schedule.status === "active") await source.pause(schedule.id);
			else await source.resume(schedule.id);
			reload();
			onChanged?.();
		} catch {
			setChangeFailed(true);
		} finally {
			setChanging(false);
		}
	};

	const backButton =
		onBack === undefined ? null : (
			<div className={back}>
				<Button size="sm" variant="ghost" onClick={onBack}>
					All schedules
				</Button>
			</div>
		);

	if (state.status !== "ready") {
		return (
			<div className={frame}>
				{backButton}
				{state.status === "loading" ? (
					<div className={loading} aria-busy="true">
						<span className="kt-sr-only">Loading the schedule</span>
						<Skeleton width="50%" />
						<Skeleton lines={3} />
						<Skeleton lines={4} />
					</div>
				) : (
					<Notice
						level="error"
						action={
							<Button size="xs" onClick={reload}>
								Try again
							</Button>
						}
					>
						Couldn't read this schedule. It may have been removed, or Kantel is unavailable.
					</Notice>
				)}
			</div>
		);
	}

	const { schedule, next, runs, complete, findings } = state.value;
	const status = SCHEDULE_STATUS[schedule.status];
	const limits = limitText(schedule);
	const payload = payloadView(schedule);
	const problems = runs.filter((run) => isProblem(run, schedule.kind));
	const listed = runFilter === "all" ? runs : problems;
	const visible = listed.slice(0, shown);
	return (
		<article className={frame} aria-labelledby="kt-schedule-title">
			{backButton}
			<header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<h2
						id="kt-schedule-title"
						className="m-0 text-lg leading-tight font-strong wrap-anywhere focus:outline-none"
						ref={heading}
						tabIndex={-1}
					>
						{schedule.title}
					</h2>
					<div className="flex flex-wrap gap-1.5">
						<Badge>{KIND_LABELS[schedule.kind]}</Badge>
						<Badge tone={status.tone}>{status.label}</Badge>
					</div>
				</div>
				{schedule.status === "ended" ? null : (
					<div className="flex flex-wrap gap-1.5">
						{onEdit !== undefined && isFormKind(schedule.kind) && payloadEditable(schedule) ? (
							<Button size="sm" variant="ghost" disabled={changing} onClick={() => onEdit(schedule)}>
								Edit
							</Button>
						) : null}
						<Button size="sm" variant="secondary" busy={changing} onClick={() => void change(schedule)}>
							{schedule.status === "active" ? "Pause" : "Resume"}
						</Button>
					</div>
				)}
			</header>
			{changeFailed ? (
				<Notice level="error">
					Couldn't {schedule.status === "active" ? "pause" : "resume"} it. Nothing changed; try again.
				</Notice>
			) : null}

			<Panel header={<h3 className={section}>When it runs</h3>}>
				<FieldList>
					<Field label="Repeats">{timingText(schedule)}</Field>
					<Field label="Time zone">{schedule.timezone}</Field>
					{limits === undefined ? null : <Field label="Limits">{limits}</Field>}
					<Field label="Owner">{ownerName(schedule.owner, directory)}</Field>
					<Field label="Created">
						{actorName(schedule.createdBy, directory)}, <ClockTime at={schedule.createdAt} now={now} />
					</Field>
					<Field label="Runs so far">{schedule.occurrences}</Field>
					{schedule.check === undefined ? null : (
						<Field label="Raises again">
							After {schedule.check.reraiseHours ?? 6} hours, when a value grows {schedule.check.risingFactor ?? 2}
							{" times, or after "}
							{schedule.check.failuresBeforeRaise ?? 3} failed runs in a row
						</Field>
					)}
				</FieldList>
				{schedule.status !== "active" ? (
					<p className={note}>
						{schedule.status === "paused" ? "Paused: nothing runs until it is resumed." : "Ended: it won't run again."}
					</p>
				) : next.length === 0 ? (
					<p className={note}>Nothing more is due.</p>
				) : (
					<div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
						<h4 className="m-0 text-xs font-medium text-muted">Next runs, in {zoneName(schedule.timezone)}</h4>
						<ol className={`${flatList} gap-1`}>
							{next.map((at) => (
								<li key={at} className="flex flex-wrap items-baseline justify-between gap-x-2.5 tabular-nums">
									<time dateTime={new Date(at).toISOString()}>{zonedText(at, schedule.timezone)}</time>
									<span className={faint}>{timeUntil(at, now)}</span>
								</li>
							))}
						</ol>
					</div>
				)}
			</Panel>

			<Panel header={<h3 className={section}>{payload.label}</h3>}>
				{payload.kind === "text" && payload.agentId !== undefined ? (
					<p className={payloadAgent}>
						Asks{" "}
						<strong className="font-medium text-fg">
							{agents.find((agent) => agent.id === payload.agentId)?.name ??
								directory.agent?.(payload.agentId) ??
								payload.agentId}
						</strong>
						, in a new session each run, with this prompt as written:
					</p>
				) : schedule.kind === "task" && payload.kind === "text" ? (
					<p className={payloadAgent}>
						Asks the default agent, in a new session each run, with this prompt as written:
					</p>
				) : null}
				{payload.kind === "text" ? (
					<p className="kt-selectable m-0 whitespace-pre-wrap wrap-anywhere">{payload.text}</p>
				) : (
					<pre className="kt-selectable m-0 overflow-x-auto rounded-control bg-sunken px-2.5 py-2 font-mono text-code whitespace-pre-wrap wrap-anywhere">
						{payload.text}
					</pre>
				)}
			</Panel>

			{findings === undefined || schedule.kind !== "check" ? null : (
				<Panel header={<h3 className={section}>Findings raised</h3>}>
					{findings.length === 0 ? (
						<p className={note}>No findings raised.</p>
					) : (
						<ul className={`${flatList} gap-2.5`}>
							{findings.slice(0, 8).map((finding) => (
								<li key={`${finding.occurrenceId}:${finding.key}`} className="flex min-w-0 items-baseline gap-2">
									<Badge tone={severityTone(finding.severity)}>{severityText(finding.severity)}</Badge>
									<span className="flex min-w-0 flex-col gap-0.5 wrap-anywhere">
										<span>{finding.summary}</span>
										<span className={faint}>
											{FINDING_REASON[finding.reason]}, <span className="kt-mono">{finding.key}</span>
										</span>
									</span>
								</li>
							))}
						</ul>
					)}
				</Panel>
			)}

			<Panel
				header={
					<div className="flex flex-1 items-baseline justify-between gap-2">
						<h3 className={section}>Run history</h3>
						{problems.length === 0 ? (
							<span className={faint}>
								{runs.length}
								{complete ? "" : "+"} {runs.length === 1 ? "run" : "runs"}
							</span>
						) : (
							<SegmentedControl
								label="Runs"
								value={runFilter}
								onChange={(value) => {
									setRunFilter(value);
									setShown(RUNS_SHOWN);
								}}
								options={[
									{ value: "all", label: complete ? "All" : "All, newest", count: runs.length },
									{ value: "problems", label: "Problems", count: problems.length },
								]}
							/>
						)}
					</div>
				}
				footer={
					listed.length > shown ? (
						<Button size="sm" variant="ghost" onClick={() => setShown((count) => count + RUNS_SHOWN * 2)}>
							Show older runs
						</Button>
					) : undefined
				}
			>
				{runs.length === 0 ? (
					<p className={note}>
						No runs yet.{" "}
						{schedule.status === "active" && schedule.nextDueAt !== undefined
							? `The first is ${timeUntil(schedule.nextDueAt, now)}.`
							: ""}
					</p>
				) : (
					<ol className={flatList}>
						{visible.map((run) => {
							const sessionId = runSession(run);
							const href = sessionId === undefined ? undefined : links?.session?.(sessionId, schedule);
							return (
								<RunRow
									key={run.id}
									run={run}
									kind={schedule.kind}
									timezone={schedule.timezone}
									{...(href === undefined ? {} : { sessionHref: href })}
								/>
							);
						})}
					</ol>
				)}
			</Panel>
		</article>
	);
}

/**
 * One run, at its due time in the schedule's own time zone, as the next runs above it are, with a link to the session
 * it started when the host can open it.
 */
function RunRow({
	run,
	kind,
	timezone,
	sessionHref,
}: {
	run: Occurrence;
	kind: ScheduleKind;
	timezone: string;
	sessionHref?: string;
}) {
	const state = runState(run, kind);
	const detail = runDetail(run, kind);
	const when = zonedText(run.dueAt, timezone);
	return (
		// The columns are in schedules-page.css, which reflows them on a phone.
		<li
			className="kt-schedule-run grid items-baseline gap-2 border-t border-border py-1.5 tabular-nums first:border-t-0 first:pt-0"
			data-linked={sessionHref === undefined ? undefined : ""}
		>
			<time className="whitespace-nowrap text-muted" dateTime={new Date(run.dueAt).toISOString()}>
				{when}
			</time>
			<span>
				<Badge tone={state.tone}>{state.label}</Badge>
			</span>
			<span className="kt-schedule-run-detail text-muted wrap-anywhere">{detail ?? ""}</span>
			{sessionHref === undefined ? null : (
				<a
					className="kt-schedule-run-link kt-focusable rounded-xs text-xs whitespace-nowrap text-accent-text no-underline hover:underline"
					href={sessionHref}
					aria-label={`Open session, from the run at ${when}`}
				>
					Open session
				</a>
			)}
		</li>
	);
}
