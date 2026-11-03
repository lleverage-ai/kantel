import type { computeSchema } from "@kantel/api";
import { describe, expect, it } from "vitest";
import { createMemoryStore, type StoredWebhook } from "../src/store.ts";
import {
	createWebhookDispatcher,
	DISABLE_AFTER_FAILURES,
	newWebhookSecret,
	RETRY_DELAYS_MS,
	signWebhook,
	verifyWebhook,
} from "../src/webhooks.ts";

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
	return { store, clock, secret, sent, dispatcher };
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
