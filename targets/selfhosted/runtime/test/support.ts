import { createScriptedModel } from "@kantel/runtime/testing";
import { registerRuntimeConformance } from "@kantel/testing/session";
import { describe, expect, it } from "vitest";
import { createSelfhostedSessionRuntime, type PostgresSessionDatabase } from "../src/index.ts";

/** A fresh schema for one case, as the brief names them: `m1_be1_<random>`. */
export function caseSchema(): string {
	return `m1_be1_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Where a test's databases come from: PGlite, or a real Postgres. */
export interface PostgresTarget {
	/** Opens a facade on the schema; each call is another connection where the target has more than one. */
	open(schema: string): Promise<PostgresSessionDatabase>;
	drop(schema: string): Promise<void>;
}

/**
 * Registers the runtime conformance suite over the target, each case in its own schema, dropped afterwards. The
 * wiring is `packages/runtime/test/sql.conformance.test.ts`'s, with the self-hosted runtime in place of the SQLite one.
 */
export function registerPostgresRuntimeConformance(title: string, target: () => PostgresTarget, skip = false): void {
	registerRuntimeConformance(
		{ describe: describe.skipIf(skip), expect, it },
		title,
		async (deps, use) => {
			const { models, script } = createScriptedModel();
			const schema = caseSchema();
			const database = await target().open(schema);
			try {
				const service = await createSelfhostedSessionRuntime({
					database,
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
				}
			} finally {
				await database.close();
				await target().drop(schema);
			}
		},
		{ projectAccess: true },
	);
}
