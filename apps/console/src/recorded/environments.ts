// The Environments page's stand-in host, in the page: @kantel/ui's environments fixtures for `source=recorded`.
// `source=api` reads `/v1/environments` instead (`api/environments-http.ts`); nothing in src/app changes.

import { createEnvironmentsScenario, directory, FIXTURE_NOW } from "@kantel/ui/environments/fixtures";
import type { ConsoleEnvironments } from "../api/oversight.ts";
import { sessionLinkPath } from "../app/router.ts";

export function createRecordedEnvironments(): ConsoleEnvironments {
	return {
		source: createEnvironmentsScenario(),
		directory,
		// The fixtures' sessions aren't the recorded console's, so a link goes by ID and finds none.
		links: { session: (sessionId) => sessionLinkPath(sessionId) },
		now: FIXTURE_NOW,
	};
}
