import { describe, expect, it } from "vitest";
import type { StickyDisk, StickyDiskPool, StickyDiskVersion } from "./compute-model.ts";
import { FIXTURE_NOW, LLEVERAGE, STICKY_DISKS } from "./fixtures.ts";
import {
	allocatedText,
	allocatedTotal,
	defaultPoolId,
	groupTitle,
	headVersion,
	hostsText,
	hostsTitle,
	orderedPools,
	poolChoiceLabel,
	sizeGbError,
	sizeGbText,
	stickyDiskGroups,
	stickyDiskHosts,
	stickyDiskNameError,
	versionsText,
} from "./sticky-disks.ts";

const GIB = 1024 ** 3;

const pool = (id: string, name: string, extra: Partial<StickyDiskPool> = {}): StickyDiskPool => ({
	id,
	name,
	default: false,
	hosts: 1,
	createdAt: FIXTURE_NOW,
	...extra,
});

const POOLS: readonly StickyDiskPool[] = [
	pool("pool_ci", "ci"),
	pool("pool_shared", "default", { default: true, shared: true }),
	pool("pool_default", "default", { default: true }),
	pool("pool_agents", "agents"),
];

const version = (id: string, hostId: string, allocatedGb: number, hostName?: string): StickyDiskVersion => ({
	id,
	hostId,
	...(hostName === undefined ? {} : { hostName }),
	sizeBytes: 150 * GIB,
	allocatedBytes: allocatedGb * GIB,
	createdAt: FIXTURE_NOW,
});

const disk = (name: string, poolId?: string, versions: readonly StickyDiskVersion[] = []): StickyDisk => ({
	id: `sdk_${name}`,
	accountId: LLEVERAGE.id,
	name,
	sizeGb: 150,
	versions,
	...(poolId === undefined ? {} : { poolId }),
	createdAt: FIXTURE_NOW,
});

describe("sticky disks by pool", () => {
	it("lists the account's pools default first, then shared ones, then pools it can't see, then none", () => {
		const groups = stickyDiskGroups(
			[
				disk("zeta", "pool_ci"),
				disk("loose"),
				disk("alpha", "pool_ci"),
				disk("home", "pool_default"),
				disk("theirs", "pool_hidden"),
				disk("common", "pool_shared"),
			],
			POOLS,
		);
		expect(groups.map((group) => [group.id, group.disks.map((each) => each.name)])).toEqual([
			["pool_default", ["home"]],
			["pool_ci", ["alpha", "zeta"]],
			["pool_shared", ["common"]],
			["pool_hidden", ["theirs"]],
			["", ["loose"]],
		]);
		expect(groups.map((group) => groupTitle(group))).toEqual([
			"default",
			"ci",
			"default",
			"Shared pool",
			"No pool yet",
		]);
		// Pools that couldn't be read: a pool not known is named by its ID.
		expect(groups.map((group) => groupTitle(group, false))).toEqual([
			"default",
			"ci",
			"default",
			"pool_hidden",
			"No pool yet",
		]);
	});

	it("leaves out pools with no disks, and lists none for no disks", () => {
		expect(stickyDiskGroups([disk("ci-cache", "pool_ci")], POOLS).map((group) => group.id)).toEqual(["pool_ci"]);
		expect(stickyDiskGroups([], POOLS)).toEqual([]);
	});

	it("groups the sample disks into ci, default and no pool", () => {
		const groups = stickyDiskGroups(STICKY_DISKS, [
			pool("pool_default", "default", { default: true }),
			pool("pool_ci", "ci"),
		]);
		expect(groups.map((group) => [groupTitle(group), group.disks.length])).toEqual([
			["default", 2],
			["ci", 2],
			["No pool yet", 1],
		]);
	});
});

