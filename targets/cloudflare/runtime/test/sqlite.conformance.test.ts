import { DatabaseSync } from "node:sqlite";
import { createScriptedModel } from "@harbour/runtime/testing";
import { registerRuntimeConformance } from "@harbour/testing/session";
import { describe, expect, it } from "vitest";
import { coreOn } from "./support.ts";

registerRuntimeConformance(
	{ describe, expect, it },
	"session runtime Durable Object core (node:sqlite)",
	async (deps, use) => {
		const { models, script } = createScriptedModel();
		const db = new DatabaseSync(":memory:");
		const core = coreOn(db, models, undefined, {
			clock: deps.clock,
			audit: deps.audit,
			identity: deps.tenancy.identity,
			sandboxes: {
				releaseSession: async (_ctx, sessionId) => {
					deps.releaseSession(sessionId);
				},
			},
		});
		try {
			const service = await core.ready;
			await use({
				runtime: service.runtime,
				directory: service.directory,
				profiles: service.profiles,
				hostTools: service.hostTools,
				model: script,
				releasedSessions: deps.releasedSessions,
				sessionEnd: service.sessionEnd,
			});
		} finally {
			await core.close();
			db.close();
		}
	},
	{ projectAccess: true },
);
