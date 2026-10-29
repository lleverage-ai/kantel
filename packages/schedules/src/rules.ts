/**
 * The rules every `Schedules` store applies, so the in-memory store (`./memory.ts`) and the SQL store (`./sql.ts`)
 * decide the same way: input validation, what a create, change or tick does to a schedule, which findings a check run
 * raises, and the audit events each writes. Pure: no storage here, and the clock is always passed in.
 */
import {
	type Actor,
	type AuditEventInput,
	type CallContext,
	type CheckReport,
	type Finding,
	HarbourError,
	type JsonValue,
	type Occurrence,
	type OrganisationId,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type ProjectId,
	type RaisedFinding,
	type Role,
	type Schedule,
	type ScheduleInput,
	systemContext,
	type Timestamp,
} from "@harbour/contracts";
import { assertValidRecurrence, assertValidTimeZone, nextDue, previewDue } from "./index.ts";

export const HOUR_MS = 3_600_000;
export const DEFAULT_RERAISE_HOURS = 6;
export const DEFAULT_RISING_FACTOR = 2;
export const DEFAULT_FAILURES_BEFORE_RAISE = 3;
/** Sal's default severity order, worst first: Linear's priority names, then `warn` and `info`. */
export const DEFAULT_SEVERITY_ORDER: readonly string[] = ["urgent", "high", "medium", "low", "warn", "info"];
/** Older severity names, read as these (prod-health's before it used Linear's names). */
const SEVERITY_ALIASES: { readonly [name: string]: string } = { sev1: "urgent", sev2: "high", sev3: "low" };
/** The most missed due times one tick walks through for a schedule. */
export const MAX_COALESCED = 10_000;
export const SCHEDULER: Actor = { kind: "system", component: "schedules" };
/** The scheduler appends its audit events as itself. */
export const AUDIT_CONTEXT = systemContext("schedules");

/** The fields a caller may set: `ScheduleInput`'s, and nothing the store owns (id, status, counts, timestamps). */
const INPUT_FIELDS = [
	"owner",
	"kind",
	"title",
	"timezone",
	"at",
	"repeat",
	"until",
	"count",
	"payload",
	"check",
] as const;

export function inputFields(input: Partial<ScheduleInput>): Partial<ScheduleInput> {
	const picked: Record<string, unknown> = {};
	for (const field of INPUT_FIELDS) {
		if (Object.hasOwn(input, field)) picked[field] = structuredClone(input[field]);
	}
	return picked as Partial<ScheduleInput>;
}

export function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
}

export function pageLimit(page: PageRequest | undefined): number {
	return Math.max(1, Math.min(page?.limit ?? 100, 500));
}

/** Pages a list held in memory by offset. */
export function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = pageLimit(page);
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new HarbourError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

export function assertValidInput(ctx: CallContext, input: ScheduleInput): void {
	const owner = input.owner;
	if (owner.kind === "platform" || owner.organisationId !== ctx.organisationId) {
		throw new HarbourError("invalid", "A schedule must be owned within the caller's organisation");
	}
	assertValidTimeZone(input.timezone);
	if ((input.at === undefined) === (input.repeat === undefined)) {
		throw new HarbourError("invalid", "Set exactly one of at and repeat");
	}
	if (input.at !== undefined && !Number.isFinite(input.at)) throw new HarbourError("invalid", "at must be a timestamp");
	if (input.repeat !== undefined) assertValidRecurrence(input.repeat);
	if (input.until !== undefined && !Number.isFinite(input.until)) {
		throw new HarbourError("invalid", "until must be a timestamp");
	}
	if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1)) {
		throw new HarbourError("invalid", "count must be a positive integer");
	}
	const check = input.check;
	if (check !== undefined) {
		if (check.reraiseHours !== undefined && !(check.reraiseHours > 0)) {
			throw new HarbourError("invalid", "reraiseHours must be positive");
		}
		if (check.risingFactor !== undefined && !(check.risingFactor > 1)) {
			throw new HarbourError("invalid", "risingFactor must be more than 1");
		}
		const failures = check.failuresBeforeRaise;
		if (failures !== undefined && (!Number.isInteger(failures) || failures < 1)) {
			throw new HarbourError("invalid", "failuresBeforeRaise must be a positive integer");
		}
		const order = check.severityOrder;
		if (
			order !== undefined &&
			(!Array.isArray(order) || order.length === 0 || order.some((name) => typeof name !== "string" || name === ""))
		) {
			throw new HarbourError("invalid", "severityOrder must be a list of severity names");
		}
	}
}

