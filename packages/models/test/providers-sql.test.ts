import type { ModelProviderId } from "@harbour/contracts";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import { replayModelProviders, type StoredModelProvider } from "@harbour/models/providers";
import { createSqlModelProviderStore, migrateModelProviders } from "@harbour/models/providers-sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { actors, contextFor, ManualClock } from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

const ORG = "org-a";
const OTHER_ORG = "org-b";

function stored(organisationId: string, providerId: ModelProviderId, modelId = "m-1"): StoredModelProvider {
	const owner = { kind: "organisation", organisationId } as const;
	const connectorId = `${organisationId}-${providerId}`;
	return {
		organisationId,
		providerId,
		connector: {
			id: connectorId,
			owner,
			preset: providerId === "anthropic" ? "anthropic" : "openai",
			baseUrl: providerId === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
			vaultItemId: `item-${connectorId}`,
			catalogue: { refresh: "gateway" },
		},
		routes: [
			{ name: providerId, owner, connectorId, modelId },
			{ name: "default", owner, connectorId, modelId },
		],
	};
}

// Postgres (PGlite) and SQLite (node:sqlite, and D1 on Miniflare as Cloudflare runs it).
for (const kind of testDatabaseKinds()) {
	const timeout = kind.testTimeoutMs === undefined ? {} : { timeout: kind.testTimeoutMs };
	describe(`SQL model provider store on ${kind.name}`, timeout, () => {
		it("saves, lists, replaces and removes connections", async () => {
			const database = await kind.open();
			try {
				// Twice: the schema is idempotent.
				await migrateModelProviders(database.driver);
				await migrateModelProviders(database.driver);
				const store = createSqlModelProviderStore(database.driver, { clock: new ManualClock() });
				expect(await store.list()).toEqual([]);

				await store.save(stored(ORG, "openai"));
				await store.save(stored(OTHER_ORG, "anthropic"));
				await store.save(stored(ORG, "anthropic"));
				expect((await store.list()).map((each) => `${each.organisationId}/${each.providerId}`)).toEqual([
					"org-a/anthropic",
					"org-a/openai",
					"org-b/anthropic",
				]);
				expect(await store.list(OTHER_ORG)).toEqual([stored(OTHER_ORG, "anthropic")]);

				const replaced = { ...stored(ORG, "openai", "m-2"), routes: [stored(ORG, "openai", "m-2").routes[0]!] };
				await store.save(replaced);
				expect(await store.list(ORG)).toEqual([stored(ORG, "anthropic"), replaced]);

				await store.remove(ORG, "openai");
				await store.remove(ORG, "openrouter");
				expect((await store.list()).map((each) => `${each.organisationId}/${each.providerId}`)).toEqual([
					"org-a/anthropic",
					"org-b/anthropic",
				]);
			} finally {
				await database.close();
			}
		});

		it("replays what it holds into a fresh directory", async () => {
			const database = await kind.open();
			try {
				await migrateModelProviders(database.driver);
				const store = createSqlModelProviderStore(database.driver);
				await store.save(stored(ORG, "anthropic"));
				await store.save(stored(OTHER_ORG, "openai"));

				const directory = createMemoryModelConnectors();
				expect(await replayModelProviders(directory, store, contextFor(actors.system("replay"), ORG))).toBe(2);
				for (const organisationId of [ORG, OTHER_ORG]) {
					const reader = contextFor(actors.system("check"), organisationId);
					const connectors = (await directory.listConnectors(reader)).items;
					expect(connectors.map((connector) => connector.id)).toEqual([
						organisationId === ORG ? "org-a-anthropic" : "org-b-openai",
					]);
					const routes = (await directory.listRoutes(reader)).items.map((route) => [route.name, route.connectorId]);
					expect(routes).toHaveLength(2);
				}
			} finally {
				await database.close();
			}
		});
	});
}
