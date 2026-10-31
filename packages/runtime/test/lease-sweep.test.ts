// The alarm for lease expiry: the runtime sweeps expired sandbox leases (`Sandboxes.sweep`) from `resume()`, a target's
// alarm, and every `leaseSweepMs` while this process holds a session open.
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { AgentProfile, SystemContext } from "@kantel/contracts";
import { createSessionRuntime, type SessionRuntimeService } from "@kantel/runtime/core";
import { createMemorySessionStore } from "@kantel/runtime/store";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORG = "org-sweep";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [{ name: "role", text: "You help." }],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const services: SessionRuntimeService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
});

function setUp(
	sweep: (ctx: SystemContext) => Promise<readonly never[]>,
	leaseSweepMs?: number,
	extra: Partial<Parameters<typeof createSessionRuntime>[0]> = {},
) {
	const errors: unknown[] = [];
	const service = createSessionRuntime({
		store: createMemorySessionStore(),
		storage: () => new MemoryStorage(),
		models: createScriptedModel().models,
		sandboxes: { releaseSession: async () => {}, sweep },
		...(leaseSweepMs === undefined ? {} : { leaseSweepMs }),
		onSweepError: (error) => errors.push(error),
		...extra,
	});
	services.push(service);
	return { service, errors };
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("lease sweeps", () => {
	it("sweeps as the session component from resume(), and reports how many leases sweepLeases released", async () => {
		const callers: SystemContext[] = [];
		const { service } = setUp(async (caller) => {
			callers.push(caller);
			return [];
		});
		await service.resume();
		expect(callers).toEqual([{ actor: { kind: "system", component: "session" } }]);
		expect(await service.sweepLeases()).toBe(0);
		expect(callers).toHaveLength(2);
	});

	it("sweeps every leaseSweepMs once a session is open here, and stops when the runtime closes", async () => {
		let sweeps = 0;
		const { service } = setUp(async () => {
			sweeps += 1;
			return [];
		}, 20);
		// No session open here: no timer.
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(sweeps).toBe(0);
		await service.profiles.put(ctx, profile);
		await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await until(() => sweeps >= 2, "two timed sweeps");
		await service.close();
		const after = sweeps;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(sweeps).toBe(after);
	});

	it("reports a failed sweep and tries again at the next one", async () => {
		let calls = 0;
		const { service, errors } = setUp(async () => {
			calls += 1;
			if (calls === 1) throw new Error("sandbox host down");
			return [];
		}, 20);
		await service.profiles.put(ctx, profile);
		await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await until(() => calls >= 2, "the sweep after the failure");
		expect(errors).toMatchObject([{ message: "sandbox host down" }]);
	});

	it("never runs two sweeps at once: the timer, resume() and sweepLeases() share the one in progress", async () => {
		let running = 0;
		let most = 0;
		let calls = 0;
		let release = () => {};
		const { service } = setUp(async () => {
			calls += 1;
			running += 1;
			most = Math.max(most, running);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			running -= 1;
			return [];
		}, 10);
		await service.profiles.put(ctx, profile);
		await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await until(() => calls === 1, "the timed sweep");
		// Held well past several intervals, with another session opening and both entry points called meanwhile.
		await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		const manual = service.sweepLeases();
		const resumed = service.resume();
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(calls).toBe(1);
		release();
		await manual;
		await resumed;
		expect(most).toBe(1);
	});

	it("recovers due sessions even when the sweep stalls, and says so", async () => {
		const store = createMemorySessionStore();
		const now = Date.now();
		const record = {
			id: "00000000-0000-4000-8000-0000000000c1",
			organisationId: ORG,
			projectId: "proj",
			agentId: "worker",
			status: "idle" as const,
			labels: {},
			createdBy: ctx.actor,
			createdAt: now,
			updatedAt: now,
		};
		await store.createSession({ record, profile, aborts: 0, closed: false });
		await store.setWake(record.id, now - 1);
		const { service, errors } = setUp(() => new Promise<never>(() => {}), undefined, { store, sweepWaitMs: 30 });
		const timers: ReturnType<typeof setTimeout>[] = [];
		const real = globalThis.setTimeout;
		const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
			const timer = real(fn, ms);
			if (ms === 30) timers.push(timer);
			return timer;
		}) as typeof setTimeout);
		const resumed = service.resume();
		// The deadline keeps a process that awaits resume() alive until it fires.
		expect(timers.map((timer) => (timer as { hasRef?: () => boolean }).hasRef?.() ?? true)).toEqual([true]);
		spy.mockRestore();
		expect(await resumed).toBe(1);
		expect(errors).toMatchObject([{ code: "unavailable" }]);
	});

	it("keeps sweeping when the error reporter throws", async () => {
		let calls = 0;
		const { service } = setUp(
			async () => {
				calls += 1;
				throw new Error("sandbox host down");
			},
			10,
			{
				onSweepError: () => {
					throw new Error("reporter broken");
				},
			},
		);
		expect(await service.sweepLeases()).toBe(0);
		await service.profiles.put(ctx, profile);
		await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await until(() => calls >= 3, "sweeps after the reporter threw");
	});

	it("arms no sweep for a session that failed to open", async () => {
		let sweeps = 0;
		const { service } = setUp(
			async () => {
				sweeps += 1;
				return [];
			},
			10,
			{
				storage: async () => {
					throw new Error("storage down");
				},
			},
		);
		await service.profiles.put(ctx, profile);
		await expect(service.runtime.create(ctx, { projectId: "proj", agentId: "worker" })).rejects.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(sweeps).toBe(0);
	});

	it("retries after a sweep that throws at once, and calls sweep on its sandboxes", async () => {
		class Sandboxes {
			calls = 0;
			async releaseSession() {}
			sweep(): Promise<readonly never[]> {
				this.calls += 1;
				if (this.calls === 1) throw new Error("thrown before any promise");
				return Promise.resolve([]);
			}
		}
		const sandboxes = new Sandboxes();
		const errors: unknown[] = [];
		const service = createSessionRuntime({
			store: createMemorySessionStore(),
			storage: () => new MemoryStorage(),
			models: createScriptedModel().models,
			sandboxes,
			onSweepError: (error) => errors.push(error),
		});
		services.push(service);
		expect(await service.sweepLeases()).toBe(0);
		expect(await service.sweepLeases()).toBe(0);
		expect(sandboxes.calls).toBe(2);
		expect(errors).toMatchObject([{ message: "thrown before any promise" }]);
	});

	it("refuses a sweep wait outside setTimeout's range", () => {
		for (const sweepWaitMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
			expect(() => setUp(async () => [], undefined, { sweepWaitMs })).toThrow(/sweepWaitMs/);
		}
	});

	it("refuses an interval that isn't a positive number", () => {
		for (const leaseSweepMs of [0, -5, Number.NaN, 2 ** 31]) {
			expect(() => setUp(async () => [], leaseSweepMs)).toThrow(/leaseSweepMs/);
		}
	});
});