export function withoutNextDue(schedule: Schedule): Schedule {
	const { nextDueAt: _nextDueAt, ...rest } = schedule;
	return rest;
}

/** The schedule active from `now` (no backfill), or ended when it has no due time left. */
export function rescheduled(schedule: Schedule, now: Timestamp): Schedule {
	const nextDueAt = previewDue(schedule, now, 1)[0];
	if (nextDueAt === undefined) return { ...withoutNextDue(schedule), status: "ended", updatedAt: now };
	return { ...schedule, status: "active", nextDueAt, updatedAt: now };
}

/** A new schedule from `input`, active from `now`. Rejects one that would never be due as `invalid`. */
export function newSchedule(ctx: CallContext, input: ScheduleInput, id: string, now: Timestamp): Schedule {
	const draft: Schedule = {
		...(inputFields(input) as ScheduleInput),
		id,
		status: "active",
		occurrences: 0,
		createdBy: ctx.actor,
		createdAt: now,
		updatedAt: now,
	};
	const schedule = rescheduled(draft, now);
	if (schedule.status === "ended") throw new HarbourError("invalid", "The schedule would never be due");
	return schedule;
}

/** `current` with `input` applied, as `update` stores it. Rejects with `conflict` once ended, `invalid` on bad input. */
export function updatedSchedule(
	ctx: CallContext,
	current: Schedule,
	input: Partial<ScheduleInput>,
	now: Timestamp,
): Schedule {
	if (current.status === "ended") throw new HarbourError("conflict", `Schedule ${current.id} has ended`);
	const merged: Schedule = { ...current, ...inputFields(input), owner: current.owner, kind: current.kind };
	assertValidInput(ctx, merged);
	return merged.status === "paused" ? { ...withoutNextDue(merged), updatedAt: now } : rescheduled(merged, now);
}

/** `current` paused, or `undefined` when it already is. Rejects with `conflict` once ended. */
export function pausedSchedule(current: Schedule, now: Timestamp): Schedule | undefined {
	if (current.status === "ended") throw new HarbourError("conflict", `Schedule ${current.id} has ended`);
	if (current.status === "paused") return undefined;
	return { ...withoutNextDue(current), status: "paused", updatedAt: now };
}

/** `current` resumed from `now` (no backfill), or `undefined` when it is active. Rejects with `conflict` once ended. */
export function resumedSchedule(current: Schedule, now: Timestamp): Schedule | undefined {
	if (current.status === "ended") throw new HarbourError("conflict", `Schedule ${current.id} has ended`);
	if (current.status === "active") return undefined;
	return rescheduled(current, now);
}

/** `current` ended, or `undefined` when it already has. */
export function endedSchedule(current: Schedule, now: Timestamp): Schedule | undefined {
	if (current.status === "ended") return undefined;
	return { ...withoutNextDue(current), status: "ended", updatedAt: now };
}

/** Whether a tick at `now` materialises an occurrence for `schedule` (given it has none due or running). */
export function isDue(schedule: Schedule, now: Timestamp): boolean {
	return schedule.status === "active" && schedule.nextDueAt !== undefined && schedule.nextDueAt <= now;
}

/**
 * What a tick at `now` does to a due schedule with no open occurrence: one occurrence at the latest missed due time,
 * standing for every due time it coalesces (at most `MAX_COALESCED`), and the schedule moved on past now (or ended).
 */
