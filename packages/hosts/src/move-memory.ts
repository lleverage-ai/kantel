/**
 * Whether a move keeps a sandbox's memory, and how long it pauses it (docs/design/disk-store.md, "Moving a sandbox to
 * another host", keeping memory). Memory moves only between hosts that both move it (`HOST_FEATURES.sandboxMoveMemory`)
 * and whose CPU and runtime fingerprints match: the target's CPU the source's (`sameCpu`), and the runtime the memory is
 * of among the target's (`memoryRestoresOn`). Elsewhere the move restarts the sandbox, and says why.
 *
 * The pause a move that keeps memory takes is mostly the memory's copy: its size (`HostSandboxMemory.bytes`, a running
 * machine's resident memory, whose untouched rest is zero and costs nothing to fetch) over the link's rate. The rate is
 * measured by the hosts themselves: each reports the rate its last fetch of at least 16 MiB from each peer ran at
 * (`HostMeshPeerHealth.fetchBytesPerSecond`). The target's rate from the source is used, else the source's from the
 * target (the same link the other way), else, with neither measured yet, 1 Gbit/s, the hosts' usual link.
 */

import { memoryRestoresOn, sameCpu } from "./facts.ts";
import { HOST_FEATURES, type HostSandboxMemory } from "./protocol.ts";
import type { HostRecord } from "./store.ts";

/**
 * What a move to one host does with a sandbox's memory: keeps it, or restarts the sandbox, and why. The reason names
 * no host (its host, the new host): it goes on the sandbox's record, which callers who may not know its hosts read too.
 */
export interface MoveMemoryWay {
	readonly kept: boolean;
	/** Why it restarts, where it has memory that might have moved: absent when it is kept, or there is none. */
	readonly reason?: string;
}

/** The rate a pause is estimated at, in bytes a second, and whether a host measured it. */
export interface MoveLinkRate {
	readonly bytesPerSecond: number;
	readonly measured: boolean;
}

/** The rate assumed before either host has measured one: 1 Gbit/s. */
export const ASSUMED_LINK_BYTES_PER_SECOND = 125_000_000;

/**
 * What a move from `source` to `target` does with the memory `memory` says the sandbox has (`sandbox.memory` on its
 * source; absent from a source that can't say), where the move asks to keep it (`keep`).
 */
export function moveMemoryWay(
	source: HostRecord,
	target: HostRecord,
	memory: HostSandboxMemory | undefined,
	keep: boolean,
): MoveMemoryWay {
	if (!keep) return { kept: false };
	const moves = (host: HostRecord) => host.facts?.features?.includes(HOST_FEATURES.sandboxMoveMemory) === true;
	if (!moves(source)) {
		return { kept: false, reason: "Its host can't move a sandbox's memory: upgrade its kantel-host" };
	}
	if (memory === undefined || !memory.memory) return { kept: false };
	if (!moves(target)) {
		return { kept: false, reason: "The new host can't take a sandbox's memory: upgrade its kantel-host" };
	}
	if (memory.refused !== undefined) return { kept: false, reason: `Its memory can't move: ${memory.refused}` };
	if (!sameCpu(source.facts?.cpu, target.facts?.cpu)) {
		return {
			kept: false,
			reason:
				source.facts?.cpu === undefined || target.facts?.cpu === undefined
					? `${source.facts?.cpu === undefined ? "Its host" : "The new host"} doesn't say what its CPU is, so its memory can't be restored there`
					: "The new host has another CPU than its host, so its memory can't be restored there",
		};
	}
	if (memory.runtime === undefined || memory.runtime === "") {
		return {
			kept: false,
			reason: "Its host can't tell what runtime its memory is of, so it can't be restored on another",
		};
	}
	if (!memoryRestoresOn(target.facts, { cpu: source.facts?.cpu, runtime: memory.runtime })) {
		return {
			kept: false,
			reason:
				"The new host has another runtime (Firecracker, guest kernel or image) than its memory was made with, so it can't be restored there",
		};
	}
	return { kept: true };
}

/** The rate a fetch from `source` to `target` runs at, as the hosts last measured it, else the assumed rate. */
export function moveLinkRate(source: HostRecord, target: HostRecord): MoveLinkRate {
	const measured = (from: HostRecord, of: HostRecord) =>
		from.capacity?.mesh?.peers.find((peer) => peer.hostId === of.id)?.fetchBytesPerSecond;
	const rate = measured(target, source) ?? measured(source, target);
	return rate !== undefined && rate > 0
		? { bytesPerSecond: rate, measured: true }
		: { bytesPerSecond: ASSUMED_LINK_BYTES_PER_SECOND, measured: false };
}

/** The pause a move that keeps `bytes` of memory takes, in milliseconds, at `rate`: the memory's copy. */
export function movePauseMs(bytes: number, rate: MoveLinkRate): number {
	return Math.ceil((Math.max(0, bytes) / rate.bytesPerSecond) * 1000);
}
