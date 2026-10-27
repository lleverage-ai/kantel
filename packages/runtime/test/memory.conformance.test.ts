import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { registerRuntimeConformance } from "@harbour/testing/session";
import { describe, expect, it } from "vitest";

registerRuntimeConformance(
	{ describe, expect, it },
	"in-memory session runtime",
	async (deps, use) => {
		const { models, script } = createScriptedModel();
		const memory = createMemoryRuntime({
			clock: deps.clock,
			audit: deps.audit,
			models,
			identity: deps.tenancy.identity,
			sandboxes: {
				releaseSession: async (_ctx, sessionId) => {
					deps.releaseSession(sessionId);
				},
			},
		});
		try {
			await use({
				runtime: memory.runtime,
				directory: memory.directory,
				profiles: memory.profiles,
				hostTools: memory.hostTools,
				model: script,
				releasedSessions: deps.releasedSessions,
				sessionEnd: memory.sessionEnd,
			});
		} finally {
			await memory.close();
		}
	},
	{ projectAccess: true },
);
