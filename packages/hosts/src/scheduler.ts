/**
 * Placement: which host a new sandbox goes on. A sandbox then stays on its host (its disk and memory are there), so
 * this runs only at create, and at a fork, which stays on the source's host.
 *
 * A host qualifies when it is connected, not revoked or draining, runs the tier, can make the shape, carries every
 * label asked for, and has the memory and disk free. What it reported in its last heartbeat is reduced by what has
 * been placed on it since, so a burst of creates doesn't all land on the host that looked emptiest a few seconds ago.
 *
 * A microVM is asked for by shape (vCPUs and memory, and a disk where one is chosen) or, as before shapes, by a size's
 * name. A shape one of the host's named sizes has is that size; another is a custom shape, which a host makes only if
 * it reports `custom-shapes`, has the vCPUs and memory, and gives that disk (`diskLimitsOn`). The host restores it from the template it keeps for its vCPU count (or boots it from
 * scratch while that's being made, or when the host keeps templates per size).
 *
 * Among those, for the isolate tier, a host already holding the owner's runtime wins (isolates of one owner share a
 * VM); then the most free memory, the least loaded. Hosts keep no warm pools of running sandboxes, so no host is
 * preferred for having one ready: a create restores a snapshot wherever it lands.
 */
import type { PlacementReason } from "@kantel/contracts";
import { HOST_FEATURES, type HostDiskLimits, type HostSize, type SandboxTier } from "./protocol.ts";
import type { HostRecord } from "./store.ts";

/**
 * What a sandbox asks for: a microVM's vCPUs and memory, and its disk where one is chosen (else its host gives the
 * shape's, `diskFor`), or an isolate's memory alone (`vcpus` 0).
 */
export interface Shape {
	readonly vcpus: number;
	readonly memoryMiB: number;
	readonly diskGiB?: number;
}

/** As a host from before hosts said their disk limits took a custom shape's disk. */
const LEGACY_DISK_LIMITS: HostDiskLimits = { minGiB: 1, maxGiB: 4096 };

/** The disk `host` gives a custom shape: what it says, else what a host from before it said took. */
export const diskLimitsOn = (host: HostRecord): HostDiskLimits => host.facts?.disk ?? LEGACY_DISK_LIMITS;

export interface PlacementRequest {
	readonly tier: SandboxTier;
	/** A microVM's named size, as asked for before shapes; `shape` wins when both are given. Default `default`. */
	readonly size?: string;
	readonly shape?: Shape;
	readonly owner?: string;
	/** Labels the host must carry, such as `{"region": "eu"}`. */
	readonly labels?: { readonly [key: string]: string };
}

export interface Candidate {
	readonly host: HostRecord;
	readonly connected: boolean;
	/** Placed since its last report, not yet in its capacity. */
	readonly reservedMemoryMiB: number;
	readonly reservedDiskGiB: number;
	/** Owners with an isolate on the host. */
	readonly owners: ReadonlySet<string>;
}

export interface Placement {
	readonly host: HostRecord;
	/** What the host makes: one of its named sizes, or a custom shape (`custom`). */
	readonly size: HostSize;
	/** A shape off the host's named sizes: sent to it as vCPUs, memory and disk, and booted from scratch. */
	readonly custom: boolean;
}

/** No host can take it: why, in words, and as a `PlacementReason`. */
export type Refusal = { readonly reason: string; readonly code: PlacementReason };

/**
 * How far a host got through the checks before it was turned away, in the order `place` makes them; a refusal is named
 * after the furthest any host got, the nearest thing to fitting (a host with the size but full says to retry later).
 */
const STAGES: readonly PlacementReason[] = [
	"no_host",
	"no_host_for_type",
	"no_host_offers_size",
	"no_host_with_labels",
	"insufficient_capacity",
];

/**
 * What an isolate books on its host. Isolates share their owner's VM, which the host counts in its free memory once it
 * runs, so an isolate books only this much, whatever memory it asked for (128 to 512 MB): booking what it asked for
 * would have a host full of small isolates look full long before its VMs are. The memory it asked for goes to the host
 * and is recorded, not enforced (workerd has no per-isolate memory limit).
 */
export const ISOLATE_SIZE: HostSize = { name: "isolate", vcpus: 0, memoryMiB: 64, diskGiB: 0 };

/** The name a host gives a custom shape (apps/host/internal/microvm's CustomSizeName). */
export const customSizeName = (size: Omit<HostSize, "name">): string =>
	`custom-${size.vcpus}c-${size.memoryMiB}m-${size.diskGiB}g`;

/**
 * The disk a custom shape gets on `sizes`: the smallest named size with at least its memory's disk, else the largest
 * one's. A host with no named sizes gives 20 GiB.
 */
export function diskFor(sizes: readonly HostSize[], memoryMiB: number): number {
	const byMemory = [...sizes].sort((a, b) => a.memoryMiB - b.memoryMiB || a.diskGiB - b.diskGiB);
	return (byMemory.find((size) => size.memoryMiB >= memoryMiB) ?? byMemory.at(-1))?.diskGiB ?? 20;
}

/** Whether a host makes shapes off its named sizes. */
export const makesCustomShapes = (host: HostRecord): boolean =>
	host.facts?.features?.includes(HOST_FEATURES.customShapes) === true;

/**
 * What `host` would make for the request: a named size it has (by name, or by a shape matching one exactly), a custom
 * shape it can make, or nothing.
 */
