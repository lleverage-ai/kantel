// "What agents may do" (#462): the lead of an HTTP connection's rules. A grid of the template's permission groups by
// read, write and delete, each Allow, Ask or Block, and what scheduled runs get in each (#466); for GitHub, the only
// repositories agents may reach; and the rules the grid didn't make, each saying where it came from. The grid is read from the rules and compiles back to them
// (connection-policy-model.ts), so the rule list under Advanced shows the same records and the dry run agrees.

import type { ConnectionRule, ConnectionRuleAction, ConnectionRules } from "@kantel/contracts";
import { type FormEvent, useId, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { SegmentedControl, type SegmentOption, type SegmentTone, TextField } from "../primitives/controls.tsx";
import { XIcon } from "../primitives/icons.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import { Badge, type BadgeTone } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import {
	cellKey,
	choiceOf,
	classifiesOperations,
	emptyPlan,
	hasRepositories,
	POLICY_ACCESSES,
	type PolicyAccess,
	type PolicyChoice,
	type PolicyGrid,
	type PolicyPlanCalls,
	planPolicy,
	policyExceptions,
	readPolicyGrid,
	repositoryProblem,
	ruleOrigin,
	runPolicyPlan,
	type ScheduledMode,
	scheduledModes,
} from "./connection-policy-model.ts";
import { whatText, whoText } from "./connection-rules.tsx";
import type { Connection, ConnectionsViewer } from "./connections-model.ts";

/** The grid's words for each answer: Block, not Deny, as people say it. */
export const POLICY_ACTION_LABELS: Record<ConnectionRuleAction, string> = { allow: "Allow", ask: "Ask", deny: "Block" };
const POLICY_ACTION_TONE: Record<ConnectionRuleAction, BadgeTone & ("done" | "approval" | "error")> = {
	allow: "done",
	ask: "approval",
	deny: "error",
};
const POLICY_OPTIONS: readonly SegmentOption<ConnectionRuleAction>[] = (["allow", "ask", "deny"] as const).map(
	(value) => ({ value, label: POLICY_ACTION_LABELS[value], tone: POLICY_ACTION_TONE[value] }),
);
const ACCESS_HEADINGS: Record<PolicyAccess, string> = { read: "Read", write: "Write", delete: "Delete" };
/** Scheduled runs' answers in a group, beside the cells (#466). */
export const SCHEDULED_LABELS: Record<ScheduledMode, string> = {
	same: "Same",
	reads: "Reads only",
	block: "Block",
};
const SCHEDULED_TONE: Record<ScheduledMode, BadgeTone & SegmentTone> = {
	same: "done",
	reads: "done",
	block: "error",
};
const SCHEDULED_HEADING = "In scheduled runs";
const ACCESS_NAMES: Record<PolicyAccess, string> = { read: "reads", write: "writes", delete: "deletes" };
const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

const subHeading = "m-0 text-sm font-medium text-fg";
const message = (error: unknown, fallback: string) =>
	error instanceof Error && error.message !== "" ? error.message : fallback;

/** How the grid reads a connection's rules: its template's groups, its first host, any agent in its project. */
export function policyOptions(connection: Pick<Connection, "templateId" | "hosts" | "owner">, now: number) {
	return {
		templateId: connection.templateId,
		host: connection.hosts[0] ?? "",
		...(connection.owner.kind === "project" ? { projectId: connection.owner.projectId } : {}),
		now,
	};
}

export interface ConnectionPolicyProps {
	readonly connection: Connection;
	readonly rules: ConnectionRules;
	/** The rules API's writes; a change is a plan of them, run in order. */
	readonly source: PolicyPlanCalls;
	readonly viewer: ConnectionsViewer;
	readonly canManage: boolean;
	readonly now: number;
	/** After a change (or a change that failed part way): read the rules again. */
	readonly onChanged: () => void;
}

/**
 * The grid over a connection's rules: a change compiles to a plan (creates, then updates, then removals of the grid's
 * own rules) and runs it, the grid taking no other change until the rules read back.
 */
