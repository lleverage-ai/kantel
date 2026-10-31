/**
 * #332: "A rule deleted through one instance stops the next request through another (both targets)." Two connections
 * services over one database, as two Workers isolates over D1 or two self-hosted gateways over Postgres: nothing caches
 * a rule, so a change through either decides the next request through the other.
 */
import { type ConnectionSessionScope, systemContext } from "@kantel/contracts";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import { memoryCredentials } from "../src/memory.ts";
import { createSqlConnectionsRepository, migrateConnections } from "../src/repository.ts";
import { createConnections } from "../src/service.ts";
import { fakeAccess, human, letEverythingThrough, ORG } from "../src/testing.ts";

const SYSTEM = systemContext("test");
const admin = human("admin");
const scope: ConnectionSessionScope = {
	organisationId: ORG,
	sessionId: "ses_1",
	agentId: "triage",
	actingUserId: "admin",
	audience: { kind: "shared" },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

for (const kind of testDatabaseKinds()) {
	describe(`connection rules across instances on ${kind.name}`, { timeout: kind.testTimeoutMs }, () => {
		it("lets a rule changed through one instance decide the next request through another", async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateConnections(database.driver);
			// The vault is shared too, as both instances reach the same one.
			const credentials = memoryCredentials();
			const sent: string[] = [];
			// One clock for both instances that moves on at each read: uses are listed newest first by time, and two
			// recorded in the same millisecond would come back in their random IDs' order.
			let tick = Date.now();
			const clock = { now: () => (tick += 1) };
			const instance = () =>
				createConnections({
					clock,
					repository: createSqlConnectionsRepository(database.driver),
					credentials,
					access: fakeAccess(["admin"]),
					deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
					fetch: async (url, init) => {
						if (init?.method === "DELETE") sent.push(String(url));
						return new Response("{}", { headers: { "content-type": "application/json" } });
					},
				});
			const one = instance();
			const two = instance();
			const connection = await one.connectKey(admin, {
				owner: { kind: "organisation", organisationId: ORG },
				templateId: "github",
				value: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
				usage: { unattended: true, visibility: "shared" },
			});
			const send = (through: typeof one) =>
				through.send(SYSTEM, scope, connection.id, {
					kind: "http",
					method: "DELETE",
					url: "https://api.github.com/repos/acme/x",
				});

			// No rules, every request allowed, as a connection whose person set it so.
			await letEverythingThrough(one, admin, connection.id);
			// Through `two` first, so it has read the connection and its (empty) rules before the change.
			await send(two);
			expect(sent).toHaveLength(1);
			const rule = await one.createRule(admin, connection.id, {
				who: { kind: "any" },
				what: { kind: "endpoint", method: "DELETE", path: "/repos/**" },
				action: "deny",
			});
			await expect(send(two)).rejects.toMatchObject({ code: "refused" });
			expect(sent).toHaveLength(1);
			// Deleted through `one`: the next request through `two` goes out.
			await one.removeRule(admin, connection.id, rule.id);
			await send(two);
			expect(sent).toHaveLength(2);
			// And the other way round.
			const again = await two.createRule(admin, connection.id, {
				who: { kind: "any" },
				what: { kind: "any" },
				action: "deny",
			});
			await expect(send(one)).rejects.toMatchObject({ code: "refused" });
			await two.removeRule(admin, connection.id, again.id);
			await send(one);
			expect(sent).toHaveLength(3);
			const uses = (await two.listUses(admin, { connectionId: connection.id })).items;
			// Uses made in the same millisecond list in either order; the sends above already show the order.
			expect(uses.map((use) => use.outcome).sort()).toEqual(["allowed", "allowed", "allowed", "denied", "denied"]);
		});

		it("gives a connection made before rules one set of defaults, whichever instance reads it first", async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateConnections(database.driver);
			const credentials = memoryCredentials();
			const sent: string[] = [];
			const repository = createSqlConnectionsRepository(database.driver);
			const instance = () =>
				createConnections({
					repository: createSqlConnectionsRepository(database.driver),
					credentials,
					access: fakeAccess(["admin"]),
					deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
					fetch: async (url, init) => {
						sent.push(`${init?.method ?? "GET"} ${String(url)}`);
						return new Response("{}", { headers: { "content-type": "application/json" } });
					},
				});
			const one = instance();
			const two = instance();
			const connection = await one.connectKey(admin, {
				owner: { kind: "organisation", organisationId: ORG },
				templateId: "github",
				value: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
				usage: { unattended: true, visibility: "shared" },
			});
			// As one made before rules is stored: no rules record.
			await repository.remove("rules", connection.id);
			const request = (method: "GET" | "DELETE") => ({
				kind: "http" as const,
				method,
				url: "https://api.github.com/repos/acme/x",
			});
			const [a, b] = await Promise.all([one.getRules(admin, connection.id), two.getRules(admin, connection.id)]);
			expect(a).toEqual(b);
			expect(a).toMatchObject({ unmatched: "ask", version: 1, defaults: { reason: "migrated" } });
			await one.send(SYSTEM, scope, connection.id, request("GET"));
			await expect(two.send(SYSTEM, scope, connection.id, request("DELETE"))).rejects.toMatchObject({
				code: "refused",
			});
			expect(sent.filter((line) => line.startsWith("DELETE"))).toEqual([]);
		});
	});
}
