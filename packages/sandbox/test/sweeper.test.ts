import { type CallContext, isKantelError, type SandboxLease, type SandboxTier } from "@kantel/contracts";
import { createInProcessIsolateBackend } from "@kantel/sandbox/isolate";
import { startLeaseSweeper, usageReport } from "@kantel/sandbox/sweeper";
import { createTieredSandboxes } from "@kantel/sandbox/tiered";
import { ManualClock, RecordingAuditSink } from "@kantel/testing/harness";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulatedContainer } from "./backends.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const OWNER = { kind: "organisation", organisationId: "org-1" } as const;

/** Lets every pending promise settle, past the faked timers. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A small seeded PRNG, so a failing soak run can be replayed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** A `sweep` stand-in that takes `ms` on the (faked) timers and records how many run at once. */
function slowSweep(ms: number, fail: (call: number) => boolean = () => false) {
	const stats = { calls: 0, active: 0, maxActive: 0, contexts: [] as unknown[] };
	return {
		stats,
		sandboxes: {
			async sweep(context: unknown): Promise<readonly SandboxLease[]> {
				stats.calls++;
				stats.contexts.push(context);
				stats.active++;
				stats.maxActive = Math.max(stats.maxActive, stats.active);
				try {
					await sleep(ms);
					if (fail(stats.calls)) throw new Error(`sweep ${stats.calls} failed`);
					return [];
				} finally {
					stats.active--;
				}
			},
		},
	};
}

describe("startLeaseSweeper", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sweeps every interval with a system context, never two sweeps at once", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { stats, sandboxes } = slowSweep(250);
		const sweeper = startLeaseSweeper({ sandboxes, intervalMs: 100 });
		await vi.advanceTimersByTimeAsync(99);
		await settle();
		expect(stats.calls).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(stats.calls).toBe(1);
		// A manual sweep while one is in flight waits for it.
		const manual = sweeper.sweepNow();
		await vi.advanceTimersByTimeAsync(2_000);
		await settle();
		await expect(manual).resolves.toEqual([]);
		expect(stats.calls).toBeGreaterThanOrEqual(4);
		expect(stats.maxActive).toBe(1);
		expect(stats.contexts[0]).toEqual({ actor: { kind: "system", component: "sandbox.sweeper" } });
		// `stop` waits for a sweep in flight, which sleeps on the faked timers.
		const stopped = sweeper.stop();
		await vi.advanceTimersByTimeAsync(300);
		await stopped;
	});

	it("reports a failed sweep and carries on", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { stats, sandboxes } = slowSweep(10, (call) => call === 1);
		const errors: unknown[] = [];
		const sweeper = startLeaseSweeper({ sandboxes, intervalMs: 100, onError: (error) => errors.push(error) });
		await vi.advanceTimersByTimeAsync(700);
		await settle();
		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("sweep 1 failed");
		expect(stats.calls).toBeGreaterThanOrEqual(3);
		await sweeper.stop();
	});

	it("keeps going when the error reporter itself throws", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { stats, sandboxes } = slowSweep(10, () => true);
		const sweeper = startLeaseSweeper({
			sandboxes,
			intervalMs: 100,
			onError: () => {
				throw new Error("reporter down");
			},
		});
		await vi.advanceTimersByTimeAsync(700);
		await settle();
		expect(stats.calls).toBeGreaterThanOrEqual(3);
		await sweeper.stop();
	});

	it("stops after the sweep in flight and sweeps no more", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { stats, sandboxes } = slowSweep(50);
		const sweeper = startLeaseSweeper({ sandboxes, intervalMs: 100 });
		await vi.advanceTimersByTimeAsync(110);
		await settle();
		expect(stats.active).toBe(1);
		const stopped = sweeper.stop();
		await vi.advanceTimersByTimeAsync(50);
		await settle();
		await stopped;
		expect(stats.active).toBe(0);
		const calls = stats.calls;
		await vi.advanceTimersByTimeAsync(1_000);
		await settle();
		expect(stats.calls).toBe(calls);
		await sweeper.stop();
	});

	it("refuses an interval that is not a positive number", () => {
		const { sandboxes } = slowSweep(0);
		expect(() => startLeaseSweeper({ sandboxes, intervalMs: 0 })).toThrow(RangeError);
		expect(() => startLeaseSweeper({ sandboxes, intervalMs: Number.NaN })).toThrow(RangeError);
	});

	it("ends the tiered sandboxes' expired leases and hands them to onSwept", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const clock = new ManualClock();
		const audit = new RecordingAuditSink();
		const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore(), clock, audit });
		const record = await workspaces.create(ctx, { owner: OWNER });
		const container = new SimulatedContainer(workspaces);
		const sandboxes = createTieredSandboxes({
			workspaces,
			isolate: createInProcessIsolateBackend(workspaces),
			container,
			clock,
			audit,
		});
		const isolate = await sandboxes.acquire(ctx, {
			sessionId: "sess-1",
			workspaceId: record.id,
			tier: "isolate",
			ttlMs: 1_000,
		});
		const held = await sandboxes.acquire(ctx, {
			sessionId: "sess-1",
			workspaceId: record.id,
			tier: "container",
			ttlMs: 2_000,
		});
		const swept: (readonly SandboxLease[])[] = [];
		const sweeper = startLeaseSweeper({ sandboxes, intervalMs: 5_000, onSwept: (leases) => swept.push(leases) });

		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(swept).toEqual([]);

		clock.advance(1_000);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(swept.map((leases) => leases.map((lease) => [lease.id, lease.endReason]))).toEqual([
			[[isolate.id, "expired"]],
		]);

		clock.advance(1_000);
		expect((await sweeper.sweepNow()).map((lease) => lease.id)).toEqual([held.id]);
		expect(container.endedCalls).toEqual([{ leaseId: held.id, discard: true }]);
		expect(audit.ofType("sandbox.lease.released").map((event) => event.actor)).toEqual([
			{ kind: "system", component: "sandbox.sweeper" },
			{ kind: "system", component: "sandbox.sweeper" },
		]);
		await sweeper.stop();
	});
});

