/**
 * Webhooks signed as Standard Webhooks are: `webhook-id` (the event's ID), `webhook-timestamp` (Unix seconds) and
 * `webhook-signature` (`v1,` and the base64 HMAC-SHA256 of `id.timestamp.body`, keyed with the base64-decoded secret
 * after its `whsec_`). The dispatcher queues a delivery per subscribed webhook for each event, sends it with a 10 s
 * timeout, and retries a failure after 5 s, 30 s, 2 min, 10 min, 1 h, 6 h and 12 h (8 attempts), then marks it failed.
 * A webhook whose deliveries fail every attempt `DISABLE_AFTER_FAILURES` times in a row is disabled.
 */
import type { computeSchema } from "@kantel/api";
import { KantelError } from "@kantel/contracts";
import type { ComputeStore, StoredDelivery, StoredWebhook } from "./store.ts";
import { base64ToBytes, bytesToBase64, randomId } from "./util.ts";

export const WEBHOOK_SECRET_PREFIX = "whsec_";
/** The waits before each retry; a delivery has one attempt more than this has entries. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 43_200_000];
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Deliveries in a row that fail every attempt before the webhook is disabled. */
export const DISABLE_AFTER_FAILURES = 5;
/** The default tolerance `verifyWebhook` allows between the timestamp and now. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A new signing secret: `whsec_` and 24 random bytes in base64. */
export const newWebhookSecret = (): string =>
	`${WEBHOOK_SECRET_PREFIX}${bytesToBase64(crypto.getRandomValues(new Uint8Array(24)))}`;

