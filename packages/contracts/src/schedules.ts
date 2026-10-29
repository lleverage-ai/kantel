/**
 * Schedules and triggers, after Sal's scheduler: reminders, tasks, summaries, checks and the heartbeat, plus `program`
 * for a saved code-mode program.
 *
 * Calendar recurrence respects time zones and DST; interval recurrence is absolute. Occurrences are unique per
 * schedule and due time, never overlap, and missed runs are coalesced into one. Execution is retried rather than
 * exactly-once: an occurrence is claimed under a lease, and handlers write idempotent markers keyed by occurrence ID.
 * Checks are scripts with no model: exit 0 is healthy, exit 3 is findings with stable keys, anything else is a failed
 * run; findings are raised again after `reraiseHours`, when a value grows by `risingFactor`, or after repeated failures.
 */
import type { Actor, CallContext, JsonValue, OwnerRef, Page, PageRequest, SystemContext, Timestamp } from "./common.ts";

export type ScheduleKind = "reminder" | "task" | "summary" | "check" | "heartbeat" | "program";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type Recurrence =
	/** Absolute intervals counted from `from`, unaffected by DST. */
	| { readonly every: "minutes" | "hours"; readonly interval: number; readonly from: Timestamp }
	/** Calendar recurrence at a local wall-clock time (`HH:MM`) in the schedule's time zone. */
	| { readonly every: "day"; readonly at: string; readonly interval?: number }
	| { readonly every: "weekday"; readonly at: string }
	| { readonly every: "week"; readonly at: string; readonly on: readonly Weekday[] }
	/** `day` 31 means the last day of the month. */
	| { readonly every: "month"; readonly at: string; readonly day: number };

export interface CheckSettings {
	/** Hours before a finding still present is raised again. Default 6. */
	readonly reraiseHours?: number;
	/** A finding whose value grows by this factor is raised again. Default 2. */
	readonly risingFactor?: number;
	/** Failed runs in a row before a `check-failed` finding is raised. Default 3. */
	readonly failuresBeforeRaise?: number;
	/**
	 * Severities, worst first, case-insensitive, for raising a finding that got worse as `escalated`. Default `urgent`,
	 * `high`, `medium`, `low`, `warn`, `info`; `sev1`, `sev2` and `sev3` read as `urgent`, `high` and `low`. A severity
	 * the list doesn't name ranks below all of them.
	 */
	readonly severityOrder?: readonly string[];
}

export interface ScheduleInput {
	readonly owner: OwnerRef;
	readonly kind: ScheduleKind;
	readonly title: string;
	/** IANA time zone for calendar recurrence and one-offs, such as `Europe/London`. */
	readonly timezone: string;
	/** A one-off at this instant. Exactly one of `at` and `repeat` is set. */
	readonly at?: Timestamp;
	readonly repeat?: Recurrence;
	/** No occurrence is due after this. */
	readonly until?: Timestamp;
	/** At most this many occurrences. */
	readonly count?: number;
	/** What runs: a reminder's message, a task's brief, a check's command, a program's ID. Opaque to the scheduler. */
	readonly payload: JsonValue;
	readonly check?: CheckSettings;
}

/**
 * What `update` changes: `ScheduleInput`'s fields but the owner and the kind, which are fixed at create. A field left out
 * stays as it is; `null` on `at`, `repeat`, `until` or `count` clears it, so a one-off can become a recurrence (and
 * back) and an end date or run limit can be dropped, over JSON as well as in process.
 */
export interface ScheduleUpdate
	extends Partial<Omit<ScheduleInput, "owner" | "kind" | "at" | "repeat" | "until" | "count">> {
	readonly at?: Timestamp | null;
	readonly repeat?: Recurrence | null;
	readonly until?: Timestamp | null;
	readonly count?: number | null;
}

