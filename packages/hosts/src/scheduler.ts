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
 * VM); then a host that holds the head of every sticky disk the sandbox attaches (`holdsHeads`), so it starts with a
 * warm cache rather than its host's older version or an empty disk (docs/design/disk-store.md, 2d). That is a preference
 * only: a host without the heads starts from what it has and fetches them in the background. Then the least full once
 * it is placed (`fullness`): the larger of the share of its memory taken and the share of
 * its vCPUs booked, so sandboxes spread over hosts of different sizes in proportion, and a host whose CPUs are all booked
 * by a few large sandboxes isn't picked for having memory left; then the least loaded for its CPUs. vCPUs are only
 * ranked on, never refused on: a host admits by memory and disk, and a booked vCPU is a share of its CPU time, not a
 * core of its own. Hosts keep no warm pools of running sandboxes, so no host is preferred for having one ready: a create
 * restores a snapshot wherever it lands.
 */
import type { PlacementReason } from "@kantel/contracts";
import { HOST_FEATURES, type HostCapacity, type HostDiskLimits, type HostSize, type SandboxTier } from "./protocol.ts";
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
	/** The sticky disks it attaches, each with its head where it has one: a host holding every head is preferred. */
	readonly stickyDisks?: readonly StickyHead[];
}

/** A sticky disk a sandbox attaches, and its head (`version`): absent for a disk with no version yet. */
export interface StickyHead {
	readonly diskId: string;
	readonly version?: string;
}

/**
 * Whether `host` last reported holding the head of every sticky disk in `disks` (`HostCapacity.stickyDisks`). A disk
 * with no head yet asks for nothing, so with none every host holds them all; a host that doesn't say what it holds
 * holds none.
 */
export function holdsHeads(host: HostRecord, disks: readonly StickyHead[] | undefined): boolean {
	const held = host.capacity?.stickyDisks;
	return (disks ?? []).every(
		(disk) =>
			disk.version === undefined ||
			held?.some(
				(holding) =>
					holding.diskId === disk.diskId && holding.versions.some((version) => version.version === disk.version),
			) === true,
	);
}

export interface Candidate {
	readonly host: HostRecord;
	readonly connected: boolean;
	/** Placed since its last report, not yet in its capacity. */
	readonly reservedMemoryMiB: number;
	readonly reservedDiskGiB: number;
	/** What `reservedMemoryMiB` is made of (`freeMemoryOn`); absent, one sandbox of all of it. */
	readonly heldMemory?: readonly HeldMemory[];
	/** Owners with an isolate on the host. */
	readonly owners: ReadonlySet<string>;
	/**
	 * The vCPUs of the microVMs placed on the host that are live (starting, running or stopping), this replica's and every other's (the
	 * placements are shared). Absent, none are counted: the host ranks by memory alone.
	 */
	readonly bookedVcpus?: number;
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
 * would have a host full of small isolates look full long before its VMs are. The memory it asked for goes to the host,
 * whose runtime enforces it per isolate where it says `memoryEnforced` (`HostIsolateRuntime`).
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
 * Whether a disk asked for is outside what `host` gives a custom shape: its limits (`diskLimitsOn`), unless one of its
 * named sizes has that disk, as kantel-host's checkDisk admits it. A custom shape given a named size's disk by default
 * (`diskFor`) records that disk, so a copy of it asking for it again goes to the same host.
 */
const diskOutside = (host: HostRecord, diskGiB: number | undefined): boolean => {
	if (diskGiB === undefined) return false;
	if (host.facts?.sizes.some((size) => size.diskGiB === diskGiB) === true) return false;
	const limits = diskLimitsOn(host);
	return diskGiB < limits.minGiB || diskGiB > limits.maxGiB;
};

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
	if (diskOutside(host, shape.diskGiB)) return undefined;
	const custom = {
		vcpus: shape.vcpus,
		memoryMiB: shape.memoryMiB,
		diskGiB: shape.diskGiB ?? diskFor(facts.sizes, shape.memoryMiB),
	};
	return { size: { name: customSizeName(custom), ...custom }, custom: true };
}

/**
 * A size a host made, by the name it answered: one of its named sizes, or a custom size by its name
 * (`customSizeName`). Undefined for a name it doesn't say and that isn't a custom size's.
 */
export function hostSizeNamed(host: HostRecord | undefined, name: string): HostSize | undefined {
	const named = host?.facts?.sizes.find((size) => size.name === name);
	if (named !== undefined) return named;
	const custom = /^custom-(\d+)c-(\d+)m-(\d+)g$/.exec(name);
	if (custom === null) return undefined;
	return { name, vcpus: Number(custom[1]), memoryMiB: Number(custom[2]), diskGiB: Number(custom[3]) };
}

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

/** Memory placed on a host (or building there) that its last report doesn't count yet: a build's counts in full. */
export interface HeldMemory {
	readonly memoryMiB: number;
	readonly build?: boolean;
}

/**
 * The memory a host has free for one more sandbox, given what was placed on it (or is building there) since its last
 * report. A host admitting by what sandboxes were given says what it has free, less what is held. One admitting by use
 * (memory over-commit) says the largest single microVM it would admit, which isn't additive: what is held is charged
 * against what it admits against (`HostMemoryAdmission`) in its own units, a new microVM at its size of what may be
 * reserved and its starting commitment of what may be committed, a build in full of both, and what is free is the
 * largest size that still fits both, at most what it said.
 */
