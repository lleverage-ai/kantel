import type { Occurrence, RaisedFinding, Schedule, ScheduleKind } from "@harbour/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuditDirectory, actorName } from "../audit/audit-model.ts";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl } from "../primitives/controls.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import { useLoad } from "../primitives/load.ts";
import { ownerName } from "../primitives/owner.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Field, FieldList, Notice, Panel } from "../primitives/surface.tsx";
import { ClockTime } from "../primitives/time.tsx";
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
import "./schedules-page.css";

export interface SchedulesPageProps {
	/** `Schedules`, bound to the viewer (see `bindSchedules`). */
	readonly source: SchedulesSource;
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
}

/**
 * The organisation's schedules: what runs on its own, when it runs next and how its runs went. A list with a status
 * filter beside the open schedule's detail; on a phone the detail replaces the list, with a way back. Pause and resume
 * act on the store and read the schedule again.
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
}: SchedulesPageProps) {
	const [filter, setFilter] = useState<StatusFilter>(initialFilter);
	const [selected, setSelected] = useState<string | undefined>(initialSelected);
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
			setSelected(id);
			onSelect?.(id);
		},
		[onSelect],
	);

	return (
		<div className="hb-schedules" data-view={selected === undefined ? "list" : "detail"}>
			<header className="hb-schedules-head">
				<h1 className="hb-schedules-title">Schedules</h1>
				<p className="hb-schedules-lede">
					What runs on its own: reminders, tasks, summaries, checks and programs, with when each runs next.
				</p>
			</header>
			<div className="hb-schedules-body">
				<section className="hb-schedules-list" aria-label="Schedules">
					<SegmentedControl
						label="Show"
						value={filter}
						onChange={setFilter}
						options={STATUS_FILTERS.map((option) =>
							state.status === "ready" ? { ...option, count: counts[option.value] } : option,
						)}
					/>
					{state.status === "loading" ? (
						<div className="hb-schedules-loading">
							<span className="hb-sr-only">Loading schedules</span>
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
						<EmptyState title="No schedules yet">
							Ask an agent for a reminder or a recurring task, or add a check, and it shows here.
						</EmptyState>
					) : shown.length === 0 ? (
						<EmptyState title={`No ${filter} schedules`}>Pick another filter to see the rest.</EmptyState>
					) : (
						<ul className="hb-schedules-rows">
							{shown.map((schedule) => (
								<li key={schedule.id}>
									<ListRow
										density="comfortable"
										overline={`${KIND_LABELS[schedule.kind]}, ${ownerName(schedule.owner, directory)}`}
										title={schedule.title}
										meta={timingText(schedule)}
										trailing={
											schedule.status === "active" ? (
												<span className="hb-schedules-next">{nextText(schedule, now)}</span>
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
				<section className="hb-schedules-detail" aria-label="Schedule">
					{selected === undefined ? (
						<div className="hb-schedules-placeholder">
							<EmptyState title="Pick a schedule">
								See when it runs next, what it runs and how its runs went.
							</EmptyState>
						</div>
					) : (
						<ScheduleDetail
							key={selected}
							scheduleId={selected}
							source={source}
							directory={directory}
							now={now}
							previewCount={previewCount}
							onBack={() => open(undefined)}
							onChanged={reload}
						/>
					)}
				</section>
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

	const back =
		onBack === undefined ? null : (
			<div className="hb-schedules-back">
				<Button size="sm" variant="ghost" onClick={onBack}>
					All schedules
				</Button>
			</div>
		);

	if (state.status !== "ready") {
		return (
			<div className="hb-schedule">
				{back}
				{state.status === "loading" ? (
					<div className="hb-schedules-loading" aria-busy="true">
						<span className="hb-sr-only">Loading the schedule</span>
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
						Couldn't read this schedule. It may have been removed, or Harbour is unavailable.
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
		<article className="hb-schedule" aria-labelledby="hb-schedule-title">
			{back}
			<header className="hb-schedule-head">
				<div className="hb-schedule-heading">
					<h2 id="hb-schedule-title" className="hb-schedule-title" ref={heading} tabIndex={-1}>
						{schedule.title}
					</h2>
					<div className="hb-schedule-tags">
						<Badge>{KIND_LABELS[schedule.kind]}</Badge>
						<Badge tone={status.tone}>{status.label}</Badge>
					</div>
				</div>
				{schedule.status === "ended" ? null : (
					<Button size="sm" variant="secondary" busy={changing} onClick={() => void change(schedule)}>
						{schedule.status === "active" ? "Pause" : "Resume"}
					</Button>
				)}
			</header>
			{changeFailed ? (
				<Notice level="error">
					Couldn't {schedule.status === "active" ? "pause" : "resume"} it. Nothing changed; try again.
				</Notice>
			) : null}

			<Panel header={<h3 className="hb-schedule-section">When it runs</h3>}>
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
					<p className="hb-schedule-note">
						{schedule.status === "paused" ? "Paused: nothing runs until it is resumed." : "Ended: it won't run again."}
					</p>
				) : next.length === 0 ? (
					<p className="hb-schedule-note">Nothing more is due.</p>
				) : (
					<div className="hb-schedule-next">
						<h4 className="hb-schedule-subhead">Next runs, in {zoneName(schedule.timezone)}</h4>
						<ol className="hb-schedule-next-list">
							{next.map((at) => (
								<li key={at} className="hb-schedule-next-item">
									<time dateTime={new Date(at).toISOString()}>{zonedText(at, schedule.timezone)}</time>
									<span className="hb-schedule-next-in">{timeUntil(at, now)}</span>
								</li>
							))}
						</ol>
					</div>
				)}
			</Panel>

			<Panel header={<h3 className="hb-schedule-section">{payload.label}</h3>}>
				{payload.kind === "text" ? (
					<p className="hb-schedule-payload-text hb-selectable">{payload.text}</p>
				) : (
					<pre className="hb-schedule-payload-code hb-selectable">{payload.text}</pre>
				)}
			</Panel>

			{findings === undefined || schedule.kind !== "check" ? null : (
				<Panel header={<h3 className="hb-schedule-section">Findings raised</h3>}>
					{findings.length === 0 ? (
						<p className="hb-schedule-note">No findings raised.</p>
					) : (
						<ul className="hb-schedule-findings">
							{findings.slice(0, 8).map((finding) => (
								<li key={`${finding.occurrenceId}:${finding.key}`} className="hb-schedule-finding">
									<Badge tone={severityTone(finding.severity)}>{severityText(finding.severity)}</Badge>
									<span className="hb-schedule-finding-text">
										<span>{finding.summary}</span>
										<span className="hb-schedule-finding-meta">
											{FINDING_REASON[finding.reason]}, <span className="hb-mono">{finding.key}</span>
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
					<div className="hb-schedule-section-row">
						<h3 className="hb-schedule-section">Run history</h3>
						{problems.length === 0 ? (
							<span className="hb-schedule-count">
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
					<p className="hb-schedule-note">
						No runs yet.{" "}
						{schedule.status === "active" && schedule.nextDueAt !== undefined
							? `The first is ${timeUntil(schedule.nextDueAt, now)}.`
							: ""}
					</p>
				) : (
					<ol className="hb-schedule-runs">
						{visible.map((run) => (
							<RunRow key={run.id} run={run} kind={schedule.kind} timezone={schedule.timezone} />
						))}
					</ol>
				)}
			</Panel>
		</article>
	);
}

/** One run, at its due time in the schedule's own time zone, as the next runs above it are. */
function RunRow({ run, kind, timezone }: { run: Occurrence; kind: ScheduleKind; timezone: string }) {
	const state = runState(run, kind);
	const detail = runDetail(run, kind);
	return (
		<li className="hb-schedule-run">
			<time className="hb-schedule-run-time" dateTime={new Date(run.dueAt).toISOString()}>
				{zonedText(run.dueAt, timezone)}
			</time>
			<span className="hb-schedule-run-state">
				<Badge tone={state.tone}>{state.label}</Badge>
			</span>
			<span className="hb-schedule-run-detail">{detail ?? ""}</span>
		</li>
	);
}
