import {
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type CheckReport,
	type Clock,
	type Finding,
	HarbourError,
	type Occurrence,
	type OrganisationId,
	type Page,
	type PageRequest,
	type RaisedFinding,
	type Schedule,
	type ScheduleInput,
	type Schedules,
	systemClock,
	type Timestamp,
} from "@harbour/contracts";
import { assertValidRecurrence, assertValidTimeZone, nextDue, previewDue } from "./index.ts";

export interface MemorySchedulesOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
}

const HOUR_MS = 3_600_000;
const DEFAULT_RERAISE_HOURS = 6;
const DEFAULT_RISING_FACTOR = 2;
const DEFAULT_FAILURES_BEFORE_RAISE = 3;
/** The most missed due times one tick walks through for a schedule. */
const MAX_COALESCED = 10_000;
const SCHEDULER: Actor = { kind: "system", component: "schedules" };

interface StoredSchedule {
	readonly organisationId: OrganisationId;
	schedule: Schedule;
	/** Failed check runs in a row; a success resets it. */
	failuresInRow: number;
	/** When each finding key was last raised, and its value then. */
	readonly raised: Map<string, { readonly at: Timestamp; readonly value?: number }>;
	/** Changes made to the schedule, numbering its lifecycle audit events. */
	changes: number;
}

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

function inputFields(input: Partial<ScheduleInput>): Partial<ScheduleInput> {
	const picked: Record<string, unknown> = {};
	for (const field of INPUT_FIELDS) {
		if (Object.hasOwn(input, field)) picked[field] = structuredClone(input[field]);
	}
	return picked as Partial<ScheduleInput>;
}

function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
}

function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new HarbourError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

function assertValidInput(ctx: CallContext, input: ScheduleInput): void {
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
	}
}

function withoutNextDue(schedule: Schedule): Schedule {
	const { nextDueAt: _nextDueAt, ...rest } = schedule;
	return rest;
}

/** The schedule active from `now` (no backfill), or ended when it has no due time left. */
function rescheduled(schedule: Schedule, now: Timestamp): Schedule {
	const nextDueAt = previewDue(schedule, now, 1)[0];
	if (nextDueAt === undefined) return { ...withoutNextDue(schedule), status: "ended", updatedAt: now };
	return { ...schedule, status: "active", nextDueAt, updatedAt: now };
}

/**
 * The reference `Schedules`: schedules and occurrences in maps. `tick` and `claim` do all their work synchronously, so
 * concurrent calls never materialise or claim one occurrence twice.
 */
