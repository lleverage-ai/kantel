/**
 * The scheduler loop: ticks a `Schedules` store, claims due occurrences under a lease and hands each to the handler for
 * its kind (`./handlers.ts` has the task, reminder and check handlers). Any number of runners may share one store, on
 * one host or several: the store materialises each due time once and gives each occurrence to one runner at a time.
 *
 * - A run holds its lease while its handler works: the runner renews it every third of `leaseMs`. If a renewal is
 *   refused (the lease lapsed and another runner took the occurrence), the handler's signal aborts and its result is
 *   dropped, so two runners never both finish one run.
 * - Execution is retried rather than exactly-once: a runner that dies mid-run leaves its lease to lapse, and the next
 *   runner to claim the occurrence runs it again, as attempt 2. Handlers make that safe by keying what they do by the
 *   occurrence's ID (a task's session label and prompt `requestId`, a reminder's delivery key).
 * - A handler past its kind's time limit is told to stop (its signal aborts with `aborted`); the attempt fails, and the
 *   runner waits for the handler to return before it finishes the occurrence, so its next run never overlaps it.
 * - `stop` aborts the runs in flight and leaves their occurrences running: their leases lapse and another runner (or
 *   this one, restarted) runs them again as the same occurrences. A restart neither drops nor duplicates one.
 * - A check's outcome goes through `reportCheck`; what it raises goes to `onRaised` for the host to act on.
 *
 * It reads no time itself (the store's clock decides what is due and when a lease lapses) and waits only through the
 * injected timers, so a test drives it with a manual clock, manual timers and `runOnce`. A target calls `runOnce` from its own alarm (a Durable Object alarm, a timer), or `start`.
 */
import {
	type CheckReport,
	type ClaimedOccurrence,
	type Clock,
	KantelError,
	type JsonValue,
	type Occurrence,
	type OrganisationId,
	type RaisedFinding,
	type Schedule,
	type ScheduleKind,
	type Schedules,
	type SystemContext,
	systemClock,
	systemContext,
} from "@kantel/contracts";

/** One run of an occurrence, as a handler gets it. */
export interface OccurrenceRun {
	readonly occurrence: ClaimedOccurrence;
	readonly schedule: Schedule;
	/** The organisation the schedule belongs to. */
	readonly organisationId: OrganisationId;
	/** Aborts when the run's lease is lost (`conflict`), its time limit passes (`aborted`) or the runner stops. */
	readonly signal: AbortSignal;
	/**
	 * Renews the lease now and resolves while this run still holds it; rejects (`conflict`, and aborts `signal`) once
	 * another runner may have the occurrence. Call it just before a side effect a retry could repeat: no other runner can
	 * claim the occurrence for a lease after it resolves, and one that already has it makes it reject.
	 */
	holdLease(): Promise<void>;
}

/** How a run ended: a finished occurrence, or for a check its report, which the store settles. */
export type RunOutcome =
	| { readonly status: "succeeded" | "failed"; readonly result?: JsonValue }
	| { readonly check: CheckReport };

export type OccurrenceHandler = (run: OccurrenceRun) => Promise<RunOutcome>;

/** The timers the runner waits with; `globalThis`'s by default. */
export interface RunnerTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** What one run came to, for logs and tests. */
export interface RunRecord {
	readonly occurrenceId: string;
	readonly scheduleId: string;
	readonly kind: ScheduleKind;
	readonly attempt: number;
	/** How long the handler took, by the runner's clock. */
	readonly durationMs: number;
	/**
	 * `lost` when the lease was lost and the result dropped; `interrupted` when the runner stopped mid-run, leaving the
	 * lease to lapse so another runner runs it again; `error` when the store refused the result.
	 */
	readonly status: "succeeded" | "failed" | "lost" | "interrupted" | "error";
	readonly raised?: readonly RaisedFinding[];
	readonly error?: string;
}

export interface ScheduleRunnerOptions {
	readonly schedules: Schedules;
	/** This runner's name, unique among the runners sharing the store, such as the host and process. */
	readonly runnerId: string;
	/** A handler per kind. An occurrence of a kind with none fails, saying so. */
	readonly handlers: { readonly [Kind in ScheduleKind]?: OccurrenceHandler };
	/** Times each run for its record; pass the store's clock. */
	readonly clock?: Clock;
	/** What it waits with: lease renewals, time limits and `start`'s interval. */
	readonly timers?: RunnerTimers;
	/** The worker calls' caller. Default `system:schedules.runner`. */
	readonly context?: SystemContext;
	/** Each claim's lease, renewed every third of it while a handler works. Default 60 s. */
	readonly leaseMs?: number;
	/** Runs at once in this runner. Default 4. */
	readonly concurrency?: number;
	/** A handler's time limit, per kind. Default 10 minutes; a task, 2 hours. */
	readonly timeoutMs?: { readonly [Kind in ScheduleKind]?: number };
	/**
	 * Told what a check run raised, once the store has recorded it, for the host to act on: a task, a message. A throw
	 * is reported to `onError`; the findings stay raised (the store will not raise them again before `reraiseHours`).
	 */
	readonly onRaised?: (raised: readonly RaisedFinding[], run: OccurrenceRun) => Promise<void>;
	/** Told of errors the loop carries on past: a failed tick, a refused result, a throwing `onRaised`. */
	readonly onError?: (error: unknown, occurrence?: Occurrence) => void;
}

