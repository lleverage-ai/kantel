// The Connections page's stand-in host, in the page: @kantel/ui's connections fixtures for `source=recorded`. Swapped
// for the public API's connections routes (`api/connections-http.ts`) when the console talks to a Kantel; nothing in
// src/app changes.

import { createConnectionsScenario, FIXTURE_NOW, PEOPLE, REDIRECT_URI, VIEWER } from "@kantel/ui/connections/fixtures";
import type { ConsoleConnections } from "../api/oversight.ts";

export function createRecordedConnections(): ConsoleConnections {
	return {
		source: createConnectionsScenario({}, VIEWER),
		viewer: VIEWER,
		people: (userId) => PEOPLE[userId],
		redirectUri: REDIRECT_URI,
		now: FIXTURE_NOW,
	};
}
