// The alarm for lease expiry: the runtime sweeps expired sandbox leases (`Sandboxes.sweep`) from `resume()`, a target's
// alarm, and every `leaseSweepMs` while this process holds a session open.
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { AgentProfile, SystemContext } from "@harbour/contracts";
import { createSessionRuntime, type SessionRuntimeService } from "@harbour/runtime/core";
import { createMemorySessionStore } from "@harbour/runtime/store";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

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
		expect(await service.resume()).toBe(1);
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

	it("refuses an interval that isn't a positive number", () => {
		for (const leaseSweepMs of [0, -5, Number.NaN]) {
			expect(() => setUp(async () => [], leaseSweepMs)).toThrow(/leaseSweepMs/);
		}
	});
});
