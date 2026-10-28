import { type CallContext, systemContext } from "@harbour/contracts";
import { createSqlSchedules, migrateSchedules } from "@harbour/schedules/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { ManualClock } from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

const HOUR = 3_600_000;
const WORKER = systemContext("scheduler");
/** D1 in Miniflare takes about 15 ms a statement, so the race is kept small. */
const SCHEDULES = 6;
const ROUNDS = 2;
const human: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-a" };

for (const kind of testDatabaseKinds()) {
	describe(`SQL schedules on ${kind.name}`, () => {
		it("runs its migrations again without harm", async () => {
			const database = await kind.open();
			try {
				await migrateSchedules(database.driver);
				await migrateSchedules(database.driver);
				const schedules = createSqlSchedules({ driver: database.driver });
				expect((await schedules.list(human)).items).toEqual([]);
			} finally {
				await database.close();
			}
		});

		it("three schedulers and ten runners racing materialise and claim each occurrence exactly once", async () => {
			const database = await kind.open();
			try {
				await migrateSchedules(database.driver);
				const clock = new ManualClock(Date.parse("2026-10-28T09:00:00Z"));
				const hosts = [0, 1, 2].map(() => createSqlSchedules({ driver: database.driver, clock }));
				const [first] = hosts;
				for (let index = 0; index < SCHEDULES; index += 1) {
					await first!.create(human, {
						owner: { kind: "organisation", organisationId: "org-a" },
						kind: "task",
						title: `Job ${index}`,
						timezone: "Europe/London",
						repeat: { every: "hours", interval: 1, from: clock.now() + HOUR },
						payload: null,
					});
				}
				for (let round = 1; round <= ROUNDS; round += 1) {
					clock.advance(HOUR);
					const ticks = await Promise.all(hosts.flatMap((host) => [host.tick(WORKER), host.tick(WORKER)]));
					const created = ticks.flat();
					expect(created).toHaveLength(SCHEDULES);
					expect(new Set(created.map((occurrence) => occurrence.id)).size).toBe(SCHEDULES);
					const claims = await Promise.all(
						Array.from({ length: 10 }, (_, index) => hosts[index % 3]!.claim(WORKER, `runner-${index}`, 60_000)),
					);
					const held = claims.filter((claim) => claim !== undefined);
					expect(held).toHaveLength(SCHEDULES);
					expect(new Set(held.map((claim) => claim.id)).size).toBe(SCHEDULES);
					await Promise.all(
						held.map((claim, index) =>
							hosts[index % 3]!.complete(WORKER, claim.id, claim.claimedBy!, { status: "succeeded" }),
						),
					);
				}
				const listed = await first!.list(human, undefined, { limit: 5 });
				expect(listed.items).toHaveLength(5);
				for (const schedule of listed.items) {
					expect(schedule.occurrences).toBe(ROUNDS);
					expect((await first!.listOccurrences(human, schedule.id)).items.map((run) => run.status)).toEqual(
						Array(ROUNDS).fill("succeeded"),
					);
				}
			} finally {
				await database.close();
			}
		}, 60_000);
	});
}