export function ConnectionPolicy({
	connection,
	rules,
	source,
	viewer,
	canManage,
	now,
	onChanged,
}: ConnectionPolicyProps) {
	const options = useMemo(() => policyOptions(connection, now), [connection, now]);
	const grid = useMemo(() => readPolicyGrid(rules, options), [rules, options]);
	// A change in flight: the rules' version it started from, and the choice it makes, shown while it saves.
	const [saving, setSaving] = useState<{ readonly from: number; readonly choice: PolicyChoice }>();
	const [error, setError] = useState<string>();
	// A cell set, to say so when other rules still decide part of it once the rules read back.
	const [asked, setAsked] = useState<{ readonly from: number; readonly key: string; readonly action: string }>();
	// A plan is several requests, and the rules can read back between them (each bumps their version). The grid takes
	// nothing until the last has answered, so a second change is never planned from half-made rules.
	const running = useRef(false);
	const [inFlight, setInFlight] = useState(false);
	const busy = inFlight || (saving !== undefined && saving.from === rules.version);

	const apply = async (choice: PolicyChoice, cell?: string) => {
		if (busy || running.current) return;
		const plan = planPolicy(rules, choice, options);
		if (emptyPlan(plan)) return;
		running.current = true;
		setInFlight(true);
		setSaving({ from: rules.version, choice });
		setError(undefined);
		const action = cell === undefined ? undefined : choice.cells[cell];
		setAsked(cell === undefined || action === undefined ? undefined : { from: rules.version, key: cell, action });
		try {
			await runPolicyPlan(source, connection.id, plan);
		} catch (caught) {
			setSaving(undefined);
			setAsked(undefined);
			setError(message(caught, "Couldn't save that. Try again."));
		} finally {
			running.current = false;
			setInFlight(false);
		}
		// Even after a failure: some of the plan may have been made.
		onChanged();
	};

	const shown: PolicyGrid =
		busy && saving !== undefined
			? {
					...grid,
					cells: { ...grid.cells, ...saving.choice.cells },
					scheduled: { ...grid.scheduled, ...saving.choice.scheduled },
					repositories: saving.choice.repositories,
				}
			: grid;
	// Scheduled runs can't use a connection whose usage leaves them out, unless it's the person's own (#487).
	const unattended = connection.owner.kind === "user" || connection.usage?.unattended !== false;
	const short = asked !== undefined && rules.version > asked.from && grid.cells[asked.key] !== asked.action;

	return (
		<PolicyGridView
			grid={shown}
			exceptions={policyExceptions(rules)}
			viewer={viewer}
			canManage={canManage}
			saving={busy}
			{...(error === undefined ? {} : { error })}
			{...(short ? { note: "Other rules still decide some of these requests. They're listed under Exceptions." } : {})}
			onCell={(key, action) => void apply(choiceOf(grid, { cell: { key, action } }), key)}
			scheduledRuns={unattended}
			onScheduled={(group, mode) => void apply(choiceOf(grid, { scheduled: { group, mode } }))}
			classifies={classifiesOperations(connection.templateId)}
			onRepositories={(repositories) => void apply(choiceOf(grid, { repositories }))}
		/>
	);
}

export interface PolicyGridViewProps {
	readonly grid: PolicyGrid;
	/** The rules the grid didn't make, from `policyExceptions`. */
	readonly exceptions: readonly ConnectionRule[];
	readonly viewer: ConnectionsViewer;
	/** Without it the grid shows each answer, with no controls. */
	readonly canManage: boolean;
	/** A change is saving: the controls take nothing, and a line says it's saving. */
	readonly saving?: boolean;
	/** Why the last change failed. */
	readonly error?: string;
	/** A quiet note under the grid, such as when other rules still decide part of a cell. */
	readonly note?: string;
	readonly onCell: (key: string, action: ConnectionRuleAction) => void;
	/** Whether scheduled runs may use the connection at all; without it their column says they can't. Default true. */
	readonly scheduledRuns?: boolean;
	/** A group's scheduled runs set (#466). Without it the column shows each answer, with no controls. */
	readonly onScheduled?: (group: string, mode: ScheduledMode) => void;
	/** Whether the template tells reads from writes by what they do (#465), not by method alone. */
	readonly classifies?: boolean;
	/** The only repositories agents may reach, or null for every one. */
	readonly onRepositories: (repositories: readonly string[] | null) => void;
}

