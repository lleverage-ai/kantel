/**
 * Placement: which host a new sandbox goes on. A sandbox then stays on its host (its disk and memory are there), so
 * this runs only at create, and at a fork, which stays on the source's host.
 *
 * A host qualifies when it is connected, not revoked or draining, runs the tier, offers the size, carries every label
 * asked for, and has the memory and disk free. What it reported in its last heartbeat is reduced by what has been
 * placed on it since, so a burst of creates doesn't all land on the host that looked emptiest a few seconds ago.
 *
 * Among those, a host with a warm sandbox of that tier and size ready wins (a create there is a restore, a few hundred
 * milliseconds, not a boot); then, for the isolate tier, a host already holding the owner's runtime (isolates of one
 * owner share a VM); then the most free memory, the least loaded.
 */
import type { HostSize, SandboxTier } from "./protocol.ts";
import type { HostRecord } from "./store.ts";

export interface PlacementRequest {
	readonly tier: SandboxTier;
	readonly size: string;
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
	readonly size: HostSize;
	readonly warm: boolean;
}

export type Refusal = { readonly reason: string };

/** The isolate tier's one shape: isolates are small, and share their owner's VM. */
export const ISOLATE_SIZE: HostSize = { name: "isolate", vcpus: 0, memoryMiB: 64, diskGiB: 0 };

export function sizeOn(host: HostRecord, tier: SandboxTier, size: string): HostSize | undefined {
	if (tier === "isolate") return ISOLATE_SIZE;
	return host.facts?.sizes.find((candidate) => candidate.name === size);
}

export function place(request: PlacementRequest, candidates: readonly Candidate[]): Placement | Refusal {
	const reasons = new Set<string>();
	const fits: { candidate: Candidate; size: HostSize; warm: boolean; free: number; owner: boolean }[] = [];
	for (const candidate of candidates) {
		const { host } = candidate;
		if (host.revoked) continue;
		if (!candidate.connected) {
			reasons.add("not connected");
			continue;
		}
		if (host.draining) {
			reasons.add("draining");
			continue;
		}
		const facts = host.facts;
		const capacity = host.capacity;
		if (facts === undefined || capacity === undefined) {
			reasons.add("no report yet");
			continue;
		}
		if (!facts.tiers.includes(request.tier)) {
			reasons.add(`no ${request.tier} tier`);
			continue;
		}
		const size = sizeOn(host, request.tier, request.size);
		if (size === undefined) {
			reasons.add(`no size ${request.size}`);
			continue;
		}
		const labels = { ...facts.labels, ...host.labels };
		if (Object.entries(request.labels ?? {}).some(([key, value]) => labels[key] !== value)) {
			reasons.add("labels don't match");
			continue;
		}
		const freeMemory = capacity.freeMemoryMiB - candidate.reservedMemoryMiB;
		const freeDisk = capacity.freeDiskGiB - candidate.reservedDiskGiB;
		if (freeMemory < size.memoryMiB || freeDisk < size.diskGiB) {
			reasons.add("full");
			continue;
		}
		const pool = `${request.tier}/${request.tier === "isolate" ? "default" : size.name}`;
		fits.push({
			candidate,
			size,
			warm: (capacity.warm[pool] ?? 0) > 0,
			free: freeMemory,
			owner: request.owner !== undefined && candidate.owners.has(request.owner),
		});
	}
	if (fits.length === 0) {
		const why = reasons.size === 0 ? "no hosts have joined" : [...reasons].sort().join(", ");
		return { reason: `No host can take a ${request.tier} sandbox of size ${request.size} (${why})` };
	}
	fits.sort(
		(a, b) =>
			Number(b.warm) - Number(a.warm) ||
			Number(b.owner) - Number(a.owner) ||
			b.free - a.free ||
			(a.candidate.host.capacity?.load1 ?? 0) - (b.candidate.host.capacity?.load1 ?? 0) ||
			(a.candidate.host.id < b.candidate.host.id ? -1 : 1),
	);
	const best = fits[0];
	if (best === undefined) return { reason: "No host" };
	return { host: best.candidate.host, size: best.size, warm: best.warm };
}

export function isRefusal(value: Placement | Refusal): value is Refusal {
	return "reason" in value;
}
