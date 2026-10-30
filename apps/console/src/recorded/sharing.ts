// The sharing page's stand-in host, in the page: @harbour/ui's sharing fixtures for `source=recorded`. Swapped for the
// public API's sharing routes (`api/sharing-http.ts`) when the console talks to a Harbour; nothing in src/app changes.

import { createSharingScenario, directory, FIXTURE_NOW, PROJECTS } from "@harbour/ui/sharing/fixtures";
import type { ConsoleSharing } from "../api/oversight.ts";

export function createRecordedSharing(): ConsoleSharing {
	return { source: createSharingScenario(), projects: PROJECTS, directory, now: FIXTURE_NOW };
}
