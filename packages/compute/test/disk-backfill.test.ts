// Backfill of a synced pool's sticky disks (docs/design/disk-store.md, 2d, "Backfill"): which heads each host should
// hold, where it stands on each, and which fetches a pass sends.
import { describe, expect, it } from "vitest";
import {
	BACKFILL_HEADROOM_BYTES,
	BACKFILL_HOST_FETCHES,
	type BackfillHost,
	type BackfillInput,
	backfillFetches,
	planStickyBackfill,
} from "../src/disk-backfill.ts";
import {
	STICKY_PREFETCH_MS,
	type StoredDiskHolder,
	type StoredStickyDisk,
	type StoredStickyDiskVersion,
} from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 17);
const GIB = 1024 ** 3;

const host = (id: string, more: Partial<BackfillHost> = {}): BackfillHost => ({
	id,
	state: "online",
	poolId: "pool_ci",
	connected: true,
	features: ["disk-sync"],
	freeDiskGb: 1000,
	meshAddress: `fd00::${id.length}`,
	...more,
});

const disk = (id: string, more: Partial<StoredStickyDisk> = {}): StoredStickyDisk => ({
	id,
	accountId: "acc_1",
	name: id,
	sizeGb: 200,
	head: `${id}_v`,
	poolId: "pool_ci",
	ranOn: { host_a: NOW - 60_000 },
	createdAt: 1,
	updatedAt: 1,
	...more,
});

const head = (
	diskId: string,
	createdAt: number,
	more: Partial<StoredStickyDiskVersion> = {},
): StoredStickyDiskVersion => ({
	id: `${diskId}_v`,
	diskId,
	accountId: "acc_1",
	hostId: "host_a",
	sandboxId: "sbx_1",
	sizeBytes: 200 * GIB,
	allocatedBytes: 20 * GIB,
	seq: 1,
	createdAt,
	mapDigest: `sha256:${"1".repeat(64)}`,
	...more,
});

const held = (diskId: string, hostId: string, state: StoredDiskHolder["state"] = "held"): StoredDiskHolder => ({
	id: `sticky:${diskId}:${diskId}_v:${hostId}`,
	kind: "sticky",
	objectId: diskId,
	version: `${diskId}_v`,
	hostId,
	state,
	since: 1,
});

function input(
	more: Partial<Omit<BackfillInput, "holders">> & { holders?: readonly StoredDiskHolder[] } = {},
): BackfillInput {
	const disks = more.disks ?? [disk("sdk_1")];
	const holders = new Map<string, Map<string, StoredDiskHolder[]>>();
	for (const each of more.holders ?? disks.map((d) => held(d.id, "host_a"))) {
		const versions = holders.get(each.objectId) ?? new Map<string, StoredDiskHolder[]>();
		versions.set(each.version, [...(versions.get(each.version) ?? []), each]);
		holders.set(each.objectId, versions);
	}
	return {
		now: NOW,
		syncing: new Set(["pool_ci"]),
		hosts: [host("host_a"), host("host_new")],
		disks,
		heads: more.heads ?? new Map(disks.map((d, i) => [d.id, head(d.id, NOW - (i + 1) * 60_000)])),
		...more,
		holders,
	};
}

const states = (plans: ReturnType<typeof planStickyBackfill>, hostId: string) =>
	plans.find((plan) => plan.hostId === hostId)?.items.map((item) => [item.diskId, item.state]);

