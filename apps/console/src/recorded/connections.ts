// The Connections page's stand-in host, in the page: @kantel/ui's connections fixtures for `source=recorded`. Swapped
// for the public API's connections routes (`api/connections-http.ts`) when the console talks to a Kantel; nothing in
// src/app changes.

import {
	createConnectionsScenario,
	createSessionAccessScenario,
	FIXTURE_NOW,
	PEOPLE,
	REDIRECT_URI,
	VIEWER,
} from "@kantel/ui/connections/fixtures";
import type { ConsoleConnections } from "../api/oversight.ts";

export function createRecordedConnections(): ConsoleConnections {
	const source = createConnectionsScenario({}, VIEWER);
	const rules = source.rules;
	return {
		source,
		viewer: VIEWER,
		people: (userId) => PEOPLE[userId],
		redirectUri: REDIRECT_URI,
		now: FIXTURE_NOW,
		// The page's own rules: a rule changed on the Connections page shows in a session's access menu.
		...(rules === undefined
			? {}
			: {
					sessionAccess: (sessionId: string, projectId?: string) => ({
						...createSessionAccessScenario({ sessionId, rules, delay: 0 }),
						...(projectId === undefined ? {} : { projectId }),
					}),
				}),
	};
}