/** The grid, the repository list and the exceptions, as the rules read now. */
export function PolicyGridView({
	grid,
	exceptions,
	viewer,
	canManage,
	saving = false,
	error,
	note,
	onCell,
	scheduledRuns = true,
	onScheduled,
	classifies = false,
	onRepositories,
}: PolicyGridViewProps) {
	const repositories = hasRepositories(grid.groups);
	return (
		<div className="kt-connection-policy flex min-w-0 flex-col gap-6" aria-busy={saving || undefined}>
			<div className="flex min-w-0 flex-col gap-2">
				<div
					className={`grid min-w-0 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_repeat(3,max-content)] sm:gap-x-4 ${saving ? "pointer-events-none" : ""}`}
				>
					<div className="hidden sm:col-span-4 sm:grid sm:grid-cols-subgrid" aria-hidden="true">
						<span />
						{POLICY_ACCESSES.map((access) => (
							// A column at least a badge and some room wide, so read-only answers don't huddle at the edge.
							<span key={access} className="min-w-20 pb-2 text-xs text-muted">
								{ACCESS_HEADINGS[access]}
							</span>
						))}
					</div>
					{grid.groups.map((group) => (
						// biome-ignore lint/a11y/useSemanticElements: a row of the grid, named for its group; a fieldset can't be a subgrid row.
						<div
							key={group.id}
							role="group"
							aria-label={group.label}
							className="flex min-w-0 flex-col gap-2 border-0 border-t border-solid border-border py-3 sm:col-span-4 sm:grid sm:grid-cols-subgrid sm:items-center sm:gap-y-2 sm:py-2.5"
						>
							<span className="min-w-0 text-sm text-fg">{group.label}</span>
							{POLICY_ACCESSES.map((access) => (
								<PolicyCell
									key={access}
									group={group.label}
									access={access}
									answer={group.accesses.includes(access) ? grid.cells[cellKey(group.id, access)] : undefined}
									canManage={canManage}
									onChange={(action) => {
										if (!saving) onCell(cellKey(group.id, access), action);
									}}
								/>
							))}
							<ScheduledCell
								group={group.label}
								modes={scheduledModes(group)}
								mode={grid.scheduled?.[group.id] ?? "same"}
								available={scheduledRuns}
								canManage={canManage && onScheduled !== undefined}
								onChange={(mode) => {
									if (!saving) onScheduled?.(group.id, mode);
								}}
							/>
						</div>
					))}
				</div>
				<p className="m-0 border-0 border-t border-solid border-border pt-2 text-xs text-faint">
					{scheduledRuns
						? "In scheduled runs, nobody is there to answer: where a cell asks, the run waits for an approver and is refused if nobody answers in time. "
						: "Scheduled runs can't use this connection: its usage leaves them out. "}
					{classifies
						? "Kantel reads each request for what it does, so a GraphQL query is a read and a mutation a write."
						: "Reads are GET and HEAD requests, deletes are DELETE, and every other request is a write."}
				</p>
				{note === undefined ? null : (
					<Notice level="info" announce={false}>
						{note}
					</Notice>
				)}
				{saving ? (
					<p className="m-0 flex items-center gap-2 text-xs text-muted" role="status">
						<Spinner size="sm" />
						Saving its rules
					</p>
				) : null}
				{error === undefined ? null : <Notice level="error">{error}</Notice>}
			</div>
			{repositories ? (
				<RepositoryList
					repositories={grid.repositories}
					canManage={canManage}
					saving={saving}
					onChange={onRepositories}
				/>
			) : null}
			<PolicyExceptions exceptions={exceptions} viewer={viewer} />
		</div>
	);
}

