import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type CheckReport,
	type Clock,
	KantelError,
	type Occurrence,
	type OrganisationId,
	type ProjectAccess,
	type Role,
	requireSystem,
	type Schedule,
	type Schedules,
	type SystemContext,
	systemClock,
} from "@kantel/contracts";
import {
	AUDIT_CONTEXT,
	assertClaimInput,
	assertValidInput,
	changeEvent,
	claimed,
	createdEvent,
	endedSchedule,
	forbidAgent,
	heldBy,
	isClaimable,
	isDue,
	matchesFilter,
	materialise,
	newSchedule,
	paginate,
	pausedSchedule,
	previewOf,
	type RaisedRecord,
	raiseEvent,
	requireOwner,
	resumedSchedule,
	settleCheck,
	updatedSchedule,
	visibleTo,
} from "./rules.ts";

export interface MemorySchedulesOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/**
	 * Checks project access on every call about a project-owned schedule (`schedules.<method>`). Without it the store
	 * checks only the organisation; every target and every conformance run passes one.
	 */
	readonly access?: ProjectAccess;
}

interface StoredSchedule {
	readonly organisationId: OrganisationId;
	schedule: Schedule;
	/** Failed check runs in a row; a success resets it. */
	failuresInRow: number;
	/** When each finding key was last raised, and its value then. */
	readonly raised: Map<string, RaisedRecord>;
	/** Changes made to the schedule, numbering its lifecycle audit events. */
	changes: number;
}

/**
 * The reference `Schedules`: schedules and occurrences in maps. `tick` and `claim` do all their work synchronously, so
 * concurrent calls never materialise or claim one occurrence twice.
 */
