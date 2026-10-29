import type { Occurrence, Schedule } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import { ownerName } from "../primitives/owner.ts";
import { createSchedulesScenario, directory, FIXTURE_NOW, FIXTURE_OWNER } from "./fixtures.ts";
import {
	countByStatus,
	filterSchedules,
	isProblem,
	limitText,
	listText,
	newestFirst,
	nextText,
	payloadView,
	readPages,
	recurrenceText,
	runDetail,
	runSession,
	runState,
	severityText,
	severityTone,
	sortSchedules,
	timeUntil,
	timingText,
	zonedText,
	zoneName,
} from "./schedules-model.ts";

const base: Schedule = {
	id: "schedule_1",
	owner: { kind: "organisation", organisationId: "org_harbour" },
	kind: "task",
	title: "Draft the release notes",
	timezone: "Europe/London",
	repeat: { every: "weekday", at: "09:00" },
	payload: "Draft them",
	status: "active",
	nextDueAt: FIXTURE_NOW + 3 * HOUR,
	occurrences: 0,
	createdBy: { kind: "human", userId: "usr_tom" },
	createdAt: FIXTURE_NOW - DAY,
	updatedAt: FIXTURE_NOW - DAY,
};

const run = (change: Partial<Occurrence>): Occurrence => ({
	id: "schedule_1@1",
	scheduleId: "schedule_1",
	dueAt: FIXTURE_NOW - HOUR,
	coalesced: 1,
	status: "succeeded",
	attempt: 1,
	...change,
});

describe("timing in words", () => {
	it("says each recurrence as a sentence", () => {
		expect(recurrenceText({ every: "minutes", interval: 15, from: 0 })).toBe("Every 15 minutes");
		expect(recurrenceText({ every: "minutes", interval: 1, from: 0 })).toBe("Every minute");
		expect(recurrenceText({ every: "hours", interval: 1, from: 0 })).toBe("Every hour");
		expect(recurrenceText({ every: "day", at: "02:00" })).toBe("Every day at 02:00");
		expect(recurrenceText({ every: "day", at: "02:00", interval: 3 })).toBe("Every 3 days at 02:00");
		expect(recurrenceText({ every: "weekday", at: "08:00" })).toBe("Every weekday at 08:00");
		expect(recurrenceText({ every: "week", at: "16:00", on: ["fri", "mon"] })).toBe("Every Monday and Friday at 16:00");
		expect(recurrenceText({ every: "week", at: "16:00", on: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] })).toBe(
			"Every day at 16:00",
		);
		expect(recurrenceText({ every: "month", at: "07:00", day: 1 })).toBe("On the 1st of every month at 07:00");
		expect(recurrenceText({ every: "month", at: "07:00", day: 22 })).toBe("On the 22nd of every month at 07:00");
		expect(recurrenceText({ every: "month", at: "18:00", day: 31 })).toBe("On the last day of every month at 18:00");
	});

	it("joins lists with commas and a final and", () => {
		expect(listText([])).toBe("");
		expect(listText(["a"])).toBe("a");
		expect(listText(["a", "b", "c"])).toBe("a, b and c");
	});

	it("shows moments in the schedule's own time zone", () => {
		// 27 Oct 2026 12:00 UTC is 12:00 in London (after the clocks went back) and 13:00 in Amsterdam.
		expect(zonedText(FIXTURE_NOW, "Europe/London")).toBe("Tue 27 Oct, 12:00");
		expect(zoneName("America/New_York")).toBe("New York time");
		expect(zonedText(FIXTURE_NOW, "Europe/Amsterdam")).toContain("13:00");
		expect(zonedText(FIXTURE_NOW, "Not/AZone")).toContain("2026");
	});

	it("says a one-off's moment and a schedule's limits", () => {
		const once: Schedule = { ...base, repeat: undefined, at: FIXTURE_NOW + DAY } as Schedule;
		expect(timingText(once)).toBe("Once, Wed 28 Oct, 12:00 London time");
		expect(limitText(base)).toBeUndefined();
		expect(limitText({ ...base, count: 2, occurrences: 1 })).toBe("At most 2 runs, 1 so far");
		expect(limitText({ ...base, until: FIXTURE_NOW + 30 * DAY, count: 1, occurrences: 0 })).toBe(
			"Until 26 Nov 2026, at most 1 run, 0 so far",
		);
	});

	it("says how long until a due time, compactly", () => {
		expect(timeUntil(FIXTURE_NOW + 30_000, FIXTURE_NOW)).toBe("now");
		expect(timeUntil(FIXTURE_NOW + 4 * MINUTE, FIXTURE_NOW)).toBe("in 4m");
		expect(timeUntil(FIXTURE_NOW + 3 * HOUR, FIXTURE_NOW)).toBe("in 3h");
		expect(timeUntil(FIXTURE_NOW + 2 * DAY, FIXTURE_NOW)).toBe("in 2d");
		expect(timeUntil(FIXTURE_NOW + 15 * DAY, FIXTURE_NOW)).toBe("in 2w");
		expect(nextText(base, FIXTURE_NOW)).toBe("Next in 3h");
		expect(nextText({ ...base, status: "paused" }, FIXTURE_NOW)).toBe("Paused");
	});
});

