// A stand-in for the schedule routes: `ScheduleWrites` over the in-memory `Schedules` store from `@harbour/schedules`,
// so the form's saves are checked by the same rules the server applies, with a fixed clock for stories and tests. A
// host swaps it for its API client; nothing else changes.

import type { CallContext, OwnerRef, Schedule, ScheduleInput, Schedules } from "@harbour/contracts";
import { createMemorySchedules } from "@harbour/schedules/memory";
import type { ScheduleAgent } from "./schedule-form-model.ts";
import { bindScheduleWrites, type ScheduleWrites } from "./schedule-writes.ts";

/** Wed 28 Oct 2026, 14:00 UTC: one fixed time, so previews read the same in every screenshot. */
export const FIXTURE_NOW = Date.UTC(2026, 9, 28, 14, 0, 0);

export const FIXTURE_ORGANISATION = "org_harbour";
export const FIXTURE_PROJECT = "prj_harbour";

export const FIXTURE_OWNER: OwnerRef = {
	kind: "project",
	organisationId: FIXTURE_ORGANISATION,
	projectId: FIXTURE_PROJECT,
};

export const FIXTURE_VIEWER: CallContext = {
	actor: { kind: "human", userId: "usr_tom" },
	organisationId: FIXTURE_ORGANISATION,
	projectId: FIXTURE_PROJECT,
};

export const FIXTURE_AGENTS: readonly ScheduleAgent[] = [
	{ id: "agt_triage", name: "Triage" },
	{ id: "agt_reviewer", name: "PR reviewer" },
	{ id: "agt_writer", name: "Release notes writer" },
];

/** Schedules the form can open for editing. */
export const FIXTURE_SCHEDULE_INPUTS: readonly ScheduleInput[] = [
	{
		owner: FIXTURE_OWNER,
		kind: "task",
		title: "Triage new issues",
		timezone: "Europe/London",
		repeat: { every: "minutes", interval: 10, from: FIXTURE_NOW - 3 * 60 * 60_000 },
		payload: {
			agentId: "agt_triage",
			prompt:
				"Look at the issues opened on tvdavies/harbour since your last run. Label each one, and ask for a reproduction where it's missing.",
		},
	},
	{
		owner: FIXTURE_OWNER,
		kind: "check",
		title: "Disk free on the build hosts",
		timezone: "Europe/London",
		repeat: { every: "hours", interval: 1, from: FIXTURE_NOW - 24 * 60 * 60_000 },
		payload: ["checks/disk-free.sh", "--hosts", "build-1,build-2", "--min-free", "15%"],
		check: { reraiseHours: 6, risingFactor: 2, failuresBeforeRaise: 3 },
	},
	{
		owner: FIXTURE_OWNER,
		kind: "task",
		title: "Weekly release notes",
		timezone: "Europe/London",
		repeat: { every: "week", at: "16:30", on: ["fri"] },
		count: 12,
		payload: {
			agentId: "agt_writer",
			prompt: "Draft this week's release notes from the merged pull requests, grouped by area.",
		},
	},
];

export interface FixtureScheduleWrites extends ScheduleWrites {
	/** The store underneath, for stories and tests that read back what was saved. */
	readonly store: Schedules;
	readonly ctx: CallContext;
}

/**
 * `ScheduleWrites` over a fresh in-memory store at `now`, holding `inputs`. `delayMs` makes each call wait, so a story
 * can show the saving state.
 */
export async function createFixtureScheduleWrites(
	options: { readonly now?: () => number; readonly inputs?: readonly ScheduleInput[]; readonly delayMs?: number } = {},
): Promise<{ readonly writes: FixtureScheduleWrites; readonly schedules: readonly Schedule[] }> {
	const now = options.now ?? (() => FIXTURE_NOW);
	const store = createMemorySchedules({ clock: { now } });
	const ctx = FIXTURE_VIEWER;
	const schedules: Schedule[] = [];
	for (const input of options.inputs ?? FIXTURE_SCHEDULE_INPUTS) schedules.push(await store.create(ctx, input));
	const bound = bindScheduleWrites(store, ctx);
	const delay = options.delayMs ?? 0;
	const later = <T>(call: () => Promise<T>): Promise<T> =>
		delay <= 0 ? call() : new Promise((resolve) => setTimeout(resolve, delay)).then(call);
	return {
		writes: {
			store,
			ctx,
			create: (input) => later(() => bound.create(input)),
			update: (id, input) => later(() => bound.update(id, input)),
			end: (id) => later(() => bound.end(id)),
		},
		schedules,
	};
}
