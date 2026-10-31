import { runSession } from "@kantel/ui";
import { describe, expect, it } from "vitest";
import { createCatalogue } from "./catalogue.ts";
import { createRecordedSchedules } from "./schedules.ts";

describe("the recorded schedules", () => {
	it("lists the fixture's schedules, and a task's runs name the recorded sessions they link to", async () => {
		const catalogue = createCatalogue(Date.now());
		const harbour = catalogue.sessions
			.filter((session) => session.projectId === "harbour")
			.map((session) => session.id);
		const schedules = await createRecordedSchedules(harbour);
		const listed = await schedules.source.list();
		const triage = listed.items.find((schedule) => schedule.title === "Triage new issues");
		expect(triage?.kind).toBe("task");
		const runs = await schedules.source.listOccurrences(triage?.id ?? "", { limit: 20 });
		const sessions = runs.items.map(runSession);
		expect(sessions.length).toBeGreaterThan(0);
		for (const sessionId of sessions) expect(harbour).toContain(sessionId);
	});

	it("creates a schedule from the form's settings and ends it", async () => {
		const schedules = await createRecordedSchedules([]);
		const owner = schedules.form?.owner;
		if (owner === undefined) throw new Error("no form");
		const made = await schedules.source.create({
			owner,
			kind: "task",
			title: "Ask Triage",
			timezone: "Europe/London",
			repeat: { every: "minutes", interval: 10, from: schedules.now ?? Date.now() },
			payload: { agentId: schedules.form?.agents[0]?.id ?? "", prompt: "Label the new issues." },
		});
		expect(made.status).toBe("active");
		expect((await schedules.source.end(made.id)).status).toBe("ended");
	});
});