describe("the list", () => {
	const schedules: Schedule[] = [
		{ ...base, id: "ended", status: "ended", nextDueAt: undefined, updatedAt: FIXTURE_NOW - 2 * DAY } as Schedule,
		{ ...base, id: "later", nextDueAt: FIXTURE_NOW + 5 * HOUR },
		{ ...base, id: "paused", status: "paused", nextDueAt: undefined } as Schedule,
		{ ...base, id: "soon", nextDueAt: FIXTURE_NOW + HOUR },
	];

	it("puts active schedules first, soonest due first", () => {
		expect(sortSchedules(schedules).map((schedule) => schedule.id)).toEqual(["soon", "later", "paused", "ended"]);
	});

	it("filters and counts by status", () => {
		expect(filterSchedules(schedules, "paused").map((schedule) => schedule.id)).toEqual(["paused"]);
		expect(filterSchedules(schedules, "all")).toHaveLength(4);
		expect(countByStatus(schedules)).toEqual({ active: 2, paused: 1, ended: 1, all: 4 });
	});

	it("names owners from the directory", () => {
		expect(ownerName({ kind: "project", organisationId: "org", projectId: "prj_billing" }, directory)).toBe(
			"Billing project",
		);
		expect(ownerName({ kind: "user", organisationId: "org", userId: "usr_tom" }, directory)).toBe("Tom Davies");
		expect(ownerName({ kind: "user", organisationId: "org", userId: "usr_nobody" }, directory)).toBe("usr_nobody");
	});
});

describe("payloads and runs", () => {
	it("shows a message as text, a command in mono and anything else as JSON", () => {
		expect(payloadView({ kind: "reminder", payload: "Call Sam" })).toEqual({
			kind: "text",
			label: "Message",
			text: "Call Sam",
		});
		expect(payloadView({ kind: "check", payload: ["checks/disk.sh", "--min-free", "15%"] })).toEqual({
			kind: "command",
			label: "Command",
			text: "checks/disk.sh --min-free 15%",
		});
		expect(payloadView({ kind: "task", payload: { brief: "x" } }).kind).toBe("json");
		// A task's payload is `{ agentId?, prompt }`; `message` is not its field.
		expect(payloadView({ kind: "task", payload: { message: "x" } }).kind).toBe("json");
		expect(payloadView({ kind: "task", payload: { prompt: "Label them" } })).toEqual({
			kind: "text",
			label: "Prompt",
			text: "Label them",
		});
		expect(payloadView({ kind: "task", payload: { agentId: "agt_1", prompt: "x", projectId: "p" } }).kind).toBe("json");
	});

	it("reads a check's result as healthy, findings or a failure", () => {
		expect(runState(run({ result: { exitCode: 0, raised: 0 } }), "check")).toEqual({ label: "Healthy", tone: "done" });
		expect(runState(run({ result: { exitCode: 3, raised: 2 } }), "check").label).toBe("2 findings");
		expect(runState(run({ result: { exitCode: 3, raised: 0 } }), "check").label).toBe("Findings, none new");
		expect(runState(run({ status: "failed", result: { exitCode: 2, raised: 0 } }), "check").label).toBe("Failed");
		expect(runDetail(run({ status: "failed", result: { exitCode: 2, raised: 0 } }), "check")).toBe("Exit code 2");
	});

	it("says what a run stood for and which attempt it was", () => {
		expect(runDetail(run({ coalesced: 8, attempt: 2, result: { message: "Sent" } }), "task")).toBe(
			"Sent. Stood for 8 missed runs. Attempt 2",
		);
		expect(runDetail(run({ status: "running" }), "heartbeat")).toBeUndefined();
	});

	it("marks failed runs and checks that found something as problems", () => {
		expect(isProblem(run({ status: "failed" }), "task")).toBe(true);
		expect(isProblem(run({ result: { exitCode: 3, raised: 0 } }), "check")).toBe(true);
		expect(isProblem(run({ result: { exitCode: 0, raised: 0 } }), "check")).toBe(false);
		expect(isProblem(run({ result: { exitCode: 3 } }), "task")).toBe(false);
	});

	it("orders runs newest first", () => {
		const runs = [run({ id: "a", dueAt: 1 }), run({ id: "c", dueAt: 3 }), run({ id: "b", dueAt: 2 })];
		expect(newestFirst(runs).map((occurrence) => occurrence.id)).toEqual(["c", "b", "a"]);
	});

	it("tones severities", () => {
		expect(severityTone("High")).toBe("error");
		expect(severityTone("medium")).toBe("approval");
		expect(severityTone("info")).toBe("neutral");
		expect(severityText("high")).toBe("High");
	});
});

