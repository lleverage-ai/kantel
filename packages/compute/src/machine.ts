/**
 * A new microVM's sizing, decided in one place (`sandboxMachine`) for every way one is made (a create, from a template
 * or a snapshot or neither, and a fork): the named size it is recorded under and the shape (vCPUs and memory, and a
 * disk where one is asked for or kept) it asks its host for. Without a disk its host gives the shape's, and its
 * placement then says what it got (its `resources`).
 */
import type { computeSchema } from "@kantel/api";
import {
	type BackendHost,
	type BackendShape,
	type BackendSize,
	CUSTOM_SHAPES_FEATURE,
	type MachineResources,
} from "./backend.ts";

/** Whether a host makes microVMs of any shape, not only its named sizes. */
export const makesCustom = (host: BackendHost): boolean => host.features?.includes(CUSTOM_SHAPES_FEATURE) === true;

/**
 * The most disk a host from before hosts said their limits is taken to give a microVM off its presets. kantel-host took
 * up to 4 TB then; offering that much in a slider says nothing useful, so a create of more goes to a host that says so.
 */
export const LEGACY_MAX_DISK_GB = 1024;

/**
 * The disk `host` gives a microVM off its presets: what it says (`BackendHost.disk`), else, for a host from before it
 * said, at least its smallest preset's (the disk its shared templates are made with, so anything smaller cold-boots)
 * and at most `LEGACY_MAX_DISK_GB`.
 */
export function diskLimitsOf(
	host: BackendHost,
	deploymentSizes: readonly BackendSize[],
): { readonly minGb: number; readonly maxGb: number } {
	if (host.disk !== undefined) return host.disk;
	const disks = (host.sizes ?? deploymentSizes).map((size) => size.diskGb).filter((gb) => gb > 0);
	return { minGb: disks.length === 0 ? 1 : Math.min(...disks), maxGb: LEGACY_MAX_DISK_GB };
}

/**
 * Whether `host` can make a microVM of `shape`: one of its named sizes (its disk too, where the shape names one), or any
 * shape it has the vCPUs and memory for, and a disk within its limits, where it makes them. A create of that shape and a
 * template build of it alike. Whether it has the free disk now is placement's to say.
 */
export function makesShape(host: BackendHost, deploymentSizes: readonly BackendSize[], shape: BackendShape): boolean {
	if (!host.tiers.includes("microvm")) return false;
	const named = (host.sizes ?? deploymentSizes).some(
		(size) =>
			size.vcpus === shape.vcpus &&
			size.memoryMb === shape.memoryMb &&
			(shape.diskGb === undefined || size.diskGb === shape.diskGb),
	);
	if (named) return true;
	if (!makesCustom(host) || shape.vcpus > host.capacity.vcpus || shape.memoryMb > host.capacity.memoryMb) return false;
	if (shape.diskGb === undefined) return true;
	const disk = diskLimitsOf(host, deploymentSizes);
	return shape.diskGb >= disk.minGb && shape.diskGb <= disk.maxGb;
}

/** A machine as a sandbox or a snapshot records it: the size it is named by, and what its host gave it. */
export interface RecordedMachine {
	readonly size?: computeSchema.SandboxSizeName;
	readonly resources?: MachineResources;
}

/**
 * Whether `of` records a machine: a named size, or resources alone (a custom shape no size names). A snapshot from
 * before sizes records neither, and is taken to be of its sandbox's machine.
 */
export const recordsMachine = (of: RecordedMachine): boolean => of.size !== undefined || of.resources !== undefined;

/**
 * The machine `of` records (a sandbox, or a snapshot), as a snapshot taken of it keeps it: its size and resources, a
 * microVM's (an isolate has neither).
 */
export function recordedMachine(of: RecordedMachine): RecordedMachine {
	return {
		...(of.size === undefined ? {} : { size: of.size }),
		...(of.resources === undefined ? {} : { resources: { ...of.resources } }),
	};
}

/**
 * A new microVM's sizing: the preset it is (by name; absent for a shape no preset has) and the shape it asks for
 * (absent: its size's).
 */
export interface SandboxMachine {
	readonly size?: computeSchema.SandboxSizeName;
	readonly shape?: BackendShape;
}

