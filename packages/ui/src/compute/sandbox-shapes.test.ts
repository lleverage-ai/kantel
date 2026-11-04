import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { onStep, sliderPercent } from "../primitives/slider.tsx";
import {
	customShapes,
	DEFAULT_SANDBOX_SHAPES,
	fitMemory,
	memoryRangeFor,
	memoryText,
	microvmsAvailable,
	onGrid,
	presetOf,
	type SandboxShapes,
	shapeAllowed,
	shapeCentsPerHour,
	shapeCreatable,
	sizeText,
	vcpuRangeFor,
} from "./compute-model.ts";
import { NewSandboxDialog, ShapeFields } from "./sandboxes-page.tsx";

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

	it("names a shape that is a preset, and no other", () => {
		const medium = { vcpus: 4, memoryMb: 8192 };
		const custom = { vcpus: 5, memoryMb: 8192 };
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

describe("New sandbox's shapes, as the hosts make them", () => {
	const presetsOnly: SandboxShapes = {
		...DEFAULT_SANDBOX_SHAPES,
		microvm: { ...DEFAULT_SANDBOX_SHAPES.microvm, custom: false },
	};
	const fields = (shapes: SandboxShapes, shape: { vcpus: number; memoryMb: number }) =>
		renderToStaticMarkup(
			createElement(ShapeFields, {
				kind: "microvm",
				shapes,
				hosting: "self-hosted",
				shape,
				onVcpus: () => {},
				onMemory: () => {},
				onPreset: () => {},
			}),
		);

	it("promises no disk: it is the host's to give, and a snapshot's to keep", () => {
		expect(fields(DEFAULT_SANDBOX_SHAPES, { vcpus: 4, memoryMb: 8192 })).not.toMatch(/GB disk/);
		expect(fields(DEFAULT_SANDBOX_SHAPES, { vcpus: 3, memoryMb: 6144 })).not.toMatch(/GB disk/);
		expect(fields(presetsOnly, { vcpus: 4, memoryMb: 8192 })).not.toMatch(/GB disk/);
	});

	it("keeps memory on the slider's grid, so what is sent is what is shown", () => {
		// A host's default preset off the 512 MB grid (2 vCPU, 1280 MB): the dialog starts on the grid, not at 1280.
		const offGrid: SandboxShapes = {
			...DEFAULT_SANDBOX_SHAPES,
			microvm: {
				...DEFAULT_SANDBOX_SHAPES.microvm,
				vcpus: { min: 1, max: 8, step: 1, default: 2 },
				memoryMb: { min: 768, max: 16_000, step: 512, default: 1280 },
				presets: [{ name: "default", vcpus: 2, memoryMb: 1280, diskGb: 20 }],
			},
		};
		const range = memoryRangeFor(offGrid, 2);
		// Both ends on the grid, the top under the hosts' 16,000 MB.
		expect(range).toMatchObject({ min: 1024, max: 15_872 });
		const start = fitMemory(offGrid, 2, offGrid.microvm.memoryMb.default);
		expect(start % 512).toBe(0);
		// The slider shows the very value kept.
		expect(onStep(start, range.min, range.max, range.step)).toBe(start);
		for (const memory of [700, 1280, 5000, 99_999]) {
			const kept = fitMemory(offGrid, 3, memory);
			const shown = memoryRangeFor(offGrid, 3);
			expect(onStep(kept, shown.min, shown.max, shown.step)).toBe(kept);
		}
		expect(onGrid({ min: 128, max: 512, step: 64 }, 300)).toBe(320);
	});

	it("keeps vCPUs to what the memory's top can hold, and memory under it", () => {
		// 32 vCPUs need 16 GB at 512 MB each; hosts with 8 GB stop at 16.
		const small: SandboxShapes = {
			...DEFAULT_SANDBOX_SHAPES,
			microvm: {
				...DEFAULT_SANDBOX_SHAPES.microvm,
				vcpus: { min: 1, max: 32, step: 1, default: 32 },
				memoryMb: { min: 512, max: 8192, step: 512, default: 2048 },
			},
		};
		const cpus = vcpuRangeFor(small);
		expect(cpus.max).toBe(16);
		expect(cpus.default).toBe(16);
		expect(memoryRangeFor(small, 32).max).toBe(8192);
		expect(memoryRangeFor(small, 32).min).toBeGreaterThan(memoryRangeFor(small, 32).max);
		expect(fitMemory(small, 16, 4096)).toBe(8192);
		// Where a count of vCPUs can't be had, memory still never goes past the hosts' top, and the shape isn't allowed.
		expect(fitMemory(small, 32, 4096)).toBe(8192);
		expect(shapeAllowed(small, { vcpus: 32, memoryMb: fitMemory(small, 32, 4096) })).toBe(false);
		expect(shapeAllowed(small, { vcpus: 16, memoryMb: 8192 })).toBe(true);
		expect(shapeAllowed(small, { vcpus: 32, memoryMb: 16_384 })).toBe(false);
		expect(shapeAllowed(small, { vcpus: 2, memoryMb: 16_384 })).toBe(false);
		const html = fields(small, { vcpus: 16, memoryMb: 8192 });
		expect(html).toContain('min="1" max="16"');
		expect(html).not.toContain('max="32"');
	});

	it("keeps presets that share a name apart, each with its own shape", () => {
		const shared: SandboxShapes = {
			...DEFAULT_SANDBOX_SHAPES,
			microvm: {
				...DEFAULT_SANDBOX_SHAPES.microvm,
				custom: false,
				presets: [
					{ name: "default", vcpus: 2, memoryMb: 4096, diskGb: 20 },
					{ name: "default", vcpus: 4, memoryMb: 2048, diskGb: 20 },
				],
			},
		};
		const html = fields(shared, { vcpus: 4, memoryMb: 2048 });
		expect(html.match(/<option/g)).toHaveLength(2);
		expect(html).toContain('value="2/4096"');
		expect(html).toContain('value="4/2048"');
		expect(shapeAllowed(shared, { vcpus: 3, memoryMb: 4096 })).toBe(false);
	});

	it("offers only the presets, from a list, where no host makes other shapes", () => {
		expect(customShapes(DEFAULT_SANDBOX_SHAPES)).toBe(true);
		expect(customShapes(presetsOnly)).toBe(false);
		const html = fields(presetsOnly, { vcpus: 4, memoryMb: 8192 });
		expect(html).not.toContain('type="range"');
		expect(html.match(/<option/g)).toHaveLength(DEFAULT_SANDBOX_SHAPES.microvm.presets.length);
		expect(fields(DEFAULT_SANDBOX_SHAPES, { vcpus: 4, memoryMb: 8192 })).toContain('type="range"');
	});

	it("makes no microVM where no host runs them, whatever the sliders say", () => {
		const none: SandboxShapes = {
			...DEFAULT_SANDBOX_SHAPES,
			microvm: { ...DEFAULT_SANDBOX_SHAPES.microvm, available: false },
		};
		const preset = DEFAULT_SANDBOX_SHAPES.microvm.presets[0];
		if (preset === undefined) throw new Error("No preset");
		expect(microvmsAvailable(none)).toBe(false);
		expect(shapeCreatable(none, "microvm", preset)).toBe(false);
		expect(shapeCreatable(none, "isolate", { vcpus: 0, memoryMb: 256 })).toBe(true);
		// Hosts that run them: a preset may be made, and isolates still.
		expect(microvmsAvailable(DEFAULT_SANDBOX_SHAPES)).toBe(true);
		expect(shapeCreatable(DEFAULT_SANDBOX_SHAPES, "microvm", preset)).toBe(true);
	});

	it("never says a shape boots cold or comes from a warm pool: hosts keep none", () => {
		const html = fields(DEFAULT_SANDBOX_SHAPES, { vcpus: 5, memoryMb: 8192 });
		expect(html).not.toMatch(/warm|cold start/i);
	});

	it("can't create until a source that says what its hosts offer has said", () => {
		const dialog = (shapes?: () => Promise<SandboxShapes>) =>
			renderToStaticMarkup(
				createElement(NewSandboxDialog, {
					open: true,
					account: { id: "acct", kind: "personal", name: "Ada", role: "owner", members: 1 },
					hosting: "self-hosted",
					now: 0,
					...(shapes === undefined ? {} : { shapes }),
					onClose: () => {},
					onCreate: () => {},
				}),
			);
		const create = (html: string) =>
			[...html.matchAll(/(<button[^>]*>)(.*?)<\/button>/g)].find(
				(match) => match[2]?.replace(/<[^>]*>/g, "") === "Create",
			)?.[1] ?? "missing";
		const reading = dialog(() => new Promise(() => {}));
		expect(reading).toContain("Reading what the hosts offer");
		expect(reading).not.toContain('type="range"');
		expect(create(reading)).toMatch(/\sdisabled=""/);
		// A source that can't say keeps the defaults, ready at once.
		const defaults = dialog();
		expect(defaults).toContain('type="range"');
		expect(create(defaults)).not.toMatch(/\sdisabled=""/);
	});
});
