import { describe, expect, it } from "vitest";
import { HOST_FEATURES, type HostFacts } from "../src/protocol.ts";
import { type Candidate, customSizeName, diskFor, isRefusal, place, shapeOn } from "../src/scheduler.ts";
import type { HostRecord } from "../src/store.ts";

const facts: HostFacts = {
	version: "0.1.0",
	protocol: 1,
	os: "linux",
	arch: "amd64",
	kernel: "6.8",
	hostname: "h",
	cpus: 16,
	memoryMiB: 32_768,
	diskGiB: 500,
	kvm: true,
	nested: true,
	tiers: ["microvm", "isolate"],
	sizes: [
		{ name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 },
		{ name: "large", vcpus: 4, memoryMiB: 8192, diskGiB: 50 },
	],
	egress: "proxy",
};

const candidate = (id: string, change: Partial<HostRecord> = {}, extra: Partial<Candidate> = {}): Candidate => ({
	host: {
		id,
		name: id,
		labels: {},
		credentialHash: id,
		revoked: false,
		draining: false,
		joinedAt: 1,
		facts,
		capacity: { freeMemoryMiB: 16_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0.5, warm: {} },
		...change,
	},
	connected: true,
	reservedMemoryMiB: 0,
	reservedDiskGiB: 0,
	owners: new Set(),
	...extra,
});

/** The candidate's host makes custom shapes (a kantel-host that reports `custom-shapes`). */
const custom = (of: Candidate): Candidate => ({
	...of,
	host: {
		...of.host,
		facts: { ...(of.host.facts ?? facts), features: [HOST_FEATURES.customShapes] },
	},
});

const capacity = (freeMemoryMiB: number, warm: { [pool: string]: number } = {}, load1 = 0.5) => ({
	capacity: { freeMemoryMiB, freeDiskGiB: 400, running: 0, stopped: 0, load1, warm },
});

