import type { OwnerRef, Schedule, Timestamp, Weekday } from "@harbour/contracts";
import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../../primitives/button.tsx";
import { Disclosure, SegmentedControl, SelectField, TextAreaField, TextField } from "../../primitives/controls.tsx";
import { ClockIcon } from "../../primitives/icons.tsx";
import { Badge } from "../../primitives/status.tsx";
import { Notice, Panel } from "../../primitives/surface.tsx";
import {
	createScheduleFormFlow,
	type DraftErrors,
	draftFromSchedule,
	emptyDraft,
	localTimeZone,
	payloadEditable,
	previewDraft,
	type ScheduleAgent,
	type ScheduleDraft,
	type ScheduleEvery,
	type ScheduleFormFlow,
	type ScheduleFormProblem,
	type ScheduleFormState,
	WEEK,
} from "./schedule-form-model.ts";
import type { FormKind, ScheduleWrites } from "./schedule-writes.ts";
import "./schedule-form.css";

export interface ScheduleFormProps {
	/** `POST /v1/schedules`, `PATCH /v1/schedules/{id}` and `POST /v1/schedules/{id}/end`, or the fixtures. */
	readonly writes: ScheduleWrites;
	/** The agents a task can ask, by name. */
	readonly agents: readonly ScheduleAgent[];
	/** Who owns a new schedule: the project the console is in. Ignored when editing. */
	readonly owner: OwnerRef;
	/** The schedule to edit; absent to create one. */
	readonly schedule?: Schedule;
	/** The kind a new schedule starts as. Default task. */
	readonly kind?: FormKind;
	/** A new schedule's time zone. Default the browser's. */
	readonly timezone?: string;
	readonly onSaved?: (schedule: Schedule) => void;
	readonly onEnded?: (schedule: Schedule) => void;
	readonly onCancel?: () => void;
	/** A fixed time, for stories and screenshots. Default `Date.now`. */
	readonly now?: () => number;
	/** Fields to start from, over the empty or edited draft: for stories. */
	readonly draft?: Partial<ScheduleDraft>;
	/** Show the draft's errors from the start: for stories. */
	readonly validate?: boolean;
	/** Where the form starts: for stories. */
	readonly initial?: Partial<Pick<ScheduleFormState, "saving" | "problem" | "confirmingEnd" | "ending">>;
}

const KIND_OPTIONS: readonly { value: FormKind; label: string }[] = [
	{ value: "task", label: "Task" },
	{ value: "check", label: "Check" },
];

const KIND_HINT: Readonly<Record<FormKind, string>> = {
	task: "Starts a session with an agent and sends it your prompt, as written.",
	check: "Runs a command with no model. Exit 0 is healthy, 3 reports findings, anything else fails the run.",
};

const WHEN_OPTIONS: readonly { value: "repeat" | "once"; label: string }[] = [
	{ value: "repeat", label: "Repeats" },
	{ value: "once", label: "Once" },
];

const EVERY_OPTIONS: readonly { value: ScheduleEvery; label: string }[] = [
	{ value: "minutes", label: "Minutes" },
	{ value: "hours", label: "Hours" },
	{ value: "day", label: "Days" },
	{ value: "weekday", label: "Weekday" },
	{ value: "week", label: "Week, on chosen days" },
	{ value: "month", label: "Month, on a day" },
];

const WEEKDAY_LABELS: Readonly<Record<Weekday, { short: string; long: string }>> = {
	mon: { short: "Mon", long: "Monday" },
	tue: { short: "Tue", long: "Tuesday" },
	wed: { short: "Wed", long: "Wednesday" },
	thu: { short: "Thu", long: "Thursday" },
	fri: { short: "Fri", long: "Friday" },
	sat: { short: "Sat", long: "Saturday" },
	sun: { short: "Sun", long: "Sunday" },
};

const FALLBACK_ZONES = [
	"UTC",
	"Europe/London",
	"Europe/Amsterdam",
	"Europe/Berlin",
	"America/New_York",
	"America/Los_Angeles",
	"Asia/Tokyo",
];

function timeZones(current: string): readonly string[] {
	let zones: readonly string[] = FALLBACK_ZONES;
	try {
		const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
		if (supported !== undefined && supported.length > 0) zones = ["UTC", ...supported.filter((zone) => zone !== "UTC")];
	} catch {
		// Older engines: the short list.
	}
	return current === "" || zones.includes(current) ? zones : [current, ...zones];
}