describe("a sticky disk's hosts", () => {
	const ciCache = disk("ci-cache", "pool_ci", [
		version("sdv_4", "hst_1", 9, "hetzner-fsn1-01"),
		version("sdv_3", "hst_2", 8, "hetzner-fsn1-02"),
		version("sdv_2", "hst_1", 8.5, "hetzner-fsn1-01"),
		version("sdv_1", "hst_shared", 30),
	]);

	it("adds up each host's versions, the one taking most first", () => {
		expect(stickyDiskHosts(ciCache)).toEqual([
			{ hostId: "hst_shared", versions: 1, allocatedBytes: 30 * GIB },
			{ hostId: "hst_1", hostName: "hetzner-fsn1-01", versions: 2, allocatedBytes: 17.5 * GIB },
			{ hostId: "hst_2", hostName: "hetzner-fsn1-02", versions: 1, allocatedBytes: 8 * GIB },
		]);
		expect(stickyDiskHosts(disk("empty"))).toEqual([]);
	});

	it("names a row's hosts in one line, a shared one as such, with each host's space on hover", () => {
		const hosts = stickyDiskHosts(ciCache);
		expect(hostsText(hosts)).toBe("Shared host and 2 more");
		expect(hostsText(hosts.slice(1, 2))).toBe("hetzner-fsn1-01");
		expect(hostsText([])).toBeUndefined();
		expect(hostsTitle(hosts)).toBe("Shared host: 30 GB\nhetzner-fsn1-01: 18 GB\nhetzner-fsn1-02: 8.0 GB");
	});

	it("totals what its versions take, with nothing for none", () => {
		expect(allocatedTotal(ciCache)).toBe(55.5 * GIB);
		expect(allocatedText(allocatedTotal(ciCache))).toBe("56 GB");
		expect(allocatedText(1.5 * GIB)).toBe("1.5 GB");
		expect(allocatedText(0)).toBeUndefined();
	});

	it("finds its head among the versions listed", () => {
		expect(headVersion({ ...ciCache, head: "sdv_3" })?.hostId).toBe("hst_2");
		expect(headVersion(ciCache)).toBeUndefined();
		expect(headVersion({ ...ciCache, head: "sdv_gone" })).toBeUndefined();
	});

	it("counts versions, saying when there may be more than the API lists", () => {
		expect(versionsText(0)).toBe("0");
		expect(versionsText(4)).toBe("4");
		expect(versionsText(20)).toBe("20+");
	});

	it("writes a size in GB", () => {
		expect(sizeGbText(150)).toBe("150 GB");
		expect(sizeGbText(2048)).toBe("2,048 GB");
	});
});

describe("a new sticky disk", () => {
	it("takes a name as the API does", () => {
		for (const name of ["ci-cache", "a", "0-docker", "x".repeat(63)]) expect(stickyDiskNameError(name)).toBeUndefined();
		for (const name of ["CI", "-cache", "ci_cache", "ci cache", "x".repeat(64)]) {
			expect(stickyDiskNameError(name)).toBeDefined();
		}
		expect(stickyDiskNameError("")).toBeUndefined();
	});

	it("takes a whole number of GB from 1 to 2048", () => {
		for (const size of ["1", "150", "2048"]) expect(sizeGbError(size)).toBeUndefined();
		for (const size of ["0", "2049", "1.5", "-3", "ten"])
			expect(sizeGbError(size)).toBe("A whole number of GB from 1 to 2,048.");
		expect(sizeGbError(" ")).toBeUndefined();
	});

	it("starts on the account's default pool, else a shared default, else the first, else none", () => {
		expect(defaultPoolId(POOLS)).toBe("pool_default");
		expect(defaultPoolId(POOLS.filter((each) => each.id !== "pool_default"))).toBe("pool_shared");
		expect(defaultPoolId([pool("pool_ci", "ci")])).toBe("pool_ci");
		expect(defaultPoolId([])).toBe("");
	});

	it("lists the pools to choose from, the account's own first, saying which is shared or the default", () => {
		expect(orderedPools(POOLS).map(poolChoiceLabel)).toEqual(["default", "agents", "ci", "default (shared)"]);
		expect(poolChoiceLabel(pool("pool_ci", "ci", { default: true }))).toBe("ci (default)");
		expect(poolChoiceLabel(pool("pool_ci", "ci", { default: true, shared: true }))).toBe("ci (shared, default)");
	});
});
