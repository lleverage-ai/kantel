import { describe, expect, it } from "vitest";
import { HOST_FEATURES, type HostFacts } from "../src/protocol.ts";
import {
	bootsFreshInstead,
	buildFitsOn,
	type Candidate,
	customSizeName,
	diskFor,
	freeMemoryOn,
	holdsHeads,
	isRefusal,
	type Placement,
	place,
	SPREAD_FULLNESS,
	SPREAD_MARGIN,
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

	it("measures memory as reserved over capacity, not as the free memory over-commit admits", () => {
		// Cerbie's case: a 16 GiB host with 14 GiB reserved and a 32 GiB host with 16 GiB reserved, each reporting what it
		// would still admit at 1.5 times its capacity.
		const report = (capacityMiB: number, reservedMiB: number) => ({
			mode: "reserved" as const,
			totalMiB: capacityMiB,
			reserveMiB: 0,
			capacityMiB,
			reservedMiB,
			committedMiB: reservedMiB,
			guestUsedMiB: 0,
			residentMiB: 0,
			availableMiB: capacityMiB - reservedMiB,
			swapUsedMiB: 0,
			pressureSome: 0,
			pressureFull: 0,
			maxRatio: 1.5,
			state: "ok" as const,
		});
		const small = candidate(
			"small",
			{
				facts: { ...facts, memoryMiB: 16_384, cpus: 16 },
				capacity: {
					freeMemoryMiB: 16_384 * 1.5 - 14_336,
					freeDiskGiB: 400,
					running: 0,
					stopped: 0,
					load1: 0,
					memory: report(16_384, 14_336),
				},
			},
			{ bookedVcpus: 2 },
		);
		const big = candidate(
			"big",
			{
				facts: { ...facts, memoryMiB: 32_768, cpus: 32 },
				capacity: {
					freeMemoryMiB: 32_768 * 1.5 - 16_384,
					freeDiskGiB: 400,
					running: 0,
					stopped: 0,
					load1: 0,
					memory: report(32_768, 16_384),
				},
			},
			{ bookedVcpus: 16 },
		);
		const chosen = place({ tier: "microvm", shape: { vcpus: 1, memoryMiB: 1_024 } }, [small, big].map(custom));
		expect(isRefusal(chosen) ? chosen.reason : chosen.host.id).toBe("big");
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

	it("prefers a host holding the head of every sticky disk, and between equals the least full", () => {
		/** A host with `free` MiB free that last reported holding these versions of sticky disks. */
		const holding = (id: string, free: number, held: { readonly [diskId: string]: readonly string[] }) =>
			candidate(id, {
				capacity: {
					...capacity(free).capacity,
					stickyDisks: Object.entries(held).map(([diskId, versions]) => ({
						diskId,
						versions: versions.map((version) => ({ version, allocatedBytes: 1, at: 1 })),
					})),
				},
			});
		const stickyDisks = [
			{ diskId: "sdk_cache", path: "/cache", sizeGiB: 10, version: "sdv_2" },
			{ diskId: "sdk_docker", path: "/docker", sizeGiB: 10, version: "sdv_9" },
		];
		const request = { tier: "microvm", size: "default", stickyDisks } as const;
		const pick = (...candidates: Candidate[]) => {
			const chosen = place(request, candidates);
			return isRefusal(chosen) ? chosen.reason : chosen.host.id;
		};
		const warm = holding("warm", 4_000, { sdk_cache: ["sdv_1", "sdv_2"], sdk_docker: ["sdv_9"] });
		// Emptier, but holding an older version of one disk, or one head of two, or nothing it says.
		const older = holding("older", 30_000, { sdk_cache: ["sdv_1"], sdk_docker: ["sdv_9"] });
		const half = holding("half", 30_000, { sdk_cache: ["sdv_2"] });
		const silent = candidate("silent", capacity(30_000));
		expect(pick(older, half, silent, warm)).toBe("warm");
		// Between hosts that both hold the heads, or that both don't, projected fullness still decides.
		const roomier = holding("roomier", 20_000, { sdk_cache: ["sdv_2"], sdk_docker: ["sdv_8", "sdv_9"] });
		expect(pick(warm, roomier, older)).toBe("roomier");
		expect(pick(holding("fuller", 8_000, {}), older)).toBe("older");
		// It is a preference only: a host without the heads takes it when the one with them is full.
		expect(pick(holding("full", 1_000, { sdk_cache: ["sdv_2"], sdk_docker: ["sdv_9"] }), older)).toBe("older");
		// Without sticky disks, or with ones that have no head yet, nothing is preferred for them.
		const plain = place({ tier: "microvm", size: "default" }, [warm, older]);
		expect(isRefusal(plain) ? plain.reason : plain.host.id).toBe("older");
		const fresh = place({ ...request, stickyDisks: [{ diskId: "sdk_new" }] }, [warm, older]);
		expect(isRefusal(fresh) ? fresh.reason : fresh.host.id).toBe("older");
	});

	it("says a host holds the heads only of what it reports, every disk with a head", () => {
		const host = candidate("h", {
			capacity: {
				...capacity(4_000).capacity,
				stickyDisks: [{ diskId: "sdk_a", versions: [{ version: "sdv_1", allocatedBytes: 1, at: 1 }] }],
			},
		}).host;
		expect(holdsHeads(host, undefined)).toBe(true);
		expect(holdsHeads(host, [{ diskId: "sdk_a", version: "sdv_1" }, { diskId: "sdk_b" }])).toBe(true);
		expect(holdsHeads(host, [{ diskId: "sdk_a", version: "sdv_2" }])).toBe(false);
		expect(holdsHeads(host, [{ diskId: "sdk_b", version: "sdv_1" }])).toBe(false);
		// A host that doesn't say what it holds (one without sticky disks, or a report it couldn't read in full).
		expect(holdsHeads(candidate("quiet").host, [{ diskId: "sdk_a", version: "sdv_1" }])).toBe(false);
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

describe("bootsFreshInstead", () => {
	/** Where `place` puts a 4 vCPU, 8 GiB machine among `candidates` alone. */
	const placed = (...candidates: Candidate[]): Placement => {
		const chosen = place({ tier: "microvm", size: "large" }, candidates);
		if (isRefusal(chosen)) throw new Error(chosen.reason);
		return chosen;
	};

	it("counts each host's fullness with the create placed", () => {
		// 16 of 32 GiB used, and 8 more: 0.75. Empty: a quarter.
		expect(placed(candidate("holder", capacity(16_384))).fullness).toBe(0.75);
		expect(placed(candidate("empty", capacity(32_768))).fullness).toBe(0.25);
		// Its CPUs booked count too: 12 of 16 vCPUs with this one.
		expect(placed(candidate("booked", capacity(32_768), { bookedVcpus: 8 })).fullness).toBe(0.75);
	});

	it("boots fresh on a much emptier host once the one with the snapshot would be at least half full", () => {
		const empty = placed(candidate("empty", capacity(32_768)));
		expect(bootsFreshInstead(placed(candidate("holder", capacity(16_384))), empty)).toBe(true);
		// At the threshold exactly, and a quarter apart exactly.
		const half = placed(candidate("half", capacity(24_576)));
		expect(half.fullness).toBe(SPREAD_FULLNESS);
		expect(half.fullness - empty.fullness).toBe(SPREAD_MARGIN);
		expect(bootsFreshInstead(half, empty)).toBe(true);
		// Its CPUs booked, though it has memory: a fresh boot elsewhere too.
		expect(bootsFreshInstead(placed(candidate("booked", capacity(32_768), { bookedVcpus: 8 })), empty)).toBe(true);
	});

	it("restores on the host with the snapshot while it has plenty of room, however empty the others", () => {
		// 0.47 full with it placed: under half, so the restore wins over an empty host.
		const roomy = placed(candidate("roomy", capacity(25_600)));
		expect(roomy.fullness).toBeLessThan(SPREAD_FULLNESS);
		expect(bootsFreshInstead(roomy, placed(candidate("empty", capacity(32_768))))).toBe(false);
		// Nor for a far bigger, emptier host.
		const big = candidate("big", { facts: { ...facts, memoryMiB: 131_072, cpus: 64 }, ...capacity(131_072) });
		expect(placed(big).fullness).toBe(0.06);
		expect(bootsFreshInstead(roomy, placed(big))).toBe(false);
	});

	it("restores when the other host is nearly as full", () => {
		const holder = placed(candidate("holder", capacity(16_384)));
		// 0.75 against 0.53: within a quarter.
		const other = placed(candidate("other", capacity(23_552)));
		expect(other.fullness).toBe(0.53);
		expect(bootsFreshInstead(holder, other)).toBe(false);
		// Both over-booked, within a quarter of each other: the restore.
		expect(
			bootsFreshInstead(
				placed(candidate("over", capacity(16_384), { bookedVcpus: 20 })),
				placed(candidate("overToo", capacity(16_384), { bookedVcpus: 18 })),
			),
		).toBe(false);
	});
});