function PolicyCell({
	group,
	access,
	answer,
	canManage,
	onChange,
}: {
	group: string;
	access: PolicyAccess;
	/** Undefined: the group has no such column. */
	answer: ConnectionRuleAction | "mixed" | undefined;
	canManage: boolean;
	onChange: (action: ConnectionRuleAction) => void;
}) {
	// On a phone each cell says its column, which the heading row says on a wider page.
	const column = <span className="text-xs text-muted sm:hidden">{ACCESS_HEADINGS[access]}</span>;
	if (answer === undefined)
		return (
			<span className="flex min-w-0 items-center justify-between gap-3 max-sm:hidden">
				<span className="text-sm text-faint" aria-hidden="true">
					—
				</span>
			</span>
		);
	const mixed = answer === "mixed";
	return (
		<span data-cell={access} className="flex min-w-0 items-center justify-between gap-3 sm:justify-start">
			{column}
			<span className="flex min-w-0 items-center gap-2">
				{mixed ? <span className="text-xs text-muted">Varies</span> : null}
				{canManage ? (
					<SegmentedControl<ConnectionRuleAction>
						label={`${group}, ${ACCESS_NAMES[access]}${mixed ? ", varies by request" : ""}`}
						options={POLICY_OPTIONS}
						value={mixed ? undefined : answer}
						onChange={(next) => {
							if (next !== answer) onChange(next);
						}}
					/>
				) : mixed ? null : (
					<Badge tone={POLICY_ACTION_TONE[answer]}>{POLICY_ACTION_LABELS[answer]}</Badge>
				)}
			</span>
		</span>
	);
}

/**
 * What scheduled runs get in a group (#466): Same, Reads only or Block, never looser than the cells. It sits under the
 * group's cells with its own label, as a fourth control doesn't fit beside three in the content column.
 */
function ScheduledCell({
	group,
	modes,
	mode,
	available,
	canManage,
	onChange,
}: {
	group: string;
	modes: readonly ScheduledMode[];
	mode: ScheduledMode | "mixed";
	available: boolean;
	canManage: boolean;
	onChange: (mode: ScheduledMode) => void;
}) {
	const label = <span className="text-xs text-muted">{SCHEDULED_HEADING}</span>;
	if (!available)
		return (
			<span
				data-cell="scheduled"
				className="flex min-w-0 items-center justify-between gap-3 sm:col-span-3 sm:col-start-2 sm:justify-start"
			>
				{label}
				<span className="text-sm text-faint">Not used</span>
			</span>
		);
	const mixed = mode === "mixed";
	return (
		<span
			data-cell="scheduled"
			className="flex min-w-0 items-center justify-between gap-3 sm:col-span-3 sm:col-start-2 sm:justify-start"
		>
			{label}
			<span className="flex min-w-0 items-center gap-2">
				{mixed ? <span className="text-xs text-muted">Varies</span> : null}
				{canManage ? (
					<SegmentedControl<ScheduledMode>
						label={`${group}, scheduled runs${mixed ? ", varies by request" : ""}`}
						options={modes.map((value) => ({
							value,
							label: SCHEDULED_LABELS[value],
							tone: SCHEDULED_TONE[value],
						}))}
						value={mixed ? undefined : mode}
						onChange={(next) => {
							if (next !== mode) onChange(next);
						}}
					/>
				) : mixed ? null : (
					<Badge tone={SCHEDULED_TONE[mode]}>{SCHEDULED_LABELS[mode]}</Badge>
				)}
			</span>
		</span>
	);
}

