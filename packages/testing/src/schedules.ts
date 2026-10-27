/**
 * Conformance suite for `Schedules` (packages/contracts/src/schedules.ts). Every target registers it with a provider
 * that builds fresh schedules on the suite's clock and audit sink.
 */
import type {
	CheckReport,
	Occurrence,
	OwnerRef,
	RaisedFinding,
	Schedule,
	ScheduleInput,
	Schedules,
	Timestamp,
} from "@harbour/contracts";
import {
	actors,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface SchedulesSubject {
	readonly schedules: Schedules;
}

export type SchedulesConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: SchedulesSubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RUNNER = "runner-1";

const human = contextFor(actors.human("owner-1"), ORG, PROJECT);
const service = contextFor(actors.service("supervisor-1"), ORG);
const agent = contextFor(actors.agent("agent-1", "session-1"), ORG, PROJECT);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);
const owner: OwnerRef = { kind: "project", organisationId: ORG, projectId: PROJECT };

const utc = (iso: string): Timestamp => Date.parse(iso);

function scheduleInput(extra: Partial<ScheduleInput>): ScheduleInput {
	return {
		owner,
		kind: "reminder",
		title: "Stand-up",
		timezone: "Europe/London",
		payload: "Time for stand-up",
		...extra,
	};
}

/** Every hour, the first due an hour from now. */
function hourly(deps: ConformanceDeps, extra: Partial<ScheduleInput> = {}): ScheduleInput {
	return scheduleInput({ repeat: { every: "hours", interval: 1, from: deps.clock.now() + HOUR }, ...extra });
}

