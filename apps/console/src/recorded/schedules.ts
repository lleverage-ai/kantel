// The schedules page's stand-in host, in the page: @kantel/ui's schedule fixtures (an in-memory store with three days
// of runs played into it) for `source=recorded`. Each task run names one of the recorded Kantel sessions, so its
// link opens a real session view. Swapped for the public API's schedule routes when the console has a client for
// them; nothing in src/app changes.

import {
	createSchedulesScenario,
	directory,
	FIXTURE_AGENTS,
	FIXTURE_NOW,
	FIXTURE_OWNER,
} from "@kantel/ui/schedules/fixtures";
import type { ConsoleSchedules } from "../api/oversight.ts";

export async function createRecordedSchedules(sessions: readonly string[]): Promise<ConsoleSchedules> {
	const scenario = await createSchedulesScenario({ sessions });
	return {
		source: scenario.source,
		directory,
		form: { agents: FIXTURE_AGENTS, owner: FIXTURE_OWNER, timezone: "Europe/London" },
		// The store's clock stops at the fixture's now, so the page reads from there too.
		now: FIXTURE_NOW,
	};
}
