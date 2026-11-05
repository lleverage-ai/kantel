/**
 * A new microVM's sizing, decided in one place (`sandboxMachine`) for every way one is made (a create, from a template
 * or a snapshot or neither, and a fork): the named size it is recorded under and the shape (vCPUs and memory) it asks
 * its host for. Its host gives the disk, and its placement then says what it got (its `resources`).
 */
import type { computeSchema } from "@kantel/api";
import { KantelError } from "@kantel/contracts";
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
 * Whether `host` can make a microVM of `shape`: one of its named sizes, or any shape it has room for where it makes them.
 * A create of that shape and a template build of it alike.
 */
export function makesShape(host: BackendHost, deploymentSizes: readonly BackendSize[], shape: BackendShape): boolean {
	if (!host.tiers.includes("microvm")) return false;
	const named = (host.sizes ?? deploymentSizes).some(
		(size) => size.vcpus === shape.vcpus && size.memoryMb === shape.memoryMb,
	);
	return named || (makesCustom(host) && shape.vcpus <= host.capacity.vcpus && shape.memoryMb <= host.capacity.memoryMb);
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

/** What a create asks for: a size by name, or a shape (checked, `shapeFor`); never both. */
export interface AskedMachine {
	readonly size?: computeSchema.SandboxSizeName;
	readonly shape?: BackendShape;
}

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
 * - a snapshot, or a source forked live: that sandbox's machine, unless `asked.size` names another size, which it then
 *   is; a live fork asks for none, so it is always its source's;
 * - else the size asked for, `default` when none is.
 */
export function sandboxMachine(
	source: MachineSource,
	asked: AskedMachine,
	presets: readonly BackendSize[],
): SandboxMachine | undefined {
	const shaped = (shape: BackendShape): SandboxMachine => {
		const preset = presetOf(presets, shape);
		return {
			...(preset === undefined ? {} : { size: preset }),
			shape: { vcpus: shape.vcpus, memoryMb: shape.memoryMb },
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
	const copiedShape =
		copied?.shape ??
		(copied?.resources === undefined
			? undefined
			: { vcpus: copied.resources.vcpus, memoryMb: copied.resources.memoryMb });
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

/**
 * What a new microVM that copies a machine (`copies`: a source forked live, or the sandbox a snapshot was taken of) will
 * be given, known before its host says: that machine's resources, disk included (its disk is a copy of that one), when
 * its sizing (`machine`, from `sandboxMachine`) is that machine's. Undefined when it asks for another size, or the
 * machine it copies records no resources, so its host's placement is the first to say.
 *
 * A fork's record carries these from the moment it is made, so it never reads as having no machine while it starts (the
 * console showed one with neither a size nor resources as its smallest size, 2 vCPU and 4 GB, until it ran).
 */
export function copiedResources(
	copies: RecordedMachine & { readonly shape?: BackendShape },
	machine: SandboxMachine | undefined,
): MachineResources | undefined {
	const own = copies.resources;
	if (machine === undefined || own === undefined) return undefined;
	const shape = machine.shape;
	const same =
		shape === undefined
			? machine.size !== undefined && machine.size === copies.size
			: shape.vcpus === own.vcpus && shape.memoryMb === own.memoryMb;
	return same ? { vcpus: own.vcpus, memoryMb: own.memoryMb, diskGb: own.diskGb } : undefined;
}

/** A snapshot as far as what a sandbox made from it may be goes. */
export interface RestoredSnapshot extends RecordedMachine {
	readonly id: string;
	/** Whether it holds its sandbox's memory, which restores only into the machine it was taken of. */
	readonly memory: boolean;
}

/**
 * What a create from `snapshot` may ask for (`asked`). A snapshot that holds its sandbox's memory restores only into
 * the machine it was taken of, so a create from one is that machine: an ask for it (its own size by name, or its
 * recorded vCPUs and memory) is dropped, so the sandbox goes under the snapshot's own size name, which its host checks;
 * any other ask is refused (`invalid`) before anything is made. Names are never looked up in other hosts' sizes, which
 * may mean other machines by them. A snapshot of the disk alone boots, so it may be any size; so may one that records no
 * machine (from before sizes), as before.
 */
export function restoreAsked(snapshot: RestoredSnapshot, asked: AskedMachine): AskedMachine {
	if (!snapshot.memory || !recordsMachine(snapshot)) return asked;
	if (asked.shape === undefined && (asked.size === undefined || asked.size === snapshot.size)) return {};
	const own = snapshot.resources;
	if (
		asked.shape !== undefined &&
		(asked.size === undefined || asked.size === snapshot.size) &&
		own !== undefined &&
		own.vcpus === asked.shape.vcpus &&
		own.memoryMb === asked.shape.memoryMb
	) {
		return {};
	}
	const machine = [
		...(snapshot.size === undefined ? [] : [`size ${snapshot.size}`]),
		...(own === undefined ? [] : [`${own.vcpus} vCPU and ${own.memoryMb} MB of memory`]),
	].join(", ");
	throw new KantelError(
		"invalid",
		`Snapshot ${snapshot.id} holds its sandbox's memory, so a sandbox made from it has that sandbox's machine (${machine}). Leave resources and size out, or ask for that machine`,
	);
}
