import { HarbourError } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { createSchedulesScenario, FIXTURE_AGENTS, FIXTURE_NOW, FIXTURE_OWNER } from "../fixtures.ts";
import {
	createScheduleFormFlow,
	draftFromSchedule,
	emptyDraft,
	previewDraft,
	readDraft,
	type ScheduleDraft,
} from "./schedule-form-model.ts";
import { joinCommand, readTaskPayload, splitCommand } from "./schedule-writes.ts";

const MINUTE = 60_000;

const draft = (patch: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
	...emptyDraft({ agents: FIXTURE_AGENTS, timezone: "Europe/London", now: FIXTURE_NOW }),
	...patch,
});

const triage = draft({ title: "Triage new issues", prompt: "  Label the new issues.\n" });

describe("reading a draft", () => {
	it("starts as a task every 10 minutes asking the first agent", () => {
		const fresh = draft();
		expect(fresh).toMatchObject({
			kind: "task",
			agentId: "agt_triage",
			when: "repeat",
			every: "minutes",
			interval: "10",
		});
	});

	it("reads a task every 10 minutes, from now, and keeps the prompt exactly as written", () => {
		const read = readDraft(triage, FIXTURE_NOW);
		expect(read).toEqual({
			ok: true,
			value: {
				title: "Triage new issues",
				timezone: "Europe/London",
				repeat: { every: "minutes", interval: 10, from: FIXTURE_NOW },
				payload: { agentId: "agt_triage", prompt: "  Label the new issues.\n" },
			},
		});
	});

	it("names each wrong field", () => {
		const read = readDraft(
			draft({ title: " ", agentId: "", prompt: " ", every: "week", on: [], at: "9am", timezone: "Mars/Olympus" }),
			FIXTURE_NOW,
		);
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(Object.keys(read.errors).sort()).toEqual(["agentId", "at", "on", "prompt", "timezone", "title"]);
	});

	it("reads a check's command into arguments, with its settings", () => {
		const read = readDraft(
			draft({
				kind: "check",
				title: "Disk",
				command: 'checks/disk.sh --hosts "build 1" --min 15%',
				reraiseHours: "12",
				failuresBeforeRaise: "2",
			}),
			FIXTURE_NOW,
		);
		expect(read.ok && read.value.payload).toEqual(["checks/disk.sh", "--hosts", "build 1", "--min", "15%"]);
		expect(read.ok && read.value.check).toEqual({ reraiseHours: 12, failuresBeforeRaise: 2 });
	});

	it("refuses a one-off in the past and reads one in the future in its time zone", () => {
		expect(readDraft(draft({ ...triage, when: "once", once: "2026-10-01T09:00" }), FIXTURE_NOW).ok).toBe(false);
		const read = readDraft(draft({ ...triage, when: "once", once: "2026-10-30T09:15" }), FIXTURE_NOW);
		// London is on GMT again after 25 Oct.
		expect(read.ok && read.value.at).toBe(Date.UTC(2026, 9, 30, 9, 15));
		expect(read.ok && read.value.repeat).toBeUndefined();
	});

	it("reads weekly days in week order and drops an interval of 1 day", () => {
		const weekly = readDraft(draft({ ...triage, every: "week", at: "16:30", on: ["fri", "mon"] }), FIXTURE_NOW);
		expect(weekly.ok && weekly.value.repeat).toEqual({ every: "week", at: "16:30", on: ["mon", "fri"] });
		const daily = readDraft(draft({ ...triage, every: "day", interval: "1", at: "09:00" }), FIXTURE_NOW);
		expect(daily.ok && daily.value.repeat).toEqual({ every: "day", at: "09:00" });
	});
});

describe("previewing a draft", () => {
	it("lists the next due times with the scheduler's own rules", () => {
		expect(previewDraft(triage, FIXTURE_NOW, 3)).toEqual([
			FIXTURE_NOW,
			FIXTURE_NOW + 10 * MINUTE,
			FIXTURE_NOW + 20 * MINUTE,
		]);
	});

	it("still previews while only the title or prompt is missing", () => {
		expect(previewDraft(draft(), FIXTURE_NOW, 1)).toEqual([FIXTURE_NOW]);
	});

	it("shows nothing while the timing is wrong", () => {
		expect(previewDraft(draft({ every: "week", on: [] }), FIXTURE_NOW, 3)).toBeUndefined();
	});

	it("runs a 09:00 London daily at 09:00 UTC in winter", () => {
		const [first] = previewDraft(draft({ ...triage, every: "day", interval: "1", at: "09:00" }), FIXTURE_NOW, 1) ?? [];
		expect(first).toBe(Date.UTC(2026, 9, 28, 9, 0));
	});
});

