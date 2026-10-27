// The session runtime's conformance suite on Postgres: the SQL session store (#69) and each session's Pi Durable
// tables, both on `PostgresSqliteDatabase`, the binding the self-hosted gateway runs on. The runtime lane registers the
// same suite on Node SQLite; this is the Postgres registration, against the compose stack's database.
//
// Runs when HARBOUR_TEST_POSTGRES_URL is set (CI's selfhosted job sets it to the compose stack's Postgres); each test
// gets a fresh schema, dropped afterwards.
import { createSessionRuntime } from "@harbour/runtime/core";
import { createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";
import { createScriptedModel } from "@harbour/runtime/testing";
import { registerRuntimeConformance } from "@harbour/testing/session";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { PostgresSqliteDatabase } from "../../src/pi-postgres.ts";

const url = process.env.HARBOUR_TEST_POSTGRES_URL ?? "";

async function dropSchema(schema: string): Promise<void> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
	} finally {
		await client.end();
	}
}

registerRuntimeConformance(
	{ describe: url === "" ? describe.skip : describe, expect, it },
	"session runtime on Postgres (SQL session store and Pi Durable tables)",
	async (deps, use) => {
		const schema = `m1sh_runtime_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
		const { models, script } = createScriptedModel();
		let db: PostgresSqliteDatabase | undefined;
		try {
			const opened = await PostgresSqliteDatabase.open({ connectionString: url, schema });
			db = opened;
			const service = createSessionRuntime({
				store: await createSqlSessionStore(opened),
				storage: (session) => sqlPiStorage(opened, session.id),
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
			await db?.close();
			await dropSchema(schema);
		}
	},
	{ projectAccess: true },
);
