import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { onStep, sliderPercent } from "../primitives/slider.tsx";
import {
	coldStart,
	customShapes,
	DEFAULT_SANDBOX_SHAPES,
	diskFor,
	fitMemory,
	memoryRangeFor,
	memoryText,
	presetOf,
	type SandboxShapes,
	shapeCentsPerHour,
	sizeText,
} from "./compute-model.ts";
import { NewSandboxDialog, ShapeFields } from "./sandboxes-page.tsx";

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

	it("gives a shape the disk the hosts would: a preset's own, else the smallest preset's with its memory", () => {
		expect(diskFor(DEFAULT_SANDBOX_SHAPES, { vcpus: 4, memoryMb: 8192 })).toBe(60);
		expect(diskFor(DEFAULT_SANDBOX_SHAPES, { vcpus: 1, memoryMb: 512 })).toBe(40);
		expect(diskFor(DEFAULT_SANDBOX_SHAPES, { vcpus: 5, memoryMb: 10_240 })).toBe(120);
		expect(diskFor(DEFAULT_SANDBOX_SHAPES, { vcpus: 16, memoryMb: 65_536 })).toBe(240);
		const none = { ...DEFAULT_SANDBOX_SHAPES, microvm: { ...DEFAULT_SANDBOX_SHAPES.microvm, presets: [] } };
		expect(diskFor(none, { vcpus: 2, memoryMb: 2048 })).toBeUndefined();
		expect(fields(DEFAULT_SANDBOX_SHAPES, { vcpus: 1, memoryMb: 512 })).toContain("40 GB disk");
		expect(fields(none, { vcpus: 2, memoryMb: 2048 })).not.toContain("GB disk");
	});

	it("offers only the presets, from a list, where no host makes other shapes", () => {
		expect(customShapes(DEFAULT_SANDBOX_SHAPES)).toBe(true);
		expect(customShapes(presetsOnly)).toBe(false);
		const html = fields(presetsOnly, { vcpus: 4, memoryMb: 8192 });
		expect(html).not.toContain('type="range"');
		expect(html.match(/<option/g)).toHaveLength(DEFAULT_SANDBOX_SHAPES.microvm.presets.length);
		expect(fields(DEFAULT_SANDBOX_SHAPES, { vcpus: 4, memoryMb: 8192 })).toContain('type="range"');
	});

	it("can't create until a source that says what its hosts offer has said", () => {
		const dialog = (shapes?: () => Promise<SandboxShapes>) =>
			renderToStaticMarkup(
				createElement(NewSandboxDialog, {
					open: true,
					account: { id: "acct", kind: "personal", name: "Ada", role: "owner", members: 1 },
					hosting: "self-hosted",
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
