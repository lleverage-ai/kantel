/**
 * The handlers the scheduler loop (`./runner.ts`) hands occurrences to, after Sal's: a task starts a session, a reminder
 * is delivered by the host (held through the owner's quiet hours), and a check runs a command with no model and
 * reports its findings. Each keys what it does by the occurrence's ID, so a run retried after a crash or a lapsed lease
 * does it once.
 */
import {
	type AgentId,
	type CallContext,
	type CheckReport,
	type Finding,
	KantelError,
	type JsonValue,
	type ProjectId,
	type Schedule,
	type SessionDirectory,
	type SessionRecord,
	type SessionRuntime,
	type Timestamp,
} from "@kantel/contracts";
import { parseLocalTime, utcToZoned, zonedToUtc } from "./index.ts";
import type { OccurrenceHandler, OccurrenceRun, RunOutcome } from "./runner.ts";

/** The labels a scheduled session carries, so a retried run finds the session its first attempt started. */
export const SCHEDULE_LABEL = "harbour.schedule";
export const OCCURRENCE_LABEL = "harbour.occurrence";

/** The caller a handler acts as: the scheduler, in the schedule's organisation (and project, when one owns it). */
export function schedulerContext(run: OccurrenceRun, projectId?: ProjectId): CallContext {
	return {
		actor: { kind: "system", component: "schedules" },
		organisationId: run.organisationId,
		...(projectId === undefined ? {} : { projectId }),
		requestId: run.occurrence.id,
		signal: run.signal,
	};
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects with `invalid` naming the schedule and the field. */
function invalidPayload(schedule: Schedule, why: string): never {
	throw new KantelError("invalid", `Schedule ${schedule.id}'s payload ${why}`);
}

/** Resolves when `promise` does, or rejects with the signal's reason once it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

// Tasks

/**
 * A `task` schedule's payload, `{ agentId?, prompt }` as the public API documents it: the agent to start (the host's
 * default agent when there's none) and the prompt sent as the session's first message, exactly as written. `projectId`
 * defaults to the project that owns the schedule; a schedule owned by an organisation or a user must name one.
 */
export interface TaskPayload {
	readonly agentId?: AgentId;
	readonly prompt: string;
	readonly projectId?: ProjectId;
	readonly title?: string;
	readonly labels?: { readonly [key: string]: string };
}

/**
 * A task payload read from a schedule, or `invalid`. A payload without an `agentId` runs `defaultAgentId`, and is
 * `invalid` when there's no default either.
 */
export function taskPayload(
	schedule: Schedule,
	defaultAgentId?: AgentId,
): TaskPayload & { readonly agentId: AgentId; readonly projectId: ProjectId } {
	const payload = schedule.payload;
	if (!isRecord(payload)) invalidPayload(schedule, "must be an object with a prompt and, optionally, an agentId");
	const { agentId: named, prompt, projectId, title, labels } = payload;
	if (named !== undefined && (typeof named !== "string" || named.length === 0)) {
		invalidPayload(schedule, "has an agentId that is not a non-empty string");
	}
	const agentId = named ?? defaultAgentId;
	if (agentId === undefined) invalidPayload(schedule, "needs an agentId, as this host has no default agent");
	if (typeof prompt !== "string") invalidPayload(schedule, "needs a prompt");
	const owner = schedule.owner;
	const project = typeof projectId === "string" ? projectId : owner.kind === "project" ? owner.projectId : undefined;
	if (project === undefined) invalidPayload(schedule, "needs a projectId when no project owns the schedule");
	if (title !== undefined && typeof title !== "string") invalidPayload(schedule, "has a title that is not a string");
	if (labels !== undefined && (!isRecord(labels) || Object.values(labels).some((value) => typeof value !== "string"))) {
		invalidPayload(schedule, "has labels that are not strings");
	}
	return {
		agentId,
		prompt,
		projectId: project,
		...(title === undefined ? {} : { title }),
		...(labels === undefined ? {} : { labels: labels as { readonly [key: string]: string } }),
	};
}

export interface TaskHandlerOptions {
	/** The public session API: `create`, `prompt`, `wait`, and `close` for a session a lapsed attempt orphaned. */
	readonly runtime: Pick<SessionRuntime, "create" | "prompt" | "wait" | "close">;
	/** Finds a session an earlier attempt of the same occurrence started. */
	readonly directory: Pick<SessionDirectory, "list">;
	/** The agent a payload without an `agentId` runs. Without one, such a payload fails as `invalid`. */
	readonly defaultAgentId?: AgentId;
	/**
	 * Hold the occurrence until the session's run ends (default), so the schedule's next run never starts while this one
	 * is working, as Sal's scheduled tasks do. `false` finishes the occurrence once the session has its prompt.
	 */
	readonly waitForRun?: boolean;
}

/**
 * Starts a session for each `task` occurrence through the public session API: creates it (labelled with the schedule
 * and occurrence), prompts it with the payload's prompt exactly as written (`requestId` is the occurrence's ID; Kantel
 * adds no text of its own) and, by default, waits for its run to end. The run succeeds when the session answered and
 * fails otherwise.
 *
 * A retry prompts once. A retried run finds the session by its label and the prompt by its `requestId`. Listing and
 * creating are not atomic, so two attempts could each create a session; the prompt is fenced by `holdLease`: an
 * attempt prompts only once it has renewed its lease, after its session exists. An attempt whose lease another runner
 * took cannot renew it, so it closes the session it created and never prompts; a later attempt cannot claim the
 * occurrence until the prompting one's lease lapses, by when its session is listed.
 */
export function createTaskHandler(options: TaskHandlerOptions): OccurrenceHandler {
	const waitForRun = options.waitForRun ?? true;
	return async (run) => {
		const { schedule, occurrence } = run;
		const payload = taskPayload(schedule, options.defaultAgentId);
		const ctx = schedulerContext(run, payload.projectId);
		const marker = { [OCCURRENCE_LABEL]: occurrence.id };
		const [existing] = (
			await options.directory.list(ctx, { projectId: payload.projectId, labels: marker }, { limit: 1 })
		).items;
		const session: SessionRecord =
			existing ??
			(await options.runtime.create(ctx, {
				projectId: payload.projectId,
				agentId: payload.agentId,
				title: payload.title ?? schedule.title,
				labels: { ...payload.labels, [SCHEDULE_LABEL]: schedule.id, ...marker },
			}));
		try {
			await run.holdLease();
		} catch (error) {
			if (existing === undefined) {
				// Another runner has the occurrence and may have made its own session: this one stays unprompted.
				const { signal: _aborted, ...unsignalled } = ctx;
				await options.runtime.close(unsignalled, session.id).catch(() => undefined);
			}
			throw error;
		}
		const submission = await options.runtime.prompt(ctx, session.id, {
			text: payload.prompt,
			requestId: `schedule:${occurrence.id}`,
		});
		const started = { sessionId: session.id, submissionId: submission.id };
		if (!waitForRun) return { status: "succeeded", result: started };
		const result = await untilAborted(options.runtime.wait(ctx, session.id, submission.id), run.signal);
		return {
			status: result.status === "answered" ? "succeeded" : "failed",
			result: { ...started, run: result.status, ...(result.error === undefined ? {} : { error: result.error }) },
		};
	};
}

// Reminders

/** Quiet hours in a time zone: `start` and `end` are `HH:MM`, and may wrap past midnight (22:00 to 08:00). */
export interface QuietHours {
	readonly start: string;
	readonly end: string;
	readonly timezone: string;
}

/** When the quiet hours `at` falls in end, or `undefined` when `at` is outside them. */
export function quietHoursEnd(at: Timestamp, quiet: QuietHours): Timestamp | undefined {
	const start = parseLocalTime(quiet.start);
	const end = parseLocalTime(quiet.end);
	const local = utcToZoned(at, quiet.timezone);
	const minute = local.hour * 60 + local.minute;
	const from = start.hour * 60 + start.minute;
	const to = end.hour * 60 + end.minute;
	if (from === to) return undefined;
	const wraps = from > to;
	const inside = wraps ? minute >= from || minute < to : minute >= from && minute < to;
	if (!inside) return undefined;
	// The end is later today, unless the quiet hours wrapped and `at` is in the evening part: then it is tomorrow.
	const day = new Date(Date.UTC(local.year, local.month - 1, local.day + (wraps && minute >= from ? 1 : 0)));
	return zonedToUtc(
		day.getUTCFullYear(),
		day.getUTCMonth() + 1,
		day.getUTCDate(),
		end.hour,
		end.minute,
		quiet.timezone,
	);
}

/** A reminder's payload: its text, or `{ message, urgent? }`. An urgent one is not held for quiet hours. */
export type ReminderPayload = string | { readonly message: string; readonly urgent?: boolean };

/** What the host delivers for a due reminder. */
export interface DueReminder {
	/** The occurrence's ID: deliver it once per key, as a retried run delivers it again. */
	readonly key: string;
	readonly organisationId: string;
	readonly schedule: Schedule;
	readonly message: string;
	readonly urgent: boolean;
	readonly dueAt: Timestamp;
	/** Due times it stands for (more than 1 when missed runs were coalesced). */
	readonly coalesced: number;
	/** When quiet hours end, for a reminder due in them: the host holds it until then. */
	readonly holdUntil?: Timestamp;
}

export interface ReminderHandlerOptions {
	/** Delivers the reminder (the host's message, notification or wake), idempotently by `key`. */
	readonly deliver: (reminder: DueReminder) => Promise<void>;
	/** The owner's quiet hours, if any; looked up for each run. */
	readonly quietHours?: (schedule: Schedule) => QuietHours | undefined | Promise<QuietHours | undefined>;
	/** For `holdUntil`. Default: the occurrence's due time. */
	readonly now?: () => Timestamp;
}

/** Hands each `reminder` occurrence to the host to deliver, with when to hold it until if it fell in quiet hours. */
export function createReminderHandler(options: ReminderHandlerOptions): OccurrenceHandler {
	return async (run) => {
		const { schedule, occurrence } = run;
		const payload = schedule.payload;
		let text: string;
		let urgent = false;
		if (typeof payload === "string") text = payload;
		else if (isRecord(payload) && typeof payload.message === "string") {
			text = payload.message;
			urgent = payload.urgent === true;
		} else invalidPayload(schedule, "must be the reminder's text or { message, urgent? }");
		const quiet = urgent ? undefined : await options.quietHours?.(schedule);
		const holdUntil = quiet === undefined ? undefined : quietHoursEnd(options.now?.() ?? occurrence.dueAt, quiet);
		await options.deliver({
			key: occurrence.id,
			organisationId: run.organisationId,
			schedule,
			message: text,
			urgent,
			dueAt: occurrence.dueAt,
			coalesced: occurrence.coalesced,
			...(holdUntil === undefined ? {} : { holdUntil }),
		});
		const result: JsonValue = holdUntil === undefined ? { delivered: true } : { holdUntil };
		return { status: "succeeded", result };
	};
}

// Checks

/** What running a check's command gave. */
export interface CheckExecution {
	readonly exitCode: number;
	readonly stdout: string;
	/** True when it was killed at its time limit: a failed run, whatever its exit code. */
	readonly timedOut?: boolean;
}

/**
 * Runs a check's command, the schedule's `payload`, with no model: in the container tier with only the grants it
 * needs, which the target decides. Gets the run's signal, which aborts at the run's time limit or when its lease is lost.
 */
export type CheckExecutor = (input: {
	readonly organisationId: string;
	readonly schedule: Schedule;
	readonly command: JsonValue;
	readonly occurrenceId: string;
	readonly signal: AbortSignal;
}) => Promise<CheckExecution>;

/** The exit code a check report gets for a run that timed out or broke the output contract: a failed run. */
export const BROKEN_RUN = -1;

/** The number to measure rising by: `value`, or `evidence.count` as Sal reads it. */
function findingValue(item: { readonly [key: string]: unknown }): number | undefined {
	if (typeof item.value === "number" && Number.isFinite(item.value)) return item.value;
	const evidence = item.evidence;
	if (isRecord(evidence) && typeof evidence.count === "number" && Number.isFinite(evidence.count))
		return evidence.count;
	return undefined;
}

/**
 * A check's report from its exit code and standard output, by Sal's contract: 0 is healthy (the output is not read),
 * 3 is findings, anything else a failed run. On 3 the output is JSON, a list of findings or an object with a
 * `findings` (or `items`) list; each is `{key, severity, summary}`, with `hint` and `title` read when `severity` and
 * `summary` are missing, `value` (or `evidence.count`) to measure rising by, and `status` (or `change`), the command's
 * own `new`, `escalated` or `unchanged`. A finding with no severity is `low`.
 * Output on 3 that breaks this (not JSON, no list, a finding without a string `key`) is a failed run, `BROKEN_RUN`.
 */
export function parseCheckOutput(execution: CheckExecution): CheckReport {
	if (execution.timedOut === true || !Number.isInteger(execution.exitCode)) return { exitCode: BROKEN_RUN };
	if (execution.exitCode !== 3) return { exitCode: execution.exitCode };
	let parsed: unknown;
	try {
		parsed = JSON.parse(execution.stdout);
	} catch {
		return { exitCode: BROKEN_RUN };
	}
	const list = Array.isArray(parsed)
		? parsed
		: isRecord(parsed)
			? Array.isArray(parsed.findings)
				? parsed.findings
				: Array.isArray(parsed.items)
					? parsed.items
					: undefined
			: undefined;
	if (list === undefined) return { exitCode: BROKEN_RUN };
	const findings: Finding[] = [];
	for (const item of list) {
		if (!isRecord(item) || typeof item.key !== "string" || item.key.length === 0) return { exitCode: BROKEN_RUN };
		const severity =
			typeof item.severity === "string" ? item.severity : typeof item.hint === "string" ? item.hint : "low";
		const summary =
			typeof item.summary === "string" ? item.summary : typeof item.title === "string" ? item.title : item.key;
		const value = findingValue(item);
		const status =
			typeof item.status === "string" ? item.status : typeof item.change === "string" ? item.change : undefined;
		findings.push({
			key: item.key,
			severity,
			summary,
			...(value === undefined ? {} : { value }),
			...(status === undefined ? {} : { status }),
		});
	}
	return { exitCode: 3, findings };
}

export interface CheckHandlerOptions {
	readonly execute: CheckExecutor;
}

/** Runs each `check` occurrence's command through `execute` and reports it by Sal's contract (`parseCheckOutput`). */
export function createCheckHandler(options: CheckHandlerOptions): OccurrenceHandler {
	return async (run): Promise<RunOutcome> => {
		let execution: CheckExecution;
		try {
			execution = await options.execute({
				organisationId: run.organisationId,
				schedule: run.schedule,
				command: run.schedule.payload,
				occurrenceId: run.occurrence.id,
				signal: run.signal,
			});
		} catch {
			return { check: { exitCode: BROKEN_RUN } };
		}
		return { check: parseCheckOutput(execution) };
	};
}
