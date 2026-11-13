// A host's CPU and runtime fingerprints: what it says in its facts, as the registry keeps them, and when a snapshot's
// memory made on one host restores on another.
import { describe, expect, it } from "vitest";
import { cpuFingerprintText, memoryRestoresOn, parseHostFacts, sameCpu } from "../src/facts.ts";
import type { HostCpuFingerprint, HostFacts } from "../src/protocol.ts";
import { facts } from "./fake-host.ts";

const AX102: HostCpuFingerprint = {
	vendor: "AuthenticAMD",
	family: 25,
	model: 97,
	featuresHash: "sha256:0123456789abcdef",
};
const RUNTIME = "firecracker=v1.17.0;kernel=6.1.102+0123456789ab;image=host-images-20261103;sticky=4";

const parsed = (value: unknown): HostFacts => {
	const result = parseHostFacts(value);
	if (!result.ok) throw new Error(result.reason);
	return result.value;
};

describe("a host's fingerprints", () => {
	it("keeps the CPU and runtimes a host says, and drops what isn't shaped as kantel-host sends it", () => {
		const runtimes = [
			{ image: "host-images-20261103", runtime: RUNTIME },
			{ image: "", runtime: "firecracker=v1.17.0;kernel=6.1.102+0123456789ab;sticky=4" },
		];
		expect(parsed({ ...facts(), cpu: AX102, runtimes })).toMatchObject({ cpu: AX102, runtimes });
		// A host from before it said: neither, and the facts still stand.
		const older = parsed(facts());
		expect(older).not.toHaveProperty("cpu");
		expect(older).not.toHaveProperty("runtimes");
		// Go's empty list is null.
		expect(parsed({ ...facts(), runtimes: null })).not.toHaveProperty("runtimes");
		for (const cpu of [
			{ ...AX102, family: "25" },
			{ ...AX102, model: -1 },
			{ ...AX102, vendor: "" },
			{ ...AX102, featuresHash: "x".repeat(300) },
			"AuthenticAMD",
		]) {
			const kept = parseHostFacts({ ...facts(), cpu });
			expect(kept.ok).toBe(true);
			expect(kept.ok && kept.value).not.toHaveProperty("cpu");
		}
		const some = parsed({
			...facts(),
			runtimes: [{ image: "a", runtime: "" }, { image: 1, runtime: RUNTIME }, "x", { image: "b", runtime: RUNTIME }],
		});
		expect(some.runtimes).toEqual([{ image: "b", runtime: RUNTIME }]);
	});

	it("matches CPUs on vendor, family, model and features, and never an unknown one", () => {
		expect(sameCpu(AX102, { ...AX102 })).toBe(true);
		expect(sameCpu(AX102, { ...AX102, vendor: "GenuineIntel" })).toBe(false);
		expect(sameCpu(AX102, { ...AX102, family: 26 })).toBe(false);
		expect(sameCpu(AX102, { ...AX102, model: 68 })).toBe(false);
		expect(sameCpu(AX102, { ...AX102, featuresHash: "sha256:fedcba9876543210" })).toBe(false);
		expect(sameCpu(AX102, undefined)).toBe(false);
		expect(sameCpu(undefined, undefined)).toBe(false);
		expect(sameCpu({ ...AX102, featuresHash: "" }, { ...AX102, featuresHash: "" })).toBe(false);
	});

	it("restores a snapshot's memory only on a host with the same CPU and its runtime", () => {
		const host = { cpu: AX102, runtimes: [{ image: "host-images-20261103", runtime: RUNTIME }] };
		expect(memoryRestoresOn(host, { cpu: { ...AX102 }, runtime: RUNTIME })).toBe(true);
		expect(memoryRestoresOn(host, { cpu: { ...AX102, model: 68 }, runtime: RUNTIME })).toBe(false);
		expect(memoryRestoresOn(host, { cpu: AX102, runtime: RUNTIME.replace("6.1.102", "6.1.155") })).toBe(false);
		// A snapshot or host from before either was kept, or a runtime that couldn't be told: it cold-boots.
		expect(memoryRestoresOn(host, { runtime: RUNTIME })).toBe(false);
		expect(memoryRestoresOn(host, { cpu: AX102 })).toBe(false);
		expect(memoryRestoresOn(host, { cpu: AX102, runtime: "" })).toBe(false);
		expect(memoryRestoresOn({ cpu: AX102 }, { cpu: AX102, runtime: RUNTIME })).toBe(false);
		expect(memoryRestoresOn(undefined, { cpu: AX102, runtime: RUNTIME })).toBe(false);
	});

	it("shows a CPU as text", () => {
		expect(cpuFingerprintText(AX102)).toBe("AuthenticAMD family 25 model 97, features sha256:0123456789abcdef");
	});
});