/** "Wed 29 Oct, 09:00", in the schedule's own time zone. */
function dueText(at: Timestamp, timezone: string): string {
	try {
		return new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			weekday: "short",
			day: "numeric",
			month: "short",
			hour: "2-digit",
			minute: "2-digit",
		}).format(at);
	} catch {
		return new Date(at).toISOString().slice(0, 16).replace("T", " ");
	}
}

function problemText(problem: ScheduleFormProblem, doing: "save" | "end"): string {
	switch (problem.kind) {
		case "forbidden":
			return doing === "save"
				? "You can't change schedules here. It needs the operator role on the project."
				: "You can't end this schedule. It needs the operator role on the project.";
		case "not-found":
			return "Harbour has no such schedule any more. It may have been removed.";
		case "ended":
			return "This schedule has ended, so it can't be changed.";
		case "invalid":
			return problem.message;
		case "unavailable":
			return doing === "save"
				? "Harbour couldn't save the schedule. Try again in a moment."
				: "Harbour couldn't end the schedule. Try again in a moment.";
	}
}

/**
 * Creates or edits a task or check schedule: what runs (an agent and a prompt, or a command), when (an interval, a
 * time on chosen days, or once), its time zone and an optional limit, with the next five due times beside it as the
 * person types. Editing an active or paused schedule also offers End, after a confirmation.
 *
 * A task's prompt goes to the agent exactly as written: the form never trims it or adds to it.
 *
 * No timers: the preview is computed from the draft on each render.
 */
