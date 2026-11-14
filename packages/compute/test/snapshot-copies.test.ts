// Two copies of each saved snapshot (docs/design/disk-store.md, "Phase 3 notes", Two copies): which holders keep a
// copy, and which host is picked for another.
import { describe, expect, it } from "vitest";
import {
	COPY_FETCH_MS,
	COPY_PASSED_OVER_MS,
	type CopiedSnapshot,
	type CopyHost,
	copyTarget,
	HOLDER_AWAY_MS,
	keepingCopies,
} from "../src/snapshot-copies.ts";
import type { StoredDiskHolder } from "../src/store.ts";

const AT = Date.UTC(2026, 10, 14);
const DIGEST = `sha256:${"1".repeat(64)}`;
const CPU = { vendor: "AuthenticAMD", family: 25, model: 97, featuresHash: "sha256:0123456789abcdef" };
const CPU_TEXT = "AuthenticAMD family 25 model 97, features sha256:0123456789abcdef";
const RUNTIME = "fc1.12/k6.1/img0.9.0@sha256:aa";

const host = (id: string, more: Partial<CopyHost> = {}): CopyHost => ({
	id,
	state: "online",
	poolId: "pool_a",
	arch: "x86_64",
	meshAddress: `fd00::${id.length}`,
	connected: true,
	features: ["disk-sync", "snapshot-sync"],
	freeDiskGb: 100,
	lastSeenAt: AT,
	...more,
});
const hostsOf = (...list: CopyHost[]) => new Map(list.map((each) => [each.id, each]));
const holder = (hostId: string, more: Partial<StoredDiskHolder> = {}): StoredDiskHolder => ({
	id: `snapshot:ssnap_1:disk:${hostId}`,
	kind: "snapshot",
	objectId: "ssnap_1",
	version: "disk",
	hostId,
	state: "held",
	since: AT - 60_000,
	mapDigest: DIGEST,
	ref: "ssnap_1",
	...more,
});
const snapshot: CopiedSnapshot = { ref: "ssnap_1", accountId: "acc_1", memory: false, sizeBytes: 5 * 1024 ** 3 };

describe("saved snapshot copies", () => {
	it("counts a copy on a host of the pool that isn't revoked, nor away for a day, and a fetch for a while", () => {
		const hosts = hostsOf(
			host("a"),
			host("b", { state: "unreachable", lastSeenAt: AT - HOLDER_AWAY_MS + 60_000 }),
			host("c", { state: "unreachable", lastSeenAt: AT - HOLDER_AWAY_MS }),
			host("d", { state: "revoked" }),
			host("e", { poolId: "pool_b" }),
			host("f", { state: "draining" }),
		);
		const holders = [
			holder("a"),
			holder("b"),
			holder("c"),
			holder("d"),
			holder("e"),
			holder("f"),
			holder("g"),
			holder("a", { id: "x", state: "deleting" }),
		];
		expect(keepingCopies(holders, hosts, "pool_a", AT).map((each) => each.hostId)).toEqual(["a", "b", "f"]);
		const fetching = (since: number) => [holder("a"), holder("b", { state: "fetching", since, mapDigest: undefined })];
		expect(keepingCopies(fetching(AT - COPY_FETCH_MS + 1), hostsOf(host("a"), host("b")), "pool_a", AT)).toHaveLength(
			2,
		);
		expect(keepingCopies(fetching(AT - COPY_FETCH_MS), hostsOf(host("a"), host("b")), "pool_a", AT)).toHaveLength(1);
	});

	it("picks the host of the pool with the most disk free that takes copies, and none once two keep one", () => {
		const hosts = hostsOf(
			host("a", { freeDiskGb: 900 }),
			host("b", { freeDiskGb: 200 }),
			host("c", { freeDiskGb: 300 }),
			host("draining", { state: "draining", freeDiskGb: 999 }),
			host("away", { connected: false, freeDiskGb: 999 }),
			host("other-pool", { poolId: "pool_b", freeDiskGb: 999 }),
			host("no-mesh", { meshAddress: undefined, freeDiskGb: 999 }),
			host("old", { features: ["disk-sync"], freeDiskGb: 999 }),
			host("arm", { arch: "aarch64", freeDiskGb: 999 }),
			host("theirs", { accountId: "acc_other", freeDiskGb: 999 }),
			host("full", { freeDiskGb: 4 }),
		);
		expect(copyTarget(snapshot, [holder("a")], hosts, "pool_a", AT)).toBe("c");
		// An account's own host takes its own account's.
		const own = hostsOf(...hosts.values(), host("mine", { accountId: "acc_1", freeDiskGb: 500 }));
		expect(copyTarget(snapshot, [holder("a")], own, "pool_a", AT)).toBe("mine");
		// Fetching one already counts; held twice, there is nothing to do.
		expect(copyTarget(snapshot, [holder("a"), holder("c", { state: "fetching" })], hosts, "pool_a", AT)).toBe(
			undefined,
		);
		expect(copyTarget(snapshot, [holder("a"), holder("b")], hosts, "pool_a", AT)).toBe(undefined);
		// A host left with the only copy, the other revoked: copied again from it.
		const revoked = hostsOf(...hosts.values(), host("gone", { state: "revoked" }));
		expect(copyTarget(snapshot, [holder("a"), holder("gone")], revoked, "pool_a", AT)).toBe("c");
		// None to copy from: nothing held with its map, or only on a host that can't serve it.
		expect(copyTarget(snapshot, [holder("a", { mapDigest: undefined })], hosts, "pool_a", AT)).toBe(undefined);
		expect(copyTarget(snapshot, [holder("away")], hosts, "pool_a", AT)).toBe(undefined);
		// A pool of one host.
		expect(copyTarget(snapshot, [holder("a")], hostsOf(host("a")), "pool_a", AT)).toBe(undefined);
	});

	it("prefers a host its memory restores on, then one on its runtime, and passes over one asked that didn't take it", () => {
		const hosts = hostsOf(
			host("a", { cpuFingerprint: CPU_TEXT, runtimeFingerprints: [RUNTIME] }),
			host("roomy", { freeDiskGb: 900 }),
			host("same-runtime", { runtimeFingerprints: [RUNTIME], cpuFingerprint: "other", freeDiskGb: 200 }),
			host("restores", { cpuFingerprint: CPU_TEXT, runtimeFingerprints: [RUNTIME], freeDiskGb: 150 }),
		);
		const withMemory = { ...snapshot, memory: true, cpu: CPU, runtime: RUNTIME };
		expect(copyTarget(withMemory, [holder("a")], hosts, "pool_a", AT)).toBe("restores");
		// Without memory, a host on its runtime (which has its root image) before one with more room, the roomier of two.
		expect(copyTarget({ ...withMemory, memory: false }, [holder("a")], hosts, "pool_a", AT)).toBe("same-runtime");
		// Asked a little while ago and not holding it: another is picked, until it has been a while.
		const asked = { ...withMemory, copying: { hostId: "restores", at: AT - COPY_PASSED_OVER_MS + 1 } };
		expect(copyTarget(asked, [holder("a")], hosts, "pool_a", AT)).toBe("same-runtime");
		const longAgo = { ...withMemory, copying: { hostId: "restores", at: AT - COPY_PASSED_OVER_MS } };
		expect(copyTarget(longAgo, [holder("a")], hosts, "pool_a", AT)).toBe("restores");
		// A host the backend says nothing of features of (the stub) takes copies.
		expect(
			copyTarget(snapshot, [holder("a")], hostsOf(host("a"), host("stub", { features: undefined })), "pool_a", AT),
		).toBe("stub");
	});
});
