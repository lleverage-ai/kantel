// A delete that reaches a sandbox's host before the host has made it (LLE-19700): the host has nothing to delete, then
// makes it, and its answer to the create comes back. Whichever of that answer and the delete's removal of the placement
// lands first, the copy the host made is deleted there and no placement is left: the delete asks the host again where
// the answer was recorded first, and the answer, where the removal was first, is refused and its copy fenced there,
// only to be deleted (`orphan`): never reported to the compute plane as a loss.
import { isKantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { FakeHost, facts } from "./fake-host.ts";

const services: HostsService[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const service of services.splice(0)) service.close();
});

/** One connected host, whose answers to `sandbox.create` wait until `answer` is called. */
async function setup() {
	const store = createMemoryHostStore();
	const service = createHostsService({ store, publicUrl: "https://kantel.example.com/", log: () => undefined });
	services.push(service);
	const lost: string[] = [];
	service.useCompute({
		secrets: async () => undefined,
		recordEgress: async () => undefined,
		sandboxLost: async (_hostId, sandboxId) => {
			lost.push(sandboxId);
			return true;
		},
	});
	const token = await service.createJoinToken({ name: "box" });
	const { hostId } = await service.register({ token: token.token, facts: facts() });
	const host = new FakeHost(service, hostId);
	host.connect();
	await vi.waitFor(() => expect(host.welcomed()).toBe(true));
	let answer: () => void = () => undefined;
	let admitted: () => void = () => undefined;
	const atCreate = new Promise<void>((resolve) => {
		admitted = resolve;
	});
	host.hold = (method) => {
		if (method !== "sandbox.create" && method !== "sandbox.fork") return undefined;
		admitted();
		return new Promise<void>((resolve) => {
			answer = resolve;
		});
	};
	/** Holds the delete's first write of the placement once its host has been asked to delete it, until released. */
	const holdDeleteWrite = (sandboxId: string) => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached: () => void = () => undefined;
		const atWrite = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const asked = () =>
			host.calls.some((call) => call.method === "sandbox.delete" && call.params.sandboxId === sandboxId);
		const update = store.updatePlacement.bind(store);
		let armed = true;
		vi.spyOn(store, "updatePlacement").mockImplementation(async (id, change) => {
			if (armed && id === sandboxId && asked()) {
				armed = false;
				reached();
				await gate;
			}
			return update(id, change);
		});
		return { atWrite, release: () => release() };
	};
	return { store, service, host, hostId, atCreate, answer: () => answer(), holdDeleteWrite, lost };
}

