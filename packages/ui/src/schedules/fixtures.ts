// The schedules page's fixtures: an in-memory `Schedules` (from @harbour/schedules) on a clock the fixture moves. It
// creates a team's schedules three days before FIXTURE_NOW, then plays the scheduler through those days, ticking,
// claiming and finishing every run, so each schedule's history is what the real store made. One known story for the
// screenshots: the build-host disk check raised findings overnight and failed three runs in a row on Monday.
//
// The scenario's `source` is the one `SchedulesSource` the page and the schedule form both use: reads and writes over
// the same store, so a schedule saved in the form shows in the list, runs on the store's own rules and ends there. An
// update's `null` on `at`, `repeat`, `until` or `count` clears it there, as the public API's PATCH does.

import {
	type CallContext,
	type Clock,
	type OwnerRef,
	type RaisedFinding,
	type Schedule,
	type ScheduleInput,
	type Schedules,
	systemContext,
} from "@harbour/contracts";
import { createMemorySchedules } from "@harbour/schedules/memory";
import { directory } from "../audit/fixtures.ts";
import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import { FIXTURE_NOW } from "../session/fixtures.ts";
import type { ScheduleAgent } from "./form/schedule-form-model.ts";
import { bindSchedules, type SchedulesSource } from "./schedules-model.ts";

export { directory, FIXTURE_NOW };

export const ORGANISATION = "org_harbour";

/** Who owns a schedule made in the form: the Platform project, as the console's current project would. */
export const FIXTURE_OWNER: OwnerRef = { kind: "project", organisationId: ORGANISATION, projectId: "prj_platform" };

/** The agents a task can ask, by name. */
export const FIXTURE_AGENTS: readonly ScheduleAgent[] = [
	{ id: "agt_triage", name: "Triage" },
	{ id: "agt_reviewer", name: "PR reviewer" },
	{ id: "agt_writer", name: "Release notes writer" },
];

const TOM: CallContext = { actor: { kind: "human", userId: "usr_tom" }, organisationId: ORGANISATION };
const ALEX: CallContext = { actor: { kind: "human", userId: "usr_alex" }, organisationId: ORGANISATION };
const SCHEDULER = systemContext("scheduler");
const RUNNER = "runner-eu-1";

/** The fixture's schedules by a short name, for stories that open one. */
export type FixtureName =
	| "triage"
	| "brief"
	| "disk"
	| "prs"
	| "release"
	| "invoices"
	| "accountant"
	| "heartbeat"
	| "backfill"
	| "export"
	| "certificate";

const START = FIXTURE_NOW - 3 * DAY;

