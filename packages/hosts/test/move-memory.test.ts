// What a move does with a sandbox's memory between two hosts, and the rate its pause is estimated at.
import { describe, expect, it } from "vitest";
import { ASSUMED_LINK_BYTES_PER_SECOND, moveLinkRate, moveMemoryWay, movePauseMs } from "../src/move-memory.ts";
import { HOST_FEATURES } from "../src/protocol.ts";
import type { HostRecord } from "../src/store.ts";

const CPU = { vendor: "AuthenticAMD", family: 25, model: 97, featuresHash: "sha256:0123456789abcdef" };
const RUNTIME = "firecracker=v1.17.0;kernel=6.1.155;sticky=2";

function host(
	id: string,
	more: Partial<HostRecord> = {},
	features: readonly string[] = [HOST_FEATURES.sandboxMoveMemory],
	cpu = CPU,
): HostRecord {
	return {
		id,
		name: id,
		labels: {},
		credentialHash: "",
		revoked: false,
		draining: false,
		joinedAt: 1,
		facts: {
			version: "0.10.0",
			protocol: 1,
			os: "linux",
			arch: "x86_64",
			kernel: "6.1",
			hostname: id,
			cpus: 8,
			memoryMiB: 1024,
			diskGiB: 10,
			tiers: ["microvm"],
			kvm: true,
			nested: false,
			sizes: [],
			egress: "nftables",
			features,
			cpu,
			runtimes: [{ image: "v1", runtime: RUNTIME }],
		},
		...more,
	};
}

const memory = { memory: true, runtime: RUNTIME, bytes: 1 << 30 };

describe("a move's memory", () => {
	it("is kept between hosts that both move it, with the same CPU and its runtime", () => {
		expect(moveMemoryWay(host("a"), host("b"), memory, true)).toEqual({ kept: true });
		expect(moveMemoryWay(host("a"), host("b"), memory, false)).toEqual({ kept: false });
		expect(moveMemoryWay(host("a"), host("b"), { memory: false, bytes: 0 }, true)).toEqual({ kept: false });
		const cpu = moveMemoryWay(host("a"), host("b", {}, undefined, { ...CPU, model: 1 }), memory, true);
		expect(cpu.kept).toBe(false);
		expect(cpu.reason).toContain("CPU");
		const runtime = moveMemoryWay(host("a"), host("b"), { ...memory, runtime: `${RUNTIME};x` }, true);
		expect(runtime.reason).toContain("runtime");
		expect(moveMemoryWay(host("a"), host("b", {}, []), memory, true).reason).toContain("upgrade its kantel-host");
		expect(moveMemoryWay(host("a", {}, []), host("b"), undefined, true).reason).toContain("upgrade its kantel-host");
		expect(moveMemoryWay(host("a"), host("b"), { ...memory, refused: "too many drives" }, true).reason).toContain(
			"too many drives",
		);
	});

	it("is estimated at the rate the target's fetch from the source ran at, else the other way, else 1 Gbit/s", () => {
		const peers = (of: string, rate: number) => ({
			capacity: {
				freeMemoryMiB: 1,
				freeDiskGiB: 1,
				running: 0,
				stopped: 0,
				load1: 0,
				mesh: {
					address: "fd00::1",
					peers: [{ hostId: of, path: "direct", fetchBytesPerSecond: rate, fetchRateAt: 1 }],
				},
			},
		});
		expect(moveLinkRate(host("a"), host("b"))).toEqual({
			bytesPerSecond: ASSUMED_LINK_BYTES_PER_SECOND,
			measured: false,
		});
		expect(moveLinkRate(host("a", peers("b", 50)), host("b"))).toEqual({ bytesPerSecond: 50, measured: true });
		expect(moveLinkRate(host("a", peers("b", 50)), host("b", peers("a", 80)))).toEqual({
			bytesPerSecond: 80,
			measured: true,
		});
		expect(movePauseMs(1_000_000_000, { bytesPerSecond: 125_000_000, measured: false })).toBe(8000);
	});
});
