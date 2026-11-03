// The compute plane's records behave the same in memory and on every SQL driver a target uses: records copied in and
// out, `list` oldest first by first insertion, and `update` atomic, so several gateways can share one database.
import { createKantelClient } from "@kantel/api/sdk";
import { pgliteDatabase, testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createSqlComputeStore, migrateComputeStore, sqlCollection } from "../src/sql-store.ts";
import { type Collection, type ComputeStore, createMemoryStore, memoryCollection } from "../src/store.ts";
import { createStubBackend } from "../src/stub-backend.ts";

interface Item {
	readonly id: string;
	readonly group: string;
	readonly done: boolean;
	readonly count: number;
	readonly tags: readonly string[];
}

/** An item as a test may change it behind the store's back. */
type Mutable = { id: string; group: string; done: boolean; count: number; tags: string[] };

const item = (id: string, group = "a", done = false, count = 0): Item => ({ id, group, done, count, tags: [] });

const ids = (records: readonly { readonly id: string }[]) => records.map((record) => record.id);

interface Opened {
	readonly store: ComputeStore;
	readonly items: Collection<Item>;
	/** Runs the migration again; absent in memory. */
	readonly migrate?: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function behaves(open: () => Promise<Opened>, sql: boolean) {
	it("gets, inserts and replaces a record, a replace keeping its place", async () => {
		const { items } = await open();
		await items.put(item("b"));
		await items.put(item("a"));
		await items.put(item("c"));
		expect(await items.get("a")).toEqual(item("a"));
		expect(await items.get("z")).toBeUndefined();
		await items.put({ ...item("a"), count: 5, tags: ["kept"] });
		expect(await items.get("a")).toEqual({ ...item("a"), count: 5, tags: ["kept"] });
		expect(ids(await items.list())).toEqual(["b", "a", "c"]);
	});

	it("lists by string, boolean and number fields, oldest first", async () => {
		const { items } = await open();
		await items.put(item("i1", "a", false));
		await items.put(item("i2", "b", true));
		await items.put(item("i3", "a", true));
		await items.put(item("i4", "a", false, 2));
		expect(ids(await items.list())).toEqual(["i1", "i2", "i3", "i4"]);
		expect(ids(await items.list({ group: "a" }))).toEqual(["i1", "i3", "i4"]);
		expect(ids(await items.list({ done: true }))).toEqual(["i2", "i3"]);
		expect(ids(await items.list({ group: "a", done: false }))).toEqual(["i1", "i4"]);
		expect(ids(await items.list({ count: 2 }))).toEqual(["i4"]);
		expect(ids(await items.list({ group: undefined, done: true }))).toEqual(["i2", "i3"]);
		expect(await items.list({ group: "z" })).toEqual([]);
		// A string never equals a number, though SQL's JSON text of the number is the same.
		expect(await items.list({ count: "2" } as unknown as Partial<Item>)).toEqual([]);
	});

	it("keeps and lists records holding a NUL or a lone surrogate, as a command's output may", async () => {
		const { items } = await open();
		const odd: Item = { ...item("odd"), tags: ["a\u0000b", "\ud800"] };
		await items.put(odd);
		await items.put(item("plain", "b"));
		expect(await items.get("odd")).toEqual(odd);
		expect(await items.list({ group: "a" })).toEqual([odd]);
		expect(ids(await items.list({ group: "b" }))).toEqual(["plain"]);
	});

	it("lists in first-insertion order after replaces, updates and a delete", async () => {
		const { items } = await open();
		for (const id of ["x", "y", "z"]) await items.put(item(id));
		await items.put({ ...item("x"), count: 1 });
		await items.update("y", (current) => ({ ...current, count: 2 }));
		await items.delete("z");
		await items.put(item("w"));
		await items.put(item("z"));
		expect(ids(await items.list())).toEqual(["x", "y", "w", "z"]);
	});

	it("updates the record as it is, and writes nothing for an undefined change or a missing record", async () => {
		const { items } = await open();
		await items.put(item("a", "a", false, 1));
		const seen: Item[] = [];
		const updated = await items.update("a", (current) => {
			seen.push(current);
			return { ...current, count: current.count + 1 };
		});
		expect(seen).toEqual([item("a", "a", false, 1)]);
		expect(updated).toEqual(item("a", "a", false, 2));
		expect(await items.get("a")).toEqual(item("a", "a", false, 2));

		expect(await items.update("a", () => undefined)).toBeUndefined();
		expect(await items.get("a")).toEqual(item("a", "a", false, 2));

		let called = false;
		const missing = await items.update("nope", (current) => {
			called = true;
			return current;
		});
		expect(missing).toBeUndefined();
		expect(called).toBe(false);
		expect(await items.get("nope")).toBeUndefined();
		expect(ids(await items.list())).toEqual(["a"]);
	});

	it("deletes, answering whether there was one", async () => {
		const { items } = await open();
		await items.put(item("a"));
		expect(await items.delete("a")).toBe(true);
		expect(await items.delete("a")).toBe(false);
		expect(await items.delete("never")).toBe(false);
		expect(await items.get("a")).toBeUndefined();
		expect(await items.list()).toEqual([]);
	});

	it("copies records in and out", async () => {
		const { items } = await open();
		const mine: Mutable = { id: "a", group: "a", done: false, count: 0, tags: ["x"] };
		await items.put(mine);
		mine.group = "changed";
		mine.tags.push("y");
		expect(await items.get("a")).toEqual({ ...item("a"), tags: ["x"] });

		const got = (await items.get("a")) as Mutable;
		got.tags.push("z");
		const [listed] = (await items.list()) as Mutable[];
		if (listed !== undefined) listed.count = 99;
		const updated = (await items.update("a", (current) => ({ ...current, done: true }))) as Mutable;
		updated.tags.push("w");
		expect(await items.get("a")).toEqual({ ...item("a"), done: true, tags: ["x"] });
	});

	it("applies concurrent updates of one record each over the last", async () => {
		const { items } = await open();
		await items.put(item("counter"));
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				items.update("counter", (current) => ({ ...current, count: current.count + 1 })),
			),
		);
		expect((await items.get("counter"))?.count).toBe(20);
		expect(results.map((result) => result?.count).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
			Array.from({ length: 20 }, (_, index) => index + 1),
		);
	});

	it("keeps each collection's records apart", async () => {
		const { store } = await open();
		await store.users.put({ id: "x", name: "X", superAdmin: false, personalAccountId: "acc_x", createdAt: 1 });
		expect(await store.accounts.get("x")).toBeUndefined();
		expect(await store.accounts.list()).toEqual([]);
		expect(await store.accounts.delete("x")).toBe(false);
		expect(ids(await store.users.list())).toEqual(["x"]);
	});

	if (sql) {
		it("migrates again over the records it has", async () => {
			const { items, migrate } = await open();
			await items.put(item("a"));
			await migrate?.();
			expect(await items.get("a")).toEqual(item("a"));
		});

		it("refuses to list by a field that isn't a plain name", async () => {
			const { items } = await open();
			await expect(items.list({ "group') OR ('1": "x" } as unknown as Partial<Item>)).rejects.toThrow(/no field/);
		});
	}
}

