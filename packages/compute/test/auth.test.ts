// A key's use is recorded at most once a minute, off the call's path, and never over a newer use, a revoke or a
// rotation (STATE-CONTRACT.md §2).
import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX, authenticate } from "../src/auth.ts";
import { createMemoryStore, type StoredApiKey } from "../src/store.ts";
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