export function shapeOn(
	host: HostRecord,
	request: Pick<PlacementRequest, "tier" | "size" | "shape">,
): { readonly size: HostSize; readonly custom: boolean } | undefined {
	if (request.tier === "isolate") return { size: ISOLATE_SIZE, custom: false };
	const facts = host.facts;
	if (facts === undefined) return undefined;
	const { shape } = request;
	if (shape === undefined) {
		const name = request.size ?? "default";
		const named = facts.sizes.find((candidate) => candidate.name === name);
		return named === undefined ? undefined : { size: named, custom: false };
	}
	const named = facts.sizes.find(
		(candidate) =>
			candidate.vcpus === shape.vcpus &&
			candidate.memoryMiB === shape.memoryMiB &&
			(shape.diskGiB === undefined || candidate.diskGiB === shape.diskGiB),
	);
	if (named !== undefined) return { size: named, custom: false };
	if (!makesCustomShapes(host) || shape.vcpus > facts.cpus || shape.memoryMiB > facts.memoryMiB) return undefined;
	if (shape.diskGiB !== undefined) {
		const limits = diskLimitsOn(host);
		if (shape.diskGiB < limits.minGiB || shape.diskGiB > limits.maxGiB) return undefined;
	}
	const custom = {
		vcpus: shape.vcpus,
		memoryMiB: shape.memoryMiB,
		diskGiB: shape.diskGiB ?? diskFor(facts.sizes, shape.memoryMiB),
	};
	return { size: { name: customSizeName(custom), ...custom }, custom: true };
}

/** Whether a disk asked for is outside what `host` gives a custom shape. */
const diskOutside = (host: HostRecord, diskGiB: number | undefined): boolean => {
	if (diskGiB === undefined) return false;
	const limits = diskLimitsOn(host);
	return diskGiB < limits.minGiB || diskGiB > limits.maxGiB;
};

/** A host's named size, by name: what a sandbox placed before shapes was made as. */
export function sizeOn(host: HostRecord, tier: SandboxTier, size: string): HostSize | undefined {
	return shapeOn(host, { tier, size })?.size;
}

/** The request in words, for a refusal: "4 vCPU, 8192 MiB" or "size large". */
const asked = (request: PlacementRequest): string =>
	request.tier === "isolate"
		? "an isolate"
		: request.shape === undefined
			? `a microVM of size ${request.size ?? "default"}`
			: `a microVM of ${request.shape.vcpus} vCPU and ${request.shape.memoryMiB} MiB${
					request.shape.diskGiB === undefined ? "" : ` with a ${request.shape.diskGiB} GiB disk`
				}`;

export function place(request: PlacementRequest, candidates: readonly Candidate[]): Placement | Refusal {
	const reasons = new Set<string>();
	let stage = 0;
	const turnedAway = (why: string, reached: PlacementReason) => {
		reasons.add(why);
		stage = Math.max(stage, STAGES.indexOf(reached));
	};
	const fits: {
		candidate: Candidate;
		size: HostSize;
		custom: boolean;
		free: number;
		owner: boolean;
	}[] = [];
	for (const candidate of candidates) {
		const { host } = candidate;
		if (host.revoked) continue;
		if (!candidate.connected) {
			turnedAway("not connected", "no_host");
			continue;
		}
		if (host.draining) {
			turnedAway("draining", "no_host");
			continue;
		}
		const facts = host.facts;
		const capacity = host.capacity;
		if (facts === undefined || capacity === undefined) {
			turnedAway("no report yet", "no_host");
			continue;
		}
		if (!facts.tiers.includes(request.tier)) {
			turnedAway(`no ${request.tier} tier`, "no_host_for_type");
			continue;
		}
		const shaped = shapeOn(host, request);
		if (shaped === undefined) {
			turnedAway(
				request.shape === undefined
					? `no size ${request.size ?? "default"}`
					: !makesCustomShapes(host)
						? "only its named sizes"
						: diskOutside(host, request.shape.diskGiB)
							? "no disk that size"
							: "too small for that shape",
				"no_host_offers_size",
			);
			continue;
		}
		const { size } = shaped;
		const labels = { ...facts.labels, ...host.labels };
		if (Object.entries(request.labels ?? {}).some(([key, value]) => labels[key] !== value)) {
			turnedAway("labels don't match", "no_host_with_labels");
			continue;
		}
		const freeMemory = capacity.freeMemoryMiB - candidate.reservedMemoryMiB;
		const freeDisk = capacity.freeDiskGiB - candidate.reservedDiskGiB;
		if (freeMemory < size.memoryMiB) {
			turnedAway("full", "insufficient_capacity");
			continue;
		}
		if (freeDisk < size.diskGiB) {
			turnedAway(`${Math.max(0, freeDisk)} GiB of disk free`, "insufficient_capacity");
			continue;
		}
		fits.push({
			candidate,
			size,
			custom: shaped.custom,
			free: freeMemory,
			owner: request.owner !== undefined && candidate.owners.has(request.owner),
		});
	}
	if (fits.length === 0) {
		const why = reasons.size === 0 ? "no hosts have joined" : [...reasons].sort().join(", ");
		return { reason: `No host can take ${asked(request)} (${why})`, code: STAGES[stage] ?? "no_host" };
	}
	fits.sort(
		(a, b) =>
			Number(b.owner) - Number(a.owner) ||
			b.free - a.free ||
			(a.candidate.host.capacity?.load1 ?? 0) - (b.candidate.host.capacity?.load1 ?? 0) ||
			(a.candidate.host.id < b.candidate.host.id ? -1 : 1),
	);
	const best = fits[0];
	if (best === undefined) return { reason: "No host", code: "no_host" };
	return { host: best.candidate.host, size: best.size, custom: best.custom };
}

export function isRefusal(value: Placement | Refusal): value is Refusal {
	return "reason" in value;
}