export function materialise(schedule: Schedule, now: Timestamp): { occurrence: Occurrence; next: Schedule } {
	let latest = schedule.nextDueAt!;
	let coalesced = 1;
	let following = nextDue(schedule, latest);
	while (following !== undefined && following <= now && coalesced < MAX_COALESCED) {
		latest = following;
		coalesced += 1;
		following = nextDue(schedule, latest);
	}
	const counted = { ...schedule, occurrences: schedule.occurrences + 1 };
	const after = nextDue(counted, now);
	const next: Schedule =
		after === undefined
			? { ...withoutNextDue(counted), status: "ended", updatedAt: now }
			: { ...counted, nextDueAt: after, updatedAt: now };
	return {
		occurrence: {
			id: `${schedule.id}@${latest}`,
			scheduleId: schedule.id,
			dueAt: latest,
			coalesced,
			status: "due",
			attempt: 0,
		},
		next,
	};
}

/** Whether `occurrence` may be claimed at `now`: due, or running past its lease (the runner died). */
export function isClaimable(occurrence: Occurrence, now: Timestamp): boolean {
	return (
		occurrence.status === "due" ||
		(occurrence.status === "running" && occurrence.leaseUntil !== undefined && now >= occurrence.leaseUntil)
	);
}

/** `occurrence` claimed by `runner` until `now + leaseMs`. */
export function claimed(occurrence: Occurrence, runner: string, leaseMs: number, now: Timestamp): Occurrence {
	return {
		...occurrence,
		status: "running",
		claimedBy: runner,
		leaseUntil: now + leaseMs,
		attempt: occurrence.attempt + 1,
	};
}

export function assertClaimInput(runner: string, leaseMs: number): void {
	if (runner.length === 0) throw new HarbourError("invalid", "A claim needs a runner");
	if (!(leaseMs > 0)) throw new HarbourError("invalid", "leaseMs must be positive");
}

/** The occurrence if `runner` holds it with a live lease at `now`; `not_found` or `conflict` otherwise. */
export function heldBy(
	occurrence: Occurrence | undefined,
	occurrenceId: string,
	runner: string,
	now: Timestamp,
): Occurrence {
	if (occurrence === undefined) throw new HarbourError("not_found", `No occurrence ${occurrenceId}`);
	if (
		occurrence.status !== "running" ||
		occurrence.claimedBy !== runner ||
		occurrence.leaseUntil === undefined ||
		now >= occurrence.leaseUntil
	) {
		throw new HarbourError("conflict", `${runner} does not hold occurrence ${occurrenceId}`);
	}
	return occurrence;
}

/** What a schedule recorded for a finding key: when it was last raised, its value and severity then, when last seen. */
export interface RaisedRecord {
	readonly at: Timestamp;
	readonly value?: number;
	readonly severity?: string;
	readonly seenAt: Timestamp;
}

/** What a check run does: how the occurrence finishes, the failure count after it, what to raise and record. */
export interface CheckSettlement {
	readonly status: "succeeded" | "failed";
	readonly result: JsonValue;
	readonly failuresInRow: number;
	readonly raised: readonly RaisedFinding[];
	/** The records to store, by finding key: every key this run saw, `check-failed` included, raised or not. */
	readonly records: ReadonlyMap<string, RaisedRecord>;
}

/**
 * Settles a check run from its exit code: 0 is healthy, 3 is findings, anything else a failed run. As Sal's checks do,
 * a finding is raised when it is new (no record, or unseen for `reraiseHours`), escalated (worse by `severityOrder`, or
 * marked `escalated` by the command with another severity), rising (`risingFactor` times its value when last raised),
 * or still present `reraiseHours` after it was last raised. `failuresBeforeRaise` failed runs in a row raise
 * `check-failed:<schedule>` (`low`), deduplicated like any other key. `lastRaised` reads what the schedule recorded.
 */