export function createMemorySchedules(options: MemorySchedulesOptions = {}): Schedules {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const access = options.access;

	const schedules = new Map<string, StoredSchedule>();
	/** Every occurrence, in the order it was materialised. */
	const occurrences = new Map<string, Occurrence>();

	async function emit(events: readonly AuditEventInput[]): Promise<void> {
		if (audit === undefined || events.length === 0) return;
		await audit.append(AUDIT_CONTEXT, events);
	}

	/** The scheduler's worker calls take a system caller and nothing else. */
	async function requireWorker(ctx: SystemContext, operation: string): Promise<void> {
		await requireSystem(ctx, operation, { ...(audit === undefined ? {} : { audit }), clock });
	}

	/** Stores a lifecycle change and audits it (`updated`, `paused`, `resumed`, `ended`) by its actor. */
	async function change(
		ctx: CallContext,
		stored: StoredSchedule,
		next: Schedule | undefined,
		kind: string,
	): Promise<Schedule> {
		if (next === undefined) return stored.schedule;
		stored.schedule = next;
		stored.changes += 1;
		await emit([changeEvent(ctx, stored.organisationId, next, kind, stored.changes, clock.now())]);
		return next;
	}

	/** The schedule in the caller's organisation (`not_found` otherwise), once the caller holds `needed` on it. */
	async function accessibleFor(
		ctx: CallContext,
		scheduleId: string,
		needed: Role,
		operation: string,
	): Promise<StoredSchedule> {
		const stored = schedules.get(scheduleId);
		if (stored === undefined || stored.organisationId !== ctx.organisationId) {
			throw new KantelError("not_found", `No schedule ${scheduleId}`);
		}
		await requireOwner(access, ctx, stored.schedule.owner, needed, operation, scheduleId);
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

	return {
		async create(ctx, input) {
			forbidAgent(ctx, "create schedules");
			assertValidInput(ctx, input);
			await requireOwner(access, ctx, input.owner, "operator", "schedules.create");
			const now = clock.now();
			const schedule = newSchedule(ctx, input, `schedule_${crypto.randomUUID()}`, now);
			schedules.set(schedule.id, {
				organisationId: ctx.organisationId,
				schedule,
				failuresInRow: 0,
				raised: new Map(),
				changes: 0,
			});
			await emit([createdEvent(ctx, schedule, now)]);
			return schedule;
		},

		async update(ctx, scheduleId, input) {
			forbidAgent(ctx, "update schedules");
			const stored = await accessibleFor(ctx, scheduleId, "operator", "schedules.update");
			return change(ctx, stored, updatedSchedule(ctx, stored.schedule, input, clock.now()), "updated");
		},

		async pause(ctx, scheduleId) {
			forbidAgent(ctx, "pause schedules");
			const stored = await accessibleFor(ctx, scheduleId, "operator", "schedules.pause");
			return change(ctx, stored, pausedSchedule(stored.schedule, clock.now()), "paused");
		},

		async resume(ctx, scheduleId) {
			forbidAgent(ctx, "resume schedules");
			const stored = await accessibleFor(ctx, scheduleId, "operator", "schedules.resume");
			return change(ctx, stored, resumedSchedule(stored.schedule, clock.now()), "resumed");
		},

		async end(ctx, scheduleId) {
			forbidAgent(ctx, "end schedules");
			const stored = await accessibleFor(ctx, scheduleId, "operator", "schedules.end");
			return change(ctx, stored, endedSchedule(stored.schedule, clock.now()), "ended");
		},

		async get(ctx, scheduleId) {
			return (await accessibleFor(ctx, scheduleId, "viewer", "schedules.get")).schedule;
		},

		async list(ctx, filter, page) {
			const own = [...schedules.values()]
				.filter((stored) => stored.organisationId === ctx.organisationId)
				.map((stored) => stored.schedule)
				.filter((schedule) => matchesFilter(schedule, filter));
			return paginate(await visibleTo(access, ctx, own), page);
		},

		async preview(ctx, scheduleId, n) {
			const schedule = (await accessibleFor(ctx, scheduleId, "viewer", "schedules.preview")).schedule;
			return previewOf(schedule, n, clock.now());
		},

		async tick(ctx) {
			await requireWorker(ctx, "schedules.tick");
			const now = clock.now();
			const created: Occurrence[] = [];
			for (const stored of schedules.values()) {
				if (!isDue(stored.schedule, now) || hasOpenOccurrence(stored.schedule.id)) continue;
				const { occurrence, next } = materialise(stored.schedule, now);
				if (!occurrences.has(occurrence.id)) {
					occurrences.set(occurrence.id, occurrence);
					created.push(occurrence);
				}
				stored.schedule = next;
			}
			return created;
		},

		async claim(ctx, runner, leaseMs) {
			await requireWorker(ctx, "schedules.claim");
			assertClaimInput(runner, leaseMs);
			const now = clock.now();
			let oldest: Occurrence | undefined;
			for (const occurrence of occurrences.values()) {
				if (isClaimable(occurrence, now) && (oldest === undefined || occurrence.dueAt < oldest.dueAt)) {
					oldest = occurrence;
				}
			}
			if (oldest === undefined) return undefined;
			const taken = claimed(oldest, runner, leaseMs, now);
			occurrences.set(taken.id, taken);
			return { ...taken, schedule: schedules.get(taken.scheduleId)!.schedule };
		},

		async renew(ctx, occurrenceId, runner, leaseMs) {
			await requireWorker(ctx, "schedules.renew");
			assertClaimInput(runner, leaseMs);
			const now = clock.now();
			const occurrence = heldBy(occurrences.get(occurrenceId), occurrenceId, runner, now);
			const renewed: Occurrence = { ...occurrence, leaseUntil: now + leaseMs };
			occurrences.set(renewed.id, renewed);
			return renewed;
		},

		async complete(ctx, occurrenceId, runner, outcome) {
			await requireWorker(ctx, "schedules.complete");
			const occurrence = heldBy(occurrences.get(occurrenceId), occurrenceId, runner, clock.now());
			return finish(occurrence, outcome.status, outcome.result);
		},

		async reportCheck(ctx, occurrenceId, runner, report: CheckReport) {
			await requireWorker(ctx, "schedules.reportCheck");
			const now = clock.now();
			const occurrence = heldBy(occurrences.get(occurrenceId), occurrenceId, runner, now);
			const stored = schedules.get(occurrence.scheduleId)!;
			const settled = settleCheck(
				stored.schedule,
				occurrenceId,
				stored.failuresInRow,
				(key) => stored.raised.get(key),
				report,
				now,
			);
			stored.failuresInRow = settled.failuresInRow;
			for (const [key, record] of settled.records) stored.raised.set(key, record);
			finish(occurrence, settled.status, settled.result);
			await emit(settled.raised.map((finding) => raiseEvent(stored.organisationId, stored.schedule, finding, now)));
			return settled.raised;
		},

		async listOccurrences(ctx, scheduleId, page) {
			await accessibleFor(ctx, scheduleId, "viewer", "schedules.listOccurrences");
			const own = [...occurrences.values()]
				.filter((occurrence) => occurrence.scheduleId === scheduleId)
				.sort((left, right) => left.dueAt - right.dueAt);
			return paginate(own, page);
		},
	};
}
