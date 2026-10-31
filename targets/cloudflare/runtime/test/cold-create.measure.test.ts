// Cold session create against how many sessions the database has held (#216). The stack Durable Object keeps every
// session's Pi Durable storage in its one SQLite; this replays that in Node: `createSessionRuntime` over
// `DurableObjectSessionDatabase` on the double of the object's `ctx.storage.sql` (`./support-sqlite.ts`, `node:sqlite`
// underneath, a statement prepared per call), with storage and archiving wired as `SessionRuntimeDurableObjectCore`
// wires them. It creates and closes sessions up to each mark, as measurement batches leave them, then times
// `runtime.create` (store row, Pi storage, Harness, root conversation) over the next runs.
//
// A measurement, so it runs only when asked, from `targets/cloudflare/runtime`:
//
//   KANTEL_MEASURE_COLD_CREATE=1 pnpm vitest run test/cold-create.measure.test.ts
//
// with optional KANTEL_MEASURE_MARKS (default 10,1000), KANTEL_MEASURE_RUNS (default 50) and
// KANTEL_MEASURE_DATABASE=node, which runs on chord's Node adapter (`openNodeSqliteDatabase`) as the runtime's own
// tests do. That adapter caches every statement it prepares for good, and SQLite expires every cached statement on each
// schema change, so with per-session table names its DDL slows as sessions pile up whatever the schema's size: it is
// reported, not held to the bound. KANTEL_MEASURE_ARCHIVE=0 keeps closed sessions' tables (as does a checkout without
// `archiveSqlPiStorage`, for a before-and-after comparison); the bound is then reported, not held. Each mark prints one JSON line; the last line is the ratio of the last p50 to the first.
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { AgentProfile, CallContext } from "@kantel/contracts";
import { createSessionRuntime } from "@kantel/runtime/core";
import * as sql from "@kantel/runtime/sql";
import { createScriptedModel } from "@kantel/runtime/testing";
import { describe, expect, it } from "vitest";
import { DurableObjectSessionDatabase } from "../src/index.ts";
import { durableObjectStorageOf } from "./support-sqlite.ts";

const measuring = process.env.KANTEL_MEASURE_COLD_CREATE !== undefined;
const marks = (process.env.KANTEL_MEASURE_MARKS ?? "10,1000").split(",").map(Number);
const runs = Number(process.env.KANTEL_MEASURE_RUNS ?? 50);
const kind = process.env.KANTEL_MEASURE_DATABASE ?? "durable-object";

const ORG = "org-measure";
const ctx: CallContext = { actor: { kind: "service", serviceId: "measure" }, organisationId: ORG };
const profile: AgentProfile = {
	id: "assistant",
	organisationId: ORG,
	name: "Assistant",
	model: { route: "default" },
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const quantile = (values: readonly number[], q: number) => {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
};
const round = (ms: number) => Math.round(ms * 10) / 10;

describe.runIf(measuring)("cold session create (#216)", () => {
	it(`stays within 2x of its p50 at ${marks[0]} sessions held, at ${marks.at(-1)}`, {
		timeout: 3_600_000,
	}, async () => {
		let raw: DatabaseSync | undefined;
		let db: SqliteDatabase;
		if (kind === "node") db = await openNodeSqliteDatabase(":memory:");
		else if (kind === "durable-object") {
			raw = new DatabaseSync(":memory:");
			db = new DurableObjectSessionDatabase(durableObjectStorageOf(raw));
		} else throw new Error(`KANTEL_MEASURE_DATABASE is durable-object or node, not ${kind}`);

		const archive =
			process.env.KANTEL_MEASURE_ARCHIVE === "0" ? undefined : (sql as Partial<typeof sql>).archiveSqlPiStorage;
		const { models } = createScriptedModel();
		const service = createSessionRuntime({
			store: await sql.createSqlSessionStore(db),
			storage: (session) => sql.sqlPiStorage(db, session.id),
			...(archive === undefined ? {} : { archive: (session) => archive(db, session.id) }),
			models,
		});
		await service.profiles.put(ctx, profile);

		let held = 0;
		const create = async () => {
			const started = performance.now();
			const record = await service.runtime.create(ctx, { projectId: "proj", agentId: profile.id });
			const elapsed = performance.now() - started;
			await service.runtime.close(ctx, record.id);
			held++;
			return elapsed;
		};

		const p50s: number[] = [];
		try {
			for (const mark of marks) {
				while (held < mark) await create();
				const times: number[] = [];
				for (let run = 0; run < runs; run++) times.push(await create());
				p50s.push(round(quantile(times, 0.5)));
				console.log(
					JSON.stringify({
						database: kind,
						archive: archive !== undefined,
						held: mark,
						p50: round(quantile(times, 0.5)),
						p95: round(quantile(times, 0.95)),
						min: round(Math.min(...times)),
						max: round(Math.max(...times)),
						runs,
					}),
				);
			}
		} finally {
			await service.close();
			await db.close();
			raw?.close();
		}
		const ratio = round((p50s.at(-1) ?? Number.NaN) / (p50s[0] ?? Number.NaN));
		console.log(JSON.stringify({ ratio, from: marks[0], to: marks.at(-1) }));
		if (kind === "durable-object" && archive !== undefined) expect(ratio).toBeLessThanOrEqual(2);
	});
});
