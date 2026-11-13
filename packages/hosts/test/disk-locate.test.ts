// The disk store over the host link (docs/design/disk-store.md, 2c): a host's welcome carries the control plane's grant
// keys (told again when they change), its reports' sticky disk holdings reach the catalogue, and its `disk.locate` is answered for its own connection.
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostGrantKey } from "../src/protocol.ts";
import type { HostComputeLink } from "../src/service.ts";
import { createHostsService, GRANT_KEYS_REFRESH_MS } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { FakeHost } from "./fake-host.ts";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

const capacity = { freeMemoryMiB: 4096, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0.1 };

async function setup(link: Partial<HostComputeLink>) {
	const clock = { at: Date.UTC(2026, 10, 13) };
	const store = createMemoryHostStore();
	const service = createHostsService({
		store,
		clock: { now: () => clock.at },
		publicUrl: "https://kantel.test",
		log: () => undefined,
	});
	closers.push(() => service.close());
	service.useCompute({ secrets: async () => undefined, recordEgress: async () => undefined, ...link });
	const token = await service.createJoinToken({ name: "box" });
	const { hostId } = await service.register({ token: token.token });
	const host = new FakeHost(service, hostId);
	host.connect();
	await vi.waitFor(() => expect(host.welcomed()).toBe(true));
	/** The answer to the host's call `id`, once it comes. */
	const result = async (id: string) => {
		let found: (typeof host.sent)[number] | undefined;
		await vi.waitFor(() => {
			found = host.sent.find((message) => message.type === "result" && message.id === id);
			if (found === undefined) throw new Error(`No answer to ${id} yet`);
		});
		return found;
	};
	return { service, store, clock, host, hostId, result };
}

describe("the disk store on the host link", () => {
	it("welcomes a host with the grant keys, and without them when there are none or they can't be read", async () => {
		const keys = [
			{ id: "key_new", publicKey: "A".repeat(43) },
			{ id: "key_old", publicKey: "B".repeat(43), until: Date.UTC(2026, 10, 14) },
		];
		const { host } = await setup({ grantKeys: async () => keys });
		const welcome = host.sent.find((message) => message.type === "welcome")?.welcome;
		// The key that signs as `grantKey` too, for hosts from before rotation.
		expect(welcome?.grantKey).toBe("A".repeat(43));
		expect(welcome?.grantKeys).toEqual(keys);
		for (const grantKeys of [async () => undefined, async () => Promise.reject(new Error("no secrets key"))]) {
			const { host: other } = await setup({ grantKeys });
			const welcome = other.sent.find((message) => message.type === "welcome")?.welcome;
			expect(welcome).toBeDefined();
			expect(welcome?.grantKey).toBeUndefined();
			expect(welcome?.grantKeys).toBeUndefined();
		}
	});

	it("sends connected hosts their welcome again when the grant keys change, and makes good a telling missed", async () => {
		let keys: HostGrantKey[] = [{ id: "key_1", publicKey: "A".repeat(43) }];
		const { service, host, clock } = await setup({ grantKeys: async () => keys });
		const welcomes = () =>
			host.sent.filter((message) => message.type === "welcome").map((message) => message.welcome?.grantKeys);
		const heartbeat = () => host.send({ type: "heartbeat", heartbeat: { capacity } });
		expect(welcomes()).toEqual([keys]);
		// A rotation: told at once.
		keys = [
			{ id: "key_2", publicKey: "B".repeat(43) },
			{ id: "key_1", publicKey: "A".repeat(43), until: clock.at + 16 * 60_000 },
		];
		await service.grantKeysChanged();
		await vi.waitFor(() => expect(welcomes()).toEqual([expect.anything(), keys]));
		// Unchanged: a heartbeat sends nothing.
		heartbeat();
		clock.at += GRANT_KEYS_REFRESH_MS;
		heartbeat();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(welcomes()).toHaveLength(2);
		// A change whose telling missed the host (another replica's, or the retired key's time up): on a later heartbeat.
		keys = [{ id: "key_2", publicKey: "B".repeat(43) }];
		heartbeat();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(welcomes()).toHaveLength(2);
		clock.at += GRANT_KEYS_REFRESH_MS;
		heartbeat();
		await vi.waitFor(() => expect(welcomes()).toEqual([expect.anything(), expect.anything(), keys]));
	});

	it("passes each report's sticky disk holdings on, and none from a report that doesn't say", async () => {
		const recordStickyHoldings = vi.fn(async () => undefined);
		const { host, hostId } = await setup({ recordStickyHoldings });
		const holdings = [{ diskId: "sdk_1", versions: [{ version: "sdv_1", allocatedBytes: 10, at: 1 }] }];
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, stickyDisks: holdings } } });
		await vi.waitFor(() => expect(recordStickyHoldings).toHaveBeenCalledWith(hostId, expect.any(Number), holdings));
		host.send({ type: "heartbeat", heartbeat: { capacity } });
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, stickyDisks: [] } } });
		await vi.waitFor(() => expect(recordStickyHoldings).toHaveBeenLastCalledWith(hostId, expect.any(Number), []));
		expect(recordStickyHoldings).toHaveBeenCalledTimes(2);
	});

	it("answers disk.locate for the connection's own host, passing on the catalogue's refusals", async () => {
		const answer = { mapDigest: "sha256:aa", holders: [{ hostId: "host_b", address: "fd00::2" }], grant: "p.s" };
		const locateDisk = vi.fn(async (_hostId: string, params: { readonly version: string }) => {
			if (params.version === "sdv_missing") throw new KantelError("not_found", "No such version of that sticky disk");
			if (params.version === "sdv_broken") throw new Error("the database is down: secret details");
			return answer;
		});
		const { host, hostId, result } = await setup({ locateDisk });
		const params = { kind: "sticky", objectId: "sdk_1", version: "sdv_1" };
		host.send({ type: "call", id: "l1", method: "disk.locate", params: { ...params, hostId: "host_other" } });
		expect(await result("l1")).toEqual({ type: "result", id: "l1", result: answer });
		expect(locateDisk).toHaveBeenCalledWith(hostId, params);
		host.send({ type: "call", id: "l2", method: "disk.locate", params: { ...params, version: "sdv_missing" } });
		expect((await result("l2"))?.error).toEqual({ code: "not_found", message: "No such version of that sticky disk" });
		host.send({ type: "call", id: "l3", method: "disk.locate", params: { ...params, version: "sdv_broken" } });
		expect((await result("l3"))?.error).toEqual({ code: "unavailable", message: "Kantel can't locate disks now" });
		host.send({ type: "call", id: "l4", method: "disk.locate", params: { kind: "sticky", objectId: "sdk_1" } });
		expect((await result("l4"))?.error?.code).toBe("invalid");
		expect(locateDisk).toHaveBeenCalledTimes(3);
	});
});
