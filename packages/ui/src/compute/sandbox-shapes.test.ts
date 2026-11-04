import { describe, expect, it } from "vitest";
import { onStep, sliderPercent } from "../primitives/slider.tsx";
import {
	coldStart,
	DEFAULT_SANDBOX_SHAPES,
	fitMemory,
	memoryRangeFor,
	memoryText,
	presetOf,
	type SandboxShapes,
	shapeCentsPerHour,
	sizeText,
} from "./compute-model.ts";

const warm = (names: readonly string[]): SandboxShapes => ({
	...DEFAULT_SANDBOX_SHAPES,
	microvm: {
		...DEFAULT_SANDBOX_SHAPES.microvm,
		presets: DEFAULT_SANDBOX_SHAPES.microvm.presets.map((preset) => ({ ...preset, warm: names.includes(preset.name) })),
	},
});

describe("sandbox shapes", () => {
	it("isolates take 128 to 512 MB in 64 MB steps, 256 by default", () => {
		expect(DEFAULT_SANDBOX_SHAPES.isolate.memoryMb).toEqual({ min: 128, max: 512, step: 64, default: 256 });
	});

	it("ties a microVM's memory to its vCPUs", () => {
		// 512 MB to 8 GB a vCPU, within 512 MB and 32 GB.
		expect(memoryRangeFor(DEFAULT_SANDBOX_SHAPES, 1)).toMatchObject({ min: 512, max: 8192 });
		expect(memoryRangeFor(DEFAULT_SANDBOX_SHAPES, 4)).toMatchObject({ min: 2048, max: 32768 });
		expect(memoryRangeFor(DEFAULT_SANDBOX_SHAPES, 16)).toMatchObject({ min: 8192, max: 32768 });
		// Memory moves into range when the vCPUs change.
		expect(fitMemory(DEFAULT_SANDBOX_SHAPES, 1, 16384)).toBe(8192);
		expect(fitMemory(DEFAULT_SANDBOX_SHAPES, 16, 1024)).toBe(8192);
		expect(fitMemory(DEFAULT_SANDBOX_SHAPES, 4, 8192)).toBe(8192);
	});

	it("prices a shape from its vCPUs and memory, and only where there are rates", () => {
		expect(shapeCentsPerHour(DEFAULT_SANDBOX_SHAPES, "microvm", { vcpus: 4, memoryMb: 8192 })).toBe(4);
		expect(shapeCentsPerHour(DEFAULT_SANDBOX_SHAPES, "microvm", { vcpus: 5, memoryMb: 8192 })).toBe(4.75);
		expect(shapeCentsPerHour(DEFAULT_SANDBOX_SHAPES, "isolate", { vcpus: 0, memoryMb: 256 })).toBe(0.5);
		const { rates: _, ...free } = DEFAULT_SANDBOX_SHAPES;
		expect(shapeCentsPerHour(free, "microvm", { vcpus: 4, memoryMb: 8192 })).toBeUndefined();
	});

	it("says a shape boots cold only where some host keeps warm machines and it isn't one", () => {
		const medium = { vcpus: 4, memoryMb: 8192 };
		const custom = { vcpus: 5, memoryMb: 8192 };
		// No warm pools (a self-hosted host's default): nothing to say.
		expect(coldStart(DEFAULT_SANDBOX_SHAPES, custom)).toBe(false);
		expect(coldStart(warm(["medium"]), medium)).toBe(false);
		expect(coldStart(warm(["medium"]), custom)).toBe(true);
		expect(coldStart(warm(["small"]), medium)).toBe(true);
		expect(presetOf(DEFAULT_SANDBOX_SHAPES, medium)?.name).toBe("medium");
		expect(presetOf(DEFAULT_SANDBOX_SHAPES, custom)).toBeUndefined();
	});

	it("writes memory and an isolate's shared CPU", () => {
		expect(memoryText(256)).toBe("256 MB");
		expect(memoryText(2048)).toBe("2 GB");
		expect(memoryText(1536)).toBe("1.5 GB");
		expect(sizeText({ vcpus: 0, memoryGb: 0.25 })).toBe("Shared CPU, 256 MB");
		expect(sizeText({ vcpus: 4, memoryGb: 8 })).toBe("4 vCPU, 8 GB");
	});
});

describe("slider steps", () => {
	it("puts a value on a step within the range", () => {
		expect(onStep(300, 128, 512, 64)).toBe(320);
		expect(onStep(9000, 128, 512, 64)).toBe(512);
		expect(onStep(0, 128, 512, 64)).toBe(128);
		expect(onStep(5, 1, 1, 1)).toBe(1);
		expect(sliderPercent(256, 128, 512)).toBeCloseTo(33.33, 1);
		expect(sliderPercent(1, 1, 1)).toBe(0);
	});
});
