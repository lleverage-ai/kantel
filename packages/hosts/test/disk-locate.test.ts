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

	it("sends a host its welcome again on the first heartbeat once a key it was told of begins signing", async () => {
		const at = Date.UTC(2026, 10, 13);
		let keys: HostGrantKey[] = [
			{ id: "key_1", publicKey: "A".repeat(43) },
			{ id: "key_2", publicKey: "B".repeat(43), from: at + 3 * 60_000 },
		];
		const { host, clock } = await setup({ grantKeys: async () => keys });
		const welcomes = () =>
			host.sent.filter((message) => message.type === "welcome").map((message) => message.welcome?.grantKey);
		const heartbeat = () => host.send({ type: "heartbeat", heartbeat: { capacity } });
		// Checked half a minute before its time: nothing to tell yet.
		clock.at = at + 3 * 60_000 - 30_000;
		heartbeat();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(welcomes()).toEqual(["A".repeat(43)]);
		// Its time comes within the minute between checks: on the next heartbeat, a host that holds only `grantKey` (one
		// from before rotation) is given the key that signs now.
		keys = [
			{ id: "key_2", publicKey: "B".repeat(43) },
			{ id: "key_1", publicKey: "A".repeat(43), until: at + 19 * 60_000 },
		];
		clock.at = at + 3 * 60_000;
		heartbeat();
		await vi.waitFor(() => expect(welcomes()).toEqual(["A".repeat(43), "B".repeat(43)]));
		// Then nothing more until something changes.
		heartbeat();
		clock.at += GRANT_KEYS_REFRESH_MS;
		heartbeat();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(welcomes()).toHaveLength(2);
	});

	it("passes each report's sticky disk holdings on, and none from a report that doesn't say", async () => {
		const recordHoldings = vi.fn(async () => undefined);
		const { host, hostId } = await setup({ recordHoldings });
		const holdings = [{ diskId: "sdk_1", versions: [{ version: "sdv_1", allocatedBytes: 10, at: 1 }] }];
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, stickyDisks: holdings } } });
		await vi.waitFor(() =>
			expect(recordHoldings).toHaveBeenCalledWith(hostId, expect.any(Number), { stickyDisks: holdings }),
		);
		host.send({ type: "heartbeat", heartbeat: { capacity } });
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, stickyDisks: [] } } });
		await vi.waitFor(() =>
			expect(recordHoldings).toHaveBeenLastCalledWith(hostId, expect.any(Number), { stickyDisks: [] }),
		);
		expect(recordHoldings).toHaveBeenCalledTimes(2);
	});

	it("passes each report's root filesystems on, leaving out a kind it doesn't know or that isn't shaped as holdings", async () => {
		const recordHoldings = vi.fn(async () => undefined);
		const { host, hostId } = await setup({ recordHoldings });
		const digest = `sha256:${"a".repeat(64)}`;
		const rootfs = [{ objectId: "b".repeat(64), versions: [{ version: "1", mapDigest: digest, allocatedBytes: 10 }] }];
		host.send({
			type: "heartbeat",
			heartbeat: { capacity: { ...capacity, holdings: { rootfs, sandbox: [{ objectId: "t", versions: [] }] } } },
		});
		await vi.waitFor(() =>
			expect(recordHoldings).toHaveBeenCalledWith(hostId, expect.any(Number), { objects: { rootfs } }),
		);
		// A version without a map digest: the kind says nothing, so nothing is passed on.
		const unmapped = [{ objectId: "b".repeat(64), versions: [{ version: "1", allocatedBytes: 10 }] }];
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, holdings: { rootfs: unmapped } } } });
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, holdings: { rootfs: [] } } } });
		await vi.waitFor(() =>
			expect(recordHoldings).toHaveBeenLastCalledWith(hostId, expect.any(Number), { objects: { rootfs: [] } }),
		);
		expect(recordHoldings).toHaveBeenCalledTimes(2);
		// Saved snapshots, beside them.
		const snapshot = [
			{ objectId: "snap_1", versions: [{ version: "disk", mapDigest: digest, allocatedBytes: 10, copy: true }] },
		];
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, holdings: { rootfs, snapshot } } } });
		await vi.waitFor(() =>
			expect(recordHoldings).toHaveBeenLastCalledWith(hostId, expect.any(Number), { objects: { rootfs, snapshot } }),
		);
	});

	it("passes each report's template snapshots on with what each was made on, dropping a fingerprint not shaped as one", async () => {
		const recordHoldings = vi.fn(async () => undefined);
		const { host, hostId } = await setup({ recordHoldings });
		const digest = `sha256:${"a".repeat(64)}`;
		const cpu = { vendor: "AuthenticAMD", family: 25, model: 97, featuresHash: "sha256:0123456789abcdef" };
		const runtime = "firecracker=v1.17.0;kernel=6.1.102+0123456789ab;sticky=2";
		const held = { version: "1", mapDigest: digest, allocatedBytes: 10, pool: "pool_a" };
		const template = [
			{ objectId: "tsn_1", versions: [{ ...held, cpu, runtime }] },
			{ objectId: "tsn_2", versions: [{ ...held, cpu: { vendor: "AuthenticAMD" }, runtime: 7 }] },
		];
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, holdings: { template } } } });
		await vi.waitFor(() =>
			expect(recordHoldings).toHaveBeenCalledWith(hostId, expect.any(Number), {
				objects: {
					template: [
						{ objectId: "tsn_1", versions: [{ ...held, cpu, runtime }] },
						{ objectId: "tsn_2", versions: [held] },
					],
				},
			}),
		);
	});

	it("passes each report's fetches on, with their progress, and none from a report not shaped as kantel-host sends it", async () => {
		const recordHoldings = vi.fn(async () => undefined);
		const { host, hostId } = await setup({ recordHoldings });
		const running = { kind: "sticky", objectId: "sdk_1", version: "sdv_1", state: "running", blocks: 10, inPlace: 4 };
		const failed = {
			kind: "template",
			objectId: "tsn_1",
			version: "1",
			state: "failed",
			blocks: 0,
			inPlace: 0,
			error: "x".repeat(5000),
		};
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, fetches: [running, failed] } } });
		await vi.waitFor(() =>
			expect(recordHoldings).toHaveBeenCalledWith(hostId, expect.any(Number), {
				fetches: [running, { ...failed, error: "x".repeat(1024) }],
			}),
		);
		// One fetch in a state Kantel doesn't know, or with a count that isn't one: the report says nothing of fetches.
		host.send({
			type: "heartbeat",
			heartbeat: { capacity: { ...capacity, fetches: [running, { ...running, state: "paused" }] } },
		});
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, fetches: [{ ...running, blocks: -1 }] } } });
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, fetches: [] } } });
		await vi.waitFor(() =>
			expect(recordHoldings).toHaveBeenLastCalledWith(hostId, expect.any(Number), { fetches: [] }),
		);
		expect(recordHoldings).toHaveBeenCalledTimes(2);
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
