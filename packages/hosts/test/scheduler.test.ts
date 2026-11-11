import { describe, expect, it } from "vitest";
import { HOST_FEATURES, type HostFacts } from "../src/protocol.ts";
import {
	buildFitsOn,
	type Candidate,
	customSizeName,
	diskFor,
	freeMemoryOn,
	isRefusal,
	place,
	shapeOn,
} from "../src/scheduler.ts";
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
		capacity: { freeMemoryMiB: 16_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0.5 },
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

const capacity = (freeMemoryMiB: number, load1 = 0.5) => ({
	capacity: { freeMemoryMiB, freeDiskGiB: 400, running: 0, stopped: 0, load1 },
});

describe("place", () => {
	it("prefers the most free memory, then the least loaded, whatever warm machines an older host reports", () => {
		const roomy = candidate("roomy", capacity(30_000));
		// A host from before warm pools were removed still reports them: placement no longer looks.
		const older = candidate("older", {
			capacity: { ...capacity(4_000).capacity, warm: { "microvm/default": 3 } } as HostRecord["capacity"],
		});
		const chosen = place({ tier: "microvm", size: "default" }, [older, roomy]);
		expect(isRefusal(chosen) ? chosen.reason : chosen.host.id).toBe("roomy");
		const idle = candidate("idle", capacity(30_000, 0.1));
		const busy = place({ tier: "microvm", size: "default" }, [roomy, idle]);
		expect(isRefusal(busy) ? busy.reason : busy.host.id).toBe("idle");
	});

	it("spreads by how full each host would be, its booked vCPUs as well as its memory", () => {
		// A host twice the size with a little more memory free, but fuller for its size, loses to the smaller, emptier one.
		const big = candidate("big", { facts: { ...facts, memoryMiB: 65_536, cpus: 32 }, ...capacity(22_000) });
		const small = candidate("small", capacity(20_000));
		const bySize = place({ tier: "microvm", size: "large" }, [big, small]);
		expect(isRefusal(bySize) ? bySize.reason : bySize.host.id).toBe("small");
		// Memory to spare but its CPUs booked: the other host, though it has less memory free.
		const booked = candidate("booked", capacity(24_000), { bookedVcpus: 14 });
		const idle = candidate("idle", capacity(16_000), { bookedVcpus: 0 });
		const byCpu = place({ tier: "microvm", size: "large" }, [booked, idle]);
		expect(isRefusal(byCpu) ? byCpu.reason : byCpu.host.id).toBe("idle");
		// vCPUs rank but never refuse: a host booked past its CPUs still takes a sandbox that fits its memory.
		const only = place({ tier: "microvm", size: "large" }, [candidate("only", capacity(16_000), { bookedVcpus: 40 })]);
		expect(isRefusal(only) ? only.reason : only.host.id).toBe("only");
	});

	it("counts what was placed since a host's last report", () => {
		const a = candidate("a", capacity(10_000), { reservedMemoryMiB: 9_000 });
		const b = candidate("b", capacity(5_000));
		const chosen = place({ tier: "microvm", size: "default" }, [a, b]);
		expect(isRefusal(chosen) ? chosen.reason : chosen.host.id).toBe("b");
	});

	it("charges what was placed on a host admitting by use in its own admission units", () => {
		const admission = {
			reservableMiB: 40_000,
			committableMiB: 5_120,
			startMiB: 1_024,
			headroomMiB: 1_024,
			headroomPercent: 25,
		};
		const memory = {
			mode: "used" as const,
			state: "ok" as const,
			...Object.fromEntries(
				[
					"totalMiB",
					"reserveMiB",
					"capacityMiB",
					"reservedMiB",
					"committedMiB",
					"guestUsedMiB",
					"residentMiB",
					"availableMiB",
					"swapUsedMiB",
				].map((k) => [k, 0]),
			),
			pressureSome: 0,
			pressureFull: 0,
			maxRatio: 2.5,
			// 5 GiB committable: a new 4 GiB microVM commits 1 GiB to start + 1 GiB of headroom, a 16 GiB one 1 + 4.
			admission,
		} as NonNullable<NonNullable<HostRecord["capacity"]>["memory"]>;
		// The largest single microVM it takes is 16 GiB (commitment 5 GiB).
		const byUse = { ...capacity(16_384).capacity, memory };
		expect(freeMemoryOn(byUse, [])).toBe(16_384);
		const fourGiB = { memoryMiB: 4_096 };
		// One 4 GiB create held leaves 3 GiB committable: the largest that commits that much is 8 GiB and change (a
		// quarter of 8195 MiB is 2048 MiB, whole MiB as the host counts).
		expect(freeMemoryOn(byUse, [fourGiB])).toBe(8_195);
		// Two leave 1 GiB, which no microVM over 1 GiB fits; a third 4 GiB create goes elsewhere.
		expect(freeMemoryOn(byUse, [fourGiB, fourGiB])).toBe(1_024);
		// A build counts in full.
		expect(freeMemoryOn(byUse, [{ memoryMiB: 4_096, build: true }])).toBe(1_024);
		expect(buildFitsOn(byUse, [], 4_096)).toBe(true);
		expect(buildFitsOn(byUse, [fourGiB], 4_096)).toBe(false);
		// The cap on what may be reserved binds too.
		const capped = { ...byUse, memory: { ...memory, admission: { ...admission, reservableMiB: 6_000 } } };
		expect(freeMemoryOn(capped, [fourGiB])).toBe(6_000 - 4_096);
		// One that admits by reservation, or predates admission, as before.
		expect(freeMemoryOn({ ...byUse, memory: { ...memory, mode: "reserved" } }, [fourGiB])).toBe(16_384 - 4_096);
		const { admission: _admission, ...older } = memory;
		expect(freeMemoryOn({ ...byUse, memory: older }, [fourGiB])).toBe(16_384 - 4_096);
		const request = { tier: "microvm" as const, size: "large" };
		const held = (n: number) =>
			candidate("used", { capacity: byUse }, { reservedMemoryMiB: 4_096 * n, heldMemory: Array(n).fill(fourGiB) });
		const first = place(request, [held(1)]);
		expect(isRefusal(first) ? first.reason : first.host.id).toBe("used");
		// With two held it is full, though 16 GiB less 8 GiB looks free: the next goes to another host.
		const other = candidate("other", capacity(9_000));
		const third = place(request, [held(2), other]);
		expect(isRefusal(third) ? third.reason : third.host.id).toBe("other");
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

	it("places a named size and a shape alike: the most free memory wins", () => {
		const a = candidate("a", capacity(8_000));
		const b = candidate("b", capacity(12_000));
		for (const request of [
			{ tier: "microvm", size: "default" },
			{ tier: "microvm", shape: { vcpus: 2, memoryMiB: 2048 } },
			{ tier: "microvm", shape: { vcpus: 3, memoryMiB: 6144 } },
		] as const) {
			const chosen = place(request, [a, custom(b)]);
			expect(isRefusal(chosen) ? chosen.reason : chosen.host.id).toBe("b");
		}
	});

	it("takes a shape a named size has as that size, so the host restores its template", () => {
		const small = custom(candidate("small", capacity(9_000)));
		const roomy = custom(candidate("roomy", capacity(30_000)));
		const chosen = place({ tier: "microvm", shape: { vcpus: 4, memoryMiB: 8192 } }, [small, roomy]);
		expect(isRefusal(chosen) ? chosen.reason : [chosen.host.id, chosen.size.name, chosen.custom]).toEqual([
			"roomy",
			"large",
			false,
		]);
	});

	it("makes a custom shape on a host that makes them", () => {
		const shape = { vcpus: 5, memoryMiB: 10_240 };
		// A host that makes only its named sizes can't take it.
		const named = candidate("named", capacity(30_000));
		const refused = place({ tier: "microvm", shape }, [named]);
		expect(isRefusal(refused) && refused.reason).toMatch(/5 vCPU and 10240 MiB.*only its named sizes/);
		const makes = custom(candidate("makes", capacity(20_000)));
		const chosen = place({ tier: "microvm", shape }, [named, makes]);
		if (isRefusal(chosen)) throw new Error(chosen.reason);
		expect(chosen.host.id).toBe("makes");
		expect(chosen.custom).toBe(true);
		// Its disk is the smallest named size's with at least its memory, else the largest's.
		expect(chosen.size).toEqual({ name: "custom-5c-10240m-50g", vcpus: 5, memoryMiB: 10_240, diskGiB: 50 });
		expect(diskFor(facts.sizes, 1024)).toBe(20);
		expect(diskFor(facts.sizes, 4096)).toBe(50);
		expect(diskFor([], 4096)).toBe(20);
		expect(customSizeName({ vcpus: 1, memoryMiB: 512, diskGiB: 20 })).toBe("custom-1c-512m-20g");
	});

	it("gives a microVM the disk it asks for within its host's limits, if the host has it free", () => {
		// Named sizes' vCPUs and memory with another disk: a custom shape, on a host that makes them.
		const shape = { vcpus: 2, memoryMiB: 2048, diskGiB: 120 };
		const named = candidate("named", capacity(30_000));
		const refused = place({ tier: "microvm", shape }, [named]);
		expect(isRefusal(refused) && refused.reason).toMatch(/2048 MiB with a 120 GiB disk.*only its named sizes/);
		const chosen = place({ tier: "microvm", shape }, [named, custom(candidate("makes"))]);
		if (isRefusal(chosen)) throw new Error(chosen.reason);
		expect(chosen).toMatchObject({
			custom: true,
			size: { name: "custom-2c-2048m-120g", vcpus: 2, memoryMiB: 2048, diskGiB: 120 },
		});
		// A named size's own disk is that size.
		const same = place({ tier: "microvm", shape: { ...shape, diskGiB: 20 } }, [named]);
		expect(isRefusal(same) ? same.reason : same.size.name).toBe("default");

		// Within the limits the host says (a host from before it said took 1 to 4096 GiB).
		const limited = (of: Candidate): Candidate => {
			const made = custom(of);
			const hostFacts = made.host.facts ?? facts;
			return { ...made, host: { ...made.host, facts: { ...hostFacts, disk: { minGiB: 20, maxGiB: 100 } } } };
		};
		const tooBig = place({ tier: "microvm", shape }, [limited(candidate("limited"))]);
		expect(isRefusal(tooBig) && tooBig).toMatchObject({ code: "no_host_offers_size" });
		expect(isRefusal(tooBig) && tooBig.reason).toMatch(/no disk that size/);
		expect(shapeOn(custom(named).host, { tier: "microvm", shape: { ...shape, diskGiB: 4000 } })?.custom).toBe(true);
		expect(shapeOn(custom(named).host, { tier: "microvm", shape: { ...shape, diskGiB: 4097 } })).toBeUndefined();

		// Free space: what it reported less what was placed on it since.
		const low = custom(candidate("low", { capacity: { ...capacity(30_000).capacity, freeDiskGiB: 150 } }));
		expect(isRefusal(place({ tier: "microvm", shape }, [low]))).toBe(false);
		const booked = { ...low, reservedDiskGiB: 100 };
		const full = place({ tier: "microvm", shape }, [booked]);
		expect(isRefusal(full) && full).toMatchObject({ code: "insufficient_capacity" });
		expect(isRefusal(full) && full.reason).toMatch(/50 GiB of disk free/);
	});

	it("refuses a custom shape bigger than a host, or than its free memory", () => {
		const host = custom(candidate("h", capacity(6_000)));
		const tooMany = place({ tier: "microvm", shape: { vcpus: 32, memoryMiB: 4096 } }, [host]);
		expect(isRefusal(tooMany) && tooMany.reason).toMatch(/too small for that shape/);
		const full = place({ tier: "microvm", shape: { vcpus: 2, memoryMiB: 8192 } }, [host]);
		expect(isRefusal(full) && full.reason).toMatch(/full/);
	});

	it("admits a custom shape asking for a named size's disk outside the host's limits, as it gave it one", () => {
		const made = custom(candidate("h"));
		const hostFacts = made.host.facts ?? facts;
		const host = { ...made, host: { ...made.host, facts: { ...hostFacts, disk: { minGiB: 60, maxGiB: 100 } } } };
		// No disk asked for: the size with at least its memory's, under the host's least.
		const first = place({ tier: "microvm", shape: { vcpus: 3, memoryMiB: 6144 } }, [host]);
		if (isRefusal(first)) throw new Error(first.reason);
		expect(first).toMatchObject({ custom: true, size: { name: "custom-3c-6144m-50g", diskGiB: 50 } });
		// A copy of it asking for that disk again goes to the same host.
		const copy = place({ tier: "microvm", shape: { vcpus: 3, memoryMiB: 6144, diskGiB: 50 } }, [host]);
		if (isRefusal(copy)) throw new Error(copy.reason);
		expect(copy).toMatchObject({ custom: true, size: { name: "custom-3c-6144m-50g", diskGiB: 50 } });
		// A disk no named size has still keeps to the limits.
		const odd = place({ tier: "microvm", shape: { vcpus: 3, memoryMiB: 6144, diskGiB: 40 } }, [host]);
		expect(isRefusal(odd) && odd.reason).toMatch(/no disk that size/);
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

	it("names the reason it can't place, after the check the nearest host failed", () => {
		const codeOf = (...args: Parameters<typeof place>) => {
			const chosen = place(...args);
			return isRefusal(chosen) ? chosen.code : `placed on ${chosen.host.id}`;
		};
		const microvm = { tier: "microvm", size: "default" } as const;
		expect(codeOf(microvm, [])).toBe("no_host");
		expect(codeOf(microvm, [candidate("gone", {}, { connected: false })])).toBe("no_host");
		expect(codeOf(microvm, [candidate("drained", { draining: true })])).toBe("no_host");
		expect(codeOf(microvm, [candidate("new", { facts: undefined })])).toBe("no_host");
		expect(codeOf(microvm, [candidate("revoked", { revoked: true })])).toBe("no_host");
		const isolatesOnly = candidate("isolates", { facts: { ...facts, tiers: ["isolate"] } });
		expect(codeOf(microvm, [isolatesOnly])).toBe("no_host_for_type");
		expect(codeOf({ tier: "microvm", size: "xlarge" }, [candidate("h")])).toBe("no_host_offers_size");
		expect(codeOf({ tier: "microvm", shape: { vcpus: 3, memoryMiB: 3072 } }, [candidate("named")])).toBe(
			"no_host_offers_size",
		);
		expect(codeOf({ ...microvm, labels: { zone: "ams" } }, [candidate("h", { labels: { zone: "fra" } })])).toBe(
			"no_host_with_labels",
		);
		expect(codeOf(microvm, [candidate("full", capacity(1_000))])).toBe("insufficient_capacity");
		// Hosts turned away for different reasons: the one that got furthest names it, so a full host says to retry.
		expect(
			codeOf(microvm, [isolatesOnly, candidate("gone", {}, { connected: false }), candidate("full", capacity(1_000))]),
		).toBe("insufficient_capacity");
		expect(codeOf(microvm, [isolatesOnly, candidate("drained", { draining: true })])).toBe("no_host_for_type");
	});
});