describe("place", () => {
	it("prefers a host with a warm sandbox of the size, then the most free memory", () => {
		const roomy = candidate("roomy", capacity(30_000));
		const warm = candidate("warm", capacity(4_000, { "microvm/default": 1 }));
		const chosen = place({ tier: "microvm", size: "default" }, [roomy, warm]);
		expect(isRefusal(chosen) ? chosen.reason : chosen.host.id).toBe("warm");
		const large = place({ tier: "microvm", size: "large" }, [roomy, warm]);
		expect(isRefusal(large) ? large.reason : large.host.id).toBe("roomy");
	});

	it("counts what was placed since a host's last report", () => {
		const a = candidate("a", capacity(10_000), { reservedMemoryMiB: 9_000 });
		const b = candidate("b", capacity(5_000));
		const chosen = place({ tier: "microvm", size: "default" }, [a, b]);
		expect(isRefusal(chosen) ? chosen.reason : chosen.host.id).toBe("b");
	});

	it("skips hosts that are revoked, draining, gone, unlabelled or without the tier", () => {
		const hosts = [
			candidate("revoked", { revoked: true }),
			candidate("draining", { draining: true }),
			candidate("gone", {}, { connected: false }),
			candidate("us", { labels: { region: "us" } }),
			candidate("isolates", { facts: { ...facts, tiers: ["isolate"] } }),
		];
		const refused = place({ tier: "microvm", size: "default", labels: { region: "eu" } }, hosts);
		expect(isRefusal(refused)).toBe(true);
		if (isRefusal(refused))
			expect(refused.reason).toMatch(/draining.*labels don't match.*no microvm tier.*not connected/);
		const eu = candidate("eu", { labels: { region: "eu" } });
		const chosen = place({ tier: "microvm", size: "default", labels: { region: "eu" } }, [...hosts, eu]);
		expect(isRefusal(chosen) ? chosen.reason : chosen.host.id).toBe("eu");
	});

	it("keeps an owner's isolates together", () => {
		const roomy = candidate("roomy", capacity(30_000));
		const theirs = candidate("theirs", capacity(2_000), { owners: new Set(["acct_1"]) });
		const chosen = place({ tier: "isolate", size: "isolate", owner: "acct_1" }, [roomy, theirs]);
		expect(isRefusal(chosen) ? chosen.reason : chosen.host.id).toBe("theirs");
		const other = place({ tier: "isolate", size: "isolate", owner: "acct_2" }, [roomy, theirs]);
		expect(isRefusal(other) ? other.reason : other.host.id).toBe("roomy");
	});

	it("places with no warm pools anywhere: the most free memory wins", () => {
		const a = candidate("a", capacity(8_000));
		const b = candidate("b", capacity(12_000));
		for (const request of [
			{ tier: "microvm", size: "default" },
			{ tier: "microvm", shape: { vcpus: 2, memoryMiB: 2048 } },
			{ tier: "microvm", shape: { vcpus: 3, memoryMiB: 6144 } },
		] as const) {
			const chosen = place(request, [a, custom(b)]);
			expect(isRefusal(chosen) ? chosen.reason : chosen.host.id).toBe("b");
			if (!isRefusal(chosen)) expect(chosen.warm).toBe(false);
		}
	});

	it("takes a shape a named size has as that size, so its warm pool serves it", () => {
		const warm = custom(candidate("warm", capacity(9_000, { "microvm/large": 1 })));
		const roomy = custom(candidate("roomy", capacity(30_000)));
		const chosen = place({ tier: "microvm", shape: { vcpus: 4, memoryMiB: 8192 } }, [roomy, warm]);
		expect(isRefusal(chosen) ? chosen.reason : [chosen.host.id, chosen.size.name, chosen.custom, chosen.warm]).toEqual([
			"warm",
			"large",
			false,
			true,
		]);
		// The pool is of another shape: no help to this one, which goes where there's most room.
		const other = place({ tier: "microvm", shape: { vcpus: 2, memoryMiB: 2048 } }, [roomy, warm]);
		expect(isRefusal(other) ? other.reason : [other.host.id, other.warm]).toEqual(["roomy", false]);
	});

	it("makes a custom shape on a host that makes them, never from a warm pool", () => {
		const shape = { vcpus: 5, memoryMiB: 10_240 };
		// A host that makes only its named sizes can't take it.
		const named = candidate("named", capacity(30_000, { "microvm/default": 2 }));
		const refused = place({ tier: "microvm", shape }, [named]);
		expect(isRefusal(refused) && refused.reason).toMatch(/5 vCPU and 10240 MiB.*only its named sizes/);
		const makes = custom(candidate("makes", capacity(20_000, { "microvm/default": 2 })));
		const chosen = place({ tier: "microvm", shape }, [named, makes]);
		if (isRefusal(chosen)) throw new Error(chosen.reason);
		expect(chosen.host.id).toBe("makes");
		expect(chosen.custom).toBe(true);
		expect(chosen.warm).toBe(false);
		// Its disk is the smallest named size's with at least its memory, else the largest's.
		expect(chosen.size).toEqual({ name: "custom-5c-10240m-50g", vcpus: 5, memoryMiB: 10_240, diskGiB: 50 });
		expect(diskFor(facts.sizes, 1024)).toBe(20);
		expect(diskFor(facts.sizes, 4096)).toBe(50);
		expect(diskFor([], 4096)).toBe(20);
		expect(customSizeName({ vcpus: 1, memoryMiB: 512, diskGiB: 20 })).toBe("custom-1c-512m-20g");
	});

	it("refuses a custom shape bigger than a host, or than its free memory", () => {
		const host = custom(candidate("h", capacity(6_000)));
		const tooMany = place({ tier: "microvm", shape: { vcpus: 32, memoryMiB: 4096 } }, [host]);
		expect(isRefusal(tooMany) && tooMany.reason).toMatch(/too small for that shape/);
		const full = place({ tier: "microvm", shape: { vcpus: 2, memoryMiB: 8192 } }, [host]);
		expect(isRefusal(full) && full.reason).toMatch(/full/);
	});

	it("books an isolate's nominal share, whatever memory it asked for", () => {
		const host = candidate("h", capacity(100));
		const chosen = place({ tier: "isolate", shape: { vcpus: 0, memoryMiB: 512 } }, [host]);
		if (isRefusal(chosen)) throw new Error(chosen.reason);
		expect(chosen.size.memoryMiB).toBe(64);
		expect(shapeOn(host.host, { tier: "isolate" })?.size.name).toBe("isolate");
	});

	it("says why when nothing fits", () => {
		const refused = place({ tier: "microvm", size: "default" }, []);
		expect(isRefusal(refused) && refused.reason).toMatch(/no hosts have joined/);
		const full = place({ tier: "microvm", size: "large" }, [candidate("small", capacity(1_000))]);
		expect(isRefusal(full) && full.reason).toMatch(/full/);
	});
});
