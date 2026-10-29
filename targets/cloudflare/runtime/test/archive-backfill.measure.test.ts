// The archive backfill (#216) on a stack object that held sessions before archiving shipped. This replays it in Node, as
// `cold-create.measure.test.ts` does: the double of the object's `ctx.storage.sql` (`./support-sqlite.ts`), sessions
// whose Pi tables stayed when they closed, then `sweepArchive` in the batches the
// core's alarm runs. It prints how long each batch took and the cold create p50 before and after.
//
// A measurement, so it runs only when asked, from `targets/cloudflare/runtime`:
//
//   HARBOUR_MEASURE_BACKFILL=1 pnpm vitest run test/archive-backfill.measure.test.ts
//
// with optional HARBOUR_MEASURE_HELD (default 800), HARBOUR_MEASURE_BATCH (default 5) and HARBOUR_MEASURE_RUNS
// (default 20).
import { DatabaseSync } from "node:sqlite";
import type { AgentProfile, CallContext } from "@harbour/contracts";
import { createSessionRuntime } from "@harbour/runtime/core";
import { archiveSqlPiStorage, createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";
import { createScriptedModel } from "@harbour/runtime/testing";
import { describe, expect, it } from "vitest";
import { DurableObjectSessionDatabase, sessionsWithPiTables } from "../src/index.ts";
import { durableObjectStorageOf } from "./support-sqlite.ts";

const measuring = process.env.HARBOUR_MEASURE_BACKFILL !== undefined;
const held = Number(process.env.HARBOUR_MEASURE_HELD ?? 800);
const batch = Number(process.env.HARBOUR_MEASURE_BATCH ?? 5);
const runs = Number(process.env.HARBOUR_MEASURE_RUNS ?? 20);

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
const summary = (times: readonly number[]) => ({
	p50: round(quantile(times, 0.5)),
	p95: round(quantile(times, 0.95)),
	max: round(Math.max(...times)),
	n: times.length,
});

describe.runIf(measuring)("archive backfill (#216)", () => {
	it(`archives ${held} sessions closed before archiving, ${batch} at a time`, { timeout: 3_600_000 }, async () => {
		const raw = new DatabaseSync(":memory:");
		const db = new DurableObjectSessionDatabase(durableObjectStorageOf(raw));
		const store = await createSqlSessionStore(db);
		const { models } = createScriptedModel();
		// Before: no archiving, so a closed session keeps its tables. (Its tables come from the seeded schema here, the same
		// tables the migrations made then; archiving drops them alike.)
		const old = createSessionRuntime({ store, storage: (session) => sqlPiStorage(db, session.id), models });
		await old.profiles.put(ctx, profile);
		for (let index = 0; index < held; index++) {
			const record = await old.runtime.create(ctx, { projectId: "proj", agentId: profile.id });
			await old.runtime.close(ctx, record.id);
		}
		await old.close();

		const service = createSessionRuntime({
			store,
			storage: (session) => sqlPiStorage(db, session.id),
			archive: (session) => archiveSqlPiStorage(db, session.id),
			unarchived: () => sessionsWithPiTables(db),
			models,
		});
		const creates = async () => {
			const times: number[] = [];
			for (let run = 0; run < runs; run++) {
				const started = performance.now();
				const record = await service.runtime.create(ctx, { projectId: "proj", agentId: profile.id });
				times.push(performance.now() - started);
				await service.runtime.close(ctx, record.id);
			}
			return summary(times);
		};
		try {
			const before = await creates();
			const batches: number[] = [];
			for (;;) {
				const started = performance.now();
				const archived = await service.sweepArchive(batch);
				batches.push(performance.now() - started);
				if (archived < batch) break;
			}
			const after = await creates();
			expect(await sessionsWithPiTables(db)).toEqual([]);
			console.log(JSON.stringify({ held, batch, createBefore: before, batches: summary(batches), createAfter: after }));
		} finally {
			await service.close();
			await db.close();
			raw.close();
		}
	});
});