describe("sticky disk backfill", () => {
	it("has a host that never ran a pool's disk fetch its head from the host that holds it", () => {
		const plans = planStickyBackfill(input());
		expect(states(plans, "host_a")).toEqual([["sdk_1", "held"]]);
		expect(states(plans, "host_new")).toEqual([["sdk_1", "missing"]]);
		expect(backfillFetches(plans)).toEqual([{ hostId: "host_new", diskId: "sdk_1", version: "sdk_1_v" }]);
	});

	it("leaves out disks nothing in the pool used for a week, deleted ones, other pools' and unmapped heads", () => {
		const disks = [
			disk("old", { ranOn: { host_a: NOW - STICKY_PREFETCH_MS - 1 } }),
			disk("gone", { deletedAt: NOW - 1 }),
			disk("other", { poolId: "pool_other" }),
			disk("unmapped"),
			disk("headless", { head: undefined }),
		];
		const heads = new Map(disks.map((d) => [d.id, head(d.id, NOW)]));
		heads.set("unmapped", head("unmapped", NOW, { mapDigest: undefined }));
		const plans = planStickyBackfill(input({ disks, heads }));
		expect(states(plans, "host_new")).toEqual([]);
	});

	it("lists only pools with sync on, and no revoked host", () => {
		const plans = planStickyBackfill(
			input({
				syncing: new Set(["pool_ci"]),
				hosts: [host("host_a"), host("host_gone", { state: "revoked" }), host("host_off", { poolId: "pool_off" })],
			}),
		);
		expect(plans.map((plan) => plan.hostId)).toEqual(["host_a"]);
	});

	it("keeps an account's own host to that account's disks", () => {
		const disks = [disk("mine"), disk("theirs", { accountId: "acc_2" })];
		const plans = planStickyBackfill(
			input({ disks, hosts: [host("host_a"), host("host_new", { accountId: "acc_1" })] }),
		);
		expect(states(plans, "host_new")).toEqual([["mine", "missing"]]);
	});

	it("fetches newest heads first, a few at a time, counting what the host is already fetching", () => {
		const disks = ["d1", "d2", "d3", "d4"].map((id) => disk(id));
		// d1 committed most lately, d4 longest ago.
		const plans = planStickyBackfill(input({ disks }));
		expect(states(plans, "host_new")).toEqual([
			["d1", "missing"],
			["d2", "missing"],
			["d3", "waiting"],
			["d4", "waiting"],
		]);
		expect(BACKFILL_HOST_FETCHES).toBe(2);
		expect(backfillFetches(plans).map((send) => send.diskId)).toEqual(["d1", "d2"]);

		// A sticky fetch it reports, and a template copy it is fetching, take its two.
		const busy = planStickyBackfill(
			input({
				disks,
				holders: [...disks.map((d) => held(d.id, "host_a")), held("d4", "host_new", "fetching")],
				otherFetches: new Map([["host_new", 1]]),
			}),
		);
		expect(states(busy, "host_new")).toEqual([
			["d1", "waiting"],
			["d2", "waiting"],
			["d3", "waiting"],
			["d4", "fetching"],
		]);
		expect(backfillFetches(busy)).toEqual([]);
	});

	it("counts a head told lately as under way, and doesn't send it again", () => {
		const disks = ["d1", "d2", "d3"].map((id) => disk(id));
		const askedLately = (hostId: string, version: string) => hostId === "host_new" && version === "d1_v";
		const plans = planStickyBackfill(input({ disks, askedLately }));
		expect(states(plans, "host_new")).toEqual([
			["d1", "missing"],
			["d2", "missing"],
			["d3", "waiting"],
		]);
		expect(backfillFetches(plans, askedLately).map((send) => send.diskId)).toEqual(["d2"]);
	});

	it("sends nothing to a host that drains, is away, or doesn't sync, but still says what it is missing", () => {
		for (const [more, paused] of [
			[{ state: "draining" }, "draining"],
			[{ state: "unreachable" }, "away"],
			[{ connected: false }, "away"],
			[{ features: ["egress-policy"] }, "no-sync"],
			[{ meshAddress: undefined }, "no-sync"],
		] as const) {
			const plans = planStickyBackfill(input({ hosts: [host("host_a"), host("host_new", more)] }));
			expect(plans.find((plan) => plan.hostId === "host_new")).toMatchObject({
				paused,
				items: [{ diskId: "sdk_1", state: "missing" }],
			});
			expect(backfillFetches(plans)).toEqual([]);
		}
	});

	it("says when no host that can serve it holds the head, or the host hasn't room for it", () => {
		// Its only holder is away.
		const away = planStickyBackfill(input({ hosts: [host("host_a", { connected: false }), host("host_new")] }));
		expect(states(away, "host_new")).toEqual([["sdk_1", "no-source"]]);
		// A draining holder still serves.
		const draining = planStickyBackfill(input({ hosts: [host("host_a", { state: "draining" }), host("host_new")] }));
		expect(states(draining, "host_new")).toEqual([["sdk_1", "missing"]]);
		// 20 GiB and the headroom need 30 GiB free.
		const full = planStickyBackfill(
			input({
				hosts: [host("host_a"), host("host_new", { freeDiskGb: (20 * GIB + BACKFILL_HEADROOM_BYTES - 1) / GIB })],
			}),
		);
		expect(states(full, "host_new")).toEqual([["sdk_1", "no-room"]]);
		// Room for one of two heads: the newer goes, the other waits for room.
		const disks = [disk("d1"), disk("d2")];
		const one = planStickyBackfill(
			input({
				disks,
				hosts: [host("host_a"), host("host_new", { freeDiskGb: (30 * GIB + BACKFILL_HEADROOM_BYTES) / GIB })],
			}),
		);
		expect(states(one, "host_new")).toEqual([
			["d1", "missing"],
			["d2", "no-room"],
		]);
	});
});