describe("usageReport", () => {
	it("gives the bound ratio per tier, zero when nothing was held", () => {
		expect(
			usageReport([
				{ tier: "isolate", leases: 2, heldMs: 1_000, busyMs: 250 },
				{ tier: "container", leases: 0, heldMs: 0, busyMs: 0 },
			]),
		).toEqual([
			{ tier: "isolate", leases: 2, heldMs: 1_000, busyMs: 250, boundRatio: 0.25 },
			{ tier: "container", leases: 0, heldMs: 0, busyMs: 0, boundRatio: 0 },
		]);
	});
});

describe("lease sweeper soak", () => {
	it("ends 150 leases with random TTLs within 30 s of expiry while commands keep running", async () => {
		const random = mulberry32(0x5eed);
		const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore() });
		const record = await workspaces.create(ctx, {
			owner: OWNER,
			seed: { name: "soak", sources: [{ kind: "files", files: { "top.txt": "top" } }] },
		});
		const container = new SimulatedContainer(workspaces);
		const sandboxes = createTieredSandboxes({
			workspaces,
			isolate: createInProcessIsolateBackend(workspaces),
			container,
		});
		const ttl = () => 200 + Math.floor(random() * 1_301);

		// 100 sessions with an isolate lease; the first 50 hold a container lease too.
		const leases: SandboxLease[] = [];
		const sessions = new Set<string>();
		for (let index = 0; index < 150; index++) {
			const tier: SandboxTier = index < 100 ? "isolate" : "container";
			const sessionId = `sess-soak-${index % 100}`;
			sessions.add(sessionId);
			leases.push(await sandboxes.acquire(ctx, { sessionId, workspaceId: record.id, tier, ttlMs: ttl() }));
		}

		const errors: unknown[] = [];
		let swept = 0;
		const sweeper = startLeaseSweeper({
			sandboxes,
			intervalMs: 200,
			onSwept: (ended) => {
				swept += ended.length;
			},
			onError: (error) => errors.push(error),
		});

		// A third of the leases are renewed once, halfway through their TTL.
		let renewed = 0;
		const renewals = leases
			.filter((_, index) => index % 3 === 0)
			.map(async (lease) => {
				await sleep((lease.expiresAt - lease.acquiredAt) / 2);
				try {
					await sandboxes.renew(ctx, lease.id, ttl());
					renewed++;
				} catch (error) {
					if (!isKantelError(error, "expired")) throw error;
				}
			});

		// Commands keep arriving on random leases, live or not, for about six seconds.
		let commands = 0;
		let refused = 0;
		const deadline = Date.now() + 6_000;
		const load = (async () => {
			while (Date.now() < deadline) {
				const lease = leases[Math.floor(random() * leases.length)]!;
				const command = lease.tier === "container" ? "printf x >> soak.txt" : "echo soak | wc -c";
				try {
					await sandboxes.exec(ctx, lease.id, { command });
					commands++;
				} catch (error) {
					if (!isKantelError(error, "expired")) throw error;
					refused++;
				}
				await sleep(5);
			}
		})();

		await Promise.all([load, ...renewals]);
		await sweeper.stop();

		expect(errors).toEqual([]);
		const ended: SandboxLease[] = [];
		for (const sessionId of sessions) ended.push(...(await sandboxes.leases(ctx, { sessionId })));
		expect(ended).toHaveLength(150);
		let maxOvershootMs = 0;
		for (const lease of ended) {
			expect(lease.endedAt, lease.id).toBeDefined();
			expect(lease.endReason, lease.id).toBe("expired");
			const overshoot = lease.endedAt! - lease.expiresAt;
			expect(overshoot, lease.id).toBeGreaterThanOrEqual(0);
			expect(overshoot, lease.id).toBeLessThanOrEqual(30_000);
			maxOvershootMs = Math.max(maxOvershootMs, overshoot);
		}
		// Expired container leases are discarded, never committed.
		expect((await workspaces.get(ctx, record.id)).head).toBe(record.head);
		expect(container.endedCalls.filter((call) => call.discard)).toHaveLength(50);
		console.log(JSON.stringify({ leases: 150, renewed, commands, refused, swept, maxOvershootMs }));
	}, 30_000);
});
