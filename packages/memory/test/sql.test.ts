import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import type {
	AuditEventInput,
	AuditSink,
	CallContext,
	Memory,
	MemorySnapshot,
	SnapshotConcept,
} from "@kantel/contracts";
import { createMemoryMemory } from "@kantel/memory/memory";
import { createSqlMemory, migrateMemory } from "@kantel/memory/sql";
import type { SqlDriver } from "@kantel/sql";
import { postgresTransactionalDriver } from "@kantel/sql/postgres";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-a";
const human: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: ORG };
const service: CallContext = { actor: { kind: "service", serviceId: "sal-worker" }, organisationId: ORG };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: ORG,
};
const owner = { kind: "organisation", organisationId: ORG } as const;
const NOW = 1_800_000_000_000;
const clock = { now: () => NOW };

function concept(id: string, title: string, statement: string, extra: Partial<SnapshotConcept> = {}): SnapshotConcept {
	return {
		id,
		title,
		statement,
		tags: [],
		scope: { kind: "global" },
		sources: ["sal-memory"],
		setBy: "owner",
		status: "active",
		updatedAt: NOW - 60_000,
		...extra,
	};
}

const snapshot: MemorySnapshot = {
	sourceId: "sal-memory",
	ref: "7fbf30f",
	concepts: [
		concept("personal/timezone", "Times in UK time", "Give Tom times in Europe/London.", { tags: ["profile"] }),
		concept("projects/harbour/deploys", "Deploy windows", "Deploy Kantel on weekday mornings.", {
			tags: ["deploy"],
			extensions: { sal: { learnedFrom: "owner" } },
		}),
		concept("projects/harbour/ci-runner", "CI runner", "Kantel CI runs on the self-hosted runner.", {
			tags: ["ci"],
			setBy: "learned",
		}),
		concept("projects/harbour/old-ci", "Old CI", "Kantel CI ran on GitHub-hosted runners.", {
			status: "superseded",
			supersededBy: "projects/harbour/ci-runner",
		}),
	],
};

function recordingAudit(): AuditSink & { readonly events: AuditEventInput[] } {
	const events: AuditEventInput[] = [];
	return { events, append: async (_ctx, batch) => void events.push(...batch) };
}

const recallRequest = (spaceId: string) => ({ spaceIds: [spaceId], query: "harbour ci deploy windows" });

/** Imports the snapshot, applies one proposal, rejects one and leaves one pending; what a later memory must see. */
async function seed(memory: Memory) {
	const space = await memory.createSpace(human, { owner, name: "Sal memory" });
	const imported = await memory.importSnapshot(service, space.id, snapshot);
	const applied = await memory.propose(agent, space.id, {
		op: "correct",
		concept: { ...concept("projects/harbour/ci-runner", "CI runner", "Kantel CI runs on two self-hosted runners.") },
		expectedVersion: 1,
	});
	await memory.decide(human, applied.id, { outcome: "apply" });
	const rejected = await memory.propose(agent, space.id, {
		op: "remember",
		concept: concept("projects/harbour/lint", "Lint", "Biome lints the code."),
	});
	await memory.decide(human, rejected.id, { outcome: "reject", note: "Not needed" });
	const pending = await memory.propose(agent, space.id, {
		op: "remember",
		concept: concept("projects/harbour/format", "Format", "Biome formats the lockfile after install."),
	});
	return {
		space: imported,
		pending,
		concepts: await memory.listConcepts(human, space.id),
		proposals: await memory.listProposals(human, space.id),
		recall: await memory.recall(agent, recallRequest(space.id)),
		search: await memory.search(agent, { spaceIds: [space.id], query: "ci" }),
		bundle: await memory.exportBundle(human, space.id),
	};
}

