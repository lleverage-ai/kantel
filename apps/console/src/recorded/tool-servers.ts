// The Tool servers page's stand-in host, in the page: @harbour/ui's tool-servers fixtures for `source=recorded`. The
// public API's adapter replaces it once Harbour serves `/v1/tool-servers`; nothing in src/app changes.

import {
	createToolServersScenario,
	FIXTURE_NOW,
	ORGANISATION,
	ORIGIN,
	PROJECTS,
} from "@harbour/ui/tool-servers/fixtures";
import type { ConsoleToolServers } from "../api/oversight.ts";
import { AUDIT_PATH } from "../app/router.ts";

export function createRecordedToolServers(): ConsoleToolServers {
	return {
		source: createToolServersScenario({ auditHref: () => AUDIT_PATH }),
		organisation: ORGANISATION,
		projects: PROJECTS,
		origin: ORIGIN,
		now: FIXTURE_NOW,
	};
}