describe("a delete that reaches a sandbox's host before the host has made it", () => {
	it("deletes it there again where the host's answer to the create is recorded before the delete's removal", async () => {
		const { store, service, host, atCreate, answer, holdDeleteWrite } = await setup();
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-late" });
		await atCreate;
		expect((await store.getPlacement("sbx-late"))?.state).toBe("starting");
		// The delete asks the host first, which has nothing yet; its removal of the placement is held.
		const held = holdDeleteWrite("sbx-late");
		const deleting = service.sandboxes.delete("sbx-late");
		await held.atWrite;
		expect(host.sandboxes.has("sbx-late")).toBe(false);
		// The host makes it, and its answer is recorded on the placement.
		answer();
		await expect(creating).resolves.toMatchObject({ sandbox: { id: "sbx-late", state: "running" } });
		expect(host.sandboxes.has("sbx-late")).toBe(true);
		expect((await store.getPlacement("sbx-late"))?.state).toBe("running");
		// The delete's removal goes on: refused, the placement no longer as read, it asks the host again.
		held.release();
		await deleting;
		expect(host.sandboxes.has("sbx-late")).toBe(false);
		expect(host.calls.filter((call) => call.method === "sandbox.delete")).toHaveLength(2);
		expect(await store.getPlacement("sbx-late")).toBeUndefined();
	});

	it("fences the copy the host makes where the delete's removal lands before the host's answer, as no loss", async () => {
		const { store, service, host, hostId, atCreate, answer, lost } = await setup();
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-later" });
		await atCreate;
		await service.sandboxes.delete("sbx-later");
		expect(await store.getPlacement("sbx-later")).toBeUndefined();
		// The host makes it after all, and answers: refused, never placed again, its copy fenced there to be deleted (the
		// fence's delete held a while).
		let deleteNow: () => void = () => undefined;
		host.hold = (method) =>
			method === "sandbox.delete"
				? new Promise<void>((resolve) => {
						deleteNow = resolve;
					})
				: undefined;
		answer();
		await expect(creating).rejects.toSatisfy((error) => isKantelError(error, "conflict"));
		const orphan = await store.getPlacement("sbx-later");
		expect(orphan).toMatchObject({ hostId, state: "lost", orphan: true });
		expect(orphan?.fenced).toBeTypeOf("number");
		expect(orphan?.attempt).toBeUndefined();
		// Only to be deleted: no loss for the compute plane's passes, and no new create over it.
		expect(await service.sandboxes.placedOnHost(hostId)).toEqual([]);
		await expect(service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-later" })).rejects.toSatisfy((error) =>
			isKantelError(error, "conflict"),
		);
		deleteNow();
		await vi.waitFor(() => expect(host.sandboxes.has("sbx-later")).toBe(false));
		await vi.waitFor(async () => expect(await store.getPlacement("sbx-later")).toBeUndefined());
		expect(lost).toEqual([]);
	});

	it("never answers a late copy's fence as a loss's, when its host is fenced as lost", async () => {
		const { store, service, host, hostId, atCreate, answer, lost } = await setup();
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-gone" });
		await atCreate;
		await service.sandboxes.delete("sbx-gone");
		const deletes: (() => void)[] = [];
		host.hold = (method) =>
			method === "sandbox.delete" ? new Promise<void>((resolve) => deletes.push(resolve)) : undefined;
		answer();
		await expect(creating).rejects.toSatisfy((error) => isKantelError(error, "conflict"));
		expect(await store.getPlacement("sbx-gone")).toMatchObject({ hostId, orphan: true });
		// A loss pass (or a loss's fallback, `settleLosing`) fencing its host for it: nothing of the sandbox's is lost there.
		const fencing = service.sandboxes.fence(hostId, ["sbx-gone"], undefined);
		await vi.waitFor(() => expect(deletes.length).toBeGreaterThan(0));
		expect(await store.getPlacement("sbx-gone")).toMatchObject({ hostId, orphan: true });
		for (const resolve of deletes) resolve();
		host.hold = undefined;
		expect(await fencing).toEqual([]);
		await vi.waitFor(async () => expect(await store.getPlacement("sbx-gone")).toBeUndefined());
		expect(lost).toEqual([]);
	});

	it("deletes the late copy on its host where a create of the same ID on another host came first", async () => {
		const { store, service, host, hostId, atCreate, answer } = await setup();
		const token = await service.createJoinToken({ name: "other" });
		const other = await service.register({ token: token.token, facts: facts() });
		const second = new FakeHost(service, other.hostId);
		second.connect();
		await vi.waitFor(() => expect(second.welcomed()).toBe(true));
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-twice", hostIds: [hostId] });
		await atCreate;
		await service.sandboxes.delete("sbx-twice");
		// The same ID made again, on the other host, before the first host answers.
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-twice", hostIds: [other.hostId] });
		answer();
		await expect(creating).rejects.toSatisfy((error) => isKantelError(error, "conflict"));
		expect(host.sandboxes.has("sbx-twice")).toBe(false);
		expect(second.sandboxes.has("sbx-twice")).toBe(true);
		expect(await store.getPlacement("sbx-twice")).toMatchObject({ hostId: other.hostId, state: "running" });
	});

	it("asks the host again where its hello found no copy and the create's answer came after the delete read that", async () => {
		const { store, service, host, atCreate, answer, holdDeleteWrite } = await setup();
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-hello" });
		await atCreate;
		// As its host's hello marks an admission it doesn't have (it came back before the create reached it).
		await store.updatePlacement("sbx-hello", (latest) => ({ ...latest, state: "lost" }));
		const held = holdDeleteWrite("sbx-hello");
		const deleting = service.sandboxes.delete("sbx-hello");
		await held.atWrite;
		answer();
		await expect(creating).resolves.toMatchObject({ sandbox: { id: "sbx-hello" } });
		expect((await store.getPlacement("sbx-hello"))?.state).toBe("running");
		held.release();
		await deleting;
		expect(host.sandboxes.has("sbx-hello")).toBe(false);
		expect(host.calls.filter((call) => call.method === "sandbox.delete")).toHaveLength(2);
		expect(await store.getPlacement("sbx-hello")).toBeUndefined();
	});

	it("ends with the host's word that it deleted it, never asking again, where the create settled after the read", async () => {
		const { store, service, host, atCreate, answer } = await setup();
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-acked" });
		await atCreate;
		// The delete reads the placement `starting` and asks the host, which takes the delete after the create.
		let deleteNow: () => void = () => undefined;
		let asked: () => void = () => undefined;
		const atDelete = new Promise<void>((resolve) => {
			asked = resolve;
		});
		host.hold = (method) => {
			if (method !== "sandbox.delete") return undefined;
			asked();
			return new Promise<void>((resolve) => {
				deleteNow = resolve;
			});
		};
		const deleting = service.sandboxes.delete("sbx-acked");
		await atDelete;
		answer();
		await expect(creating).resolves.toMatchObject({ sandbox: { id: "sbx-acked" } });
		expect((await store.getPlacement("sbx-acked"))?.state).toBe("running");
		// It deletes the copy it made, and says so: done, with no second call (its link may be gone by then).
		deleteNow();
		await deleting;
		expect(host.sandboxes.has("sbx-acked")).toBe(false);
		expect(host.calls.filter((call) => call.method === "sandbox.delete")).toHaveLength(1);
		expect(await store.getPlacement("sbx-acked")).toBeUndefined();
	});

	it("fences the copy a fork makes where the delete's removal lands before the host's answer", async () => {
		const { store, service, host } = await setup();
		host.hold = undefined;
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-source" });
		let answerFork: () => void = () => undefined;
		let forking: () => void = () => undefined;
		const atFork = new Promise<void>((resolve) => {
			forking = resolve;
		});
		host.hold = (method) => {
			if (method !== "sandbox.fork") return undefined;
			forking();
			return new Promise<void>((resolve) => {
				answerFork = resolve;
			});
		};
		const fork = service.sandboxes.fork("sbx-source", { newId: "sbx-forked" });
		await atFork;
		await service.sandboxes.delete("sbx-forked");
		expect(await store.getPlacement("sbx-forked")).toBeUndefined();
		answerFork();
		await expect(fork).rejects.toSatisfy((error) => isKantelError(error, "conflict"));
		await vi.waitFor(() => expect(host.sandboxes.has("sbx-forked")).toBe(false));
		await vi.waitFor(async () => expect(await store.getPlacement("sbx-forked")).toBeUndefined());
		expect(host.sandboxes.has("sbx-source")).toBe(true);
		expect((await store.getPlacement("sbx-source"))?.state).toBe("running");
	});
});