export function settleCheck(
	schedule: Schedule,
	occurrenceId: string,
	failuresInRow: number,
	lastRaised: (key: string) => RaisedRecord | undefined,
	report: CheckReport,
	now: Timestamp,
): CheckSettlement {
	if (schedule.kind !== "check") throw new HarbourError("invalid", `Schedule ${schedule.id} is not a check`);
	if (!Number.isInteger(report.exitCode)) throw new HarbourError("invalid", "exitCode must be an integer");
	const settings = schedule.check ?? {};
	if (report.exitCode === 0 || report.exitCode === 3) {
		const records = new Map<string, RaisedRecord>();
		const raised =
			report.exitCode === 3
				? findingsToRaise(schedule, occurrenceId, lastRaised, records, report.findings ?? [], now)
				: [];
		return {
			status: "succeeded",
			result: { exitCode: report.exitCode, raised: raised.length },
			failuresInRow: 0,
			raised,
			records,
		};
	}
	const failures = failuresInRow + 1;
	const threshold = settings.failuresBeforeRaise ?? DEFAULT_FAILURES_BEFORE_RAISE;
	const records = new Map<string, RaisedRecord>();
	const raised =
		failures >= threshold
			? findingsToRaise(
					schedule,
					occurrenceId,
					lastRaised,
					records,
					[
						{
							key: `check-failed:${schedule.id}`,
							severity: "low",
							summary: `${schedule.title} failed ${failures} runs in a row (last exit code ${report.exitCode})`,
						},
					],
					now,
				).map((finding) => (finding.reason === "new" ? { ...finding, reason: "failures" as const } : finding))
			: [];
	return {
		status: "failed",
		result: { exitCode: report.exitCode, raised: raised.length },
		failuresInRow: failures,
		raised,
		records,
	};
}

function findingsToRaise(
	schedule: Schedule,
	occurrenceId: string,
	lastRaised: (key: string) => RaisedRecord | undefined,
	records: Map<string, RaisedRecord>,
	findings: readonly Finding[],
	now: Timestamp,
): RaisedFinding[] {
	const settings = schedule.check ?? {};
	const reraiseMs = (settings.reraiseHours ?? DEFAULT_RERAISE_HOURS) * HOUR_MS;
	const risingFactor = settings.risingFactor ?? DEFAULT_RISING_FACTOR;
	const rank = severityRank(settings.severityOrder ?? DEFAULT_SEVERITY_ORDER);
	const raised: RaisedFinding[] = [];
	const seen = new Set<string>();
	for (const finding of findings) {
		if (seen.has(finding.key)) continue;
		seen.add(finding.key);
		const last = lastRaised(finding.key);
		let reason: RaisedFinding["reason"] | undefined;
		if (last === undefined || now - last.seenAt >= reraiseMs) reason = "new";
		else if (last.severity !== undefined && rank(finding.severity) < rank(last.severity)) reason = "escalated";
		else if (
			finding.status?.toLowerCase() === "escalated" &&
			normalSeverity(finding.severity) !== normalSeverity(last.severity ?? "")
		) {
			reason = "escalated";
		} else if (
			finding.value !== undefined &&
			last.value !== undefined &&
			(last.value > 0 ? finding.value >= risingFactor * last.value : finding.value > 0)
		) {
			reason = "rising";
		} else if (now - last.at >= reraiseMs) reason = "reraise";
		if (reason === undefined) {
			// Seen, not raised: only when it was last seen changes, so it isn't new again while it stays.
			records.set(finding.key, { ...last!, seenAt: now });
			continue;
		}
		records.set(finding.key, {
			at: now,
			severity: finding.severity,
			seenAt: now,
			...(finding.value === undefined ? {} : { value: finding.value }),
		});
		raised.push({ ...finding, scheduleId: schedule.id, occurrenceId, reason });
	}
	return raised;
}

/** A severity name as ranked: lower case, with `sev1`-`sev3` read as their current names. */
function normalSeverity(severity: string): string {
	const lower = severity.toLowerCase();
	return SEVERITY_ALIASES[lower] ?? lower;
}

/** Ranks severities by `order`, worst first (0); one it doesn't name ranks below all of them. */
export function severityRank(order: readonly string[]): (severity: string) => number {
	const ranks = new Map<string, number>();
	order.forEach((name, index) => {
		const normal = normalSeverity(name);
		if (!ranks.has(normal)) ranks.set(normal, index);
	});
	return (severity) => ranks.get(normalSeverity(severity)) ?? order.length;
}

function projectOf(schedule: Schedule): { readonly projectId?: ProjectId } {
	return schedule.owner.kind === "project" ? { projectId: schedule.owner.projectId } : {};
}