export interface Schedule extends ScheduleInput {
	readonly id: string;
	readonly status: "active" | "paused" | "ended";
	/** The next due time, absent when ended or paused. */
	readonly nextDueAt?: Timestamp;
	/** Occurrences materialised so far, coalesced ones counted once. */
	readonly occurrences: number;
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

export type OccurrenceStatus = "due" | "running" | "succeeded" | "failed";

export interface Occurrence {
	/** `<scheduleId>@<dueAt>`: unique per schedule and due time, and the key for a handler's idempotent markers. */
	readonly id: string;
	readonly scheduleId: string;
	readonly dueAt: Timestamp;
	/** How many due times this occurrence stands for (more than 1 when missed runs were coalesced). */
	readonly coalesced: number;
	readonly status: OccurrenceStatus;
	readonly attempt: number;
	readonly claimedBy?: string;
	/** A claim past its lease may be claimed again (the runner died). */
	readonly leaseUntil?: Timestamp;
	readonly finishedAt?: Timestamp;
	readonly result?: JsonValue;
}

/**
 * Proposed (issue #23): an occurrence as `claim` hands it to a runner, with its schedule as it was when claimed, so the
 * runner knows what to run (kind, payload, check settings) and for which organisation without another call.
 */
export interface ClaimedOccurrence extends Occurrence {
	readonly schedule: Schedule;
}

export interface Finding {
	/** Stable across runs, such as `disk:/var` or `pr:4811:stale`. */
	readonly key: string;
	readonly severity: string;
	readonly summary: string;
	/** A number to compare with `risingFactor`, such as an error count. */
	readonly value?: number;
	/**
	 * The command's own view, such as `new`, `escalated` or `unchanged`: advisory, as the store decides from its record,
	 * except that `escalated` with a severity other than the one last raised raises it (one `severityOrder` can't rank).
	 */
	readonly status?: string;
}

export interface RaisedFinding extends Finding {
	readonly scheduleId: string;
	readonly occurrenceId: string;
	readonly reason: "new" | "escalated" | "reraise" | "rising" | "failures";
}

export interface CheckReport {
	readonly exitCode: number;
	readonly findings?: readonly Finding[];
}

export interface Schedules {
	/** Agents may not create schedules (`forbidden`): they propose them to their supervisor. */
	create(ctx: CallContext, input: ScheduleInput): Promise<Schedule>;
	/** Changes the fields `input` names; `null` clears `at`, `repeat`, `until` or `count` (see `ScheduleUpdate`). */
	update(ctx: CallContext, scheduleId: string, input: ScheduleUpdate): Promise<Schedule>;
	pause(ctx: CallContext, scheduleId: string): Promise<Schedule>;
	resume(ctx: CallContext, scheduleId: string): Promise<Schedule>;
	end(ctx: CallContext, scheduleId: string): Promise<Schedule>;
	get(ctx: CallContext, scheduleId: string): Promise<Schedule>;
	list(
		ctx: CallContext,
		filter?: { readonly kind?: ScheduleKind; readonly status?: Schedule["status"] },
		page?: PageRequest,
	): Promise<Page<Schedule>>;
	/** The next `n` due times from now, without materialising them. */
	preview(ctx: CallContext, scheduleId: string, n: number): Promise<readonly Timestamp[]>;
	/**
	 * Materialises due occurrences up to the clock's now. A schedule with an occurrence still `due` or `running` gets no
	 * new one: its missed due times are coalesced into the next. Several missed due times become one occurrence at
	 * the latest of them. Idempotent: ticking twice at the same time creates nothing new.
	 *
	 * `tick`, `claim`, `renew`, `complete` and `reportCheck` are the scheduler's worker calls (settled question 13): each takes a
	 * `SystemContext`, and any actor but `system` is `forbidden`, audited, and changes nothing.
	 */
	tick(ctx: SystemContext): Promise<readonly Occurrence[]>;
	/** Atomically claims the oldest claimable occurrence for `runner`, or returns undefined. */
	claim(ctx: SystemContext, runner: string, leaseMs: number): Promise<ClaimedOccurrence | undefined>;
	/**
	 * Proposed (issue #23): extends a held claim's lease to `leaseMs` from now, so a long run keeps it. The runner must
	 * hold it with a live lease (`conflict` otherwise: a lapsed lease is not revived, since another runner may have it).
	 */
	renew(ctx: SystemContext, occurrenceId: string, runner: string, leaseMs: number): Promise<Occurrence>;
	/** Finishes a claim. The runner must hold it (`conflict` otherwise, including after its lease was taken over). */
	complete(
		ctx: SystemContext,
		occurrenceId: string,
		runner: string,
		outcome: { readonly status: "succeeded" | "failed"; readonly result?: JsonValue },
	): Promise<Occurrence>;
	/** Finishes a check's claim from its exit code and returns the findings to raise now. */
	reportCheck(
		ctx: SystemContext,
		occurrenceId: string,
		runner: string,
		report: CheckReport,
	): Promise<readonly RaisedFinding[]>;
	listOccurrences(ctx: CallContext, scheduleId: string, page?: PageRequest): Promise<Page<Occurrence>>;
}
