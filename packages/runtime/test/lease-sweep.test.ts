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

function setUp(sweep: (ctx: SystemContext) => Promise<readonly never[]>, leaseSweepMs?: number) {
	const errors: unknown[] = [];
	const service = createSessionRuntime({
		store: createMemorySessionStore(),
		storage: () => new MemoryStorage(),
		models: createScriptedModel().models,
		sandboxes: { releaseSession: async () => {}, sweep },
		...(leaseSweepMs === undefined ? {} : { leaseSweepMs }),
		onSweepError: (error) => errors.push(error),
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

	it("refuses an interval that isn't a positive number", () => {
		for (const leaseSweepMs of [0, -5, Number.NaN]) {
			expect(() => setUp(async () => [], leaseSweepMs)).toThrow(/leaseSweepMs/);
		}
	});
});