/** `schedules.schedule.created`, by the creating actor. */
export function createdEvent(ctx: CallContext, schedule: Schedule, now: Timestamp): AuditEventInput {
	return {
		id: `schedules:schedule:${schedule.id}:created`,
		at: now,
		source: "schedules",
		type: "schedules.schedule.created",
		actor: ctx.actor,
		organisationId: ctx.organisationId,
		...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
		subject: { kind: "schedules.schedule", id: schedule.id },
		data: {
			kind: schedule.kind,
			title: schedule.title,
			timezone: schedule.timezone,
			nextDueAt: schedule.nextDueAt ?? null,
		},
	};
}

/** A lifecycle change (`updated`, `paused`, `resumed`, `ended`) by its actor; `change` numbers it within the schedule. */
export function changeEvent(
	ctx: CallContext,
	organisationId: OrganisationId,
	schedule: Schedule,
	change: string,
	changes: number,
	now: Timestamp,
): AuditEventInput {
	return {
		id: `schedules:schedule:${schedule.id}:${change}:${changes}`,
		at: now,
		source: "schedules",
		type: `schedules.schedule.${change}`,
		actor: ctx.actor,
		organisationId,
		...projectOf(schedule),
		subject: { kind: "schedules.schedule", id: schedule.id },
		data: { status: schedule.status, nextDueAt: schedule.nextDueAt ?? null },
	};
}

/** `schedules.finding.raised`, by the scheduler. */
export function raiseEvent(
	organisationId: OrganisationId,
	schedule: Schedule,
	raised: RaisedFinding,
	now: Timestamp,
): AuditEventInput {
	return {
		id: `schedules:finding:${raised.occurrenceId}:${raised.key}`,
		at: now,
		source: "schedules",
		type: "schedules.finding.raised",
		actor: SCHEDULER,
		organisationId,
		...projectOf(schedule),
		subject: { kind: "schedules.schedule", id: schedule.id },
		data: {
			occurrenceId: raised.occurrenceId,
			key: raised.key,
			severity: raised.severity,
			summary: raised.summary,
			reason: raised.reason,
			...(raised.value === undefined ? {} : { value: raised.value }),
		},
	};
}

/** Requires `needed` on the schedule's project when a project owns it; other owners need no project check. */
export async function requireOwner(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	owner: ScheduleInput["owner"],
	needed: Role,
	operation: string,
	scheduleId?: string,
): Promise<void> {
	if (access === undefined || owner.kind !== "project") return;
	await access.require(ctx, {
		projectId: owner.projectId,
		needed,
		operation,
		...(scheduleId === undefined ? {} : { subject: { kind: "schedules.schedule", id: scheduleId } }),
	});
}

/**
 * Keeps the schedules the caller may see: a project's only when the caller `allows` viewer on it, asked once per
 * project through `viewable`, which the caller keeps across pages.
 */
export async function visibleTo(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	schedules: readonly Schedule[],
	viewable: Map<ProjectId, Promise<boolean>> = new Map(),
): Promise<Schedule[]> {
	if (access === undefined) return [...schedules];
	const visible: Schedule[] = [];
	for (const schedule of schedules) {
		const owner = schedule.owner;
		if (owner.kind === "project") {
			let allowed = viewable.get(owner.projectId);
			if (allowed === undefined) {
				allowed = access.allows(ctx, { projectId: owner.projectId, needed: "viewer" });
				viewable.set(owner.projectId, allowed);
			}
			if (!(await allowed)) continue;
		}
		visible.push(schedule);
	}
	return visible;
}

/** Whether `schedule` matches a `list` filter. */
export function matchesFilter(
	schedule: Schedule,
	filter: { readonly kind?: Schedule["kind"]; readonly status?: Schedule["status"] } | undefined,
): boolean {
	return (
		(filter?.kind === undefined || schedule.kind === filter.kind) &&
		(filter?.status === undefined || schedule.status === filter.status)
	);
}

/** The due times `preview` lists: from the next due time when active, else from now; none once ended. */
export function previewOf(schedule: Schedule, n: number, now: Timestamp): Timestamp[] {
	if (!Number.isInteger(n) || n < 0) throw new HarbourError("invalid", "n must be a non-negative integer");
	if (schedule.status === "ended") return [];
	const from = schedule.status === "active" && schedule.nextDueAt !== undefined ? schedule.nextDueAt : now;
	return previewDue(schedule, from, n);
}