/** What each schedule is, and when the fixture creates it (before START when it has a longer past). */
const SCHEDULES: readonly { name: FixtureName; by: CallContext; input: ScheduleInput }[] = [
	{
		name: "triage",
		by: TOM,
		input: {
			owner: FIXTURE_OWNER,
			kind: "task",
			title: "Triage new issues",
			timezone: "Europe/London",
			repeat: { every: "minutes", interval: 10, from: START },
			payload: {
				agentId: "agt_triage",
				prompt:
					"Look at the issues opened on harbour-dev/harbour since your last run. Label each one, and ask for a reproduction where it's missing.",
			},
		},
	},
	{
		name: "brief",
		by: TOM,
		input: {
			owner: { kind: "user", organisationId: ORGANISATION, userId: "usr_tom" },
			kind: "summary",
			title: "Morning brief",
			timezone: "Europe/London",
			repeat: { every: "weekday", at: "08:00" },
			payload: "Summarise last night's sessions, the approvals waiting on me and any check that raised a finding.",
		},
	},
	{
		name: "disk",
		by: ALEX,
		input: {
			owner: { kind: "project", organisationId: ORGANISATION, projectId: "prj_platform" },
			kind: "check",
			title: "Disk space on the build hosts",
			timezone: "Europe/London",
			repeat: { every: "minutes", interval: 30, from: START },
			payload: ["checks/disk-free.sh", "--hosts", "build-1,build-2,build-3", "--min-free", "15%"],
			check: { reraiseHours: 6, risingFactor: 2, failuresBeforeRaise: 3 },
		},
	},
	{
		name: "prs",
		by: TOM,
		input: {
			owner: { kind: "project", organisationId: ORGANISATION, projectId: "prj_platform" },
			kind: "check",
			title: "Stale pull requests",
			timezone: "Europe/London",
			repeat: { every: "hours", interval: 2, from: START },
			payload: ["checks/stale-prs.sh", "--repo", "harbour-dev/harbour", "--older-than", "3d"],
		},
	},
	{
		name: "release",
		by: ALEX,
		input: {
			owner: { kind: "project", organisationId: ORGANISATION, projectId: "prj_platform" },
			kind: "task",
			title: "Draft the weekly release notes",
			timezone: "Europe/London",
			repeat: { every: "week", at: "16:00", on: ["fri"] },
			payload: {
				agentId: "agt_writer",
				prompt:
					"Read the pull requests merged to main since last Friday and draft release notes in notes/releases/. Group them by area, link each one, and leave the draft for review.",
			},
		},
	},
	{
		name: "invoices",
		by: TOM,
		input: {
			owner: { kind: "project", organisationId: ORGANISATION, projectId: "prj_billing" },
			kind: "task",
			title: "Reconcile last month's invoices",
			timezone: "Europe/London",
			repeat: { every: "month", at: "07:00", day: 1 },
			// No agent named: the runner asks the default one.
			payload: {
				prompt: "Match every Stripe invoice from last month to its customer record and list the mismatches.",
			},
		},
	},
	{
		name: "accountant",
		by: TOM,
		input: {
			owner: { kind: "user", organisationId: ORGANISATION, userId: "usr_tom" },
			kind: "reminder",
			title: "Call the accountant about the VAT return",
			timezone: "Europe/London",
			at: FIXTURE_NOW + 2 * DAY + 2 * HOUR,
			payload: "Call Sam at the accountant's about the VAT return before the deadline on Friday.",
		},
	},
	{
		name: "heartbeat",
		by: ALEX,
		input: {
			owner: { kind: "organisation", organisationId: ORGANISATION },
			kind: "heartbeat",
			title: "Supervisor heartbeat",
			timezone: "UTC",
			repeat: { every: "minutes", interval: 15, from: START },
			payload: { supervisor: "sal", checkStuckWorkers: true },
		},
	},
	{
		name: "backfill",
		by: TOM,
		input: {
			owner: { kind: "project", organisationId: ORGANISATION, projectId: "prj_data" },
			kind: "program",
			title: "Nightly events backfill",
			timezone: "Europe/Amsterdam",
			repeat: { every: "day", at: "02:00" },
			payload: "prg_events_backfill",
		},
	},
	{
		name: "export",
		by: ALEX,
		input: {
			owner: { kind: "organisation", organisationId: ORGANISATION },
			kind: "task",
			title: "Export the audit log for the Q3 review",
			timezone: "Europe/London",
			repeat: { every: "day", at: "18:00" },
			count: 2,
			payload: {
				agentId: "agt_writer",
				prompt: "Export last quarter's audit log as JSONL and put it in the shared review folder.",
			},
		},
	},
	{
		name: "certificate",
		by: TOM,
		input: {
			owner: { kind: "project", organisationId: ORGANISATION, projectId: "prj_platform" },
			kind: "reminder",
			title: "Renew the staging certificate",
			timezone: "Europe/London",
			at: START + 5 * HOUR,
			payload: "The staging TLS certificate expires at the weekend: renew it.",
		},
	},
];

/** A repeatable sequence of numbers in [0, 1), so every build of the fixture is the same. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

export interface SchedulesScenario {
	readonly store: Schedules;
	readonly source: SchedulesSource;
	/** Each fixture schedule's ID, by its short name. */
	readonly ids: Readonly<Record<FixtureName, string>>;
	readonly ctx: CallContext;
}

export interface SchedulesScenarioOptions {
	/** Create nothing, for the empty list. */
	readonly empty?: boolean;
	/**
	 * The sessions task runs say they started, taken in turn: a host's own sessions, so a run's link opens one. Default
	 * a made-up ID per run.
	 */
	readonly sessions?: readonly string[];
}

/**
 * Builds the store and plays three days of the scheduler. The clock ends at FIXTURE_NOW, with the heartbeat's latest
 * run still running and the disk check's next one due.
 */
