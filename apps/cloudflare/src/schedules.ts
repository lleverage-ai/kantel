/**
 * The scheduler on Cloudflare (#23): the stack object's alarm wakes `@kantel/schedules`' runner, which ticks the
 * schedules store (materialising due occurrences, coalescing missed ones, never overlapping), claims each due occurrence
 * under a lease, hands it to the handler for its kind and finishes it. This file only hosts it: which handlers run here,
 * and when the alarm should next wake.
 *
 * - **task**: `createTaskHandler` starts a session through the public session API, in the schedule's project (the
 *   deployment's default project for one owned by the organisation or a user, unless the payload names one), labelled
 *   with the schedule and occurrence. The prompt goes to the agent exactly as written. The occurrence finishes once the
 *   session has its prompt (`waitForRun: false`), with `{ sessionId, submissionId }` as its result: the session runs in
 *   this same object, so the alarm must not wait on it, and the console lists it like any other. The session is
 *   unattended (`SessionRecord.unattended`); in a one-person deployment (`actForCreator`) a task a person scheduled acts
 *   for them, private to them, so their own connections may be used (#335).
 * - **check**: `createCheckHandler` over the isolate tier (`src/schedule-checks.ts`), with no model.
 * - every other kind has no handler here yet, so its runs fail saying so.
 *
 * Portable (no `cloudflare:workers`), so the tests run it in Node over the in-memory or SQL store.
 */
import {
	type AgentId,
	type CallContext,
	type Clock,
	type JsonValue,
	type OrganisationId,
	type ProjectId,
	type Schedule,
	type Schedules,
	type SessionDirectory,
	type SessionRuntime,
	type SystemContext,
	systemContext,
	type Timestamp,
} from "@kantel/contracts";
import { type CheckExecutor, createCheckHandler, createTaskHandler } from "@kantel/schedules/handlers";
import {
	createScheduleRunner,
	type OccurrenceHandler,
	type RunRecord,
	type ScheduleRunner,
} from "@kantel/schedules/runner";

/** The system component the scheduler's worker calls are made as. */
export const SCHEDULER_COMPONENT = "schedules.cloudflare";
/** A claim's lease. A task run only starts a session, so it is well inside this; a check's command has its own limit. */
export const RUN_LEASE_MS = 2 * 60_000;
/** The longest the alarm sleeps while any schedule is active, so a missed arm costs at most this much lateness. */
export const MAX_SLEEP_MS = 15 * 60_000;
/** How soon the alarm looks again at a schedule held up by an occurrence still due or running (a lapsed lease). */
export const MIN_SLEEP_MS = 30_000;

export interface CloudflareSchedulerOptions {
	readonly schedules: Schedules;
	/** The public session API a task's session is started and found again through. */
	readonly runtime: Pick<SessionRuntime, "create" | "prompt" | "wait" | "close">;
	readonly directory: Pick<SessionDirectory, "list">;
	readonly clock: Clock;
	/** The deployment's one organisation: its schedules say when the alarm should next wake. */
	readonly organisationId: OrganisationId;
	/** Where a task owned by the organisation or a user runs, unless its payload names a project. */
	readonly defaultProjectId: ProjectId;
	/** The agent a task runs when its payload names none. */
	readonly defaultAgentId: AgentId;
	/** Runs a check's command. Without one, check runs fail. */
	readonly checks?: CheckExecutor;
	/**
	 * A deployment with one person (`KANTEL_CONNECTIONS_PERSONAL=on`): a task a person scheduled runs acting for them, in
	 * a session private to them, so their own connections may be used (`scheduledActingUser`). Default: for no one.
	 */
	readonly actForCreator?: boolean;
	readonly onError?: (error: unknown) => void;
}

export interface CloudflareScheduler {
	/** Runs everything due, then says when to wake next (`undefined`: no schedule is active). */
	wake(): Promise<{ readonly runs: readonly RunRecord[]; readonly nextWakeAt?: Timestamp }>;
	/** When the next wake should be, without running anything. */
	nextWakeAt(): Promise<Timestamp | undefined>;
	readonly runner: ScheduleRunner;
}

/**
 * A task schedule owned by the organisation or a user runs in this deployment's default project unless its payload
 * names one. Nothing else in the payload changes: the prompt goes to the agent exactly as written.
 */
export function withDefaultProject(schedule: Schedule, projectId: ProjectId): Schedule {
	if (schedule.owner.kind === "project") return schedule;
	const payload = schedule.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return schedule;
	const fields = payload as { readonly [key: string]: JsonValue };
	if (fields.projectId !== undefined) return schedule;
	return { ...schedule, payload: { ...fields, projectId } };
}

export function createCloudflareScheduler(options: CloudflareSchedulerOptions): CloudflareScheduler {
	const { schedules, clock } = options;
	const context: SystemContext = systemContext(SCHEDULER_COMPONENT);
	const inOrganisation: CallContext = { actor: context.actor, organisationId: options.organisationId };

	const tasks = createTaskHandler({
		runtime: options.runtime,
		directory: options.directory,
		defaultAgentId: options.defaultAgentId,
		waitForRun: false,
		...(options.actForCreator === true ? { actForCreator: true } : {}),
	});
	const task: OccurrenceHandler = (run) =>
		tasks({ ...run, schedule: withDefaultProject(run.schedule, options.defaultProjectId) });
	const handlers = {
		task,
		...(options.checks === undefined ? {} : { check: createCheckHandler({ execute: options.checks }) }),
	};
	const runner = createScheduleRunner({
		schedules,
		runnerId: "cloudflare:stack",
		handlers,
		clock,
		context,
		leaseMs: RUN_LEASE_MS,
		...(options.onError === undefined ? {} : { onError: (error: unknown) => options.onError?.(error) }),
	});

	const nextWakeAt = async (): Promise<Timestamp | undefined> => {
		const now = clock.now();
		let wanted = now + MAX_SLEEP_MS;
		let active = false;
		let cursor: string | undefined;
		do {
			const page = await schedules.list(
				inOrganisation,
				{ status: "active" },
				cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
			);
			for (const schedule of page.items) {
				active = true;
				const due = schedule.nextDueAt;
				if (due === undefined) continue;
				// A due time already past is a schedule whose occurrence is still due or running (held by a runner, or by one
				// that died, until its lease passes): look again shortly rather than straight away.
				wanted = Math.min(wanted, due > now ? due : now + MIN_SLEEP_MS);
			}
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return active ? wanted : undefined;
	};

	return {
		runner,
		nextWakeAt,
		async wake() {
			const runs = await runner.runOnce();
			const next = await nextWakeAt();
			return next === undefined ? { runs } : { runs, nextWakeAt: next };
		},
	};
}