async function hmacBase64(secret: string, message: string): Promise<string> {
	const raw = secret.startsWith(WEBHOOK_SECRET_PREFIX) ? secret.slice(WEBHOOK_SECRET_PREFIX.length) : secret;
	const key = await crypto.subtle.importKey("raw", base64ToBytes(raw), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
	return bytesToBase64(signature);
}

function sameText(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

/** The `webhook-signature` header for a delivery: `v1,` and the base64 HMAC-SHA256 of `id.timestamp.body`. */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
	return `v1,${await hmacBase64(secret, `${id}.${timestamp}.${body}`)}`;
}

export interface VerifyWebhookOptions {
	/** How far the timestamp may be from now. Default 300. */
	readonly toleranceSeconds?: number;
	/** Now, in epoch milliseconds. Default `Date.now()`. */
	readonly now?: number;
}

type HeaderSource = Headers | { readonly [name: string]: string | undefined };

function headerOf(headers: HeaderSource, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
	return undefined;
}

/**
 * Whether a delivery is signed with `secret` and its timestamp is within the tolerance. Compares in constant time, and
 * takes any of several space-separated signatures (as a sender does while rotating its secret).
 */
export async function verifyWebhook(
	secret: string,
	headers: HeaderSource,
	body: string,
	options: VerifyWebhookOptions = {},
): Promise<boolean> {
	const id = headerOf(headers, "webhook-id");
	const timestamp = headerOf(headers, "webhook-timestamp");
	const signatures = headerOf(headers, "webhook-signature");
	if (id === undefined || timestamp === undefined || signatures === undefined || !/^\d+$/.test(timestamp)) return false;
	const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
	if (Math.abs(nowSeconds - Number(timestamp)) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;
	let expected: string;
	try {
		expected = await hmacBase64(secret, `${id}.${timestamp}.${body}`);
	} catch {
		return false;
	}
	let ok = false;
	for (const candidate of signatures.split(" ")) {
		const comma = candidate.indexOf(",");
		if (comma < 0 || candidate.slice(0, comma) !== "v1") continue;
		if (sameText(candidate.slice(comma + 1), expected)) ok = true;
	}
	return ok;
}

/** A delivery as the API answers it. */
export function deliveryView(delivery: StoredDelivery): computeSchema.WebhookDelivery {
	return {
		id: delivery.id,
		webhookId: delivery.webhookId,
		eventId: delivery.eventId,
		eventType: delivery.eventType,
		state: delivery.state,
		attempts: delivery.attempts,
		createdAt: delivery.createdAt,
		...(delivery.lastStatus === undefined ? {} : { lastStatus: delivery.lastStatus }),
		...(delivery.lastError === undefined ? {} : { lastError: delivery.lastError }),
		...(delivery.nextAttemptAt === undefined ? {} : { nextAttemptAt: delivery.nextAttemptAt }),
		...(delivery.deliveredAt === undefined ? {} : { deliveredAt: delivery.deliveredAt }),
	};
}

export interface WebhookDispatcherOptions {
	readonly store: ComputeStore;
	/** Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** Default `Date.now`. */
	readonly now?: () => number;
	/** Default 10 000. */
	readonly timeoutMs?: number;
}

export interface WebhookDispatcher {
	/** Queues a delivery of the event to each enabled webhook of its account subscribed to its type. */
	/**
	 * Queues a delivery of `event` to each of its account's webhooks that wants it. With `written` (the event's own
	 * write), it looks the webhooks up meanwhile but queues nothing until that write has resolved, and nothing if it
	 * fails: a delivery never outlives an event that wasn't stored.
	 */
	enqueue(event: computeSchema.Event, written?: Promise<unknown>): Promise<StoredDelivery[]>;
	/** Sends a signed `sandbox.created` event for a made-up sandbox to the webhook now, and answers the delivery. */
	test(webhookId: string): Promise<StoredDelivery>;
	/** Attempts every delivery that is due by `now()`. */
	drain(): Promise<void>;
	/** Drains every `intervalMs` (default 1000) until `stop`. */
	start(intervalMs?: number): void;
	stop(): void;
}

/** The dispatcher of an account's events to its webhooks. */
export function createWebhookDispatcher(options: WebhookDispatcherOptions): WebhookDispatcher {
	const { store } = options;
	const now = options.now ?? (() => Date.now());
	const doFetch: typeof fetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
	let timer: ReturnType<typeof setInterval> | undefined;
	let queue: Promise<void> = Promise.resolve();

	const newDelivery = (webhook: StoredWebhook, event: computeSchema.Event): StoredDelivery => ({
		id: randomId("dlv"),
		webhookId: webhook.id,
		accountId: webhook.accountId,
		eventId: event.id,
		eventType: event.type,
		state: "pending",
		attempts: 0,
		nextAttemptAt: now(),
		createdAt: now(),
		body: JSON.stringify(event),
		history: [],
	});

	/** One attempt; `force` sends to a disabled webhook too (a test). */
	async function attempt(delivery: StoredDelivery, force: boolean): Promise<StoredDelivery> {
		const webhook = await store.webhooks.get(delivery.webhookId);
		if (webhook === undefined) {
			await store.deliveries.delete(delivery.id);
			return delivery;
		}
		const at = now();
		if (!webhook.enabled && !force) {
			const failed: StoredDelivery = {
				...delivery,
				state: "failed",
				lastError: "The webhook is disabled",
				nextAttemptAt: undefined,
			};
			await store.deliveries.put(failed);
			return failed;
		}
		const timestamp = Math.floor(at / 1000);
		let status: number | undefined;
		let error: string | undefined;
		try {
			const response = await doFetch(webhook.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"user-agent": "Kantel-Webhooks/1",
					"webhook-id": delivery.eventId,
					"webhook-timestamp": String(timestamp),
					"webhook-signature": await signWebhook(webhook.secret, delivery.eventId, timestamp, delivery.body),
				},
				body: delivery.body,
				signal: AbortSignal.timeout(timeoutMs),
			});
			status = response.status;
			await response.body?.cancel().catch(() => undefined);
			if (status < 200 || status > 299) error = `The endpoint answered ${status}`;
		} catch (thrown) {
			error = thrown instanceof Error ? thrown.message : String(thrown);
		}
		const ok = error === undefined;
		const attempts = delivery.attempts + 1;
		const retryIn = RETRY_DELAYS_MS[attempts - 1];
		const state: StoredDelivery["state"] = ok ? "delivered" : retryIn === undefined ? "failed" : "pending";
		const updated: StoredDelivery = {
			...delivery,
			state,
			attempts,
			lastStatus: status,
			lastError: error,
			nextAttemptAt: state === "pending" && retryIn !== undefined ? at + retryIn : undefined,
			deliveredAt: ok ? at : undefined,
			history: [
				...delivery.history,
				{ at, ...(status === undefined ? {} : { status }), ...(error === undefined ? {} : { error }) },
			],
		};
		await store.deliveries.put(updated);
		// Only the bookkeeping is written, onto the webhook as it is now: a change or a secret rotation made while the
		// request was out stays.
		await store.webhooks.update(webhook.id, (current) => {
			const failures = ok ? 0 : state === "failed" ? current.consecutiveFailures + 1 : current.consecutiveFailures;
			return {
				...current,
				lastDelivery: { at, ok, ...(status === undefined ? {} : { status }) },
				consecutiveFailures: failures,
				enabled: current.enabled && failures < DISABLE_AFTER_FAILURES,
			};
		});
		return updated;
	}

	async function runDue(): Promise<void> {
		const at = now();
		const due = (await store.deliveries.list({ state: "pending" })).filter(
			(delivery) => (delivery.nextAttemptAt ?? 0) <= at,
		);
		for (const delivery of due) {
			// Claimed first, by moving its next attempt past the request's timeout: another dispatcher on the same store
			// (a second gateway) then finds it not due, so it is sent once. A dispatcher that dies holding one lets it fall
			// due again after that.
			const claimed = await store.deliveries.update(delivery.id, (current) =>
				current.state === "pending" && (current.nextAttemptAt ?? 0) <= at
					? { ...current, nextAttemptAt: at + timeoutMs + 5_000 }
					: undefined,
			);
			if (claimed !== undefined) await attempt(claimed, false);
		}
	}

	const dispatcher: WebhookDispatcher = {
		async enqueue(event, written) {
			const [webhooks] = await Promise.all([
				store.webhooks.list({ accountId: event.accountId, enabled: true }),
				written,
			]);
			const made: StoredDelivery[] = [];
			for (const webhook of webhooks) {
				if (!webhook.events.includes(event.type)) continue;
				const delivery = newDelivery(webhook, event);
				await store.deliveries.put(delivery);
				made.push(delivery);
			}
			return made;
		},

		async test(webhookId) {
			const webhook = await store.webhooks.get(webhookId);
			if (webhook === undefined) throw new KantelError("not_found", "No such webhook");
			const event: computeSchema.Event = {
				id: randomId("evt"),
				type: "sandbox.created",
				accountId: webhook.accountId,
				createdAt: now(),
				sandboxId: randomId("sbx_test", 6),
				data: { name: "test-sandbox", state: "starting" },
			};
			const delivery = newDelivery(webhook, event);
			await store.deliveries.put(delivery);
			return attempt(delivery, true);
		},

		drain() {
			queue = queue.then(runDue, runDue);
			return queue;
		},

		start(intervalMs = 1000) {
			if (timer !== undefined) return;
			timer = setInterval(() => {
				dispatcher.drain().catch(() => undefined);
			}, intervalMs);
			(timer as { unref?: () => void }).unref?.();
		},

		stop() {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		},
	};
	return dispatcher;
}
