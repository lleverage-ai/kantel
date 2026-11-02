import { describe, expect, it } from "vitest";
import {
	environmentStatusText,
	eventText,
	idleText,
	latencyText,
	leaseCountText,
	ownerText,
	powerAction,
	resumeText,
	runningText,
	sortLeases,
} from "./environments-model.ts";
import {
	createEnvironmentsScenario,
	DEV_ENV,
	directory,
	FAILED_ENV,
	FIXTURE_NOW,
	RENDER_ENV,
	SCRATCH_ENV,
} from "./fixtures.ts";

const MINUTE = 60_000;

describe("environmentStatusText", () => {
	it("says running, idle with its countdown, stopped with when, or failed", () => {
		expect(environmentStatusText(DEV_ENV, FIXTURE_NOW)).toBe("Running");
		expect(environmentStatusText(SCRATCH_ENV, FIXTURE_NOW)).toBe("Idle, stops in 9m");
		expect(environmentStatusText({ ...SCRATCH_ENV, idleStopAt: FIXTURE_NOW + 20_000 }, FIXTURE_NOW)).toBe(
			"Idle, stops in under a minute",
		);
		expect(environmentStatusText(RENDER_ENV, FIXTURE_NOW)).toBe("Stopped 1d ago");
		expect(environmentStatusText(FAILED_ENV, FIXTURE_NOW)).toBe("Failed");
	});
});

describe("words", () => {
	it("names the owner, one person's or the whole project's", () => {
		expect(ownerText(DEV_ENV, directory)).toBe("Lleverage project, Tom's sessions");
		expect(ownerText(FAILED_ENV, directory)).toBe("Kantel project, every member's sessions");
	});

	it("counts sessions and times", () => {
		expect(leaseCountText(0)).toBe("No sessions");
		expect(leaseCountText(1)).toBe("1 session");
		expect(leaseCountText(2)).toBe("2 sessions");
		expect(latencyText(850)).toBe("850 ms");
		expect(latencyText(3_420)).toBe("3.4 s");
		expect(latencyText(65_000)).toBe("1m 5s");
		expect(idleText(15 * MINUTE)).toBe("Stops after 15 minutes idle");
		expect(idleText(60 * MINUTE)).toBe("Stops after 1 hour idle");
		expect(runningText(30_000)).toBe("Not run this month");
		expect(runningText(50 * MINUTE)).toBe("50 min this month");
		expect(runningText(3.6 * 60 * MINUTE)).toBe("3.6 h this month");
	});

	it("reports resume latency once there is one", () => {
		expect(resumeText(DEV_ENV)).toBe("Wakes in 3.4 s (median of 12), last 3.1 s");
		expect(resumeText(SCRATCH_ENV)).toBe("Wakes in 2.9 s");
		expect(resumeText(FAILED_ENV)).toBeUndefined();
	});

	it("words history with session titles", () => {
		expect(eventText({ at: 0, kind: "lease.acquired", sessionId: "ses_flaky" }, directory)).toBe(
			"Fix the flaky workflow-engine test attached",
		);
		expect(eventText({ at: 0, kind: "stopped", reason: "idle" }, directory)).toBe("Stopped when idle");
		expect(eventText({ at: 0, kind: "started", durationMs: 3_140 }, directory)).toBe("Started in 3.1 s");
		expect(eventText({ at: 0, kind: "lease.ended", sessionId: "ses_unknown" }, directory)).toBe("A session let go");
	});
});

describe("powerAction", () => {
	it("offers stop when up, start when down or failed, nothing while moving", () => {
		expect(powerAction("running")).toBe("stop");
		expect(powerAction("idle")).toBe("stop");
		expect(powerAction("stopped")).toBe("start");
		expect(powerAction("error")).toBe("start");
		expect(powerAction("starting")).toBeUndefined();
		expect(powerAction("stopping")).toBeUndefined();
		expect(powerAction("destroyed")).toBeUndefined();
	});
});

describe("sortLeases", () => {
	it("keeps live leases, newest first", async () => {
		const source = createEnvironmentsScenario({ delayMs: 0 });
		const detail = await source.get(DEV_ENV.id);
		const sorted = sortLeases([...detail.leases, { ...detail.leases[0]!, id: "gone", endedAt: FIXTURE_NOW }]);
		expect(sorted.map((lease) => lease.sessionId)).toEqual(["ses_tables", "ses_flaky"]);
	});
});

describe("the scenario source", () => {
	it("starts a stopped environment through starting to idle, measuring the start", async () => {
		let clock = FIXTURE_NOW;
		const source = createEnvironmentsScenario({ delayMs: 0, settleMs: 5, now: () => clock });
		expect((await source.start(RENDER_ENV.id)).state).toBe("starting");
		clock += 3_000;
		await new Promise((resolve) => setTimeout(resolve, 20));
		const after = (await source.get(RENDER_ENV.id)).environment;
		expect(after.state).toBe("idle");
		expect(after.resume?.samples).toBe(6);
		expect(after.idleStopAt).toBe(clock + RENDER_ENV.idleTimeoutMs);
	});

	it("stops a running environment and ends its leases", async () => {
		const source = createEnvironmentsScenario({ delayMs: 0, settleMs: 5 });
		expect((await source.stop(DEV_ENV.id)).state).toBe("stopping");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const detail = await source.get(DEV_ENV.id);
		expect(detail.environment.state).toBe("stopped");
		expect(sortLeases(detail.leases)).toEqual([]);
	});

	it("filters by project", async () => {
		const source = createEnvironmentsScenario({ delayMs: 0 });
		expect((await source.list({ projectId: "proj_kantel" })).map((env) => env.alias)).toEqual(["ci", "scratch"]);
	});
});
