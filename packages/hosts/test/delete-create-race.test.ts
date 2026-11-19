// A delete that reaches a sandbox's host before the host has made it (LLE-19700): the host has nothing to delete, then
// makes it, and its answer to the create comes back. Whichever of that answer and the delete's removal of the placement
// lands first, the copy the host made is deleted there and no placement is left: the delete asks the host again where
// the answer was recorded first, and the answer, where the removal was first, is refused and its copy fenced there.
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
	return { store, service, host, hostId, atCreate, answer: () => answer(), holdDeleteWrite };
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

	it("fences the copy the host makes where the delete's removal lands before the host's answer", async () => {
		const { store, service, host, atCreate, answer } = await setup();
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-later" });
		await atCreate;
		await service.sandboxes.delete("sbx-later");
		expect(await store.getPlacement("sbx-later")).toBeUndefined();
		// The host makes it after all, and answers: refused, never placed again, its copy deleted by its fence.
		answer();
		await expect(creating).rejects.toSatisfy((error) => isKantelError(error, "conflict"));
		await vi.waitFor(() => expect(host.sandboxes.has("sbx-later")).toBe(false));
		await vi.waitFor(async () => expect(await store.getPlacement("sbx-later")).toBeUndefined());
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
