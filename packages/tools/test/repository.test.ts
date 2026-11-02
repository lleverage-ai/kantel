// The registry's records behave the same in memory and on every SQL driver a target uses: names unique in an
// organisation, revision-checked changes, tokens found by hash, and a removal taking the server's tokens with it.
import type { ToolServer, ToolServerToken } from "@kantel/contracts";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMemoryToolServerRepository,
	createSqlToolServerRepository,
	migrateToolServers,
	type ToolServerRepository,
} from "../src/repository.ts";

const server = (id: string, name: string, organisationId = "org-a"): ToolServer => ({
	id,
	organisationId,
	name,
	transport: "tunnel",
	disabledTools: [],
	connection: { status: "offline" },
	createdBy: { kind: "human", userId: "ada" },
	createdAt: 10,
	updatedAt: 10,
});

const token = (id: string, toolServerId: string, createdAt: number): ToolServerToken => ({
	id,
	toolServerId,
	prefix: "ktt_abcd",
	createdBy: { kind: "human", userId: "ada" },
	createdAt,
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function behaves(open: () => Promise<ToolServerRepository>) {
	it("keeps a name unique in its organisation, lists by name and checks the revision on a change", async () => {
		const repo = await open();
		expect(await repo.insert(server("ts_2", "warehouse"))).toBe(true);
		expect(await repo.insert(server("ts_3", "warehouse"))).toBe(false);
		expect(await repo.insert(server("ts_2", "other"))).toBe(false);
		expect(await repo.insert(server("ts_4", "warehouse", "org-b"))).toBe(true);
		expect(await repo.insert(server("ts_1", "docs"))).toBe(true);
		expect((await repo.list("org-a")).map((stored) => stored.server.name)).toEqual(["docs", "warehouse"]);
		expect((await repo.byName("org-a", "warehouse"))?.server.id).toBe("ts_2");
		expect(await repo.byName("org-a", "nope")).toBeUndefined();

		const stored = await repo.get("ts_2");
		expect(stored?.revision).toBe(1);
		const edited = { ...server("ts_2", "warehouse"), description: "Warehouse tools" };
		expect(await repo.update(edited, 1)).toBe(true);
		expect(await repo.update({ ...edited, description: "stale" }, 1)).toBe(false);
		expect(await repo.get("ts_2")).toEqual({ server: edited, revision: 2 });
	});

	it("finds a token by its hash, lists a server's oldest first, and removes them with the server", async () => {
		const repo = await open();
		await repo.insert(server("ts_1", "atlas"));
		await repo.insertToken({ token: token("tst_b", "ts_1", 20), organisationId: "org-a", hash: "h2" });
		await repo.insertToken({ token: token("tst_a", "ts_1", 10), organisationId: "org-a", hash: "h1" });
		expect((await repo.tokens("ts_1")).map((stored) => stored.token.id)).toEqual(["tst_a", "tst_b"]);
		expect(await repo.tokenByHash("h2")).toEqual({
			token: token("tst_b", "ts_1", 20),
			organisationId: "org-a",
			hash: "h2",
		});
		await repo.updateToken({ ...token("tst_b", "ts_1", 20), lastUsedAt: 30 });
		expect((await repo.tokenByHash("h2"))?.token.lastUsedAt).toBe(30);
		expect(await repo.removeToken("tst_a")).toBe(true);
		expect(await repo.removeToken("tst_a")).toBe(false);
		await repo.remove("ts_1");
		expect(await repo.get("ts_1")).toBeUndefined();
		expect(await repo.tokens("ts_1")).toEqual([]);
		expect(await repo.tokenByHash("h2")).toBeUndefined();
	});
}

describe("the tool server repository in memory", () => {
	behaves(async () => createMemoryToolServerRepository());
});

for (const kind of testDatabaseKinds()) {
	describe(`the tool server repository on ${kind.name}`, { timeout: kind.testTimeoutMs }, () => {
		behaves(async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateToolServers(database.driver);
			// Twice, as every start does.
			await migrateToolServers(database.driver);
			return createSqlToolServerRepository(database.driver);
		});
	});
}
