// Two compute APIs over one database and one backend, as two gateway replicas in front of one host: a lifecycle move
// is conditional on the state it was read in, so of two racing calls one wins and the other loses cleanly, and a
// stale step never writes `error` over the state the winner left.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend } from "../src/backend.ts";
import { createComputeApi } from "../src/http.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import { type ComputeStore, matches, type StoredSandbox } from "../src/store.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const TOM: PersonIdentity = { userId: "usr_tom", name: "Tom", email: "tom@example.com" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Two replicas over one PGlite database and one stub backend that counts its stops. `stale` makes the second replica
 * read the sandboxes it names as they were when named, as a replica does that read just before the other wrote.
 */
async function twoReplicas(clock: () => number = () => Date.now()) {
	const database = await pgliteDatabase.open();
	cleanups.push(() => database.close());
	await migrateComputeStore(database.driver);
	const stub = createStubBackend();
	const stops: string[] = [];
	const backend: SandboxBackend = {
		...stub,
		stop: async (sandboxId, options) => {
			stops.push(sandboxId);
			return stub.stop(sandboxId, options);
		},
	};
	const stale = new Map<string, StoredSandbox>();
	const replica = (store: ComputeStore) => {
		const api = createComputeApi({
			store,
			backend,
			now: clock,
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer tom-token" ? TOM : undefined,
			fetch: async () => new Response(null, { status: 204 }),
		});
		cleanups.push(() => api.close());
		const client = createKantelClient({
			baseUrl: "http://compute.test/v1",
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		return { api, client };
	};
	const shared = createSqlComputeStore(database.driver);
	const behind = createSqlComputeStore(database.driver);
	const staleStore: ComputeStore = {
		...behind,
		sandboxes: {
			...behind.sandboxes,
			get: async (id) => {
				const old = stale.get(id);
				return old === undefined ? behind.sandboxes.get(id) : structuredClone(old);
			},
			list: async (where) =>
				(await behind.sandboxes.list()).flatMap((sandbox) => {
					const seen = stale.get(sandbox.id) ?? sandbox;
					return matches(seen, where) ? [structuredClone(seen)] : [];
				}),
		},
	};
	const first = replica(shared);
	const second = replica(staleStore);
	const freeze = async (id: string) => {
		const now = await shared.sandboxes.get(id);
		if (now !== undefined) stale.set(id, now);
	};
	return { first, second, stops, freeze, thaw: () => stale.clear(), store: shared };
}

async function refusal(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

const eventTypes = async (store: ComputeStore, sandboxId: string) =>
	(await store.events.list({ sandboxId })).map((event) => event.type);

describe("two replicas, one host", {
	...(pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs }),
}, () => {
	it("a stop that read `running` after the other replica stopped it loses, and stops nothing", async () => {
		const { first, second, stops, freeze, store } = await twoReplicas();
		const sandbox = await first.client.createSandbox({ type: "microvm", wait: true });
		await freeze(sandbox.id);
		await first.client.stopSandbox(sandbox.id, { wait: true });
		// The second replica still reads it `running`: its move to `stopping` is refused, not written over `stopped`.
		const refused = await refusal(second.client.stopSandbox(sandbox.id, { wait: true }));
		expect(refused.code).toBe("conflict");
		await second.api.service.idle();
		expect(stops).toEqual([sandbox.id]);
		expect((await first.client.getSandbox(sandbox.id)).state).toBe("stopped");
		expect(await eventTypes(store, sandbox.id)).toEqual(["sandbox.created", "sandbox.running", "sandbox.stopped"]);
	});

	it("two stops sent to both replicas at once stop once and never end in `error`", async () => {
		const { first, second, stops, store } = await twoReplicas();
		for (let round = 0; round < 10; round++) {
			const sandbox = await first.client.createSandbox({ type: "microvm", wait: true });
			const answers = await Promise.allSettled([
				first.client.stopSandbox(sandbox.id, { wait: true }),
				second.client.stopSandbox(sandbox.id, { wait: true }),
			]);
			await Promise.all([first.api.service.idle(), second.api.service.idle()]);
			expect(answers.some((answer) => answer.status === "fulfilled")).toBe(true);
			for (const answer of answers) {
				if (answer.status === "rejected") expect((answer.reason as KantelApiError).code).toBe("conflict");
			}
			expect(stops.filter((id) => id === sandbox.id)).toHaveLength(1);
			expect((await first.client.getSandbox(sandbox.id)).state).toBe("stopped");
			expect(await eventTypes(store, sandbox.id)).not.toContain("sandbox.error");
		}
	});

	it("auto-stops an expired sandbox once though every replica sweeps", async () => {
		let clock = 1_000_000;
		const { first, second, stops, store } = await twoReplicas(() => clock);
		const sandbox = await first.client.createSandbox({ type: "microvm", autoStopMinutes: 1, wait: true });
		clock += 2 * 60_000;
		await Promise.all([first.api.service.sweep(), second.api.service.sweep()]);
		await Promise.all([first.api.service.idle(), second.api.service.idle()]);
		expect(stops).toEqual([sandbox.id]);
		expect((await first.client.getSandbox(sandbox.id)).state).toBe("stopped");
		expect((await eventTypes(store, sandbox.id)).filter((type) => type === "sandbox.stopped")).toHaveLength(1);
		expect(await eventTypes(store, sandbox.id)).not.toContain("sandbox.error");
	});

	it("doesn't auto-stop a sandbox another replica gave more time after the sweep listed it", async () => {
		let clock = 1_000_000;
		const { first, second, stops, freeze } = await twoReplicas(() => clock);
		const sandbox = await first.client.createSandbox({ type: "microvm", autoStopMinutes: 1, wait: true });
		await freeze(sandbox.id);
		await first.client.updateSandbox(sandbox.id, { extendMinutes: 30 });
		clock += 2 * 60_000;
		// The second replica's sweep still lists it as expired: the move itself must refuse.
		await second.api.service.sweep();
		await second.api.service.idle();
		expect(stops).toEqual([]);
		expect((await first.client.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("a delete on one replica isn't overwritten by a resume the other read before it", async () => {
		const { first, second, freeze } = await twoReplicas();
		const sandbox = await first.client.createSandbox({ type: "microvm", wait: true });
		await first.client.stopSandbox(sandbox.id, { wait: true });
		await freeze(sandbox.id);
		await first.client.deleteSandbox(sandbox.id);
		await first.api.service.idle();
		const refused = await refusal(second.client.resumeSandbox(sandbox.id, { wait: true }));
		expect(refused.code).toBe("conflict");
		await second.api.service.idle();
		expect((await first.client.getSandbox(sandbox.id)).state).toBe("deleted");
	});
});
