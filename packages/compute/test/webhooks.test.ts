import type { computeSchema } from "@kantel/api";
import type { SqlDriver } from "@kantel/sql";
import { type TestDatabaseKind, testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import { type ComputeStore, createMemoryStore, type StoredWebhook } from "../src/store.ts";
import {
	createWebhookDispatcher,
	DISABLE_AFTER_FAILURES,
	deliveryId,
	newWebhookSecret,
	OUTBOX_GRACE_MS,
	RETRY_DELAYS_MS,
	signWebhook,
	verifyWebhook,
	type WebhookDispatcher,
} from "../src/webhooks.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const NOW = Date.UTC(2026, 10, 3, 12);
const TIMESTAMP = Math.floor(NOW / 1000);
const BODY = JSON.stringify({ id: "evt_1", type: "sandbox.running" });

async function signed(secret: string, body = BODY) {
	return {
		"webhook-id": "evt_1",
		"webhook-timestamp": String(TIMESTAMP),
		"webhook-signature": await signWebhook(secret, "evt_1", TIMESTAMP, body),
	};
}

describe("signing", () => {
	it("matches the Standard Webhooks reference signature", async () => {
		const signature = await signWebhook(
			"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
			"msg_p5jXN8AQM9LWM0D4loKWxJek",
			1614265330,
			'{"test": 2432232314}',
		);
		expect(signature).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
	});

	it("verifies what it signs, from a record or Headers", async () => {
		const secret = newWebhookSecret();
		expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
		const headers = await signed(secret);
		expect(headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
		expect(await verifyWebhook(secret, headers, BODY, { now: NOW })).toBe(true);
		expect(await verifyWebhook(secret, new Headers(headers), BODY, { now: NOW })).toBe(true);
	});

	it("refuses a tampered body, ID or signature, and another secret", async () => {
		const secret = newWebhookSecret();
		const headers = await signed(secret);
		expect(await verifyWebhook(secret, headers, `${BODY} `, { now: NOW })).toBe(false);
		expect(await verifyWebhook(secret, { ...headers, "webhook-id": "evt_2" }, BODY, { now: NOW })).toBe(false);
		expect(await verifyWebhook(secret, { ...headers, "webhook-signature": "v1,AAAA" }, BODY, { now: NOW })).toBe(false);
		expect(await verifyWebhook(newWebhookSecret(), headers, BODY, { now: NOW })).toBe(false);
		const { "webhook-signature": _dropped, ...unsigned } = headers;
		expect(await verifyWebhook(secret, unsigned, BODY, { now: NOW })).toBe(false);
	});

	it("refuses a timestamp outside the tolerance", async () => {
		const secret = newWebhookSecret();
		const headers = await signed(secret);
		expect(await verifyWebhook(secret, headers, BODY, { now: NOW + 299_000 })).toBe(true);
		expect(await verifyWebhook(secret, headers, BODY, { now: NOW + 301_000 })).toBe(false);
		expect(await verifyWebhook(secret, headers, BODY, { now: NOW - 301_000 })).toBe(false);
		expect(await verifyWebhook(secret, headers, BODY, { now: NOW + 301_000, toleranceSeconds: 600 })).toBe(true);
	});

	it("takes any of several signatures, as during a rotation", async () => {
		const secret = newWebhookSecret();
		const headers = await signed(secret);
		const both = { ...headers, "webhook-signature": `v1,bm90IGl0 ${headers["webhook-signature"]}` };
		expect(await verifyWebhook(secret, both, BODY, { now: NOW })).toBe(true);
	});
});

interface Sent {
	readonly url: string;
	readonly headers: Headers;
	readonly body: string;
}

async function dispatcherWith(statuses: readonly number[]) {
	const store = createMemoryStore();
	const clock = { now: NOW };
	const secret = newWebhookSecret();
	const webhook: StoredWebhook = {
		id: "whk_1",
		accountId: "acc_1",
		name: "hook",
		url: "https://hooks.example/in",
		events: ["sandbox.running"],
		enabled: true,
		createdAt: NOW,
		secret,
		consecutiveFailures: 0,
	};
	await store.webhooks.put(webhook);
	const sent: Sent[] = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		sent.push({ url: request.url, headers: request.headers, body: await request.text() });
		return new Response("", { status: statuses[sent.length - 1] ?? statuses[statuses.length - 1] ?? 200 });
	};
	const dispatcher = createWebhookDispatcher({ store, fetch: fakeFetch, now: () => clock.now });
	return { store, clock, secret, sent, dispatcher, fetch: fakeFetch };
}

const event: computeSchema.Event = {
	id: "evt_1",
	type: "sandbox.running",
	accountId: "acc_1",
	createdAt: NOW,
	sandboxId: "sbx_1",
	data: { name: "brave-otter", state: "running" },
};

describe("the dispatcher", () => {
	it("retries after a 500 and then delivers, signed", async () => {
		const { store, clock, secret, sent, dispatcher } = await dispatcherWith([500, 200]);
		const [queued] = await dispatcher.enqueue(event);
		expect(queued?.state).toBe("pending");
		const id = queued?.id ?? "";

		await dispatcher.drain();
		expect(sent).toHaveLength(1);
		expect(await store.deliveries.get(id)).toMatchObject({
			state: "pending",
			attempts: 1,
			lastStatus: 500,
			nextAttemptAt: NOW + 5_000,
		});

		clock.now += 4_000;
		await dispatcher.drain();
		expect(sent).toHaveLength(1);

		clock.now += 1_000;
		await dispatcher.drain();
		expect(sent).toHaveLength(2);
		expect(await store.deliveries.get(id)).toMatchObject({
			state: "delivered",
			attempts: 2,
			lastStatus: 200,
			deliveredAt: clock.now,
		});

		const delivered = sent[1];
		expect(delivered?.url).toBe("https://hooks.example/in");
		expect(delivered?.headers.get("webhook-id")).toBe("evt_1");
		expect(JSON.parse(delivered?.body ?? "{}")).toEqual(event);
		const verified = await verifyWebhook(secret, delivered?.headers ?? new Headers(), delivered?.body ?? "", {
			now: clock.now,
		});
		expect(verified).toBe(true);
		const webhook = await store.webhooks.get("whk_1");
		expect(webhook?.lastDelivery).toEqual({ at: clock.now, ok: true, status: 200 });
		expect(webhook?.consecutiveFailures).toBe(0);
	});

	it("sends a delivery once when two dispatchers (two gateways) share the store", async () => {
		const { store, clock, sent, dispatcher, fetch } = await dispatcherWith([200]);
		const other = createWebhookDispatcher({ store, fetch, now: () => clock.now });
		const [queued] = await dispatcher.enqueue(event);
		await Promise.all([dispatcher.drain(), other.drain()]);
		expect(sent).toHaveLength(1);
		expect(await store.deliveries.get(queued?.id ?? "")).toMatchObject({ state: "delivered", attempts: 1 });
		await Promise.all([dispatcher.drain(), other.drain()]);
		expect(sent).toHaveLength(1);
	});

	it("queues a delivery only once its event is stored, and none if storing it fails", async () => {
		const { store, dispatcher } = await dispatcherWith([200]);
		let store_!: () => void;
		const written = new Promise<void>((resolve) => {
			store_ = resolve;
		});
		const queuing = dispatcher.enqueue(event, written);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(await store.deliveries.list()).toEqual([]);
		store_();
		expect(await queuing).toHaveLength(1);

		const failed = Promise.reject(new Error("the event wasn't stored"));
		await expect(dispatcher.enqueue({ ...event, id: "evt_2" }, failed)).rejects.toThrow("wasn't stored");
		expect(await store.deliveries.list({ eventId: "evt_2" })).toEqual([]);
	});

	it("queues nothing for an event type the webhook doesn't take", async () => {
		const { dispatcher } = await dispatcherWith([200]);
		expect(await dispatcher.enqueue({ ...event, type: "sandbox.stopped" })).toEqual([]);
		expect(await dispatcher.enqueue({ ...event, accountId: "acc_2" })).toEqual([]);
	});

	it("fails a delivery after every attempt, and disables the webhook after repeated failures", async () => {
		const { store, clock, sent, dispatcher } = await dispatcherWith([500]);
		for (let round = 0; round < DISABLE_AFTER_FAILURES; round++) {
			const [queued] = await dispatcher.enqueue({ ...event, id: `evt_${round}` });
			await dispatcher.drain();
			for (const delay of RETRY_DELAYS_MS) {
				clock.now += delay;
				await dispatcher.drain();
			}
			expect((await store.deliveries.get(queued?.id ?? ""))?.state).toBe("failed");
		}
		expect(sent).toHaveLength(DISABLE_AFTER_FAILURES * (RETRY_DELAYS_MS.length + 1));
		const webhook = await store.webhooks.get("whk_1");
		expect(webhook?.enabled).toBe(false);
		expect(webhook?.consecutiveFailures).toBe(DISABLE_AFTER_FAILURES);
		expect(await dispatcher.enqueue({ ...event, id: "evt_after" })).toEqual([]);
	});
});

/**
 * A fresh SQL store over `kind`; with `interrupt.next` set, its next batch fails after its own statements have run, so
 * the transaction rolls them back (as `sticky-disks.test.ts`'s).
 */
async function sqlStore(kind: TestDatabaseKind, interrupt: { next: boolean }): Promise<ComputeStore> {
	const database = await kind.open();
	cleanups.push(() => database.close());
	await migrateComputeStore(database.driver);
	const driver: SqlDriver = {
		dialect: database.driver.dialect,
		query: (text, params) => database.driver.query(text, params),
		async batch(statements) {
			if (!interrupt.next) return database.driver.batch(statements);
			interrupt.next = false;
			await database.driver.batch([...statements, { sql: "SELECT no_such_column FROM no_such_table" }]);
		},
	};
	return createSqlComputeStore(driver);
}

/**
 * A gateway over `store` that dies at `dies`: after the event's write has landed, or after its deliveries are queued
 * and before its outbox record is cleared. From then on, everything it writes fails.
 */
function dyingGateway(store: ComputeStore, dies: "after the event" | "after its deliveries"): ComputeStore {
	let dead = false;
	const died = async (): Promise<never> => {
		throw new Error("the gateway died");
	};
	return {
		...store,
		eventWrites: {
			async put(event) {
				await store.eventWrites.put(event);
				if (dies === "after the event") dead = true;
			},
		},
		deliveries: {
			...store.deliveries,
			insert: async (delivery) => (dead ? died() : store.deliveries.insert(delivery)),
		},
		eventOutbox: {
			...store.eventOutbox,
			delete: async (id) => (dead || dies === "after its deliveries" ? died() : store.eventOutbox.delete(id)),
		},
	};
}

/** What `emit` in `service.ts` does with an event: its write, with its deliveries queued once it has landed. */
async function emit(store: ComputeStore, dispatcher: WebhookDispatcher, stored = event) {
	const written = store.eventWrites.put(stored);
	await Promise.all([written, dispatcher.enqueue(stored, written).catch(() => undefined)]);
}

const STORES: readonly { readonly name: string; readonly kind?: TestDatabaseKind }[] = [
	{ name: "the memory store" },
	// Postgres too, where KANTEL_TEST_POSTGRES_URL names one.
	...testDatabaseKinds().map((kind) => ({ name: `a SQL store on ${kind.name}`, kind })),
];

for (const each of STORES) {
	const timeout = each.kind?.testTimeoutMs === undefined ? {} : { timeout: each.kind.testTimeoutMs };
	const interrupt = { next: false };
	const open = (): Promise<ComputeStore> =>
		each.kind === undefined ? Promise.resolve(createMemoryStore()) : sqlStore(each.kind, interrupt);

	/** A store with two webhooks that take `sandbox.running`, and dispatchers sending to a fake endpoint. */
	async function setUp() {
		const store = await open();
		const clock = { now: NOW };
		const secret = newWebhookSecret();
		const hook = (id: string): StoredWebhook => ({
			id,
			accountId: "acc_1",
			name: id,
			url: `https://hooks.example/${id}`,
			events: ["sandbox.running"],
			enabled: true,
			createdAt: NOW,
			secret,
			consecutiveFailures: 0,
		});
		await store.webhooks.put(hook("whk_1"));
		await store.webhooks.put(hook("whk_2"));
		const sent: Sent[] = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			sent.push({ url: request.url, headers: request.headers, body: await request.text() });
			return new Response("", { status: 200 });
		};
		const dispatcherOver = (over: ComputeStore) =>
			createWebhookDispatcher({ store: over, fetch: fakeFetch, now: () => clock.now });
		return { store, clock, secret, sent, hook, dispatcherOver };
	}

	describe(`an event's webhooks in ${each.name}`, timeout, () => {
		it("are delivered by a fresh dispatcher when the gateway died between storing the event and queueing them", async () => {
			const { store, clock, secret, sent, dispatcherOver } = await setUp();
			const gateway = dyingGateway(store, "after the event");
			await emit(gateway, dispatcherOver(gateway));
			expect(await store.events.get(event.id)).toEqual(event);
			expect(await store.deliveries.list()).toEqual([]);
			expect(await store.eventOutbox.get(event.id)).toMatchObject({ id: event.id, accountId: "acc_1" });

			// Two fresh gateways leave it to the one that stored it for the grace period, then queue it once between them.
			const [b, c] = [dispatcherOver(store), dispatcherOver(store)];
			await Promise.all([b.drain(), c.drain()]);
			expect(sent).toEqual([]);
			clock.now += OUTBOX_GRACE_MS;
			await Promise.all([b.drain(), c.drain()]);
			expect(sent.map((one) => one.url).sort()).toEqual(["https://hooks.example/whk_1", "https://hooks.example/whk_2"]);
			expect(await store.eventOutbox.get(event.id)).toBeUndefined();
			// Signed with the event's ID as `webhook-id`, as before the crash, so a receiver drops a duplicate by it.
			for (const one of sent) {
				expect(one.headers.get("webhook-id")).toBe(event.id);
				expect(JSON.parse(one.body)).toEqual(event);
				expect(await verifyWebhook(secret, one.headers, one.body, { now: clock.now })).toBe(true);
			}
			const delivered = await store.deliveries.list({ eventId: event.id });
			expect(delivered.map((delivery) => delivery.state)).toEqual(["delivered", "delivered"]);

			// Nothing more later, or when it is queued again.
			clock.now += OUTBOX_GRACE_MS;
			expect(await b.enqueue(event)).toEqual([]);
			await Promise.all([b.drain(), c.drain()]);
			expect(sent).toHaveLength(2);
		});

		it("are queued once when the gateway died after queueing them, before clearing the outbox", async () => {
			const { store, clock, sent, dispatcherOver } = await setUp();
			const gateway = dyingGateway(store, "after its deliveries");
			await emit(gateway, dispatcherOver(gateway));
			expect(await store.deliveries.list({ eventId: event.id })).toHaveLength(2);
			expect(await store.eventOutbox.get(event.id)).toBeDefined();
			clock.now += OUTBOX_GRACE_MS;
			await dispatcherOver(store).drain();
			expect(await store.eventOutbox.get(event.id)).toBeUndefined();
			expect(await store.deliveries.list({ eventId: event.id })).toHaveLength(2);
			expect(sent).toHaveLength(2);
		});

		it("are queued once for an event stored again under its ID", async () => {
			const { store, sent, dispatcherOver } = await setUp();
			const dispatcher = dispatcherOver(store);
			await emit(store, dispatcher);
			await emit(store, dispatcher, { ...event, createdAt: NOW + 1 });
			const queued = await store.deliveries.list({ eventId: event.id });
			expect(queued.map((delivery) => delivery.id).sort()).toEqual(
				[await deliveryId(event.id, "whk_1"), await deliveryId(event.id, "whk_2")].sort(),
			);
			expect(await store.eventOutbox.get(event.id)).toBeUndefined();
			await dispatcher.drain();
			await dispatcher.drain();
			expect(sent).toHaveLength(2);
		});

		it("are recorded in the outbox only for an event a webhook wants", async () => {
			const { store, hook, dispatcherOver } = await setUp();
			// An account whose ID starts with this one's, and a disabled webhook: neither wants the events below.
			await store.webhooks.put({ ...hook("whk_3"), accountId: "acc_10", events: ["sandbox.stopped"] });
			await store.webhooks.put({ ...hook("whk_4"), events: ["sandbox.paused"], enabled: false });
			for (const unwanted of [
				{ ...event, id: "evt_stopped", type: "sandbox.stopped" as const },
				{ ...event, id: "evt_paused", type: "sandbox.paused" as const },
				{ ...event, id: "evt_other", accountId: "acc_2" },
			]) {
				await store.eventWrites.put(unwanted);
				expect(await store.events.get(unwanted.id)).toEqual(unwanted);
				expect(await store.eventOutbox.get(unwanted.id), unwanted.id).toBeUndefined();
			}
			await emit(store, dispatcherOver(store));
			expect(await store.deliveries.list({ eventId: event.id })).toHaveLength(2);
			expect(await store.eventOutbox.list()).toEqual([]);
		});

		if (each.kind !== undefined) {
			it("are recorded with the event, or neither is stored", async () => {
				const { store, dispatcherOver } = await setUp();
				interrupt.next = true;
				const written = store.eventWrites.put(event);
				const queued = dispatcherOver(store).enqueue(event, written);
				await expect(written).rejects.toThrow();
				await expect(queued).rejects.toThrow();
				expect(await store.events.get(event.id)).toBeUndefined();
				expect(await store.eventOutbox.get(event.id)).toBeUndefined();
				expect(await store.deliveries.list()).toEqual([]);
			});
		}
	});
}
