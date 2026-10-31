// The sharing page's stand-in host, in the page: @kantel/ui's sharing fixtures for `source=recorded`. Swapped for the
// public API's sharing routes (`api/sharing-http.ts`) when the console talks to a Kantel; nothing in src/app changes.

import {
	createSharingScenario,
	directory,
	FIXTURE_NOW,
	PROJECTS,
	skillSharingFixtures,
} from "@kantel/ui/sharing/fixtures";
import type { ConsoleSharing } from "../api/oversight.ts";

/** `sharedSkillId`, a Billing skill of the recorded skills page, gets shares and a request to show on its page. */
export function createRecordedSharing(sharedSkillId?: string): ConsoleSharing {
	const extra = sharedSkillId === undefined ? {} : skillSharingFixtures(sharedSkillId, "prj_billing");
	return { source: createSharingScenario(extra), projects: PROJECTS, directory, now: FIXTURE_NOW };
}