async function checkAfterRestart(memory: Memory, seeded: Awaited<ReturnType<typeof seed>>) {
	const spaceId = seeded.space.id;
	expect(await memory.listConcepts(human, spaceId)).toEqual(seeded.concepts);
	expect(await memory.listProposals(human, spaceId)).toEqual(seeded.proposals);
	expect(await memory.recall(agent, recallRequest(spaceId))).toEqual(seeded.recall);
	expect(await memory.search(agent, { spaceIds: [spaceId], query: "ci" })).toEqual(seeded.search);
	expect(await memory.exportBundle(human, spaceId)).toEqual(seeded.bundle);
	expect((await memory.getConcept(human, spaceId, "projects/harbour/ci-runner")).version).toBe(2);
	// The space still holds its snapshot: importing the same ref again changes nothing.
	expect(await memory.importSnapshot(service, spaceId, snapshot)).toEqual(seeded.space);
	// A proposal left pending can be decided after the restart.
	const decided = await memory.decide(human, seeded.pending.id, { outcome: "apply" });
	expect(decided.status).toBe("applied");
	expect((await memory.getConcept(human, spaceId, "projects/harbour/format")).setBy).toBe("learned");
	// A new snapshot drops what it leaves out, and an ID that comes back carries on from its highest version.
	await memory.importSnapshot(service, spaceId, {
		...snapshot,
		ref: "8a1b2c3",
		concepts: snapshot.concepts.slice(0, 2),
	});
	await expect(memory.getConcept(human, spaceId, "projects/harbour/ci-runner")).rejects.toMatchObject({
		code: "not_found",
	});
	await memory.importSnapshot(service, spaceId, { ...snapshot, ref: "9c8d7e6" });
	expect((await memory.getConcept(human, spaceId, "projects/harbour/ci-runner")).version).toBe(3);
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

for (const kind of testDatabaseKinds()) {
	describe(`SQL memory on ${kind.name}`, { timeout: kind.testTimeoutMs }, () => {
		async function open(): Promise<SqlDriver> {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateMemory(database.driver);
			return database.driver;
		}

		it("keeps snapshots, concepts and proposals for a memory opened again over the same database", async () => {
			const driver = await open();
			const seeded = await seed(createSqlMemory({ driver, clock }));
			await migrateMemory(driver);
			await checkAfterRestart(createSqlMemory({ driver, clock }), seeded);
		});

		it("recalls exactly what the in-memory memory recalls from the same writes", async () => {
			const driver = await open();
			const durable = await seed(createSqlMemory({ driver, clock }));
			const reference = await seed(createMemoryMemory({ clock }));
			const withoutIds = (value: unknown) =>
				JSON.parse(
					JSON.stringify(value)
						.replace(/space_[0-9a-f-]{36}/g, "space")
						.replace(/memprop_[0-9a-f-]{36}/g, "p"),
				);
			expect(withoutIds(durable.recall)).toEqual(withoutIds(reference.recall));
			expect(withoutIds(durable.search)).toEqual(withoutIds(reference.search));
			expect(withoutIds(durable.bundle)).toEqual(withoutIds(reference.bundle));
			expect(withoutIds(durable.concepts)).toEqual(withoutIds(reference.concepts));
		});

		it("lets exactly one of two memories on one database apply racing corrections, and serves the winner to both", async () => {
			const driver = await open();
			const audit = recordingAudit();
			const left = createSqlMemory({ driver, clock, audit });
			const right = createSqlMemory({ driver, clock, audit });
			const space = await left.createSpace(human, { owner, name: "Sal memory" });
			await left.importSnapshot(service, space.id, snapshot);
			const correction = (statement: string) =>
				left.propose(human, space.id, {
					op: "correct",
					concept: concept("projects/harbour/deploys", "Deploy windows", statement),
					expectedVersion: 1,
				});
			const first = await correction("Deploy Kantel before ten.");
			const second = await correction("Deploy Kantel after lunch.");
			const before = await right.recall(agent, recallRequest(space.id));
			const results = await Promise.allSettled([
				left.decide(human, first.id, { outcome: "apply" }),
				right.decide(service, second.id, { outcome: "apply" }),
				right.importSnapshot(service, space.id, snapshot),
			]);
			expect(results.slice(0, 2).filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const current = await right.getConcept(human, space.id, "projects/harbour/deploys");
			expect(current.version).toBe(2);
			expect(await left.getConcept(human, space.id, "projects/harbour/deploys")).toEqual(current);
			// The other memory's cached recall index sees the change.
			const after = await right.recall(agent, recallRequest(space.id));
			expect(after.text).not.toEqual(before.text);
			expect(after.text).toContain(current.statement);
			expect(audit.events.filter((event) => event.type === "memory.proposal.applied")).toHaveLength(1);
		});

		it("names the snapshot its recalled concepts came from when an import lands during the recall", async () => {
			const driver = await open();
			const left = createSqlMemory({ driver, clock });
			const space = await left.createSpace(human, { owner, name: "Sal memory" });
			await left.importSnapshot(service, space.id, snapshot);
			const changed: MemorySnapshot = {
				...snapshot,
				ref: "8a1b2c3",
				concepts: [concept("projects/harbour/deploys", "Deploy windows", "Deploy Kantel on Friday evenings.")],
			};
			// The import lands after the recall has read the space, before it reads the concepts.
			let pending: (() => Promise<unknown>) | undefined = () => left.importSnapshot(service, space.id, changed);
			const gated: SqlDriver = {
				dialect: driver.dialect,
				batch: (statements) => driver.batch(statements),
				async query(text, params) {
					if (pending !== undefined && text.includes("memory_concepts")) {
						const run = pending;
						pending = undefined;
						await run();
					}
					return driver.query(text, params);
				},
			};
			const recall = await createSqlMemory({ driver: gated, clock }).recall(agent, recallRequest(space.id));
			expect(pending).toBeUndefined();
			expect(recall.text).toContain("Friday evenings");
			expect(recall.manifest.length).toBeGreaterThan(0);
			expect(recall.manifest.map((entry) => entry.snapshotRef)).toEqual(recall.manifest.map(() => "8a1b2c3"));
		});

		it("pages a space's proposals in order, after others' proposals elsewhere", async () => {
			const driver = await open();
			const memory = createSqlMemory({ driver, clock });
			const one = await memory.createSpace(human, { owner, name: "One" });
			const two = await memory.createSpace(human, { owner, name: "Two" });
			const ids: string[] = [];
			for (let index = 0; index < 5; index += 1) {
				const write = {
					op: "remember" as const,
					concept: concept(`projects/harbour/n${index}`, "N", `Note ${index}.`),
				};
				ids.push((await memory.propose(agent, one.id, write)).id);
				await memory.propose(agent, two.id, write);
			}
			const seen: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await memory.listProposals(human, one.id, undefined, { limit: 2, ...(cursor ? { cursor } : {}) });
				seen.push(...page.items.map((item) => item.id));
				cursor = page.nextCursor;
			} while (cursor !== undefined);
			expect(seen).toEqual(ids);
		});
	});
}

describe("SQL memory across a real restart", () => {
	it("keeps snapshots and proposals when node:sqlite closes and opens its file again", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harbour-memory-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const first = new DatabaseSync(join(dir, "memory.db"));
		await migrateMemory(syncSqliteDriver(first));
		const seeded = await seed(createSqlMemory({ driver: syncSqliteDriver(first), clock }));
		first.close();
		const second = new DatabaseSync(join(dir, "memory.db"));
		cleanups.push(() => second.close());
		await migrateMemory(syncSqliteDriver(second));
		await checkAfterRestart(createSqlMemory({ driver: syncSqliteDriver(second), clock }), seeded);
	});

	it("keeps snapshots and proposals when PGlite closes and opens its data directory again", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harbour-memory-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const first = await PGlite.create(join(dir, "pg"));
		await migrateMemory(postgresTransactionalDriver(first));
		const seeded = await seed(createSqlMemory({ driver: postgresTransactionalDriver(first), clock }));
		await first.close();
		const second = await PGlite.create(join(dir, "pg"));
		cleanups.push(() => second.close());
		await checkAfterRestart(createSqlMemory({ driver: postgresTransactionalDriver(second), clock }), seeded);
	});
});
