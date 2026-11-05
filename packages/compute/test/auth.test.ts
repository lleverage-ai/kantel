// A key's use is recorded at most once a minute, off the call's path, and never over a newer use, a revoke or a
// rotation (STATE-CONTRACT.md §2).
import { pgliteDatabase } from "@kantel/sql/testing";
import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX, authenticate, ensurePerson } from "../src/auth.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import { type ComputeStore, createMemoryStore, type StoredAccount, type StoredApiKey } from "../src/store.ts";
import { sha256Hex } from "../src/util.ts";

const MINUTE = 60_000;
const T = 1_800_000_000_000;
const secret = `${API_KEY_PREFIX}secret`;

async function withKey(lastUsedAt?: number) {
	const store = createMemoryStore();
	const key: StoredApiKey = {
		id: "key_1",
		accountId: "acc_1",
		name: "agent",
		prefix: secret.slice(0, 8),
		scopes: ["sandboxes:write"],
		createdBy: { kind: "user", id: "usr_1" },
		createdAt: T - 10 * MINUTE,
		ownerUserId: "usr_1",
		secretHash: await sha256Hex(secret),
		...(lastUsedAt === undefined ? {} : { lastUsedAt }),
	};
	await store.apiKeys.put(key);
	return { store, key };
}

const call = () => new Request("https://kantel.test/v1/sandboxes", { headers: { authorization: `Bearer ${secret}` } });
/** Lets the detached write land. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("recording a key's use", () => {
	it("records the first use, and then once a minute", async () => {
		const { store } = await withKey();
		await authenticate(call(), { store, now: T });
		await settled();
		expect((await store.apiKeys.get("key_1"))?.lastUsedAt).toBe(T);
		await authenticate(call(), { store, now: T + MINUTE - 1 });
		await settled();
		expect((await store.apiKeys.get("key_1"))?.lastUsedAt).toBe(T);
		await authenticate(call(), { store, now: T + MINUTE });
		await settled();
		expect((await store.apiKeys.get("key_1"))?.lastUsedAt).toBe(T + MINUTE);
	});

	it("writes once of many calls that saw the use stale, and never over a newer one", async () => {
		const { store } = await withKey(T - MINUTE);
		// Ten calls read the key stale at once (none answers its read until all have read), each a millisecond later than
		// the last.
		const list = store.apiKeys.list.bind(store.apiKeys);
		let reading = 10;
		let allRead!: () => void;
		const barrier = new Promise<void>((resolve) => {
			allRead = resolve;
		});
		store.apiKeys.list = async (where) => {
			const found = await list(where);
			if (--reading === 0) allRead();
			await barrier;
			return found;
		};
		const writes: number[] = [];
		const update = store.apiKeys.update.bind(store.apiKeys);
		store.apiKeys.update = async (id, change, expected) => {
			const written = await update(id, change, expected);
			if (written?.lastUsedAt !== undefined) writes.push(written.lastUsedAt);
			return written;
		};
		await Promise.all(Array.from({ length: 10 }, (_, index) => authenticate(call(), { store, now: T + index })));
		await settled();
		const lastUsedAt = (await store.apiKeys.get("key_1"))?.lastUsedAt;
		expect(lastUsedAt).toBeGreaterThanOrEqual(T);
		expect(new Set(writes).size).toBe(1);
		// An older use, landing after a newer one was recorded, writes nothing.
		await authenticate(call(), { store, now: T - 1 });
		await settled();
		expect((await store.apiKeys.get("key_1"))?.lastUsedAt).toBe(lastUsedAt);
	});

	it("never undoes a revoke that lands before the write", async () => {
		const { store, key } = await withKey(T - MINUTE);
		const get = store.apiKeys.list.bind(store.apiKeys);
		// The call reads the key live; the revoke lands before its write.
		store.apiKeys.list = async (where) => {
			const found = await get(where);
			await store.apiKeys.put({ ...key, revokedAt: T });
			return found;
		};
		await authenticate(call(), { store, now: T });
		await settled();
		const stored = await store.apiKeys.get("key_1");
		expect(stored?.revokedAt).toBe(T);
		expect(stored?.lastUsedAt).toBe(T - MINUTE);
	});
});

describe("a person's record", () => {
	it("takes their email when a later sign-in carries one, and keeps it when one doesn't", async () => {
		// Gateways passed no email before the fix for #657, so people first seen before then have none stored.
		const store = createMemoryStore();
		const first = await ensurePerson(store, { userId: "usr_1", name: "usr_1" }, T);
		expect(first.email).toBeUndefined();
		const later = await ensurePerson(store, { userId: "usr_1", name: "usr_1", email: "ann@example.com" }, T + MINUTE);
		expect(later).toMatchObject({ email: "ann@example.com", personalAccountId: first.personalAccountId });
		expect((await store.users.get("usr_1"))?.email).toBe("ann@example.com");
		expect((await ensurePerson(store, { userId: "usr_1", name: "usr_1" }, T + 2 * MINUTE)).email).toBe(
			"ann@example.com",
		);
	});

	it("is named by their name, else their email, and their personal account with them", async () => {
		const store = createMemoryStore();
		const named = await ensurePerson(store, { userId: "usr_1", name: "Ann", email: "ann@example.com" }, T);
		expect(named.name).toBe("Ann");
		expect((await store.accounts.get(named.personalAccountId))?.name).toBe("Ann");
		const unnamed = await ensurePerson(store, { userId: "usr_2", name: "usr_2", email: "bob@example.com" }, T);
		expect(unnamed.name).toBe("bob@example.com");
		expect((await store.accounts.get(unnamed.personalAccountId))?.name).toBe("bob@example.com");
		expect((await ensurePerson(store, { userId: "usr_3", name: "" }, T)).name).toBe("usr_3");
	});

	it("never has a real name overwritten by a sign-in that carries only their user ID or nothing", async () => {
		const store = createMemoryStore();
		await ensurePerson(store, { userId: "usr_1", name: "Ann", email: "ann@example.com" }, T);
		for (const name of ["usr_1", "", "  "]) {
			const again = await ensurePerson(store, { userId: "usr_1", name, email: "ann@example.com" }, T + MINUTE);
			expect(again.name).toBe("Ann");
		}
		expect((await store.users.get("usr_1"))?.name).toBe("Ann");
		// A name sign-in does give replaces it.
		expect((await ensurePerson(store, { userId: "usr_1", name: "Ann Lee" }, T + 2 * MINUTE)).name).toBe("Ann Lee");
	});

	it("mends a record that was named by its user ID, and its personal account, on the next sign-in", async () => {
		// Before the fix every gateway passed the user ID as the name, and each sign-in wrote it back.
		const store = createMemoryStore();
		const legacy = await ensurePerson(store, { userId: "usr_1", name: "usr_1" }, T);
		expect(legacy.name).toBe("usr_1");
		const mended = await ensurePerson(store, { userId: "usr_1", name: "usr_1", email: "ann@example.com" }, T + MINUTE);
		expect(mended.name).toBe("ann@example.com");
		expect((await store.accounts.get(legacy.personalAccountId))?.name).toBe("ann@example.com");
		// A real name later replaces the email that stood in for it, on the account too.
		await ensurePerson(store, { userId: "usr_1", name: "Ann", email: "ann@example.com" }, T + 2 * MINUTE);
		expect((await store.users.get("usr_1"))?.name).toBe("Ann");
		expect((await store.accounts.get(legacy.personalAccountId))?.name).toBe("Ann");
	});

	it("leaves a personal account its person renamed alone", async () => {
		const store = createMemoryStore();
		const user = await ensurePerson(store, { userId: "usr_1", name: "Ann" }, T);
		const account = await store.accounts.get(user.personalAccountId);
		if (account === undefined) throw new Error("no personal account");
		await store.accounts.put({ ...account, name: "Ann's sandboxes" });
		await ensurePerson(store, { userId: "usr_1", name: "Ann Lee" }, T + MINUTE);
		expect((await store.accounts.get(user.personalAccountId))?.name).toBe("Ann's sandboxes");
	});

	it.each([
		["memory", async () => ({ store: createMemoryStore(), close: async () => undefined })],
		[
			"SQL",
			async () => {
				const database = await pgliteDatabase.open();
				await migrateComputeStore(database.driver);
				return { store: createSqlComputeStore(database.driver), close: () => database.close() };
			},
		],
	] as const)(
		"keeps a name its person saves while a sign-in renames their personal account (%s)",
		async (_kind, open) => {
			const { store: inner, close } = await open();
			try {
				const legacy = await ensurePerson(inner, { userId: "usr_1", name: "usr_1" }, T);
				// Between the sign-in deciding to rename the account and its write, the person saves a name of their own.
				let raced = false;
				const race = async () => {
					if (raced) return;
					raced = true;
					await inner.accounts.update(legacy.personalAccountId, (current) => ({ ...current, name: "Ann's sandboxes" }));
				};
				const accounts = {
					...inner.accounts,
					put: async (record: StoredAccount) => {
						await race();
						return inner.accounts.put(record);
					},
					update: async (
						id: string,
						change: (current: StoredAccount) => StoredAccount | undefined,
						expected?: StoredAccount,
					) => {
						await race();
						return inner.accounts.update(id, change, expected);
					},
				};
				const store: ComputeStore = { ...inner, accounts };
				await ensurePerson(store, { userId: "usr_1", name: "Ann", email: "ann@example.com" }, T + MINUTE);
				expect(raced).toBe(true);
				expect((await inner.users.get("usr_1"))?.name).toBe("Ann");
				expect((await inner.accounts.get(legacy.personalAccountId))?.name).toBe("Ann's sandboxes");
			} finally {
				await close();
			}
		},
		pgliteDatabase.testTimeoutMs,
	);

	it("is signed in under their name, else their email, never a user ID while either is known", async () => {
		const store = createMemoryStore();
		const request = new Request("http://compute.test/v1/me", { headers: { authorization: "Bearer person" } });
		const principal = await authenticate(request, {
			store,
			now: T,
			authenticatePerson: async () => ({ userId: "usr_1", name: "usr_1", email: "ann@example.com" }),
		});
		expect(principal).toMatchObject({ kind: "person", name: "ann@example.com" });
	});
});
