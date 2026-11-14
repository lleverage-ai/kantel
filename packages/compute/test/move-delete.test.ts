// A delete and a move of the same sandbox on two gateways (POST /sandboxes/{id}/move, packages/hosts/test/move.test.ts
// for the move itself): a delete that read the sandbox stopped, landing after another gateway's move has begun, is
// refused, and the move is left as it was (`starting` with `moving`, for its gateway or the sweep to settle), never put
// in `deleting` or `error` over it. In memory and in each SQL store (Postgres too, with KANTEL_TEST_POSTGRES_URL).
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import { type ComputeStore, createMemoryStore, type StoredSandbox } from "../src/store.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const STORES: readonly {
	readonly name: string;
	readonly make: () => Promise<ComputeStore>;
	readonly timeout?: number;
}[] = [
	{ name: "in memory", make: async () => createMemoryStore() },
	...testDatabaseKinds().map((kind) => ({
		name: `in ${kind.name}`,
		...(kind.testTimeoutMs === undefined ? {} : { timeout: kind.testTimeoutMs }),
		make: async () => {
			const database = await kind.open();
			closers.push(() => database.close());
			await migrateComputeStore(database.driver);
			return createSqlComputeStore(database.driver);
		},
	})),
];

for (const { name, make, timeout } of STORES) {
	describe(`a delete racing a move ${name}`, timeout === undefined ? {} : { timeout }, () => {
		it("is refused when another gateway's move begins after the delete read the sandbox", async () => {
			const store = await make();
			const api: ComputeApi = createComputeApi({
				store,
				backend: createStubBackend(),
				authenticatePerson: async (request) =>
					PEOPLE[request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""],
				fetch: async () => new Response(null, { status: 204 }),
				publicUrl: "http://compute.test",
			});
			closers.push(() => api.close());
			const root = createKantelClient({
				baseUrl: "http://compute.test/v1",
				token: "root-token",
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
			const made = await root.createSandbox({ type: "microvm", wait: true });
			await root.stopSandbox(made.id, { wait: true });
			// Another gateway's move begins just as this one's delete writes: between its read of the sandbox (stopped,
			// no move) and its write, the record goes `starting` with the move, as `moveStopped` writes it.
			const update = store.sandboxes.update.bind(store.sandboxes);
			let raced = false;
			store.sandboxes.update = async (id, change, expected) => {
				if (!raced && id === made.id) {
					const read = await store.sandboxes.get(id);
					if (read !== undefined && change(read)?.state === "deleting") {
						raced = true;
						await update(id, (latest) => ({
							...latest,
							state: "starting",
							lifecycle: (latest.lifecycle ?? 0) + 1,
							moving: {
								operationId: "mov_other",
								at: Date.now(),
								heartbeatAt: Date.now(),
								phase: "copying",
								from: "stopped",
								before: {},
							},
						}));
					}
				}
				return update(id, change, expected);
			};
			let refused: unknown;
			try {
				await root.deleteSandbox(made.id);
			} catch (error) {
				refused = error;
			}
			expect(raced).toBe(true);
			expect(refused).toBeInstanceOf(KantelApiError);
			expect((refused as KantelApiError).code).toBe("conflict");
			const after = (await store.sandboxes.get(made.id)) as StoredSandbox;
			expect(after.state).toBe("starting");
			expect(after.moving?.operationId).toBe("mov_other");
			expect((await root.getSandbox(made.id)).state).toBe("moving");
		});
	});
}