describe("the form flow on the fixtures", () => {
	it("creates a task the store accepts, owned by the project, and the page's list reads it", async () => {
		const { source } = await createSchedulesScenario({ empty: true });
		const flow = createScheduleFormFlow({
			writes: source,
			owner: FIXTURE_OWNER,
			draft: triage,
			now: () => FIXTURE_NOW,
		});
		const saved = await flow.save();
		expect(saved).toMatchObject({ kind: "task", status: "active", owner: FIXTURE_OWNER, nextDueAt: FIXTURE_NOW });
		expect(saved?.payload).toEqual({ agentId: "agt_triage", prompt: "  Label the new issues.\n" });
		expect(readTaskPayload(saved?.payload ?? null)?.prompt).toBe("  Label the new issues.\n");
		expect(readTaskPayload({ prompt: "x" })).toEqual({ prompt: "x" });
		expect(readTaskPayload({ agentId: "agt_triage", message: "x" })).toBeUndefined();
		const listed = await source.list();
		expect(listed.items.map((schedule) => schedule.id)).toEqual([saved?.id]);
	});

	it("holds back a save with errors, then clears each as it's fixed", async () => {
		const { source } = await createSchedulesScenario({ empty: true });
		const flow = createScheduleFormFlow({
			writes: source,
			owner: FIXTURE_OWNER,
			draft: draft(),
			now: () => FIXTURE_NOW,
		});
		expect(await flow.save()).toBeUndefined();
		expect(Object.keys(flow.getState().errors).sort()).toEqual(["prompt", "title"]);
		flow.edit({ title: "Triage" });
		expect(Object.keys(flow.getState().errors)).toEqual(["prompt"]);
	});

	it("edits a schedule without moving an interval's start, and switches it to a one-off", async () => {
		const { source, ids } = await createSchedulesScenario();
		const task = await source.get(ids.triage);
		const editing = draftFromSchedule(task, FIXTURE_NOW);
		expect(editing).toMatchObject({ title: task.title, agentId: "agt_triage", every: "minutes", interval: "10" });
		const flow = createScheduleFormFlow({
			writes: source,
			owner: FIXTURE_OWNER,
			draft: { ...editing, title: "Triage every issue" },
			schedule: task,
			now: () => FIXTURE_NOW,
		});
		const saved = await flow.save();
		expect(saved?.title).toBe("Triage every issue");
		expect(saved?.repeat).toEqual(task.repeat);

		const again = createScheduleFormFlow({
			writes: source,
			owner: FIXTURE_OWNER,
			draft: { ...editing, when: "once", once: "2026-10-30T09:15" },
			schedule: saved ?? task,
			now: () => FIXTURE_NOW,
		});
		const once = await again.save();
		expect(once?.repeat).toBeUndefined();
		expect(once?.at).toBe(Date.UTC(2026, 9, 30, 9, 15));
	});

	it("ends a schedule only after the confirmation, and it stays listed as ended", async () => {
		const { source, ids } = await createSchedulesScenario();
		const task = await source.get(ids.triage);
		const flow = createScheduleFormFlow({
			writes: source,
			owner: FIXTURE_OWNER,
			draft: draftFromSchedule(task, FIXTURE_NOW),
			schedule: task,
			now: () => FIXTURE_NOW,
		});
		expect(await flow.end()).toBeUndefined();
		flow.askEnd();
		expect((await flow.end())?.status).toBe("ended");
		const ended = await source.list({ status: "ended" });
		expect(ended.items.map((schedule) => schedule.id)).toContain(ids.triage);
	});

	it("says why the server refused a save", async () => {
		const { source } = await createSchedulesScenario({ empty: true });
		const flow = createScheduleFormFlow({
			writes: { ...source, create: () => Promise.reject(new HarbourError("forbidden", "operator needed")) },
			owner: FIXTURE_OWNER,
			draft: triage,
			now: () => FIXTURE_NOW,
		});
		expect(await flow.save()).toBeUndefined();
		expect(flow.getState()).toMatchObject({ saving: false, problem: { kind: "forbidden" } });
	});
});

describe("commands", () => {
	it("splits on spaces outside quotes and joins back to the same arguments", () => {
		const parts = splitCommand(`checks/x.sh --name "a b" --q 'it''s' --e \\"x`);
		expect(parts).toEqual(["checks/x.sh", "--name", "a b", "--q", "its", "--e", '"x']);
		expect(splitCommand(joinCommand(parts))).toEqual(parts);
		expect(splitCommand(joinCommand(["a", ""]))).toEqual(["a", ""]);
	});
});
