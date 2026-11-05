// A new microVM's machine made from a snapshot: the snapshot's disk kept through other vCPUs, memory or sizes, each
// resolved on the host the snapshot is on, never on another host's presets.
import { describe, expect, it } from "vitest";
import type { BackendSize } from "../src/backend.ts";
import { type CopiedOn, sandboxMachine } from "../src/machine.ts";

const PRESETS: readonly BackendSize[] = [
	{ name: "small", vcpus: 1, memoryMb: 1024, diskGb: 10 },
	{ name: "default", vcpus: 2, memoryMb: 4096, diskGb: 20 },
	{ name: "large", vcpus: 4, memoryMb: 8192, diskGb: 50 },
	{ name: "xlarge", vcpus: 8, memoryMb: 16384, diskGb: 80 },
];
const CUSTOM: CopiedOn = { presets: PRESETS, custom: true };

/** A snapshot of a sandbox of `size` that was given a disk of `diskGb`. */
const snapshotOf = (size: "small" | "default", diskGb: number) => {
	const preset = PRESETS.find((each) => each.name === size);
	if (preset === undefined) throw new Error(size);
	return { size, resources: { vcpus: preset.vcpus, memoryMb: preset.memoryMb, diskGb } };
};

describe("a machine made from a snapshot", () => {
	it("keeps the snapshot's disk with its own vCPUs and memory, whatever another preset's disk is", () => {
		// A small sandbox given 50 GB, the large preset's disk too, made again with its own vCPUs and memory.
		expect(
			sandboxMachine({ copies: snapshotOf("small", 50), on: CUSTOM }, { shape: { vcpus: 1, memoryMb: 1024 } }, PRESETS),
		).toEqual({ size: "small", shape: { vcpus: 1, memoryMb: 1024, diskGb: 50 } });
		// A default sandbox given 15 GB, less than its preset's 20 GB: still 15 GB.
		expect(
			sandboxMachine(
				{ copies: snapshotOf("default", 15), on: CUSTOM },
				{ shape: { vcpus: 2, memoryMb: 4096 } },
				PRESETS,
			),
		).toEqual({ size: "default", shape: { vcpus: 2, memoryMb: 4096, diskGb: 15 } });
	});

	it("keeps a bigger copied disk through other vCPUs, memory or a size, though a preset has that disk", () => {
		const copies = snapshotOf("small", 50);
		expect(sandboxMachine({ copies, on: CUSTOM }, { shape: { vcpus: 2, memoryMb: 4096 } }, PRESETS)).toEqual({
			size: "default",
			shape: { vcpus: 2, memoryMb: 4096, diskGb: 50 },
		});
		expect(sandboxMachine({ copies, on: CUSTOM }, { size: "default" }, PRESETS)).toEqual({
			size: "default",
			shape: { vcpus: 2, memoryMb: 4096, diskGb: 50 },
		});
		// A size whose own disk is as big or bigger is that size, whole.
		expect(sandboxMachine({ copies, on: CUSTOM }, { size: "large" }, PRESETS)).toEqual({ size: "large" });
		expect(sandboxMachine({ copies, on: CUSTOM }, { size: "xlarge" }, PRESETS)).toEqual({ size: "xlarge" });
	});

	it("takes another size from the snapshot's host, whatever other hosts' presets are", () => {
		// The snapshot's host's large is 4 vCPUs and 8 GB; another host, listed first, has a bigger large.
		const elsewhere: readonly BackendSize[] = [
			{ name: "large", vcpus: 8, memoryMb: 16384, diskGb: 50 },
			...PRESETS.filter((each) => each.name !== "large"),
		];
		const copies = { size: "default" as const, resources: { vcpus: 2, memoryMb: 4096, diskGb: 64 } };
		const expected = { size: "large", shape: { vcpus: 4, memoryMb: 8192, diskGb: 64 } };
		expect(sandboxMachine({ copies, on: CUSTOM }, { size: "large" }, [...elsewhere, ...PRESETS])).toEqual(expected);
		expect(sandboxMachine({ copies, on: CUSTOM }, { size: "large" }, [])).toEqual(expected);
	});

	it("asks a host that makes only its presets for one by name, and an unknown host for the size alone", () => {
		const copies = snapshotOf("default", 20);
		const presetOnly: CopiedOn = { presets: PRESETS, custom: false };
		expect(sandboxMachine({ copies, on: presetOnly }, { size: "small" }, PRESETS)).toEqual({ size: "small" });
		expect(sandboxMachine({ copies }, { size: "small" }, PRESETS)).toEqual({ size: "small" });
		// One its host has no preset of, with the copied disk it was given elsewhere: asked for by vCPUs and memory.
		expect(sandboxMachine({ copies: snapshotOf("small", 20), on: presetOnly }, {}, PRESETS)).toEqual({
			size: "small",
			shape: { vcpus: 1, memoryMb: 1024 },
		});
	});

	it("is the copied machine whole when nothing else is asked for", () => {
		const copies = snapshotOf("default", 64);
		expect(sandboxMachine({ copies, on: CUSTOM }, {}, PRESETS)).toEqual({
			size: "default",
			shape: { vcpus: 2, memoryMb: 4096, diskGb: 64 },
		});
		expect(sandboxMachine({ copies, on: CUSTOM }, { size: "default" }, PRESETS)).toEqual({
			size: "default",
			shape: { vcpus: 2, memoryMb: 4096, diskGb: 64 },
		});
	});
});