export function freeMemoryOn(capacity: HostCapacity, held: readonly HeldMemory[]): number {
	const left = admissionLeft(capacity, held);
	if (left === undefined) return capacity.freeMemoryMiB - held.reduce((sum, entry) => sum + entry.memoryMiB, 0);
	if (held.length === 0) return capacity.freeMemoryMiB;
	const { reservable, committable, commit } = left;
	if (reservable <= 0 || committable <= 0) return 0;
	// A commitment grows with size: the largest size whose commitment fits, at most what may be reserved.
	let lo = 0;
	let hi = Math.min(reservable, capacity.freeMemoryMiB);
	while (lo < hi) {
		const mid = lo + Math.ceil((hi - lo) / 2);
		if (commit(mid) <= committable) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * Whether a template build of `memoryMiB` fits on a host beside what is `held` there: by use, it counts in full of what
 * may be reserved and committed both.
 */
export function buildFitsOn(capacity: HostCapacity, held: readonly HeldMemory[], memoryMiB: number): boolean {
	const left = admissionLeft(capacity, held);
	if (left === undefined) return freeMemoryOn(capacity, held) >= memoryMiB;
	return left.reservable >= memoryMiB && left.committable >= memoryMiB;
}

/** What a host admitting by use has left with `held` charged in its units (`HostMemoryAdmission`); else undefined. */
function admissionLeft(capacity: HostCapacity, held: readonly HeldMemory[]) {
	const admission = capacity.memory?.mode === "used" ? capacity.memory.admission : undefined;
	if (admission === undefined) return undefined;
	const headroom = (size: number) =>
		Math.min(size, Math.max(admission.headroomMiB, Math.floor((size * admission.headroomPercent) / 100)));
	const commit = (size: number) => Math.min(size, admission.startMiB + headroom(size));
	return {
		reservable: admission.reservableMiB - held.reduce((sum, entry) => sum + entry.memoryMiB, 0),
		committable:
			admission.committableMiB -
			held.reduce((sum, entry) => sum + (entry.build === true ? entry.memoryMiB : commit(entry.memoryMiB)), 0),
		commit,
	};
}

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
		heads: boolean;
		fullness: number;
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
		const freeMemory = freeMemoryOn(
			capacity,
			candidate.heldMemory ?? (candidate.reservedMemoryMiB > 0 ? [{ memoryMiB: candidate.reservedMemoryMiB }] : []),
		);
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
			heads: holdsHeads(host, request.stickyDisks),
			fullness: fullness(candidate, size, freeMemory),
		});
	}
	if (fits.length === 0) {
		const why = reasons.size === 0 ? "no hosts have joined" : [...reasons].sort().join(", ");
		return { reason: `No host can take ${asked(request)} (${why})`, code: STAGES[stage] ?? "no_host" };
	}
	fits.sort(
		(a, b) =>
			Number(b.owner) - Number(a.owner) ||
			Number(b.heads) - Number(a.heads) ||
			a.fullness - b.fullness ||
			b.free - a.free ||
			loadPerCpu(a.candidate.host) - loadPerCpu(b.candidate.host) ||
			(a.candidate.host.id < b.candidate.host.id ? -1 : 1),
	);
	const best = fits[0];
	if (best === undefined) return { reason: "No host", code: "no_host" };
	return { host: best.candidate.host, size: best.size, custom: best.custom };
}

/**
 * How full a host would be with `size` placed on it, from 0 (more than 1 when over-booked): the larger of the share of
 * its memory reserved and the share of its vCPUs booked. Memory is counted in one set of units: what its sandboxes were
 * given (`HostMemoryReport.reservedMiB`), and what was placed since the report, over what it has for sandboxes
 * (`capacityMiB`), whichever way it admits them. Free memory as a host reports it is what it would still admit, which
 * over-commit makes larger than what is unused, so it isn't a share of anything. A host from before memory reports
 * counts its machine's memory less what it said was free. vCPUs are its CPUs, booked by live microVMs. Rounded to a
 * hundredth, so two hosts about as full are ranked by what comes next (the most free memory, the least loaded).
 */
export function fullness(candidate: Candidate, size: HostSize, freeMemoryMiB: number): number {
	const { host } = candidate;
	const report = host.capacity?.memory;
	const held = candidate.heldMemory?.reduce((sum, entry) => sum + entry.memoryMiB, 0) ?? candidate.reservedMemoryMiB;
	const memory =
		report !== undefined && report.capacityMiB > 0
			? (report.reservedMiB + held + size.memoryMiB) / report.capacityMiB
			: (host.facts?.memoryMiB ?? 0) > 0
				? ((host.facts?.memoryMiB ?? 0) - freeMemoryMiB + size.memoryMiB) / (host.facts?.memoryMiB ?? 1)
				: 0;
	const cpus = host.facts?.cpus ?? 0;
	const vcpus = cpus > 0 && candidate.bookedVcpus !== undefined ? (candidate.bookedVcpus + size.vcpus) / cpus : 0;
	return Math.round(Math.max(memory, vcpus, 0) * 100) / 100;
}

/** A host's one-minute load for each of its CPUs. */
const loadPerCpu = (host: HostRecord): number => (host.capacity?.load1 ?? 0) / Math.max(1, host.facts?.cpus ?? 1);

export function isRefusal(value: Placement | Refusal): value is Refusal {
	return "reason" in value;
}