describe("the fixture over the in-memory store", () => {
	it("plays three days of runs into the real store", async () => {
		const scenario = await createSchedulesScenario();
		const { items } = await readPages((page) => scenario.source.list(undefined, page));
		expect(countByStatus(items)).toMatchObject({ active: 8, paused: 1, ended: 2 });

		const disk = await readPages((page) => scenario.source.listOccurrences(scenario.ids.disk, page));
		const states = disk.items.map((occurrence) => runState(occurrence, "check").label);
		expect(states).toContain("Healthy");
		expect(states).toContain("Failed");
		expect(states.some((label) => label.endsWith("finding") || label.endsWith("findings"))).toBe(true);
		const findings = await scenario.source.findings?.(scenario.ids.disk);
		expect(findings?.some((finding) => finding.reason === "failures")).toBe(true);

		const heartbeat = newestFirst(
			(await readPages((page) => scenario.source.listOccurrences(scenario.ids.heartbeat, page))).items,
		);
		expect(heartbeat[0]?.status).toBe("running");
		expect(heartbeat.some((occurrence) => occurrence.coalesced > 1)).toBe(true);

		const next = await scenario.source.preview(scenario.ids.brief, 3);
		expect(next.map((at) => zonedText(at, "Europe/London"))).toEqual([
			"Wed 28 Oct, 08:00",
			"Thu 29 Oct, 08:00",
			"Fri 30 Oct, 08:00",
		]);

		const paused = await scenario.source.resume(scenario.ids.backfill);
		expect(paused.status).toBe("active");
	});

	it("can start empty", async () => {
		const scenario = await createSchedulesScenario({ empty: true });
		expect((await scenario.source.list()).items).toHaveLength(0);
	});

	it("names the session each task run started, from the host's own when it gives them", async () => {
		const scenario = await createSchedulesScenario({ sessions: ["ses_a", "ses_b"] });
		const runs = (await readPages((page) => scenario.source.listOccurrences(scenario.ids.triage, page))).items;
		expect(runs.length).toBeGreaterThan(400);
		const sessions = new Set(runs.map(runSession));
		expect(sessions).toEqual(new Set(["ses_a", "ses_b"]));
		const triage = await scenario.source.get(scenario.ids.triage);
		expect(payloadView(triage)).toMatchObject({ kind: "text", label: "Prompt", agentId: "agt_triage" });

		const made = await createSchedulesScenario();
		const [first] = (await made.source.listOccurrences(made.ids.triage, { limit: 1 })).items;
		expect(first === undefined ? undefined : runSession(first)).toMatch(/^ses_/);
		const disk = (await made.source.listOccurrences(made.ids.disk, { limit: 5 })).items;
		expect(disk.map(runSession)).toEqual(disk.map(() => undefined));
	});

	it("creates, changes and ends through the same source it lists from", async () => {
		const { source } = await createSchedulesScenario({ empty: true });
		const made = await source.create({
			owner: FIXTURE_OWNER,
			kind: "check",
			title: "Disk",
			timezone: "Europe/London",
			repeat: { every: "hours", interval: 1, from: FIXTURE_NOW },
			payload: ["checks/disk.sh"],
		});
		expect((await source.update(made.id, { title: "Disk free" })).title).toBe("Disk free");
		expect((await source.end(made.id)).status).toBe("ended");
		expect((await source.list({ status: "ended" })).items.map((schedule) => schedule.title)).toEqual(["Disk free"]);
	});
});