describe("memory", () => {
	behaves(async () => ({ store: createMemoryStore(), items: memoryCollection<Item>() }), false);
});

for (const kind of testDatabaseKinds()) {
	describe(kind.name, { ...(kind.testTimeoutMs === undefined ? {} : { timeout: kind.testTimeoutMs }) }, () => {
		behaves(async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateComputeStore(database.driver);
			await migrateComputeStore(database.driver);
			return {
				store: createSqlComputeStore(database.driver),
				items: sqlCollection<Item>(database.driver, "items"),
				migrate: () => migrateComputeStore(database.driver),
			};
		}, true);
	});
}

const TOM: PersonIdentity = { userId: "usr_tom", name: "Tom", email: "tom@example.com" };

describe("two compute APIs over one database", {
	...(pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs }),
}, () => {
	it("share keys and sandboxes, as two gateway replicas do", async () => {
		const database = await pgliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		const replica = (): ComputeApi => {
			const api = createComputeApi({
				store: createSqlComputeStore(database.driver),
				backend: createStubBackend(),
				authenticatePerson: async (request) =>
					request.headers.get("authorization") === "Bearer tom-token" ? TOM : undefined,
				fetch: async () => new Response(null, { status: 204 }),
			});
			cleanups.push(() => api.close());
			return api;
		};
		const client = (api: ComputeApi, token: string) =>
			createKantelClient({
				baseUrl: "http://compute.test/v1",
				token,
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
		const first = replica();
		const second = replica();

		const tom = client(first, "tom-token");
		const sandbox = await tom.createSandbox({ wait: true });
		const issued = await tom.createApiKey({ name: "reader", preset: "read-only" });

		const reader = client(second, issued.secret);
		expect((await reader.getCaller()).apiKey?.id).toBe(issued.key.id);
		const seen = await reader.listSandboxes();
		expect(ids(seen.items)).toEqual([sandbox.id]);
		expect(ids((await tom.listSandboxes()).items)).toEqual([sandbox.id]);
	});
});
