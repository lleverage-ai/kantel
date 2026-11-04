import { type ComputeApi, createComputeApi, createMemoryStore, type PersonIdentity } from "@kantel/compute";
import { createStubBackend } from "@kantel/compute/stub";
import { afterEach, describe, expect, it } from "vitest";
import { revivingStub } from "../src/compute.ts";

const TOM: PersonIdentity = { userId: "usr_tom", name: "Tom", email: "tom@example.com" };

interface SandboxBody {
	readonly id: string;
	readonly state: string;
	readonly size?: string;
	readonly resources?: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb: number };
	readonly cost: { readonly ratePerHour?: number };
}

const opened: ComputeApi[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

/** A stack on `store` whose stub starts empty, as a Durable Object's does after eviction. */
function stack(store: ReturnType<typeof createMemoryStore>) {
	const api = createComputeApi({
		store,
		backend: revivingStub(createStubBackend(), store.sandboxes),
		authenticatePerson: async () => TOM,
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const call = async (method: string, path: string, body?: unknown): Promise<SandboxBody> => {
		const response = await api.fetch(
			new Request(`http://compute.test/v1${path}`, {
				method,
				headers: { authorization: "Bearer tom", "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		if (response === undefined || !response.ok) {
			throw new Error(`${method} ${path}: ${response?.status} ${await response?.text()}`);
		}
		return (await response.json()) as SandboxBody;
	};
	return { call };
}

describe("A revived sandbox's shape", () => {
	it("survives the stub losing its machine, and a stop and start; a size named on restart replaces it", async () => {
		const store = createMemoryStore();
		const first = stack(store);
		const made = await first.call("POST", "/sandboxes", {
			type: "microvm",
			resources: { vcpus: 3, memoryMb: 6144 },
			wait: true,
		});
		expect(made.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });
		const rate = made.cost.ratePerHour;
		expect(rate).toBeGreaterThan(0);

		// The stub's memory goes (another stack on the same records): its next call revives the machine.
		const second = stack(store);
		await second.call("POST", `/sandboxes/${made.id}/stop`, { wait: true });
		const started = await second.call("POST", `/sandboxes/${made.id}/start`, { wait: true });
		expect(started.state).toBe("running");
		expect(started.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });
		expect(started.cost.ratePerHour).toBe(rate);

		// Again on a third, from stopped: a start revives it as its shape too.
		await second.call("POST", `/sandboxes/${made.id}/stop`, { wait: true });
		const third = stack(store);
		const again = await third.call("POST", `/sandboxes/${made.id}/start`, { wait: true });
		expect(again.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });

		// A size named on a resume replaces the shape, and stays replaced through another revival.
		await third.call("POST", `/sandboxes/${made.id}/stop`, { wait: true });
		const large = await third.call("POST", `/sandboxes/${made.id}/resume`, { size: "large", wait: true });
		expect(large.size).toBe("large");
		expect(large.resources).toMatchObject({ vcpus: 4, memoryMb: 8192 });
		expect(large.cost.ratePerHour).not.toBe(rate);
		await third.call("POST", `/sandboxes/${made.id}/stop`, { wait: true });
		const fourth = stack(store);
		const kept = await fourth.call("POST", `/sandboxes/${made.id}/start`, { wait: true });
		expect(kept.size).toBe("large");
		expect(kept.resources).toMatchObject({ vcpus: 4, memoryMb: 8192 });
	});

	it("keeps a legacy record's named size", async () => {
		const store = createMemoryStore();
		const made = await stack(store).call("POST", "/sandboxes", { type: "microvm", size: "small", wait: true });
		await stack(store).call("POST", `/sandboxes/${made.id}/stop`, { wait: true });
		const started = await stack(store).call("POST", `/sandboxes/${made.id}/start`, { wait: true });
		expect(started.size).toBe("small");
		expect(started.resources).toMatchObject({ vcpus: 1, memoryMb: 1024 });
	});
});
