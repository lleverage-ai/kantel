// The environment store behaves the same in memory and on every SQL driver a target uses.
import type { Environment, EnvironmentGrant, EnvironmentLease } from "@kantel/contracts";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createSqlEnvironmentStore, migrateEnvironments } from "../src/sql-store.ts";
import { createMemoryEnvironmentStore, type EnvironmentStore, type StoredEnvironment } from "../src/store.ts";

const environment = (id: string, organisationId = "org_a"): Environment => ({
	id,
	organisationId,
	owner: { projectId: "proj_a", userId: "usr_a" },
	name: id,
	alias: "dev",
	provider: "fake",
	size: { name: "default", vcpus: 2, memoryGb: 8, diskGb: 40 },
	definition: { version: 1 },
	sharing: "shared",
	egress: "unmanaged",
	placeholders: true,
	idleTimeoutMs: 900_000,
	state: "idle",
	createdAt: 10,
	createdBy: { kind: "human", userId: "usr_a" },
	updatedAt: 10,
	leaseCount: 0,
	runningMsThisMonth: 0,
});

const stored = (id: string, machineId?: string, organisationId?: string): StoredEnvironment => ({
	environment: environment(id, organisationId),
	...(machineId === undefined ? {} : { machine: { provider: "fake", machineId } }),
	resumeSamples: [1200],
	meter: { month: "2026-11", ms: 0 },
});

const grant = (id: string, environmentId: string, sessionId: string): EnvironmentGrant => ({
	id,
	organisationId: "org_a",
	environmentId,
	sessionId,
	alias: "dev",
	rights: "worktree",
	grantedBy: { kind: "system", component: "environments" },
	createdAt: 10,
	status: "active",
});

const lease = (id: string, sessionId: string, acquiredAt: number, endedAt?: number): EnvironmentLease => ({
	id,
	environmentId: "env_1",
	sessionId,
	grantId: "eng_1",
	worktree: `/home/user/kantel/worktrees/${sessionId}`,
	composeProject: "kt_1",
	portBase: 20_000,
	acquiredAt,
	renewedAt: acquiredAt,
	expiresAt: acquiredAt + 600_000,
	...(endedAt === undefined ? {} : { endedAt, endReason: "released" as const }),
	commands: 0,
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function behaves(open: () => Promise<EnvironmentStore>) {
	it("keeps environments by ID, organisation and machine, and replaces one on put", async () => {
		const store = await open();
		await store.put(stored("env_1", "m_1"));
		await store.put(stored("env_2", undefined, "org_b"));
		expect((await store.get("env_1"))?.resumeSamples).toEqual([1200]);
		expect((await store.byMachine("m_1"))?.environment.id).toBe("env_1");
		expect((await store.list("org_a")).map((s) => s.environment.id)).toEqual(["env_1"]);
		expect((await store.list()).map((s) => s.environment.id)).toEqual(["env_1", "env_2"]);
		await store.put({ ...stored("env_1", "m_2"), environment: { ...environment("env_1"), state: "stopped" } });
		expect((await store.get("env_1"))?.environment.state).toBe("stopped");
		expect(await store.byMachine("m_1")).toBeUndefined();
		expect(await store.get("env_x")).toBeUndefined();
	});

	it("keeps grants and leases by environment and session", async () => {
		const store = await open();
		await store.putGrant(grant("eng_1", "env_1", "ses_a"));
		await store.putGrant({ ...grant("eng_1", "env_1", "ses_a"), status: "revoked" });
		await store.putGrant(grant("eng_2", "env_2", "ses_a"));
		expect((await store.grants("env_1")).map((g) => g.status)).toEqual(["revoked"]);
		expect((await store.sessionGrants("ses_a")).map((g) => g.id)).toEqual(["eng_1", "eng_2"]);
		await store.putLease(lease("enl_1", "ses_a", 100));
		await store.putLease(lease("enl_2", "ses_b", 200));
		await store.putLease(lease("enl_1", "ses_a", 100, 300));
		const leases = await store.leases("env_1");
		expect(leases.map((l) => [l.id, l.endedAt])).toEqual([
			["enl_2", undefined],
			["enl_1", 300],
		]);
		expect((await store.sessionLeases("ses_b")).map((l) => l.id)).toEqual(["enl_2"]);
	});

	it("reads events newest first, as written, up to a limit", async () => {
		const store = await open();
		await store.appendEvent("env_1", { at: 100, kind: "created" });
		await store.appendEvent("env_1", { at: 100, kind: "starting" });
		await store.appendEvent("env_1", { at: 200, kind: "started", durationMs: 900 });
		await store.appendEvent("env_2", { at: 300, kind: "created" });
		expect((await store.events("env_1", 10)).map((e) => e.kind)).toEqual(["started", "starting", "created"]);
		expect((await store.events("env_1", 1)).map((e) => e.kind)).toEqual(["started"]);
	});
}

describe("the environment store in memory", () => {
	behaves(async () => createMemoryEnvironmentStore());
});

for (const kind of testDatabaseKinds()) {
	describe(`the environment store on ${kind.name}`, { timeout: kind.testTimeoutMs }, () => {
		behaves(async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateEnvironments(database.driver);
			await migrateEnvironments(database.driver);
			return createSqlEnvironmentStore(database.driver);
		});
	});
}