export function ScheduleForm({
	writes,
	agents,
	owner,
	schedule,
	kind,
	timezone,
	onSaved,
	onEnded,
	onCancel,
	now = Date.now,
	draft: draftPatch,
	validate,
	initial,
}: ScheduleFormProps) {
	const latest = useRef({ writes, onSaved, onEnded });
	latest.current = { writes, onSaved, onEnded };
	const [flow] = useState<ScheduleFormFlow>(() => {
		const base =
			schedule === undefined
				? emptyDraft({
						...(kind === undefined ? {} : { kind }),
						agents,
						timezone: timezone ?? localTimeZone(),
						now: now(),
					})
				: draftFromSchedule(schedule, now());
		return createScheduleFormFlow({
			writes: {
				create: (input) => latest.current.writes.create(input),
				update: (id, input) => latest.current.writes.update(id, input),
				end: (id) => latest.current.writes.end(id),
			},
			owner,
			draft: { ...base, ...draftPatch },
			...(schedule === undefined ? {} : { schedule }),
			now,
			...(validate === undefined ? {} : { validate }),
			...(initial === undefined ? {} : { initial }),
		});
	});
	const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
	const { draft, errors } = state;
	const editing = schedule !== undefined;
	const busy = state.saving || state.ending;
	const preview = previewDraft(draft, now(), 5, schedule);
	const zones = useMemo(() => timeZones(draft.timezone), [draft.timezone]);
	const agentOptions = useMemo(() => {
		const options = agents.map((agent) => ({ value: agent.id, label: agent.name }));
		if (draft.agentId !== "" && !agents.some((agent) => agent.id === draft.agentId)) {
			options.unshift({ value: draft.agentId, label: draft.agentId });
		}
		if (draft.agentId === "") options.unshift({ value: "", label: "Choose an agent" });
		return options;
	}, [agents, draft.agentId]);
	const keepsPayload = schedule !== undefined && !payloadEditable(schedule);
	const titleId = editing ? "hb-schedule-form-edit-title" : "hb-schedule-form-new-title";

	const submit = (event: FormEvent) => {
		event.preventDefault();
		void flow.save().then((saved) => {
			if (saved !== undefined) latest.current.onSaved?.(saved);
		});
	};

	return (
		<Panel
			className="hb-schedule-form"
			aria-labelledby={titleId}
			header={
				<div className="hb-schedule-form-head">
					<h2 id={titleId} className="hb-schedule-form-title">
						{editing ? `Edit ${schedule.title}` : "New schedule"}
					</h2>
					{editing ? <Badge>{draft.kind === "check" ? "Check" : "Task"}</Badge> : null}
				</div>
			}
		>
			<form className="hb-schedule-form-body" onSubmit={submit} noValidate>
				<div className="hb-schedule-form-fields">
					{editing ? null : (
						<div className="hb-schedule-form-choice">
							<span className="hb-schedule-form-label" aria-hidden="true">
								Kind
							</span>
							<SegmentedControl
								label="Kind"
								options={KIND_OPTIONS}
								value={draft.kind}
								onChange={(next) => flow.edit({ kind: next })}
							/>
							<p className="hb-schedule-form-hint">{KIND_HINT[draft.kind]}</p>
						</div>
					)}

					<TextField
						label="Title"
						name="title"
						autoComplete="off"
						// The form opened because the person asked for a schedule; the title is the first thing it needs.
						autoFocus={!editing}
						value={draft.title}
						disabled={busy}
						placeholder={draft.kind === "task" ? "Triage new issues" : "Disk free on the build hosts"}
						onChange={(event) => flow.edit({ title: event.target.value })}
						{...(errors.title === undefined ? {} : { error: errors.title })}
					/>

					{keepsPayload ? (
						<Notice level="info" announce={false}>
							This schedule's payload isn't one the form edits, so saving keeps it as it is.
						</Notice>
					) : draft.kind === "task" ? (
						<>
							<SelectField
								label="Agent"
								name="agent"
								options={agentOptions}
								value={draft.agentId}
								disabled={busy}
								onChange={(event) => flow.edit({ agentId: event.target.value })}
								{...(errors.agentId === undefined ? {} : { error: errors.agentId })}
							/>
							<TextAreaField
								label="Prompt"
								name="prompt"
								rows={5}
								value={draft.prompt}
								disabled={busy}
								placeholder="What should the agent do each time?"
								onChange={(event) => flow.edit({ prompt: event.target.value })}
								{...(errors.prompt === undefined
									? { hint: "Each run starts a new session and sends this as its first message, exactly as written." }
									: { error: errors.prompt })}
							/>
						</>
					) : (
						<TextField
							label="Command"
							name="command"
							className="hb-schedule-form-command"
							autoComplete="off"
							spellCheck={false}
							value={draft.command}
							disabled={busy}
							placeholder="checks/disk-free.sh --min-free 15%"
							onChange={(event) => flow.edit({ command: event.target.value })}
							{...(errors.command === undefined
								? { hint: "A script and its arguments. Quote an argument that has spaces." }
								: { error: errors.command })}
						/>
					)}

					<When flow={flow} draft={draft} errors={errors} busy={busy} zones={zones} />

					{draft.kind === "check" ? (
						<CheckSettingsFields flow={flow} draft={draft} errors={errors} busy={busy} />
					) : null}
				</div>

				<NextRuns preview={preview} timezone={draft.timezone} schedule={schedule} />

				{state.problem === undefined || state.confirmingEnd ? null : (
					<Notice level="error">{problemText(state.problem, "save")}</Notice>
				)}

				{state.confirmingEnd && schedule !== undefined ? (
					<EndConfirmation
						flow={flow}
						state={state}
						schedule={schedule}
						onEnded={(ended) => latest.current.onEnded?.(ended)}
					/>
				) : (
					<div className="hb-schedule-form-actions">
						<div className="hb-schedule-form-actions-main">
							<Button variant="primary" size="sm" type="submit" busy={state.saving}>
								{editing ? "Save changes" : "Create schedule"}
							</Button>
							{onCancel === undefined ? null : (
								<Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
									Cancel
								</Button>
							)}
						</div>
						{editing && schedule.status !== "ended" ? (
							<Button variant="danger" size="sm" disabled={busy} onClick={() => flow.askEnd()}>
								End schedule
							</Button>
						) : null}
					</div>
				)}
			</form>
		</Panel>
	);
}