/** What a new sandbox is made from, as far as its machine goes. */
export type MachineSource =
	/** A template: its resources. */
	| { readonly template: computeSchema.TemplateResources }
	/** A snapshot (its sandbox's machine when taken), or a running sandbox forked live (its shape now). */
	| { readonly copies: RecordedMachine & { readonly shape?: BackendShape } }
	| undefined;

/**
 * What a create asks for: a size by name, or a shape (checked, `shapeFor`); never both. A disk alone (`diskGb`) is
 * given to the machine either makes, or the default size's.
 */
export interface AskedMachine {
	readonly size?: computeSchema.SandboxSizeName;
	readonly shape?: BackendShape;
	readonly diskGb?: number;
}

/** `shape`'s vCPUs and memory, and its disk where it has one. */
const copyShape = (shape: BackendShape, diskGb = shape.diskGb): BackendShape => ({
	vcpus: shape.vcpus,
	memoryMb: shape.memoryMb,
	...(diskGb === undefined || diskGb <= 0 ? {} : { diskGb }),
});

/** The preset among `presets` with exactly `shape`'s vCPUs and memory, by name. */
export const presetOf = (
	presets: readonly BackendSize[],
	shape: BackendShape,
): computeSchema.SandboxSizeName | undefined =>
	presets.find((size) => size.vcpus === shape.vcpus && size.memoryMb === shape.memoryMb)?.name;

/**
 * A new microVM's sizing, from what it is made from, what it asks for (`asked`) and the presets of the hosts it may go
 * to (`presets`), each shape named by the preset it matches, so its host restores that size's template snapshot:
 * - a shape asked for: that shape, whatever it is made from (a template's snapshot is then used only when it was built
 *   as that shape);
 * - a template: as a size asked for, that size's shape (undefined when no preset has the name); else its resources;
 * - a snapshot, or a source forked live: that sandbox's machine, its disk too, unless `asked.size` names another size,
 *   which it then is; a live fork asks for none, so it is always its source's;
 * - else the size asked for, `default` when none is.
 *
 * A disk asked for alone (`asked.diskGb`) then replaces that machine's: its shape is its size's vCPUs and memory with
 * that disk (undefined when no preset has the size). A machine's preset name stays with its vCPUs and memory, whatever
 * its disk: its shape says the disk.
 */
export function sandboxMachine(
	source: MachineSource,
	asked: AskedMachine,
	presets: readonly BackendSize[],
): SandboxMachine | undefined {
	const machine = machineOf(source, asked, presets);
	if (asked.diskGb === undefined || machine === undefined) return machine;
	const base = machine.shape ?? presets.find((each) => each.name === machine.size);
	if (base === undefined) return undefined;
	return { ...(machine.size === undefined ? {} : { size: machine.size }), shape: copyShape(base, asked.diskGb) };
}

/** `sandboxMachine` but for a disk asked for alone. */
function machineOf(
	source: MachineSource,
	asked: AskedMachine,
	presets: readonly BackendSize[],
): SandboxMachine | undefined {
	const shaped = (shape: BackendShape): SandboxMachine => {
		const preset = presetOf(presets, shape);
		return {
			...(preset === undefined ? {} : { size: preset }),
			shape: copyShape(shape),
		};
	};
	if (asked.shape !== undefined) return shaped(asked.shape);
	if (source !== undefined && "template" in source) {
		if (asked.size === undefined) return shaped(source.template);
		const named = presets.find((each) => each.name === asked.size);
		return named === undefined
			? undefined
			: { size: named.name, shape: { vcpus: named.vcpus, memoryMb: named.memoryMb } };
	}
	const copied = source?.copies;
	// Its disk is the copied machine's: what its host gave it, else what it asked for.
	const copiedBase =
		copied?.shape ??
		(copied?.resources === undefined
			? undefined
			: { vcpus: copied.resources.vcpus, memoryMb: copied.resources.memoryMb });
	const copiedShape =
		copiedBase === undefined ? undefined : copyShape(copiedBase, copied?.resources?.diskGb ?? copiedBase.diskGb);
	if (copied !== undefined && (copied.size !== undefined || copiedShape !== undefined)) {
		if (asked.size === undefined || asked.size === copied.size) {
			return {
				...(copied.size === undefined ? {} : { size: copied.size }),
				...(copiedShape === undefined ? {} : { shape: copiedShape }),
			};
		}
	}
	return { size: asked.size ?? "default" };
}