export function createSchedulesConformance(options: {
	assertions: ConformanceAssertions;
	provider: SchedulesConformanceProvider;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (
		name: string,
		body: (schedules: Schedules, deps: ConformanceDeps) => Promise<void>,
	): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			await options.provider(deps, (subject) => body(subject.schedules, deps));
		},
	});

	/** Ticks, claims and finishes one occurrence as RUNNER. */
	async function runOnce(schedules: Schedules): Promise<Occurrence> {
		const created = await schedules.tick();
		assert.strictEqual(created.length, 1, "the tick materialises one occurrence");
		const claimed = await schedules.claim(RUNNER, 10 * MINUTE);
		assert.ok(claimed, "the occurrence can be claimed");
		return schedules.complete(claimed!.id, RUNNER, { status: "succeeded" });
	}

	/** Moves the clock to a check's next hourly run and reports it. */
	async function runCheck(
		schedules: Schedules,
		deps: ConformanceDeps,
		report: CheckReport,
	): Promise<readonly RaisedFinding[]> {
		deps.clock.advance(HOUR);
		const created = await schedules.tick();
		assert.strictEqual(created.length, 1, "each check run is one occurrence");
		const claimed = await schedules.claim(RUNNER, 10 * MINUTE);
		assert.ok(claimed, "the check run can be claimed");
		return schedules.reportCheck(claimed!.id, RUNNER, report);
	}

	function createCheck(schedules: Schedules, deps: ConformanceDeps, check: ScheduleInput["check"] = {}) {
		return schedules.create(service, hourly(deps, { kind: "check", title: "Disk", payload: "df -h", check }));
	}

	return [
		test("runs a daily 09:00 Europe/London schedule at 08:00 UTC in summer and 09:00 UTC in winter", async (schedules, deps) => {
			deps.clock.set(utc("2026-10-22T12:00:00Z"));
			const schedule = await schedules.create(human, scheduleInput({ repeat: { every: "day", at: "09:00" } }));
			assert.strictEqual(schedule.status, "active");
			assert.strictEqual(schedule.nextDueAt, utc("2026-10-23T08:00:00Z"), "the next due time is 09:00 BST");
			assert.deepEqual(await schedules.preview(human, schedule.id, 5), [
				utc("2026-10-23T08:00:00Z"),
				utc("2026-10-24T08:00:00Z"),
				utc("2026-10-25T09:00:00Z"),
				utc("2026-10-26T09:00:00Z"),
				utc("2026-10-27T09:00:00Z"),
			]);
			assert.strictEqual((await schedules.tick()).length, 0, "previewing materialises nothing");
		}),

		test("runs a local time in the spring-forward gap once at the first valid instant after it", async (schedules, deps) => {
			deps.clock.set(utc("2026-03-27T12:00:00Z"));
			const schedule = await schedules.create(human, scheduleInput({ repeat: { every: "day", at: "01:30" } }));
			assert.deepEqual(await schedules.preview(human, schedule.id, 3), [
				utc("2026-03-28T01:30:00Z"),
				utc("2026-03-29T01:00:00Z"),
				utc("2026-03-30T00:30:00Z"),
			]);
		}),

		test("runs an ambiguous fall-back local time once, at its first instant", async (schedules, deps) => {
			deps.clock.set(utc("2026-10-23T12:00:00Z"));
			const schedule = await schedules.create(human, scheduleInput({ repeat: { every: "day", at: "01:30" } }));
			assert.deepEqual(await schedules.preview(human, schedule.id, 3), [
				utc("2026-10-24T00:30:00Z"),
				utc("2026-10-25T00:30:00Z"),
				utc("2026-10-26T01:30:00Z"),
			]);
			deps.clock.set(utc("2026-10-24T00:30:00Z"));
			await runOnce(schedules);
			deps.clock.set(utc("2026-10-25T00:30:00Z"));
			const first = await runOnce(schedules);
			assert.strictEqual(first.dueAt, utc("2026-10-25T00:30:00Z"));
			deps.clock.set(utc("2026-10-25T01:30:00Z"));
			assert.strictEqual((await schedules.tick()).length, 0, "the second 01:30 of the night is not due");
			assert.strictEqual((await schedules.get(human, schedule.id)).nextDueAt, utc("2026-10-26T01:30:00Z"));
		}),

		test("keeps interval schedules absolute: every 6 hours stays 6 hours apart across a DST change", async (schedules, deps) => {
			deps.clock.set(utc("2026-10-24T12:00:00Z"));
			const from = utc("2026-10-24T22:00:00Z");
			const schedule = await schedules.create(human, scheduleInput({ repeat: { every: "hours", interval: 6, from } }));
			const due = await schedules.preview(human, schedule.id, 4);
			assert.deepEqual(due, [from, from + 6 * HOUR, from + 12 * HOUR, from + 18 * HOUR]);
			const minutes = await schedules.create(
				human,
				scheduleInput({ repeat: { every: "minutes", interval: 90, from: utc("2026-10-25T00:00:00Z") } }),
			);
			assert.deepEqual(await schedules.preview(human, minutes.id, 2), [
				utc("2026-10-25T00:00:00Z"),
				utc("2026-10-25T01:30:00Z"),
			]);
		}),

		test("runs a monthly day-31 schedule on the last day of short months", async (schedules, deps) => {
			deps.clock.set(utc("2026-01-15T12:00:00Z"));
			const schedule = await schedules.create(
				human,
				scheduleInput({ repeat: { every: "month", day: 31, at: "12:00" } }),
			);
			assert.deepEqual(await schedules.preview(human, schedule.id, 4), [
				utc("2026-01-31T12:00:00Z"),
				utc("2026-02-28T12:00:00Z"),
				utc("2026-03-31T11:00:00Z"),
				utc("2026-04-30T11:00:00Z"),
			]);
		}),

		test("runs weekday and weekly schedules only on their days", async (schedules, deps) => {
			deps.clock.set(utc("2026-01-09T12:00:00Z")); // a Friday
			const weekday = await schedules.create(human, scheduleInput({ repeat: { every: "weekday", at: "09:00" } }));
			assert.deepEqual(await schedules.preview(human, weekday.id, 2), [
				utc("2026-01-12T09:00:00Z"),
				utc("2026-01-13T09:00:00Z"),
			]);
			const weekly = await schedules.create(
				human,
				scheduleInput({ timezone: "America/New_York", repeat: { every: "week", on: ["sun", "wed"], at: "18:30" } }),
			);
			assert.deepEqual(await schedules.preview(human, weekly.id, 3), [
				utc("2026-01-11T23:30:00Z"),
				utc("2026-01-14T23:30:00Z"),
				utc("2026-01-18T23:30:00Z"),
			]);
		}),

		test("creates one occurrence when ticked twice at the same time", async (schedules, deps) => {
			const schedule = await schedules.create(human, hourly(deps));
			deps.clock.advance(HOUR);
			const [first, ...rest] = await schedules.tick();
			assert.strictEqual(rest.length, 0);
			assert.partialDeepEqual(first, {
				id: `${schedule.id}@${schedule.nextDueAt}`,
				scheduleId: schedule.id,
				dueAt: schedule.nextDueAt,
				coalesced: 1,
				status: "due",
				attempt: 0,
			});
			assert.strictEqual((await schedules.tick()).length, 0, "the second tick creates nothing");
			assert.strictEqual((await schedules.listOccurrences(human, schedule.id)).items.length, 1);
			assert.strictEqual((await schedules.get(human, schedule.id)).occurrences, 1);
		}),

		test("coalesces a day of missed hourly runs into one occurrence at the latest due time", async (schedules, deps) => {
			const start = deps.clock.now();
			const schedule = await schedules.create(human, hourly(deps));
			deps.clock.advance(DAY);
			const created = await schedules.tick();
			assert.strictEqual(created.length, 1);
			assert.partialDeepEqual(created[0], { coalesced: 24, dueAt: start + DAY, id: `${schedule.id}@${start + DAY}` });
			const after = await schedules.get(human, schedule.id);
			assert.strictEqual(after.occurrences, 1, "coalesced runs count once");
			assert.strictEqual(after.nextDueAt, start + DAY + HOUR, "the next due time is past now");
		}),

		test("never overlaps occurrences: ticks create none while one is due or running, and one after it completes", async (schedules, deps) => {
			const start = deps.clock.now();
			const schedule = await schedules.create(human, hourly(deps));
			deps.clock.advance(HOUR);
			assert.strictEqual((await schedules.tick()).length, 1);
			deps.clock.advance(HOUR);
			assert.strictEqual((await schedules.tick()).length, 0, "nothing while one is due");
			const claimed = await schedules.claim(RUNNER, DAY);
			deps.clock.advance(HOUR);
			assert.strictEqual((await schedules.tick()).length, 0, "nothing while one is running");
			await schedules.complete(claimed!.id, RUNNER, { status: "succeeded", result: { ok: true } });
			const next = await schedules.tick();
			assert.strictEqual(next.length, 1, "one occurrence after it completes");
			assert.partialDeepEqual(next[0], { coalesced: 2, dueAt: start + 3 * HOUR });
			const listed = await schedules.listOccurrences(human, schedule.id);
			assert.partialDeepEqual(listed.items[0], {
				status: "succeeded",
				result: { ok: true },
				finishedAt: start + 3 * HOUR,
			});
		}),

		test("claims the oldest claimable occurrence first", async (schedules, deps) => {
			const early = await schedules.create(human, hourly(deps));
			deps.clock.advance(30 * MINUTE);
			await schedules.create(human, hourly(deps));
			deps.clock.advance(2 * HOUR);
			assert.strictEqual((await schedules.tick()).length, 2);
			const first = await schedules.claim(RUNNER, MINUTE);
			assert.strictEqual(first?.scheduleId, early.id);
			const second = await schedules.claim("runner-2", MINUTE);
			assert.ok(second && second.scheduleId !== early.id, "the second claim takes the other occurrence");
			assert.strictEqual(await schedules.claim("runner-3", MINUTE), undefined, "nothing is left to claim");
		}),

		test("keeps a claim exclusive until its lease passes, then hands it over and refuses the first runner", async (schedules, deps) => {
			await schedules.create(human, hourly(deps));
			deps.clock.advance(HOUR);
			await schedules.tick();
			const first = await schedules.claim(RUNNER, MINUTE);
			assert.partialDeepEqual(first, {
				status: "running",
				claimedBy: RUNNER,
				attempt: 1,
				leaseUntil: deps.clock.now() + MINUTE,
			});
			assert.strictEqual(await schedules.claim("runner-2", MINUTE), undefined, "a live claim is exclusive");
			await assert.rejectsWithCode(
				schedules.complete(first!.id, "runner-2", { status: "succeeded" }),
				"conflict",
				"only the claimant completes",
			);
			deps.clock.advance(MINUTE);
			await assert.rejectsWithCode(
				schedules.complete(first!.id, RUNNER, { status: "succeeded" }),
				"conflict",
				"a lapsed lease cannot complete",
			);
			const second = await schedules.claim("runner-2", MINUTE);
			assert.partialDeepEqual(second, { id: first!.id, claimedBy: "runner-2", attempt: 2 });
			await assert.rejectsWithCode(
				schedules.complete(first!.id, RUNNER, { status: "succeeded" }),
				"conflict",
				"the first runner lost the claim",
			);
			const done = await schedules.complete(first!.id, "runner-2", { status: "failed" });
			assert.strictEqual(done.status, "failed");
			await assert.rejectsWithCode(
				schedules.complete(first!.id, "runner-2", { status: "succeeded" }),
				"conflict",
				"a finished occurrence cannot complete again",
			);
		}),

		test("ends a schedule when its count or until is reached", async (schedules, deps) => {
			const counted = await schedules.create(human, hourly(deps, { count: 2 }));
			const until = await schedules.create(human, hourly(deps, { until: deps.clock.now() + 2 * HOUR }));
			const oneOff = await schedules.create(human, scheduleInput({ at: deps.clock.now() + HOUR }));
			assert.deepEqual(await schedules.preview(human, counted.id, 5), [
				counted.createdAt + HOUR,
				counted.createdAt + 2 * HOUR,
			]);
			deps.clock.advance(HOUR);
			assert.strictEqual((await schedules.tick()).length, 3);
			assert.strictEqual((await schedules.get(human, oneOff.id)).status, "ended", "a one-off ends after it runs");
			for (let index = 0; index < 3; index += 1) {
				const claimed = await schedules.claim(RUNNER, MINUTE);
				await schedules.complete(claimed!.id, RUNNER, { status: "succeeded" });
			}
			deps.clock.advance(HOUR);
			assert.strictEqual((await schedules.tick()).length, 2);
			for (const id of [counted.id, until.id]) {
				const ended = await schedules.get(human, id);
				assert.strictEqual(ended.status, "ended");
				assert.strictEqual(ended.nextDueAt, undefined);
				assert.strictEqual(ended.occurrences, 2);
				assert.deepEqual(await schedules.preview(human, id, 3), []);
			}
			for (let index = 0; index < 2; index += 1) {
				const claimed = await schedules.claim(RUNNER, MINUTE);
				await schedules.complete(claimed!.id, RUNNER, { status: "succeeded" });
			}
			deps.clock.advance(5 * HOUR);
			assert.strictEqual((await schedules.tick()).length, 0, "ended schedules create nothing");
		}),

		test("raises nothing for a check that exits 0", async (schedules, deps) => {
			const check = await createCheck(schedules, deps);
			const raised = await runCheck(schedules, deps, {
				exitCode: 0,
				findings: [{ key: "disk:/var", severity: "warning", summary: "Disk 91% full", value: 91 }],
			});
			assert.deepEqual(raised, []);
			assert.strictEqual((await schedules.listOccurrences(human, check.id)).items[0]?.status, "succeeded");
			assert.strictEqual(deps.audit.ofType("schedules.finding.raised").length, 0);
		}),

		test("raises a check's new findings once and audits each raise", async (schedules, deps) => {
			const check = await createCheck(schedules, deps);
			const findings = [
				{ key: "disk:/var", severity: "warning", summary: "Disk 91% full" },
				{ key: "pr:4811:stale", severity: "info", summary: "PR 4811 is stale" },
			];
			const raised = await runCheck(schedules, deps, { exitCode: 3, findings });
			assert.deepEqual(
				raised.map((finding) => [finding.key, finding.reason, finding.scheduleId]),
				[
					["disk:/var", "new", check.id],
					["pr:4811:stale", "new", check.id],
				],
			);
			assert.strictEqual((await schedules.listOccurrences(human, check.id)).items[0]?.status, "succeeded");
			assert.deepEqual(
				await runCheck(schedules, deps, { exitCode: 3, findings }),
				[],
				"still present: not raised again",
			);
			const events = deps.audit.ofType("schedules.finding.raised");
			assert.strictEqual(events.length, 2);
			assert.partialDeepEqual(events[0], {
				source: "schedules",
				organisationId: ORG,
				subject: { kind: "schedules.schedule", id: check.id },
				data: { key: "disk:/var", reason: "new", occurrenceId: raised[0]!.occurrenceId },
			});
		}),

		test("raises a finding still present again after reraiseHours", async (schedules, deps) => {
			await createCheck(schedules, deps);
			const findings = [{ key: "disk:/var", severity: "warning", summary: "Disk 91% full" }];
			assert.strictEqual((await runCheck(schedules, deps, { exitCode: 3, findings })).length, 1);
			for (let hour = 1; hour < 6; hour += 1) {
				assert.deepEqual(await runCheck(schedules, deps, { exitCode: 3, findings }), [], `quiet after ${hour} h`);
			}
			const again = await runCheck(schedules, deps, { exitCode: 3, findings });
			assert.deepEqual(
				again.map((finding) => finding.reason),
				["reraise"],
				"raised again after the default 6 hours",
			);
			assert.deepEqual(await runCheck(schedules, deps, { exitCode: 3, findings }), [], "the clock restarts");
		}),

		test("raises a finding whose value doubles as rising", async (schedules, deps) => {
			await createCheck(schedules, deps);
			const errors = (value: number): CheckReport => ({
				exitCode: 3,
				findings: [{ key: "errors:api", severity: "warning", summary: `${value} errors`, value }],
			});
			assert.strictEqual((await runCheck(schedules, deps, errors(4))).length, 1);
			assert.deepEqual(await runCheck(schedules, deps, errors(6)), [], "growing by less than the factor is quiet");
			const rising = await runCheck(schedules, deps, errors(8));
			assert.partialDeepEqual(rising, [{ key: "errors:api", reason: "rising", value: 8 }]);
			assert.deepEqual(await runCheck(schedules, deps, errors(10)), [], "compared with the value last raised");
		}),

		test("raises one check-failed finding after three failed runs in a row, and again only after a success", async (schedules, deps) => {
			const check = await createCheck(schedules, deps);
			const failed: CheckReport = { exitCode: 1 };
			assert.deepEqual(await runCheck(schedules, deps, failed), []);
			assert.deepEqual(await runCheck(schedules, deps, { exitCode: 2 }), []);
			const raised = await runCheck(schedules, deps, failed);
			assert.partialDeepEqual(raised, [{ key: `check-failed:${check.id}`, reason: "failures", scheduleId: check.id }]);
			assert.strictEqual(raised.length, 1);
			assert.deepEqual(await runCheck(schedules, deps, failed), [], "nothing more while it keeps failing");
			const runs = (await schedules.listOccurrences(human, check.id)).items;
			assert.strictEqual(runs.at(-1)?.status, "failed", "a non-zero, non-3 exit is a failed run");
			assert.deepEqual(await runCheck(schedules, deps, { exitCode: 0 }), []);
			assert.deepEqual(await runCheck(schedules, deps, failed), []);
			assert.deepEqual(await runCheck(schedules, deps, failed), []);
			assert.strictEqual((await runCheck(schedules, deps, failed)).length, 1, "a success resets the count");
			assert.strictEqual(deps.audit.ofType("schedules.finding.raised").length, 2);
		}),

		test("lets only the claimant report a check", async (schedules, deps) => {
			await createCheck(schedules, deps);
			deps.clock.advance(HOUR);
			await schedules.tick();
			const claimed = await schedules.claim(RUNNER, MINUTE);
			await assert.rejectsWithCode(schedules.reportCheck(claimed!.id, "runner-2", { exitCode: 0 }), "conflict");
			deps.clock.advance(MINUTE);
			await assert.rejectsWithCode(schedules.reportCheck(claimed!.id, RUNNER, { exitCode: 0 }), "conflict");
		}),

		test("refuses an agent creating, updating, pausing, resuming or ending a schedule", async (schedules, deps) => {
			await assert.rejectsWithCode(schedules.create(agent, hourly(deps)), "forbidden");
			const schedule = await schedules.create(human, hourly(deps));
			await assert.rejectsWithCode(schedules.update(agent, schedule.id, { title: "Mine now" }), "forbidden");
			await assert.rejectsWithCode(schedules.pause(agent, schedule.id), "forbidden");
			await schedules.pause(human, schedule.id);
			await assert.rejectsWithCode(schedules.resume(agent, schedule.id), "forbidden");
			await assert.rejectsWithCode(schedules.end(agent, schedule.id), "forbidden");
			assert.strictEqual((await schedules.get(agent, schedule.id)).status, "paused", "an agent may still read it");
			assert.strictEqual(
				deps.audit.ofType("schedules.schedule.created").length,
				1,
				"only the human's create is audited",
			);
			assert.partialDeepEqual(deps.audit.ofType("schedules.schedule.created")[0], {
				actor: human.actor,
				organisationId: ORG,
				subject: { kind: "schedules.schedule", id: schedule.id },
			});
		}),

		test("creates no occurrences for a paused schedule and does not backfill paused time on resume", async (schedules, deps) => {
			const start = deps.clock.now();
			const schedule = await schedules.create(service, hourly(deps));
			const paused = await schedules.pause(service, schedule.id);
			assert.strictEqual(paused.status, "paused");
			assert.strictEqual(paused.nextDueAt, undefined);
			deps.clock.advance(5 * HOUR + 30 * MINUTE);
			assert.strictEqual((await schedules.tick()).length, 0, "paused schedules create nothing");
			const resumed = await schedules.resume(service, schedule.id);
			assert.strictEqual(resumed.status, "active");
			assert.strictEqual(resumed.nextDueAt, start + 6 * HOUR, "the next due time is after now");
			assert.strictEqual((await schedules.tick()).length, 0, "no backfill on resume");
			deps.clock.advance(30 * MINUTE);
			const created = await schedules.tick();
			assert.partialDeepEqual(created, [{ coalesced: 1, dueAt: start + 6 * HOUR }]);
			const ended = await schedules.end(service, schedule.id);
			assert.strictEqual(ended.status, "ended");
			await assert.rejectsWithCode(schedules.resume(service, schedule.id), "conflict", "an ended schedule stays ended");
			for (const change of ["paused", "resumed", "ended"]) {
				const events = deps.audit.ofType(`schedules.schedule.${change}`);
				assert.strictEqual(events.length, 1, `one schedules.schedule.${change} event`);
				assert.partialDeepEqual(events[0], { actor: service.actor, subject: { id: schedule.id } });
			}
		}),

		test("update ignores fields outside ScheduleInput and is audited", async (schedules, deps) => {
			const schedule = await schedules.create(human, hourly(deps));
			deps.clock.advance(HOUR);
			await schedules.tick();
			const before = await schedules.get(human, schedule.id);
			const sneaky = {
				title: "Renamed",
				id: "schedule_someone-elses",
				createdBy: actors.human("intruder"),
				occurrences: 0,
				status: "ended",
				nextDueAt: 1,
				createdAt: 1,
			} as unknown as Parameters<Schedules["update"]>[2];
			const updated = await schedules.update(human, schedule.id, sneaky);
			assert.strictEqual(updated.title, "Renamed", "input fields are applied");
			assert.strictEqual(updated.id, schedule.id);
			assert.deepEqual(updated.createdBy, schedule.createdBy);
			assert.strictEqual(updated.createdAt, schedule.createdAt);
			assert.strictEqual(updated.occurrences, before.occurrences);
			assert.strictEqual(updated.status, "active");
			assert.greaterThan(updated.nextDueAt ?? 0, deps.clock.now() - 1, "nextDueAt is the store's, not the caller's");
			assert.strictEqual((await schedules.list(outsider)).items.length, 0, "the other organisation sees nothing");
			const created = await schedules.create(human, {
				...hourly(deps),
				id: "chosen",
				occurrences: 99,
				status: "ended",
			} as unknown as ScheduleInput);
			assert.ok(created.id !== "chosen", "create ignores them too");
			assert.strictEqual(created.occurrences, 0);
			assert.strictEqual(created.status, "active");
			assert.partialDeepEqual(deps.audit.ofType("schedules.schedule.updated"), [
				{ actor: human.actor, subject: { id: schedule.id } },
			]);
		}),

		test("rejects an invalid time zone, a bad HH:MM, or both or neither of at and repeat as invalid", async (schedules, deps) => {
			const daily = { every: "day", at: "09:00" } as const;
			await assert.rejectsWithCode(
				schedules.create(human, scheduleInput({ timezone: "Europe/Atlantis", repeat: daily })),
				"invalid",
			);
			for (const at of ["9:00", "24:00", "09:60", "0900", "09:00:00"]) {
				await assert.rejectsWithCode(
					schedules.create(human, scheduleInput({ repeat: { every: "day", at } })),
					"invalid",
					`"${at}" is invalid`,
				);
			}
			await assert.rejectsWithCode(
				schedules.create(human, scheduleInput({ at: deps.clock.now() + HOUR, repeat: daily })),
				"invalid",
			);
			await assert.rejectsWithCode(schedules.create(human, scheduleInput({})), "invalid");
			await assert.rejectsWithCode(
				schedules.create(human, scheduleInput({ repeat: { every: "month", day: 32, at: "09:00" } })),
				"invalid",
			);
			const schedule = await schedules.create(human, scheduleInput({ repeat: daily }));
			await assert.rejectsWithCode(schedules.update(human, schedule.id, { timezone: "Mars/Olympus" }), "invalid");
			await assert.rejectsWithCode(schedules.update(human, schedule.id, { at: deps.clock.now() + HOUR }), "invalid");
			assert.strictEqual((await schedules.list(human)).items.length, 1, "nothing invalid was stored");
		}),

		test("hides another organisation's schedules as not found", async (schedules, deps) => {
			const schedule = await schedules.create(human, hourly(deps));
			await assert.rejectsWithCode(schedules.get(outsider, schedule.id), "not_found");
			await assert.rejectsWithCode(schedules.update(outsider, schedule.id, { title: "Theirs" }), "not_found");
			await assert.rejectsWithCode(schedules.pause(outsider, schedule.id), "not_found");
			await assert.rejectsWithCode(schedules.resume(outsider, schedule.id), "not_found");
			await assert.rejectsWithCode(schedules.end(outsider, schedule.id), "not_found");
			await assert.rejectsWithCode(schedules.preview(outsider, schedule.id, 1), "not_found");
			await assert.rejectsWithCode(schedules.listOccurrences(outsider, schedule.id), "not_found");
			assert.strictEqual((await schedules.list(outsider)).items.length, 0);
			await assert.rejectsWithCode(
				schedules.create(outsider, hourly(deps)),
				"invalid",
				"a schedule cannot be owned by another organisation",
			);
			const unchanged: Schedule = await schedules.get(human, schedule.id);
			assert.strictEqual(unchanged.status, "active");
		}),
	];
}

export function registerSchedulesConformance(
	runner: ConformanceRunner,
	name: string,
	provider: SchedulesConformanceProvider,
): void {
	registerCases(
		runner,
		name,
		createSchedulesConformance({ assertions: createExpectAssertions(runner.expect), provider }),
	);
}