/** "Every repository it can reach" or only these, with the listed ones as chips and a field to add one. */
function RepositoryList({
	repositories,
	canManage,
	saving,
	onChange,
}: {
	repositories: readonly string[] | undefined;
	canManage: boolean;
	saving: boolean;
	onChange: (repositories: readonly string[] | null) => void;
}) {
	const headingId = useId();
	const name = useId();
	// "Only these" chosen with nothing listed yet: shown, not saved, until the first repository is added.
	const [choosing, setChoosing] = useState(false);
	const [draft, setDraft] = useState("");
	const [shown, setShown] = useState(false);
	const only = repositories !== undefined || choosing;
	const listed = repositories ?? [];
	const problem = repositoryProblem(draft) ?? (listed.includes(draft.trim()) ? "It's already listed" : undefined);

	const add = (event: FormEvent) => {
		event.preventDefault();
		setShown(true);
		if (problem !== undefined || saving) return;
		onChange([...listed, draft.trim()]);
		setDraft("");
		setShown(false);
		setChoosing(false);
	};

	return (
		<section className="flex min-w-0 flex-col gap-3" aria-labelledby={headingId}>
			<h4 id={headingId} className={subHeading}>
				Repositories
			</h4>
			{canManage ? (
				<fieldset className={`m-0 flex min-w-0 flex-col gap-2 border-0 p-0 ${saving ? "pointer-events-none" : ""}`}>
					<legend className="kt-sr-only">Which repositories agents may reach</legend>
					{(
						[
							["every", "Every repository it can reach"],
							["only", "Only these"],
						] as const
					).map(([value, label]) => (
						<label key={value} className="flex min-w-0 cursor-pointer items-center gap-2.5 text-sm text-fg">
							<input
								type="radio"
								name={name}
								value={value}
								checked={value === "only" ? only : !only}
								onChange={() => {
									if (saving) return;
									if (value === "only") setChoosing(true);
									else {
										setChoosing(false);
										if (repositories !== undefined) onChange(null);
									}
								}}
								className="kt-focusable m-0 size-3.5 accent-accent"
							/>
							{label}
						</label>
					))}
				</fieldset>
			) : (
				<p className="m-0 text-sm text-fg">{only ? "Only these" : "Every repository it can reach"}</p>
			)}
			{only ? (
				<div className="flex min-w-0 flex-col gap-2 sm:pl-6">
					{listed.length === 0 ? null : (
						<ul className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0">
							{listed.map((repo) => (
								<li
									key={repo}
									className="inline-flex h-control-sm min-w-0 items-center gap-0.5 rounded-full border border-border bg-panel pr-0.5 pl-2.5 text-xs text-fg"
								>
									<span className="min-w-0 truncate">{repo}</span>
									{/* The last one stays: Every repository is the way out, so the list never blocks them all. */}
									{canManage && listed.length > 1 ? (
										<IconButton
											variant="ghost"
											size="xs"
											className="rounded-full"
											label={`Remove ${repo}`}
											icon={<XIcon size="sm" />}
											disabled={saving}
											onClick={() => onChange(listed.filter((each) => each !== repo))}
										/>
									) : (
										<span className="w-2" />
									)}
								</li>
							))}
						</ul>
					)}
					{canManage ? (
						<form className="flex min-w-0 items-start gap-2" onSubmit={add}>
							<TextField
								label="Add a repository"
								hideLabel
								mono
								className="min-w-0 flex-1 sm:max-w-64"
								placeholder="owner/name"
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								error={shown ? problem : undefined}
							/>
							<Button type="submit" busy={saving}>
								Add
							</Button>
						</form>
					) : null}
					<p className="m-0 text-xs text-faint">
						{listed.length === 0
							? "Agents reach every repository until you add the first one."
							: "Requests to any other repository are blocked, and writes that name no one repository, such as GraphQL mutations, ask first."}
					</p>
				</div>
			) : null}
		</section>
	);
}

/** The rules the grid didn't make: an approval's, a person's, this session's. Each is changed under Advanced. */
function PolicyExceptions({
	exceptions,
	viewer,
}: {
	exceptions: readonly ConnectionRule[];
	viewer: ConnectionsViewer;
}) {
	const headingId = useId();
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby={headingId}>
			<div className="flex min-w-0 flex-col gap-1">
				<h4 id={headingId} className={subHeading}>
					Exceptions
				</h4>
				<p className="m-0 max-w-prose text-xs leading-normal text-muted">
					Rules that decide some requests themselves, whatever the grid says for the rest. Change them under Advanced.
				</p>
			</div>
			{exceptions.length === 0 ? (
				<p className="m-0 text-sm text-muted">None. The grid decides every request.</p>
			) : (
				<ul className="m-0 flex min-w-0 list-none flex-col p-0">
					{exceptions.map((rule) => (
						<li
							key={rule.id}
							data-rule={rule.id}
							className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 border-0 border-t border-solid border-border py-2 first:border-t-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
						>
							<span className="self-center">
								<Badge tone={POLICY_ACTION_TONE[rule.action]}>{POLICY_ACTION_LABELS[rule.action]}</Badge>
							</span>
							<span className="flex min-w-0 flex-col gap-0.5">
								<code className="kt-mono min-w-0 text-code text-fg wrap-anywhere">{whatText(rule.what)}</code>
								{rule.who.kind === "any" || rule.who.kind === "session" ? null : (
									<span className="text-xs text-muted">{whoText(rule.who, viewer)}</span>
								)}
							</span>
							<span className="col-start-2 text-xs text-faint sm:col-start-3 sm:text-right">
								{ruleOrigin(rule, (at) => day.format(at))}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
