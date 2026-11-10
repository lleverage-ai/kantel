import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { onStep, sliderPercent } from "../primitives/slider.tsx";
import {
	customShapes,
	DEFAULT_SANDBOX_SHAPES,
	diskRangeFor,
	fitDisk,
	fitMemory,
	memoryRangeFor,
	memoryText,
	microvmsAvailable,
	onGrid,
	presetOf,
	type SandboxShapes,
	sandboxSpec,
	shapeAllowed,
	shapeCentsPerHour,
	shapeCreatable,
	sizeText,
	vcpuRangeFor,
} from "./compute-model.ts";
import { NewSandboxDialog, type NewSandboxForm, newSandboxInput, ShapeFields } from "./sandboxes-page.tsx";

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

	it("counts an isolate with no resources as the default isolate, never a microVM size", () => {
		const unshaped = sandboxSpec({ kind: "isolate" });
		expect(unshaped).toEqual({ vcpus: 0, memoryGb: 0.25, diskGb: 0 });
		expect(sizeText(unshaped)).toBe("Shared CPU, 256 MB");
		const given = { vcpus: 0, memoryGb: 0.375, diskGb: 0 };
		expect(sandboxSpec({ kind: "isolate", resources: given })).toBe(given);
		// One that asked for 512 MB reads as that while it starts.
		expect(sandboxSpec({ kind: "isolate", shape: { vcpus: 0, memoryGb: 0.5 } })).toEqual({
			vcpus: 0,
			memoryGb: 0.5,
			diskGb: 0,
		});
	});

	it("shows a microVM's asked shape until its host says, and never a sample size's figures", () => {
		// A custom 4 vCPU, 16 GB microVM while it starts: its shape, no disk yet.
		const starting = sandboxSpec({ kind: "microvm", shape: { vcpus: 4, memoryGb: 16 } });
		expect(starting).toEqual({ vcpus: 4, memoryGb: 16 });
		expect(sizeText(starting)).toBe("4 vCPU, 16 GB");
		// Once its host says, what it got.
		const placed = { vcpus: 4, memoryGb: 16, diskGb: 50 };
		expect(sandboxSpec({ kind: "microvm", shape: { vcpus: 4, memoryGb: 16 }, resources: placed })).toBe(placed);
		// Neither (a named size not placed yet, or made before shapes): unknown, not the sample small's 2 vCPU, 4 GB.
		expect(sandboxSpec({ kind: "microvm" })).toBeUndefined();
		expect(sizeText(undefined)).toBe("–");
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
	// Older hosts: only their presets, and no disk off them.
	const { diskGb: _disk, ...noDisk } = DEFAULT_SANDBOX_SHAPES.microvm;
	const presetsOnly: SandboxShapes = { ...DEFAULT_SANDBOX_SHAPES, microvm: { ...noDisk, custom: false } };
	const fields = (
		shapes: SandboxShapes,
		shape: { vcpus: number; memoryMb: number; diskGb?: number },
		diskKept = false,
		diskInherited = false,
	) =>
		renderToStaticMarkup(
			createElement(ShapeFields, {
				kind: "microvm",
				shapes,
				hosting: "self-hosted",
				shape,
				diskKept,
				diskInherited,
				onVcpus: () => {},
				onMemory: () => {},
				onDisk: () => {},
				onPreset: () => {},
			}),
		);

	it("offers a disk where the hosts take one off their presets, and not from a snapshot, which keeps its own", () => {
		const html = fields(DEFAULT_SANDBOX_SHAPES, { vcpus: 4, memoryMb: 8192, diskGb: 80 });
		expect(html).toContain("4 vCPU, 8 GB memory, 80 GB disk");
		expect(html).toContain(">Disk<");
		expect(html.match(/type="range"/g)).toHaveLength(3);
		expect(html).toMatch(/min="20" max="500" step="1"[^>]*value="80"/);
		// From a snapshot: no disk to choose, and it says why.
		const kept = fields(DEFAULT_SANDBOX_SHAPES, { vcpus: 4, memoryMb: 8192 }, true);
		expect(kept).not.toMatch(/GB disk/);
		expect(kept.match(/type="range"/g)).toHaveLength(2);
		expect(kept).toContain("A sandbox made from a snapshot keeps its disk.");
		// A template's own machine: its host gives the disk, so none shows as chosen until one is.
		const inherited = fields(DEFAULT_SANDBOX_SHAPES, { vcpus: 2, memoryMb: 4096 }, false, true);
		expect(inherited).not.toMatch(/GB disk/);
		expect(inherited.match(/type="range"/g)).toHaveLength(2);
		expect(inherited).toContain("Disk: the template&#x27;s own, as its host gives it.");
		expect(inherited).toContain("Choose a disk");
		// Hosts that take no disk off their presets: none is offered, whether they make other shapes or only presets.
		const custom = fields({ ...DEFAULT_SANDBOX_SHAPES, microvm: noDisk }, { vcpus: 3, memoryMb: 6144 });
		expect(custom).not.toMatch(/GB disk|>Disk</);
		expect(custom.match(/type="range"/g)).toHaveLength(2);
		expect(fields(presetsOnly, { vcpus: 4, memoryMb: 8192 })).not.toMatch(/GB disk|>Disk</);
		// Only presets, even where a disk range is said: each preset's own disk.
		const listed = { ...DEFAULT_SANDBOX_SHAPES, microvm: { ...DEFAULT_SANDBOX_SHAPES.microvm, custom: false } };
		expect(diskRangeFor(listed)).toBeUndefined();
		expect(fields(listed, { vcpus: 4, memoryMb: 8192 })).not.toMatch(/GB disk|>Disk</);
	});

	it("keeps a disk on its slider's grid, from the hosts' default, and allows none outside its range", () => {
		expect(diskRangeFor(DEFAULT_SANDBOX_SHAPES)).toEqual({ min: 20, max: 500, step: 1, default: 60 });
		expect(fitDisk(DEFAULT_SANDBOX_SHAPES)).toBe(60);
		const read: SandboxShapes = {
			...DEFAULT_SANDBOX_SHAPES,
			microvm: { ...DEFAULT_SANDBOX_SHAPES.microvm, diskGb: { min: 10, max: 200, step: 5, default: 42 } },
		};
		expect(fitDisk(read)).toBe(40);
		expect(fitDisk(read, 999)).toBe(200);
		expect(fitDisk({ ...DEFAULT_SANDBOX_SHAPES, microvm: noDisk })).toBeUndefined();
		const medium = { vcpus: 4, memoryMb: 8192 };
		expect(shapeAllowed(DEFAULT_SANDBOX_SHAPES, { ...medium, diskGb: 120 })).toBe(true);
		expect(shapeAllowed(DEFAULT_SANDBOX_SHAPES, { ...medium, diskGb: 10 })).toBe(false);
		expect(shapeAllowed(DEFAULT_SANDBOX_SHAPES, { ...medium, diskGb: 501 })).toBe(false);
		expect(shapeAllowed(DEFAULT_SANDBOX_SHAPES, { vcpus: 5, memoryMb: 8192, diskGb: 501 })).toBe(false);
		// No disk may be asked for where no host takes one.
		expect(shapeAllowed({ ...DEFAULT_SANDBOX_SHAPES, microvm: noDisk }, { ...medium, diskGb: 60 })).toBe(false);
		expect(shapeCreatable(DEFAULT_SANDBOX_SHAPES, "microvm", { ...medium, diskGb: 1000 })).toBe(false);
		// A preset is still the preset whatever disk it asks for, and the disk isn't priced.
		expect(presetOf(DEFAULT_SANDBOX_SHAPES, { ...medium, diskGb: 200 })?.name).toBe("medium");
		expect(shapeCentsPerHour(DEFAULT_SANDBOX_SHAPES, "microvm", { ...medium, diskGb: 400 })).toBe(4);
	});

	it("sends the disk chosen for a microVM, and none from a snapshot or for an isolate", () => {
		const form = {
			accountId: "acct",
			name: "",
			kind: "microvm" as const,
			shape: { vcpus: 4, memoryMb: 8192, diskGb: 80 },
			shapeChosen: false,
			from: "",
			environments: [],
			autoStop: "never",
		};
		expect(newSandboxInput(form).shape).toEqual({ vcpus: 4, memoryMb: 8192, diskGb: 80 });
		const fromSnapshot = newSandboxInput({ ...form, from: "snap_1" });
		expect(fromSnapshot.fromSnapshot).toBe("snap_1");
		expect(fromSnapshot.shape).toEqual({ vcpus: 4, memoryMb: 8192 });
		expect(fromSnapshot.shape).not.toHaveProperty("diskGb");
		const isolate = newSandboxInput({ ...form, kind: "isolate", shape: { vcpus: 0, memoryMb: 256, diskGb: 80 } });
		expect(isolate.shape).toEqual({ vcpus: 0, memoryMb: 256 });
		expect(newSandboxInput({ ...form, shape: { vcpus: 4, memoryMb: 8192 } }).shape).not.toHaveProperty("diskGb");
		// A template's own machine sends no shape, so no disk; one chosen goes with the shape.
		const template = { id: "tpl_1", spec: { vcpus: 2, memoryMb: 4096 } } as NonNullable<NewSandboxForm["template"]>;
		const own = newSandboxInput({ ...form, shape: { vcpus: 2, memoryMb: 4096 }, template });
		expect(own).not.toHaveProperty("shape");
		expect(own.templateId).toBe("tpl_1");
		const chosen = newSandboxInput({
			...form,
			shape: { vcpus: 2, memoryMb: 4096, diskGb: 90 },
			template,
			shapeChosen: true,
		});
		expect(chosen.shape).toEqual({ vcpus: 2, memoryMb: 4096, diskGb: 90 });
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
		// The disk starts at the shapes' default: the medium preset's 60 GB.
		expect(defaults).toContain(">Disk<");
		expect(defaults).toContain('aria-valuetext="60 GB"');
		expect(defaults).toContain("4 vCPU, 8 GB memory, 60 GB disk");
	});
});
