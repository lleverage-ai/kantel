import { describe, expect, it } from "vitest";
import type { HostFacts } from "../src/protocol.ts";
import { type Candidate, isRefusal, place } from "../src/scheduler.ts";
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

	it("says why when nothing fits", () => {
		const refused = place({ tier: "microvm", size: "default" }, []);
		expect(isRefusal(refused) && refused.reason).toMatch(/no hosts have joined/);
		const full = place({ tier: "microvm", size: "large" }, [candidate("small", capacity(1_000))]);
		expect(isRefusal(full) && full.reason).toMatch(/full/);
	});
});
