import { describe, expect, it } from "vitest";
import { DEFAULT_POOL_SIZE, MAX_POOL_SIZE, Pool, type PoolOptions, parsePoolSize } from "../src/pool.ts";

const IDLE_MS = 1_000;

function fixture(options: Partial<PoolOptions> = {}) {
	const clock = { now: 0 };
	const pool = new Pool({
		sessionIdleMs: IDLE_MS,
		quietMs: 25,
		refillPatienceMs: 500,
		now: () => clock.now,
		// Each sleep moves the fake clock on by its length.
		sleep: async (ms) => {
			clock.now += ms;
		},
		...options,
	});
	const loaded: string[] = [];
	const load = async (slot: string) => {
		loaded.push(slot);
	};
	return { clock, pool, loaded, load };
}

/** A call by `sessionId`, as loader.ts makes it. */
function call(pool: Pool, sessionId: string) {
	pool.begin();
	const { assignment, hit } = pool.assign(sessionId);
	assignment.inFlight += 1;
	return {
		assignment,
		hit,
		done(now: number) {
			pool.end();
			assignment.inFlight -= 1;
			assignment.lastUsed = now;
		},
	};
}

describe("parsePoolSize", () => {
	it("defaults when unset or empty, and turns the pool off for anything but 0 to 64", () => {
		expect(parsePoolSize(undefined)).toEqual({ size: DEFAULT_POOL_SIZE, invalid: false });
		expect(parsePoolSize(" ")).toEqual({ size: DEFAULT_POOL_SIZE, invalid: false });
		expect(parsePoolSize("0")).toEqual({ size: 0, invalid: false });
		expect(parsePoolSize("2")).toEqual({ size: 2, invalid: false });
		expect(parsePoolSize(String(MAX_POOL_SIZE))).toEqual({ size: MAX_POOL_SIZE, invalid: false });
		for (const raw of ["65", "-1", "1.5", "four", "1e1", "0x4"]) {
			expect(parsePoolSize(raw)).toEqual({ size: 0, invalid: true });
		}
	});
});

describe("Pool", () => {
	it("hands each new session its own pre-loaded slot, and never the same slot twice", async () => {
		const { pool, load } = fixture();
		await pool.refill(load, 2);
		const a = call(pool, "a");
		const b = call(pool, "b");
		const c = call(pool, "c");
		expect([a.hit, b.hit, c.hit]).toEqual([true, true, false]);
		const slots = [a, b, c].map((x) => x.assignment.slot);
		expect(new Set(slots).size).toBe(3);
		expect(slots.map((slot) => pool.owner(slot))).toEqual(["a", "b", "c"]);
		// A session's later calls keep its slot.
		const again = call(pool, "a");
		expect(again.hit).toBeUndefined();
		expect(again.assignment.slot).toBe(a.assignment.slot);
	});

	it("refuses egress from a slot not yet handed out", async () => {
		const { pool, load, loaded } = fixture();
		await pool.refill(load, 1);
		expect(loaded).toHaveLength(1);
		expect(pool.owner(loaded[0]!)).toBeUndefined();
		expect(pool.owner("pool:999")).toBeUndefined();
	});

	it("drops an idle session's slot at its owner lookup, with no other assignment", () => {
		const { clock, pool } = fixture();
		const a = call(pool, "a");
		a.done(clock.now);
		clock.now += IDLE_MS - 1;
		expect(pool.owner(a.assignment.slot)).toBe("a");
		clock.now += 1;
		expect(pool.owner(a.assignment.slot)).toBeUndefined();
		expect(pool.stats().sessions).toBe(0);
		// The session's next call gets a fresh slot; the old one stays refused.
		const next = call(pool, "a");
		expect(next.assignment.slot).not.toBe(a.assignment.slot);
		expect(pool.owner(a.assignment.slot)).toBeUndefined();
		expect(pool.owner(next.assignment.slot)).toBe("a");
	});

	it("drops idle sessions at a health check", () => {
		const { clock, pool } = fixture();
		call(pool, "a").done(clock.now);
		call(pool, "b").done(clock.now);
		expect(pool.stats().sessions).toBe(2);
		clock.now += IDLE_MS;
		expect(pool.stats().sessions).toBe(0);
	});

	it("keeps a session's slot while one of its calls is in flight", () => {
		const { clock, pool } = fixture();
		const a = call(pool, "a");
		clock.now += IDLE_MS * 5;
		expect(pool.owner(a.assignment.slot)).toBe("a");
		expect(pool.stats().sessions).toBe(1);
		a.done(clock.now);
		clock.now += IDLE_MS;
		expect(pool.owner(a.assignment.slot)).toBeUndefined();
	});

	it("refills only once nothing has been in flight for the quiet spell", async () => {
		const { clock, pool } = fixture();
		const loadedAt: number[] = [];
		const load = async () => {
			loadedAt.push(clock.now);
		};
		const a = call(pool, "a");
		// In flight: the refill waits, and gives up after its patience.
		await pool.refill(load, 2);
		expect(loadedAt).toHaveLength(0);
		a.done(clock.now);
		const ended = clock.now;
		await pool.refill(load, 2);
		expect(loadedAt).toHaveLength(2);
		// Not before 25 ms with nothing in flight.
		expect(loadedAt[0]! - ended).toBeGreaterThanOrEqual(25);
		expect(pool.stats().idle).toBe(2);
	});

	it("runs one refill at a time", async () => {
		const { pool, load, loaded } = fixture();
		const first = pool.refill(load, 3);
		expect(pool.refill(load, 3)).toBe(first);
		await first;
		expect(loaded).toEqual(["pool:0", "pool:1", "pool:2"]);
		// Done, so the next call starts a new one.
		const next = pool.refill(load, 3);
		expect(next).not.toBe(first);
		await next;
		expect(loaded).toHaveLength(3);
	});

	it("reports a failed load and stops, so a later refill can try again", async () => {
		const errors: unknown[] = [];
		const { pool } = fixture({ onRefillError: (error) => errors.push(error) });
		await pool.refill(async () => {
			throw new Error("load failed");
		}, 2);
		expect(errors).toHaveLength(1);
		expect(pool.stats().idle).toBe(0);
		await pool.refill(async () => {}, 2);
		expect(pool.stats().idle).toBe(2);
	});
});