export async function createSchedulesScenario(options: SchedulesScenarioOptions = {}): Promise<SchedulesScenario> {
	let now = START - 2 * HOUR;
	const clock: Clock = { now: () => now };
	const store = createMemorySchedules({ clock });
	const findings = new Map<string, RaisedFinding[]>();
	const ids = {} as Record<FixtureName, string>;
	const source = bindSchedules(store, TOM, async (scheduleId) => [...(findings.get(scheduleId) ?? [])].reverse());
	if (options.empty === true) {
		now = FIXTURE_NOW;
		return { store, source, ids, ctx: TOM };
	}

	for (const { name, by, input } of SCHEDULES) ids[name] = (await store.create(by, input)).id;
	const kinds = new Map<string, Schedule["kind"]>();
	for (const { name, input } of SCHEDULES) kinds.set(ids[name], input.kind);

	let started = 0;
	const sessionFor = (occurrenceId: string): string => {
		const sessions = options.sessions ?? [];
		started += 1;
		return sessions.length === 0
			? `ses_${occurrenceId.replace(/^occ_/, "")}`
			: (sessions[(started - 1) % sessions.length] as string);
	};
	const next = random(20_261_027);
	// The disk on build-2 fills overnight on the second night; the check's script breaks for three runs on the third
	// morning; nothing ran for two hours on the first afternoon (a runner outage), so those runs were coalesced.
	const outage = { from: START + 14 * HOUR, to: START + 16 * HOUR };
	const diskFull = { from: START + DAY + 22 * HOUR, to: START + 2 * DAY + 7 * HOUR };
	const diskBroken = { from: START + 2 * DAY + 9 * HOUR, to: START + 2 * DAY + 10 * HOUR + 31 * MINUTE };
	const within = (at: number, window: { from: number; to: number }) => at >= window.from && at < window.to;

	for (now = START; now <= FIXTURE_NOW; now += 5 * MINUTE) {
		if (now === START + 2 * DAY + 3 * HOUR) await store.pause(TOM, ids.backfill);
		if (within(now, outage)) continue;
		await store.tick(SCHEDULER);
		for (;;) {
			const claimed = await store.claim(SCHEDULER, RUNNER, 10 * MINUTE);
			if (claimed === undefined) break;
			// The run in flight at FIXTURE_NOW stays running.
			if (now === FIXTURE_NOW && kinds.get(claimed.scheduleId) === "heartbeat") continue;
			const kind = kinds.get(claimed.scheduleId);
			if (kind === "check") {
				const report =
					claimed.scheduleId === ids.disk
						? within(now, diskBroken)
							? { exitCode: 2 }
							: within(now, diskFull)
								? {
										exitCode: 3,
										findings: [
											{
												key: "disk:build-2:/var",
												severity: "high",
												summary: `build-2 has ${Math.max(2, Math.round(14 - (now - diskFull.from) / HOUR))}% free on /var`,
												value: Math.round((now - diskFull.from) / HOUR) + 1,
											},
										],
									}
								: { exitCode: 0 }
						: next() < 0.35
							? {
									exitCode: 3,
									findings: [
										{
											key: "pr:4811:stale",
											severity: "medium",
											summary: "#4811 Rotate the Linear key has waited 4 days for review",
										},
										...(next() < 0.5
											? [
													{
														key: "pr:4822:stale",
														severity: "low",
														summary: "#4822 Tidy the audit export has waited 3 days for review",
													},
												]
											: []),
									],
								}
							: { exitCode: 0 };
				const raised = await store.reportCheck(SCHEDULER, claimed.id, RUNNER, report);
				if (raised.length > 0)
					findings.set(claimed.scheduleId, [...(findings.get(claimed.scheduleId) ?? []), ...raised]);
			} else {
				const failed = kind === "task" && claimed.scheduleId === ids.export && next() < 0.6;
				await store.complete(SCHEDULER, claimed.id, RUNNER, {
					status: failed ? "failed" : "succeeded",
					...(kind === "task"
						? {
								result: failed
									? { message: "The review folder refused the upload (403)" }
									: {
											message: "Done; the session left its notes in the workspace",
											sessionId: sessionFor(claimed.id),
										},
							}
						: kind === "summary"
							? { result: "Sent the brief to Tom" }
							: {}),
				});
			}
		}
	}
	now = FIXTURE_NOW;
	return { store, source, ids, ctx: TOM };
}

/** A source that never answers, for the loading state. */
export const pendingSource: SchedulesSource = {
	list: () => new Promise(() => undefined),
	get: () => new Promise(() => undefined),
	preview: () => new Promise(() => undefined),
	listOccurrences: () => new Promise(() => undefined),
	create: () => new Promise(() => undefined),
	update: () => new Promise(() => undefined),
	pause: () => new Promise(() => undefined),
	resume: () => new Promise(() => undefined),
	end: () => new Promise(() => undefined),
};

const unavailable = () => Promise.reject(new Error("Harbour is unavailable"));

/** A source whose every read fails, for the error state. */
export const failingSource: SchedulesSource = {
	list: unavailable,
	get: unavailable,
	preview: unavailable,
	listOccurrences: unavailable,
	create: unavailable,
	update: unavailable,
	pause: unavailable,
	resume: unavailable,
	end: unavailable,
};

/** The scenario's source with the detail's reads and every change slowed, to see their loading and saving states. */
export function slowSource(source: SchedulesSource, ms: number): SchedulesSource {
	const slow =
		<A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
		(...args: A) =>
			new Promise<R>((resolve, reject) => setTimeout(() => call(...args).then(resolve, reject), ms));
	return {
		list: source.list,
		get: slow(source.get),
		preview: slow(source.preview),
		listOccurrences: slow(source.listOccurrences),
		create: slow(source.create),
		update: slow(source.update),
		pause: slow(source.pause),
		resume: slow(source.resume),
		end: slow(source.end),
		...(source.findings === undefined ? {} : { findings: source.findings }),
	};
}