function When({
	flow,
	draft,
	errors,
	busy,
	zones,
}: {
	flow: ScheduleFormFlow;
	draft: ScheduleDraft;
	errors: DraftErrors;
	busy: boolean;
	zones: readonly string[];
}) {
	const hasInterval = draft.every === "minutes" || draft.every === "hours" || draft.every === "day";
	const hasAt = !(draft.every === "minutes" || draft.every === "hours");
	return (
		// Fields are disabled one by one while saving, not by the fieldset, so the choices above stay reachable by Tab.
		<fieldset className="hb-schedule-form-when">
			<legend className="hb-schedule-form-label">When</legend>
			<SegmentedControl
				label="When"
				options={WHEN_OPTIONS}
				value={draft.when}
				onChange={(when) => flow.edit({ when })}
			/>
			{draft.when === "once" ? (
				<TextField
					label="Date and time"
					name="once"
					type="datetime-local"
					disabled={busy}
					className="hb-schedule-form-narrow"
					value={draft.once}
					onChange={(event) => flow.edit({ once: event.target.value })}
					{...(errors.once === undefined ? {} : { error: errors.once })}
				/>
			) : (
				<div className="hb-schedule-form-row">
					<SelectField
						label="Every"
						name="every"
						disabled={busy}
						options={EVERY_OPTIONS}
						value={draft.every}
						onChange={(event) => flow.edit({ every: event.target.value as ScheduleEvery })}
					/>
					{hasInterval ? (
						<TextField
							label={
								draft.every === "minutes" ? "Minutes apart" : draft.every === "hours" ? "Hours apart" : "Days apart"
							}
							name="interval"
							disabled={busy}
							type="number"
							inputMode="numeric"
							min={1}
							step={1}
							className="hb-schedule-form-number"
							value={draft.interval}
							onChange={(event) => flow.edit({ interval: event.target.value })}
							{...(errors.interval === undefined ? {} : { error: errors.interval })}
						/>
					) : null}
					{draft.every === "month" ? (
						<TextField
							label="Day of the month"
							name="day"
							disabled={busy}
							type="number"
							inputMode="numeric"
							min={1}
							max={31}
							step={1}
							className="hb-schedule-form-number"
							value={draft.day}
							onChange={(event) => flow.edit({ day: event.target.value })}
							{...(errors.day === undefined ? { hint: "31 means the last day." } : { error: errors.day })}
						/>
					) : null}
					{hasAt ? (
						<TextField
							label="At"
							name="at"
							disabled={busy}
							type="time"
							className="hb-schedule-form-time"
							value={draft.at}
							onChange={(event) => flow.edit({ at: event.target.value })}
							{...(errors.at === undefined ? {} : { error: errors.at })}
						/>
					) : null}
				</div>
			)}
			{draft.when === "repeat" && draft.every === "week" ? (
				<Weekdays value={draft.on} onChange={(on) => flow.edit({ on })} error={errors.on} />
			) : null}
			<div className="hb-schedule-form-row">
				<SelectField
					label="Time zone"
					name="timezone"
					disabled={busy}
					options={zones.map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }))}
					value={draft.timezone}
					onChange={(event) => flow.edit({ timezone: event.target.value })}
					{...(errors.timezone === undefined ? {} : { error: errors.timezone })}
				/>
				{draft.when === "repeat" ? (
					<TextField
						label="Stop after"
						name="count"
						disabled={busy}
						type="number"
						inputMode="numeric"
						min={1}
						step={1}
						className="hb-schedule-form-number"
						placeholder="No limit"
						value={draft.count}
						onChange={(event) => flow.edit({ count: event.target.value })}
						{...(errors.count === undefined ? { hint: "Runs, in all." } : { error: errors.count })}
					/>
				) : null}
			</div>
		</fieldset>
	);
}

