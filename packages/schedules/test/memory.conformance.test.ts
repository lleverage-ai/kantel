import { createMemorySchedules } from "@kantel/schedules/memory";
import { registerSchedulesConformance } from "@kantel/testing/schedules";
import { describe, expect, it } from "vitest";

registerSchedulesConformance(
	{ describe, expect, it },
	"in-memory schedules",
	async (deps, use) => {
		await use({ schedules: createMemorySchedules({ clock: deps.clock, audit: deps.audit, access: deps.access }) });
	},
	{ projectAccess: true },
);
