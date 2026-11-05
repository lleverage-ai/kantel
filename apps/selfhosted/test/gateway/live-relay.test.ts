// The live relay (live-relay.ts): its notices, and two gateways' relays over one Postgres (KANTEL_TEST_POSTGRES_URL,
// skipped without one), each hearing the other's changes and not its own, apart from another schema's, and telling its
// watchers to read again once its listening connection comes back.
import type { SandboxChange } from "@kantel/compute";
import pg from "pg";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { liveChannel, noticeOf, postgresLiveRelay } from "../../src/gateway/live-relay.ts";

const databaseUrl = process.env.KANTEL_TEST_POSTGRES_URL ?? "";

const change: SandboxChange = {
	sandboxId: "sbx_1",
	accountId: "acc_1",
	state: "stopped",
	previousState: "stopping",
	at: 5,
};

describe("notices", () => {
	test("read back what a relay sends, and refuse anything else", () => {
		expect(noticeOf(JSON.stringify({ origin: "a", change }))).toEqual({ origin: "a", change });
		const { previousState: _gone, ...made } = change;
		expect(noticeOf(JSON.stringify({ origin: "a", change: made }))).toEqual({ origin: "a", change: made });
		for (const payload of [
			undefined,
			"",
			"not json",
			"null",
			JSON.stringify({ change }),
			JSON.stringify({ origin: "a" }),
			JSON.stringify({ origin: "a", change: { ...change, at: "5" } }),
			JSON.stringify({ origin: "a", change: { ...change, sandboxId: 1 } }),
			JSON.stringify({ origin: "a", change: { ...change, previousState: 1 } }),
		]) {
			expect(noticeOf(payload)).toBeUndefined();
		}
	});

	test("go on a channel of the schema's, a name Postgres takes", () => {
		expect(liveChannel("kantel")).toMatch(/^kantel_live_[0-9a-f]{16}$/);
		expect(liveChannel("kantel")).toBe(liveChannel("kantel"));
		expect(liveChannel("kantel")).not.toBe(liveChannel("other"));
	});
});

describe.skipIf(databaseUrl === "")("relays over Postgres", () => {
	const stops: (() => Promise<void> | void)[] = [];
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

	afterEach(async () => {
		for (const stop of stops.splice(0)) await stop();
	});
	afterAll(async () => {
		await pool.end();
	});

	/** A relay on `schema`; its first `unreachable` listening connections go nowhere. */
	const relay = (schema: string, clients: pg.Client[] = [], unreachable = 0) => {
		const received: SandboxChange[] = [];
		const probes: string[] = [];
		let resyncs = 0;
		let connections = 0;
		const made = postgresLiveRelay({
			schema,
			query: (text, values) => pool.query(text, [...values]),
			connect: () => {
				connections += 1;
				const client = new pg.Client(
					connections <= unreachable
						? { host: "127.0.0.1", port: 1, connectionTimeoutMillis: 200 }
						: { connectionString: databaseUrl },
				);
				clients.push(client);
				return client;
			},
			log: () => {},
			retryMs: [50],
		});
		made.start(
			(taken) => {
				if (taken.sandboxId.startsWith("sbx_probe")) probes.push(taken.sandboxId);
				else received.push(taken);
			},
			() => {
				resyncs += 1;
			},
		);
		stops.push(() => made.stop());
		return {
			relay: made,
			received,
			probes,
			get resyncs() {
				return resyncs;
			},
		};
	};

	const until = async (done: () => boolean, what: string) => {
		const deadline = Date.now() + 5_000;
		while (!done()) {
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};

	/** Waits until a relay's listener is in: a notice it sends to itself is ignored, so another relay's is needed. */
	const listening = async (to: { probes: string[] }, from: { relay: { send(c: SandboxChange): void } }) => {
		const probe = `sbx_probe_${crypto.randomUUID()}`;
		let last = 0;
		await until(() => {
			if (Date.now() - last > 100) {
				last = Date.now();
				from.relay.send({ ...change, sandboxId: probe });
			}
			return to.probes.includes(probe);
		}, "the listener");
	};

	test("carry a change to the other gateway, not back to its own, and not to another schema's", async () => {
		const schema = `live_${crypto.randomUUID().slice(0, 8)}`;
		const one = relay(schema);
		const two = relay(schema);
		const elsewhere = relay(`${schema}_other`);
		await listening(two, one);
		await listening(one, two);
		await listening(elsewhere, relay(`${schema}_other`));

		one.relay.send(change);
		await until(() => two.received.length === 1, "the other gateway");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(two.received).toEqual([change]);
		expect(one.received).toEqual([]);
		expect(elsewhere.received).toEqual([]);
	});

	test("listen again after a dropped connection, and say the watchers may have missed some", async () => {
		const schema = `live_${crypto.randomUUID().slice(0, 8)}`;
		const clients: pg.Client[] = [];
		const one = relay(schema, clients);
		const two = relay(schema);
		await listening(one, two);
		// Its first LISTEN says so too, though nobody watched yet.
		expect(one.resyncs).toBe(1);

		// The database ends the listening connection, as a restart or failover would.
		const listener = clients[0] as pg.Client & { processID?: number };
		await pool.query("SELECT pg_terminate_backend($1)", [listener.processID]);
		await until(() => one.resyncs === 2, "the resync");
		await listening(one, two);
		two.relay.send(change);
		await until(() => one.received.length === 1, "a change after the drop");
		expect(one.received).toEqual([change]);
		expect(clients.length).toBeGreaterThanOrEqual(2);
	});

	test("say the watchers may have missed some once a first LISTEN that failed to open gets in", async () => {
		const schema = `live_${crypto.randomUUID().slice(0, 8)}`;
		const clients: pg.Client[] = [];
		const one = relay(schema, clients, 2);
		const two = relay(schema);
		await listening(one, two);
		expect(clients.length).toBe(3);
		expect(one.resyncs).toBe(1);
	});

	test("send nothing and stop listening once stopped", async () => {
		const schema = `live_${crypto.randomUUID().slice(0, 8)}`;
		const one = relay(schema);
		const two = relay(schema);
		await listening(two, one);
		await one.relay.stop();
		one.relay.send(change);
		two.relay.send(change);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(two.received).toEqual([]);
		expect(one.received).toEqual([]);
	});
});
