import { describe, expect, it } from "vitest";
import type { Host, Pool } from "./compute-model.ts";
import { createComputeFixtures, HOSTS } from "./fixtures.ts";
import { looksLikeOrigin } from "./host-join.tsx";
import { poolGroups, poolNameError, poolSummaryText } from "./host-pools.tsx";
import { limitBytes, limitText, parseLabels } from "./hosts-page.tsx";

describe("the public URL field", () => {
	it("takes an origin, with or without its trailing slash", () => {
		expect(looksLikeOrigin("https://kantel.example.com")).toBe(true);
		expect(looksLikeOrigin(" http://10.0.0.5:58090/ ")).toBe(true);
	});

	it("refuses a path, a query or something that isn't http(s)", () => {
		expect(looksLikeOrigin("https://kantel.example.com/console")).toBe(false);
		expect(looksLikeOrigin("https://kantel.example.com?x=1")).toBe(false);
		expect(looksLikeOrigin("kantel.example.com")).toBe(false);
		expect(looksLikeOrigin("ftp://kantel.example.com")).toBe(false);
	});
});

describe("a new host's labels", () => {
	it("reads key=value pairs, skipping empty ones", () => {
		expect(parseLabels("site=fsn1, tier=microvm,")).toEqual({ labels: { site: "fsn1", tier: "microvm" } });
	});

	it("says which pair is wrong", () => {
		expect(parseLabels("site=fsn1, tier").error).toBe("Write tier as key=value, such as site=fsn1.");
	});
});

describe("a saved snapshot limit as typed", () => {
	it("reads whole and decimal GB", () => {
		expect(limitBytes("50")).toBe(50 * 1024 ** 3);
		expect(limitBytes(" 1.5 ")).toBe(1.5 * 1024 ** 3);
	});

	it("refuses nothing, zero, a negative number and a unit", () => {
		for (const text of ["", "0", "-5", "50 GB", "abc"]) expect(limitBytes(text)).toBeUndefined();
	});
});

describe("a saved snapshot limit to edit", () => {
	it("shows the limit unrounded, so reading it back gives the same bytes", () => {
		expect(limitText(50 * 1024 ** 3)).toBe("50");
		expect(limitText(1.25 * 1024 ** 3)).toBe("1.25");
		for (const bytes of [1, 1_000, Math.round(0.01 * 1024 ** 3), 1.25 * 1024 ** 3 + 7, 123_456_789_012]) {
			const text = limitText(bytes);
			expect(text).toMatch(/^\d+(\.\d+)?$/);
			expect(limitBytes(text)).toBe(bytes);
		}
	});
});

describe("the sample hosts' public URL", () => {
	it("starts at a default install's loopback, and the join command carries it", async () => {
		const hosts = createComputeFixtures({ hosting: "self-hosted" }).hosts;
		const url = await hosts?.publicUrl?.get();
		expect(url).toMatchObject({ publicUrl: "http://127.0.0.1:58090", setHere: false, loopback: true });
		expect((await hosts?.join({}))?.command).toContain("--url http://127.0.0.1:58090 ");
	});

	it("sets one hosts can reach, then goes back to the deployment's", async () => {
		const hosts = createComputeFixtures({ hosting: "self-hosted" }).hosts;
		const set = await hosts?.publicUrl?.set("https://kantel.example.com/");
		expect(set).toMatchObject({ publicUrl: "https://kantel.example.com", setHere: true, loopback: false });
		expect((await hosts?.join({}))?.command).toContain("--url https://kantel.example.com ");
		const cleared = await hosts?.publicUrl?.set(null);
		expect(cleared).toMatchObject({ publicUrl: "http://127.0.0.1:58090", setHere: false });
	});
});

describe("hosts by pool", () => {
	const pool = (id: string, name: string, isDefault = false): Pool => ({
		id,
		name,
		default: isDefault,
		hosts: 0,
		createdAt: 0,
	});
	const host = (id: string, poolId?: string): Host => {
		const { poolId: _, ...sample } = HOSTS[0] as Host;
		return { ...sample, id, ...(poolId === undefined ? {} : { poolId }) };
	};

	it("lists the default first, then the rest by name, an empty pool too", () => {
		const groups = poolGroups(
			[host("a", "pool_ci"), host("b", "pool_default")],
			[pool("pool_workflows", "workflows"), pool("pool_ci", "ci"), pool("pool_default", "default", true)],
		);
		expect(groups.map((group) => [group.pool.name, group.hosts.map((each) => each.id)])).toEqual([
			["default", ["b"]],
			["ci", ["a"]],
			["workflows", []],
		]);
	});

	it("puts a host in no known pool in the default, as Kantel does", () => {
		const groups = poolGroups(
			[host("a"), host("b", "pool_gone")],
			[pool("pool_ci", "ci"), pool("pool_default", "default", true)],
		);
		expect(groups[0]?.hosts.map((each) => each.id)).toEqual(["a", "b"]);
		expect(groups[1]?.hosts).toEqual([]);
	});

	it("says what a pool's hosts hold, or that it has none", () => {
		expect(poolSummaryText([])).toBe("No hosts");
		expect(poolSummaryText(HOSTS.slice(0, 2))).toBe("2 hosts, 1 online, 50 of 128 vCPU in use, 133 sandboxes");
	});

	it("takes a pool's name only as the API does", () => {
		expect(poolNameError("ci-runners")).toBeUndefined();
		expect(poolNameError("")).toBeUndefined();
		for (const name of ["CI", "-ci", "ci-", "ci runners", "ci_runners"]) expect(poolNameError(name)).toBeDefined();
	});
});

describe("the sample hosts' pools", () => {
	it("move only a drained host with no sandboxes, with the API's reasons", async () => {
		const { hosts } = createComputeFixtures({ hostOverrides: { hst_mac: { state: "draining" } } });
		if (hosts?.move === undefined || hosts.pools === undefined) throw new Error("No pools in the sample");
		await expect(hosts.move("hst_hetzner_1", "pool_workflows")).rejects.toThrow("Drain the host");
		await expect(hosts.move("hst_hetzner_2", "pool_workflows")).rejects.toThrow("still has sandboxes");
		expect((await hosts.move("hst_mac", "pool_workflows")).poolId).toBe("pool_workflows");
		expect((await hosts.pools.list()).find((each) => each.id === "pool_workflows")?.hosts).toBe(1);
	});

	it("delete only an empty pool that isn't the default", async () => {
		const { hosts } = createComputeFixtures();
		const pools = hosts?.pools;
		if (pools === undefined) throw new Error("No pools in the sample");
		await expect(pools.remove("pool_default")).rejects.toThrow("default pool");
		await expect(pools.remove("pool_ci")).rejects.toThrow("2 hosts");
		await pools.remove("pool_workflows");
		expect((await pools.list()).map((each) => each.name)).toEqual(["default", "ci"]);
	});
});