export interface ScheduleRunner {
	/**
	 * One pass: ticks, then claims and runs occurrences, `concurrency` at a time, until none is claimable. Resolves
	 * once every run it started has finished.
	 */
	runOnce(): Promise<readonly RunRecord[]>;
	/** Runs a pass now and then every `intervalMs` (default 15 s) after the last one ends, until `stop`. */
	start(intervalMs?: number): void;
	/** Stops the loop, aborts the runs in flight and waits for them to return. */
	stop(): Promise<void>;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUTS: { readonly [Kind in ScheduleKind]?: number } = { task: 2 * 60 * 60_000 };
const DEFAULT_INTERVAL_MS = 15_000;

const realTimers: RunnerTimers = {
	setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whether `outcome` is a check's report. */
function isCheckOutcome(outcome: RunOutcome): outcome is { readonly check: CheckReport } {
	return "check" in outcome;
}

/** The organisation a schedule belongs to; every schedule a store accepts is owned within one. */
export function organisationOf(schedule: Schedule): OrganisationId {
	const owner = schedule.owner;
	if (owner.kind === "platform") throw new KantelError("invalid", `Schedule ${schedule.id} has no organisation`);
	return owner.organisationId;
}

export function createScheduleRunner(options: ScheduleRunnerOptions): ScheduleRunner {
	const { schedules, runnerId, handlers } = options;
	const clock = options.clock ?? systemClock;
	const timers = options.timers ?? realTimers;
	const ctx = options.context ?? systemContext("schedules.runner");
	const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	const concurrency = Math.max(1, options.concurrency ?? 4);
	if (runnerId.length === 0) throw new KantelError("invalid", "A runner needs a runnerId");
	if (!(leaseMs > 0)) throw new KantelError("invalid", "leaseMs must be positive");
	const report = (error: unknown, occurrence?: Occurrence) => options.onError?.(error, occurrence);

	/** Aborted by `stop`; every run's signal follows it. */
	let stopping = new AbortController();
	let loop: unknown;
	let pass: Promise<unknown> = Promise.resolve();

	function timeoutFor(kind: ScheduleKind): number {
		return options.timeoutMs?.[kind] ?? DEFAULT_TIMEOUTS[kind] ?? DEFAULT_TIMEOUT_MS;
	}

	/** Runs one claimed occurrence to the end: renews its lease, enforces its time limit and records the outcome. */
	async function run(occurrence: ClaimedOccurrence): Promise<RunRecord> {
		const schedule = occurrence.schedule;
		const started = {
			occurrenceId: occurrence.id,
			scheduleId: schedule.id,
			kind: schedule.kind,
			attempt: occurrence.attempt,
		};
		const startedAt = clock.now();
		const controller = new AbortController();
		// Any run in flight when the runner stops is left to lapse, even one already winding down from its time limit.
		let interrupted = false;
		const onStop = () => {
			interrupted = true;
			if (!controller.signal.aborted) controller.abort(stopping.signal.reason);
		};
		stopping.signal.addEventListener("abort", onStop, { once: true });
		let lost = false;
		/** Marks the lease lost and tells the handler; the run's result is then dropped. */
		const loseLease = (error: unknown) => {
			if (lost) return;
			lost = true;
			report(error, occurrence);
			if (!controller.signal.aborted) controller.abort(new KantelError("conflict", "The run's lease was lost"));
		};
		/** Set once the handler returned; a renewal still in flight then neither re-arms nor counts as lost. */
		let done = false;
		let renewal: unknown;
		// Renews until the handler returns, after a timeout or stop too, so a run winding down keeps its occurrence.
		const renew = () => {
			renewal = timers.setTimeout(() => {
				if (done) return;
				schedules.renew(ctx, occurrence.id, runnerId, leaseMs).then(
					() => {
						if (!done) renew();
					},
					(error: unknown) => {
						if (!done) loseLease(error);
					},
				);
			}, leaseMs / 3);
		};
		renew();
		const holdLease = async () => {
			if (lost) throw new KantelError("conflict", "The run's lease was lost");
			try {
				await schedules.renew(ctx, occurrence.id, runnerId, leaseMs);
			} catch (error) {
				loseLease(error);
				throw error;
			}
		};
		const deadline = timers.setTimeout(
			() => controller.abort(new KantelError("aborted", `The ${schedule.kind} run passed its time limit`)),
			timeoutFor(schedule.kind),
		);
		let outcome: RunOutcome;
		try {
			const handler = handlers[schedule.kind];
			if (handler === undefined) {
				outcome = { status: "failed", result: { error: `This runner has no handler for ${schedule.kind}` } };
			} else {
				const runInput: OccurrenceRun = {
					occurrence,
					schedule,
					organisationId: organisationOf(schedule),
					signal: controller.signal,
					holdLease,
				};
				outcome = await handler(runInput);
				if (controller.signal.aborted && !lost) {
					outcome = timedOut(schedule.kind, controller.signal.reason);
				}
			}
		} catch (error) {
			outcome =
				schedule.kind === "check"
					? { check: { exitCode: -1 } }
					: {
							status: "failed",
							result: { error: controller.signal.aborted ? message(controller.signal.reason) : message(error) },
						};
		} finally {
			done = true;
			timers.clearTimeout(renewal);
			timers.clearTimeout(deadline);
			stopping.signal.removeEventListener("abort", onStop);
		}
		const base = { ...started, durationMs: clock.now() - startedAt };
		if (lost) return { ...base, status: "lost" };
		// Stopped, not failed: the occurrence stays running until its lease lapses, then runs again as the same occurrence.
		if (interrupted) return { ...base, status: "interrupted" };
		try {
			if (isCheckOutcome(outcome)) {
				const raised = await schedules.reportCheck(ctx, occurrence.id, runnerId, outcome.check);
				const succeeded = outcome.check.exitCode === 0 || outcome.check.exitCode === 3;
				if (raised.length > 0 && options.onRaised !== undefined) {
					try {
						await options.onRaised(raised, {
							occurrence,
							schedule,
							organisationId: organisationOf(schedule),
							signal: controller.signal,
							// The occurrence is finished: there is no lease left to hold.
							holdLease: async () => {
								throw new KantelError("conflict", "The run has finished");
							},
						});
					} catch (error) {
						report(error, occurrence);
					}
				}
				return { ...base, status: succeeded ? "succeeded" : "failed", raised };
			}
			await schedules.complete(ctx, occurrence.id, runnerId, outcome);
			return { ...base, status: outcome.status };
		} catch (error) {
			report(error, occurrence);
			return { ...base, status: "error", error: message(error) };
		}
	}

	function timedOut(kind: ScheduleKind, reason: unknown): RunOutcome {
		return kind === "check" ? { check: { exitCode: -1 } } : { status: "failed", result: { error: message(reason) } };
	}

	async function runOnce(): Promise<readonly RunRecord[]> {
		try {
			await schedules.tick(ctx);
		} catch (error) {
			// Claims can still run what earlier ticks materialised.
			report(error);
		}
		const records: RunRecord[] = [];
		const inFlight = new Set<Promise<void>>();
		let drained = false;
		while (!stopping.signal.aborted) {
			while (!drained && inFlight.size < concurrency && !stopping.signal.aborted) {
				let claimed: ClaimedOccurrence | undefined;
				try {
					claimed = await schedules.claim(ctx, runnerId, leaseMs);
				} catch (error) {
					report(error);
					drained = true;
					break;
				}
				if (claimed === undefined) {
					drained = true;
					break;
				}
				if (stopping.signal.aborted) {
					// Stopped while the claim was in flight: start nothing, and leave the claim to lapse.
					records.push({
						occurrenceId: claimed.id,
						scheduleId: claimed.scheduleId,
						kind: claimed.schedule.kind,
						attempt: claimed.attempt,
						durationMs: 0,
						status: "interrupted",
					});
					break;
				}
				const running = run(claimed).then((record) => {
					records.push(record);
					inFlight.delete(running);
				});
				inFlight.add(running);
			}
			if (inFlight.size === 0) break;
			await Promise.race(inFlight);
			// A run finishing may have freed its schedule's next occurrence for a later tick, not this pass.
		}
		await Promise.all(inFlight);
		return records;
	}

	return {
		runOnce() {
			const next = pass.then(runOnce, runOnce);
			pass = next.catch(() => undefined);
			return next;
		},

		start(intervalMs = DEFAULT_INTERVAL_MS) {
			if (loop !== undefined) return;
			if (stopping.signal.aborted) stopping = new AbortController();
			const cycle = () => {
				const next = pass.then(runOnce, runOnce);
				pass = next.catch(report);
				void pass.then(() => {
					if (loop !== undefined) loop = timers.setTimeout(cycle, intervalMs);
				});
			};
			loop = true;
			cycle();
		},

		async stop() {
			if (loop !== undefined) timers.clearTimeout(loop);
			loop = undefined;
			stopping.abort(new KantelError("conflict", "The runner stopped"));
			await pass;
		},
	};
}