export function createMemorySchedules(options: MemorySchedulesOptions = {}): Schedules {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;

	const schedules = new Map<string, StoredSchedule>();
	/** Every occurrence, in the order it was materialised. */
	const occurrences = new Map<string, Occurrence>();

	async function emit(events: readonly AuditEventInput[]): Promise<void> {
		if (audit === undefined || events.length === 0) return;
		await audit.append(events);
	}

	/** Audits a lifecycle change (`updated`, `paused`, `resumed`, `ended`) by its actor. */
	async function emitChange(ctx: CallContext, stored: StoredSchedule, change: string): Promise<void> {
		stored.changes += 1;
		const owner = stored.schedule.owner;
		await emit([
			{
				id: `schedules:schedule:${stored.schedule.id}:${change}:${stored.changes}`,
				at: clock.now(),
				source: "schedules",
				type: `schedules.schedule.${change}`,
				actor: ctx.actor,
				organisationId: stored.organisationId,
				...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
				subject: { kind: "schedules.schedule", id: stored.schedule.id },
				data: { status: stored.schedule.status, nextDueAt: stored.schedule.nextDueAt ?? null },
			},
		]);
	}

	function storedFor(organisationId: OrganisationId, scheduleId: string): StoredSchedule {
		const stored = schedules.get(scheduleId);
		if (stored === undefined || stored.organisationId !== organisationId) {
			throw new HarbourError("not_found", `No schedule ${scheduleId}`);
		}
		return stored;
	}

	function hasOpenOccurrence(scheduleId: string): boolean {
		for (const occurrence of occurrences.values()) {
			if (occurrence.scheduleId === scheduleId && (occurrence.status === "due" || occurrence.status === "running")) {
				return true;
			}
		}
		return false;
	}

	/** The occurrence `runner` holds with a live lease; `conflict` otherwise. */
	function heldClaim(occurrenceId: string, runner: string): Occurrence {
		const occurrence = occurrences.get(occurrenceId);
		if (occurrence === undefined) throw new HarbourError("not_found", `No occurrence ${occurrenceId}`);
		if (
			occurrence.status !== "running" ||
			occurrence.claimedBy !== runner ||
			occurrence.leaseUntil === undefined ||
			clock.now() >= occurrence.leaseUntil
		) {
			throw new HarbourError("conflict", `${runner} does not hold occurrence ${occurrenceId}`);
		}
		return occurrence;
	}

	function finish(
		occurrence: Occurrence,
		status: "succeeded" | "failed",
		result: Occurrence["result"] | undefined,
	): Occurrence {
		const finished: Occurrence = {
			...occurrence,
			status,
			finishedAt: clock.now(),
			...(result === undefined ? {} : { result }),
		};
		occurrences.set(finished.id, finished);
		return finished;
	}

	function raiseEvent(stored: StoredSchedule, raised: RaisedFinding): AuditEventInput {
		const owner = stored.schedule.owner;
		return {
			id: `schedules:finding:${raised.occurrenceId}:${raised.key}`,
			at: clock.now(),
			source: "schedules",
			type: "schedules.finding.raised",
			actor: SCHEDULER,
			organisationId: stored.organisationId,
			...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
			subject: { kind: "schedules.schedule", id: stored.schedule.id },
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

	/** The findings of a successful check run to raise now, recording each as raised. */
	function findingsToRaise(
		stored: StoredSchedule,
		occurrenceId: string,
		findings: readonly Finding[],
	): RaisedFinding[] {
		const now = clock.now();
		const settings = stored.schedule.check ?? {};
		const reraiseMs = (settings.reraiseHours ?? DEFAULT_RERAISE_HOURS) * HOUR_MS;
		const risingFactor = settings.risingFactor ?? DEFAULT_RISING_FACTOR;
		const raised: RaisedFinding[] = [];
		const seen = new Set<string>();
		for (const finding of findings) {
			if (seen.has(finding.key)) continue;
			seen.add(finding.key);
			const last = stored.raised.get(finding.key);
			let reason: RaisedFinding["reason"] | undefined;
			if (last === undefined) reason = "new";
			else if (now - last.at >= reraiseMs) reason = "reraise";
			else if (finding.value !== undefined && last.value !== undefined) {
				const rising = last.value > 0 ? finding.value >= risingFactor * last.value : finding.value > 0;
				if (rising) reason = "rising";
			}
			if (reason === undefined) continue;
			stored.raised.set(finding.key, { at: now, ...(finding.value === undefined ? {} : { value: finding.value }) });
			raised.push({ ...finding, scheduleId: stored.schedule.id, occurrenceId, reason });
		}
		return raised;
	}

	return {
		async create(ctx, input) {
			forbidAgent(ctx, "create schedules");
			assertValidInput(ctx, input);
			const now = clock.now();
			const draft: Schedule = {
				...(inputFields(input) as ScheduleInput),
				id: `schedule_${crypto.randomUUID()}`,
				status: "active",
				occurrences: 0,
				createdBy: ctx.actor,
				createdAt: now,
				updatedAt: now,
			};
			const schedule = rescheduled(draft, now);
			if (schedule.status === "ended") throw new HarbourError("invalid", "The schedule would never be due");
			schedules.set(schedule.id, {
				organisationId: ctx.organisationId,
				schedule,
				failuresInRow: 0,
				raised: new Map(),
				changes: 0,
			});
			await emit([
				{
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
				},
			]);
			return schedule;
		},

		async update(ctx, scheduleId, input) {
			forbidAgent(ctx, "update schedules");
			const stored = storedFor(ctx.organisationId, scheduleId);
			const current = stored.schedule;
			if (current.status === "ended") throw new HarbourError("conflict", `Schedule ${scheduleId} has ended`);
			const merged: Schedule = { ...current, ...inputFields(input), owner: current.owner, kind: current.kind };
			assertValidInput(ctx, merged);
			const now = clock.now();
			stored.schedule =
				merged.status === "paused" ? { ...withoutNextDue(merged), updatedAt: now } : rescheduled(merged, now);
			const updated = stored.schedule;
			await emitChange(ctx, stored, "updated");
			return updated;
		},

		async pause(ctx, scheduleId) {
			forbidAgent(ctx, "pause schedules");
			const stored = storedFor(ctx.organisationId, scheduleId);
			const current = stored.schedule;
			if (current.status === "ended") throw new HarbourError("conflict", `Schedule ${scheduleId} has ended`);
			if (current.status === "paused") return current;
			stored.schedule = { ...withoutNextDue(current), status: "paused", updatedAt: clock.now() };
			const paused = stored.schedule;
			await emitChange(ctx, stored, "paused");
			return paused;
		},

		async resume(ctx, scheduleId) {
			forbidAgent(ctx, "resume schedules");
			const stored = storedFor(ctx.organisationId, scheduleId);
			const current = stored.schedule;
			if (current.status === "ended") throw new HarbourError("conflict", `Schedule ${scheduleId} has ended`);
			if (current.status === "active") return current;
			stored.schedule = rescheduled(current, clock.now());
			const resumed = stored.schedule;
			await emitChange(ctx, stored, "resumed");
			return resumed;
		},

		async end(ctx, scheduleId) {
			forbidAgent(ctx, "end schedules");
			const stored = storedFor(ctx.organisationId, scheduleId);
			const current = stored.schedule;
			if (current.status === "ended") return current;
			stored.schedule = { ...withoutNextDue(current), status: "ended", updatedAt: clock.now() };
			const ended = stored.schedule;
			await emitChange(ctx, stored, "ended");
			return ended;
		},

		async get(ctx, scheduleId) {
			return storedFor(ctx.organisationId, scheduleId).schedule;
		},

		async list(ctx, filter, page) {
			const own = [...schedules.values()]
				.filter((stored) => stored.organisationId === ctx.organisationId)
				.map((stored) => stored.schedule)
				.filter(
					(schedule) =>
						(filter?.kind === undefined || schedule.kind === filter.kind) &&
						(filter?.status === undefined || schedule.status === filter.status),
				);
			return paginate(own, page);
		},

		async preview(ctx, scheduleId, n) {
			const schedule = storedFor(ctx.organisationId, scheduleId).schedule;
			if (!Number.isInteger(n) || n < 0) throw new HarbourError("invalid", "n must be a non-negative integer");
			if (schedule.status === "ended") return [];
			const from = schedule.status === "active" && schedule.nextDueAt !== undefined ? schedule.nextDueAt : clock.now();
			return previewDue(schedule, from, n);
		},

		async tick() {
			const now = clock.now();
			const created: Occurrence[] = [];
			for (const stored of schedules.values()) {
				const schedule = stored.schedule;
				if (schedule.status !== "active" || schedule.nextDueAt === undefined || schedule.nextDueAt > now) continue;
				if (hasOpenOccurrence(schedule.id)) continue;
				let latest = schedule.nextDueAt;
				let coalesced = 1;
				let next = nextDue(schedule, latest);
				while (next !== undefined && next <= now && coalesced < MAX_COALESCED) {
					latest = next;
					coalesced += 1;
					next = nextDue(schedule, latest);
				}
				const id = `${schedule.id}@${latest}`;
				const counted = { ...schedule, occurrences: schedule.occurrences + 1 };
				if (!occurrences.has(id)) {
					const occurrence: Occurrence = {
						id,
						scheduleId: schedule.id,
						dueAt: latest,
						coalesced,
						status: "due",
						attempt: 0,
					};
					occurrences.set(id, occurrence);
					created.push(occurrence);
				}
				const following = nextDue(counted, now);
				stored.schedule =
					following === undefined
						? { ...withoutNextDue(counted), status: "ended", updatedAt: now }
						: { ...counted, nextDueAt: following, updatedAt: now };
			}
			return created;
		},

		async claim(runner, leaseMs) {
			if (runner.length === 0) throw new HarbourError("invalid", "A claim needs a runner");
			if (!(leaseMs > 0)) throw new HarbourError("invalid", "leaseMs must be positive");
			const now = clock.now();
			let oldest: Occurrence | undefined;
			for (const occurrence of occurrences.values()) {
				const claimable =
					occurrence.status === "due" ||
					(occurrence.status === "running" && occurrence.leaseUntil !== undefined && now >= occurrence.leaseUntil);
				if (claimable && (oldest === undefined || occurrence.dueAt < oldest.dueAt)) oldest = occurrence;
			}
			if (oldest === undefined) return undefined;
			const claimed: Occurrence = {
				...oldest,
				status: "running",
				claimedBy: runner,
				leaseUntil: now + leaseMs,
				attempt: oldest.attempt + 1,
			};
			occurrences.set(claimed.id, claimed);
			return claimed;
		},

		async complete(occurrenceId, runner, outcome) {
			const occurrence = heldClaim(occurrenceId, runner);
			return finish(occurrence, outcome.status, outcome.result);
		},

		async reportCheck(occurrenceId, runner, report: CheckReport) {
			const occurrence = heldClaim(occurrenceId, runner);
			const stored = schedules.get(occurrence.scheduleId)!;
			if (stored.schedule.kind !== "check") {
				throw new HarbourError("invalid", `Schedule ${stored.schedule.id} is not a check`);
			}
			if (!Number.isInteger(report.exitCode)) throw new HarbourError("invalid", "exitCode must be an integer");
			let raised: RaisedFinding[] = [];
			if (report.exitCode === 0 || report.exitCode === 3) {
				stored.failuresInRow = 0;
				if (report.exitCode === 3) raised = findingsToRaise(stored, occurrenceId, report.findings ?? []);
				finish(occurrence, "succeeded", { exitCode: report.exitCode, raised: raised.length });
			} else {
				stored.failuresInRow += 1;
				const threshold = stored.schedule.check?.failuresBeforeRaise ?? DEFAULT_FAILURES_BEFORE_RAISE;
				if (stored.failuresInRow === threshold) {
					raised = [
						{
							key: `check-failed:${stored.schedule.id}`,
							severity: "error",
							summary: `${stored.schedule.title} failed ${threshold} runs in a row (last exit code ${report.exitCode})`,
							scheduleId: stored.schedule.id,
							occurrenceId,
							reason: "failures",
						},
					];
				}
				finish(occurrence, "failed", { exitCode: report.exitCode, raised: raised.length });
			}
			await emit(raised.map((finding) => raiseEvent(stored, finding)));
			return raised;
		},

		async listOccurrences(ctx, scheduleId, page) {
			storedFor(ctx.organisationId, scheduleId);
			const own = [...occurrences.values()]
				.filter((occurrence) => occurrence.scheduleId === scheduleId)
				.sort((left, right) => left.dueAt - right.dueAt);
			return paginate(own, page);
		},
	};
}
