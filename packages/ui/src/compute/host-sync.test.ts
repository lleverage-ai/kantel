import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Host, HostSyncFetch, HostSync as HostSyncModel } from "./compute-model.ts";
import { fetchRateText } from "./host-peers.tsx";
import { poolSyncText } from "./host-pools.tsx";
import {
	fetchKindText,
	fetchPercent,
	fetchProgressText,
	HostSync,
	syncDiskState,
	syncedUp,
	syncPausedText,
	syncSummaryText,
} from "./host-sync.tsx";

const GB = 1024 ** 3;
const disk = (name: string, state: HostSyncModel["disks"][number]["state"]) => ({
	diskId: `sdk_${name}`,
	name,
	version: `sdv_${name}`,
	state,
	allocatedBytes: 10 * GB,
	committedAt: 1,
});
const fetch: HostSyncFetch = {
	kind: "sticky",
	objectId: "sdk_cache",
	version: "sdv_cache",
	state: "running",
	blocks: 2560,
	blocksInPlace: 1024,
	bytes: 1.5 * GB,
	totalBytes: 10 * GB,
};

describe("a host's sync in words", () => {
	it("counts the heads it holds", () => {
		expect(syncSummaryText({ disks: [] })).toBe("No disks to hold");
		expect(syncSummaryText({ disks: [disk("a", "held")] })).toBe("Holds its 1 disk");
		expect(syncSummaryText({ disks: [disk("a", "held"), disk("b", "held")] })).toBe("Holds all 2 disks");
		expect(syncSummaryText({ disks: [disk("a", "held"), disk("b", "fetching"), disk("c", "missing")] })).toBe(
			"Holds 1 of 3 disks",
		);
	});

	it("names each state and why it isn't fetching", () => {
		expect(syncDiskState("held")).toEqual({ status: "done", text: "Held" });
		expect(syncDiskState("fetching").status).toBe("working");
		expect(syncDiskState("failed").status).toBe("error");
		expect(syncDiskState("no-source").text).toBe("No copy to fetch");
		expect(syncPausedText("draining")).toMatch(/^Draining/);
		expect(syncPausedText("away")).toMatch(/^Not connected/);
	});

	it("says how far a fetch has got, rounding down so 100% is done", () => {
		expect(fetchPercent(fetch)).toBe(40);
		expect(fetchPercent({ blocks: 3, blocksInPlace: 2 })).toBe(66);
		expect(fetchPercent({ blocks: 0, blocksInPlace: 0 })).toBe(0);
		expect(fetchProgressText(fetch)).toBe("40% of 10 GB in place, 1.5 GB fetched");
		expect(fetchProgressText({ ...fetch, bytes: undefined })).toBe("40% of 10 GB in place");
		expect(fetchProgressText({ ...fetch, state: "queued", blocks: 0, blocksInPlace: 0 })).toBe("Waiting its turn");
		expect(fetchKindText("template")).toBe("Template snapshot");
		expect(fetchKindText("relay")).toBe("relay");
	});

	it("rates a peer's fetches in bits a second", () => {
		expect(fetchRateText(undefined)).toBe("Not measured");
		expect(fetchRateText(117_500_000)).toBe("940 Mbit/s");
		expect(fetchRateText(400_000)).toBe("3.2 Mbit/s");
		expect(fetchRateText(250_000_000)).toBe("2.0 Gbit/s");
	});
});

describe("a pool's hosts in sync", () => {
	const host = (sync: HostSyncModel | undefined) => ({ sync }) as unknown as Host;
	it("counts the hosts that hold every head, those fetching and those stuck", () => {
		expect(syncedUp(host({ disks: [disk("a", "held")], fetches: [] }))).toBe(true);
		expect(syncedUp(host({ paused: "draining", disks: [disk("a", "held")], fetches: [] }))).toBe(false);
		expect(syncedUp(host(undefined))).toBe(false);
		expect(poolSyncText([host(undefined)])).toBeUndefined();
		expect(poolSyncText([host({ disks: [disk("a", "held")], fetches: [] })])).toBe("Its host is in sync");
		expect(
			poolSyncText([
				host({ disks: [disk("a", "held")], fetches: [] }),
				host({ disks: [disk("a", "fetching")], fetches: [] }),
				host({ disks: [disk("a", "failed")], fetches: [] }),
				host(undefined),
			]),
		).toBe("1 of 3 hosts in sync, 1 fetching, 1 stuck");
	});
});

describe("a host's sync panel", () => {
	const render = (sync: HostSyncModel | undefined, narrow = false) =>
		renderToStaticMarkup(
			createElement(HostSync, {
				host: { name: "ci-6", state: "online", ...(sync === undefined ? {} : { sync }) },
				narrow,
			}),
		);

	it("shows each head with its fetch's progress, and the other fetches apart", () => {
		const html = render({
			disks: [disk("cache", "fetching"), disk("git", "held")],
			fetches: [fetch, { ...fetch, kind: "template", objectId: "tsn_1", version: "1", state: "failed", error: "gone" }],
		});
		expect(html).toContain("Holds 1 of 2 disks");
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="1024"');
		expect(html).toContain("40% of 10 GB in place");
		expect(html).toContain("Other fetches");
		expect(html).toContain("Template snapshot");
		expect(html).toContain("gone");
		expect(render({ disks: [disk("cache", "fetching")], fetches: [fetch] }, true)).toContain("data-sync-disk");
	});

	it("says when its pool doesn't sync", () => {
		expect(render(undefined)).toContain("Its pool doesn&#x27;t sync disks");
	});
});