function Weekdays({
	value,
	onChange,
	error,
}: {
	value: readonly Weekday[];
	onChange: (value: readonly Weekday[]) => void;
	error: string | undefined;
}) {
	return (
		<div className="hb-schedule-form-choice">
			<span className="hb-schedule-form-label" id="hb-schedule-form-days">
				On
			</span>
			{/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, inside the When fieldset already. */}
			<div className="hb-schedule-form-days" role="group" aria-labelledby="hb-schedule-form-days">
				{WEEK.map((weekday) => {
					const on = value.includes(weekday);
					return (
						<button
							key={weekday}
							type="button"
							className="hb-schedule-form-day hb-focusable"
							aria-pressed={on}
							aria-label={WEEKDAY_LABELS[weekday].long}
							onClick={() => onChange(on ? value.filter((day) => day !== weekday) : [...value, weekday])}
						>
							{WEEKDAY_LABELS[weekday].short}
						</button>
					);
				})}
			</div>
			{error === undefined ? null : (
				<p className="hb-text-field-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

function CheckSettingsFields({
	flow,
	draft,
	errors,
	busy,
}: {
	flow: ScheduleFormFlow;
	draft: ScheduleDraft;
	errors: DraftErrors;
	busy: boolean;
}) {
	const changed = draft.reraiseHours !== "" || draft.risingFactor !== "" || draft.failuresBeforeRaise !== "";
	const wrong =
		errors.reraiseHours !== undefined || errors.risingFactor !== undefined || errors.failuresBeforeRaise !== undefined;
	return (
		<Disclosure
			summary="When findings are raised again"
			defaultOpen={changed || wrong}
			className="hb-schedule-form-check"
		>
			<fieldset className="hb-schedule-form-row">
				<legend className="hb-sr-only">When findings are raised again</legend>
				<TextField
					label="Raise again after"
					name="reraiseHours"
					disabled={busy}
					type="number"
					inputMode="decimal"
					min={0}
					className="hb-schedule-form-number"
					placeholder="6"
					value={draft.reraiseHours}
					onChange={(event) => flow.edit({ reraiseHours: event.target.value })}
					{...(errors.reraiseHours === undefined
						? { hint: "Hours a finding stays quiet." }
						: { error: errors.reraiseHours })}
				/>
				<TextField
					label="Rising by"
					name="risingFactor"
					disabled={busy}
					type="number"
					inputMode="decimal"
					min={1}
					className="hb-schedule-form-number"
					placeholder="2"
					value={draft.risingFactor}
					onChange={(event) => flow.edit({ risingFactor: event.target.value })}
					{...(errors.risingFactor === undefined
						? { hint: "Raise when a value grows this many times." }
						: { error: errors.risingFactor })}
				/>
				<TextField
					label="Failures before raising"
					name="failuresBeforeRaise"
					disabled={busy}
					type="number"
					inputMode="numeric"
					min={1}
					step={1}
					className="hb-schedule-form-number"
					placeholder="3"
					value={draft.failuresBeforeRaise}
					onChange={(event) => flow.edit({ failuresBeforeRaise: event.target.value })}
					{...(errors.failuresBeforeRaise === undefined
						? { hint: "Failed runs in a row." }
						: { error: errors.failuresBeforeRaise })}
				/>
			</fieldset>
		</Disclosure>
	);
}

function NextRuns({
	preview,
	timezone,
	schedule,
}: {
	preview: readonly Timestamp[] | undefined;
	timezone: string;
	schedule: Schedule | undefined;
}) {
	return (
		<section className="hb-schedule-form-preview" aria-labelledby="hb-schedule-form-preview-title">
			<h3 id="hb-schedule-form-preview-title" className="hb-schedule-form-preview-title">
				<ClockIcon size="sm" />
				Next runs
			</h3>
			{preview === undefined ? (
				<p className="hb-schedule-form-hint">Fix the timing above to see when it runs.</p>
			) : preview.length === 0 ? (
				<p className="hb-schedule-form-hint">
					{schedule?.count !== undefined || schedule?.until !== undefined
						? "Nothing more is due: it has reached its limit."
						: "Nothing is due."}
				</p>
			) : (
				<>
					<ol className="hb-schedule-form-runs">
						{preview.map((at) => (
							<li key={at} className="hb-schedule-form-run">
								{dueText(at, timezone)}
							</li>
						))}
					</ol>
					<p className="hb-schedule-form-hint">In {timezone.replaceAll("_", " ")} time.</p>
				</>
			)}
		</section>
	);
}

function EndConfirmation({
	flow,
	state,
	schedule,
	onEnded,
}: {
	flow: ScheduleFormFlow;
	state: ScheduleFormState;
	schedule: Schedule;
	onEnded: (schedule: Schedule) => void;
}) {
	const cancel = useRef<HTMLButtonElement>(null);
	// Into the confirmation when it opens, on the safe choice.
	useEffect(() => cancel.current?.focus(), []);
	return (
		// biome-ignore lint/a11y/useSemanticElements: a confirmation inside the form, not a form of its own.
		<div className="hb-schedule-form-confirm" role="group" aria-label={`End ${schedule.title}`}>
			<p className="hb-schedule-form-confirm-text">
				End {schedule.title}? Nothing more runs. It stays in the list as ended, with its run history. This can't be
				undone.
			</p>
			{state.problem === undefined ? null : <Notice level="error">{problemText(state.problem, "end")}</Notice>}
			<div className="hb-schedule-form-actions-main">
				<Button
					variant="danger"
					size="sm"
					busy={state.ending}
					onClick={() =>
						void flow.end().then((ended) => {
							if (ended !== undefined) onEnded(ended);
						})
					}
				>
					End schedule
				</Button>
				<Button ref={cancel} variant="ghost" size="sm" disabled={state.ending} onClick={() => flow.cancelEnd()}>
					Keep it
				</Button>
			</div>
		</div>
	);
}
