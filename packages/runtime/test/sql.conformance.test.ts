import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createSessionRuntime } from "@harbour/runtime/core";
import { createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";
import { createScriptedModel } from "@harbour/runtime/testing";
import { registerRuntimeConformance } from "@harbour/testing/session";
import { describe, expect, it } from "vitest";

registerRuntimeConformance(
	{ describe, expect, it },
	"session runtime on SQL (Node SQLite)",
	async (deps, use) => {
		const { models, script } = createScriptedModel();
		const db = await openNodeSqliteDatabase(":memory:");
		const service = createSessionRuntime({
			store: await createSqlSessionStore(db),
			storage: (session) => sqlPiStorage(db, session.id),
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
				runtime: service.runtime,
				directory: service.directory,
				profiles: service.profiles,
				hostTools: service.hostTools,
				model: script,
				releasedSessions: deps.releasedSessions,
				sessionEnd: service.sessionEnd,
			});
		} finally {
			await service.close();
			await db.close();
		}
	},
	{ projectAccess: true },
);
