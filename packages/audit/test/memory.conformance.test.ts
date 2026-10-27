import { createMemoryAuditOutbox, createMemoryAuditStore } from "@harbour/audit/memory";
import { flakyAuditSink, registerAuditConformance } from "@harbour/testing/audit";
import { describe, expect, it } from "vitest";

registerAuditConformance(
	{ describe, expect, it },
	"in-memory audit store and outbox",
	async (deps, use) => {
		await use({
			store: createMemoryAuditStore({ clock: deps.clock, access: deps.access }),
			outbox: createMemoryAuditOutbox({ clock: deps.clock }),
			flakySink: flakyAuditSink,
		});
	},
	{ projectAccess: true },
);
