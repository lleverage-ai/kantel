/**
 * Two copies of each saved snapshot (docs/design/disk-store.md, "Phase 3 notes", Two copies): a saved snapshot named by
 * its ID alone is kept on two hosts of its pool, where the pool has two or more that can hold it, so losing a host loses
 * no one's saved snapshot. Decided (11 Nov 2026): an account's setting (`StoredAccount.snapshotCopies`), on by default;
 * copies stay in the snapshot's pool.
 *
 * Which hosts keep a copy is the catalogue's (`StoredDiskHolder`, kind `snapshot`, version `disk`), as hosts report
 * them: a holder keeps one while its host is in the snapshot's pool and isn't revoked, nor away for `HOLDER_AWAY_MS`.
 * One still fetching it counts for `COPY_FETCH_MS` from when it was told, so a fetch that never finishes is passed over
 * for another host. With fewer than `SNAPSHOT_COPIES`, the host for another copy is picked here (`copyTarget`): one in
 * the pool that takes copies, those its memory restores on first, then those on its runtime (which have its root image),
 * then the one with the most disk free. The compute plane asks it to fetch the snapshot's disk (`disk.fetch`) after a
 * save once its host reports it, and again on each pass (and a revocation) while a copy is missing.
 *
 * Nothing else frees a copy: hosts never delete a saved snapshot of their own accord (their disk budget refuses a new
 * fetch, `ReserveSnapshotFetch`, rather than freeing one), and the control plane deletes a copy only with its snapshot,
 * or when a host reports one the catalogue has no record of (`DiskHolders.recordHoldings`).
 */
import { memoryRestoresOn, type SnapshotMadeOn } from "./backend.ts";
import type { StoredDiskHolder, StoredSnapshot } from "./store.ts";

/** How many hosts of its pool keep each saved snapshot. */
export const SNAPSHOT_COPIES = 2;

/** How long a holder's host may be away (unreachable) before its copy no longer counts, and another is made. */
export const HOLDER_AWAY_MS = 24 * 60 * 60_000;

/**
 * How long a host told to fetch a copy counts as keeping one while it hasn't it yet: long enough for a large disk over a
 * host's sync rate (200 GB at 60 MB/s is under an hour), so a fetch that fails without finishing is passed over.
 */
export const COPY_FETCH_MS = 3 * 60 * 60_000;

/** The least time between two asks for one snapshot's copy, from any gateway (`StoredSnapshot.copying`). */
export const COPY_RETRY_MS = 5 * 60_000;

/** How long a host asked for a copy that it doesn't hold is passed over for another. */
export const COPY_PASSED_OVER_MS = 60 * 60_000;

/**
 * The disk a host must still have free once it has fetched a snapshot (the host's `snapshotHeadroom`, which
 * `ReserveSnapshotFetch` holds it to): a host with less is refused before it is asked.
 */
export const SNAPSHOT_FETCH_HEADROOM_BYTES = 10 * 1024 ** 3;

/** The host features a host takes a saved snapshot's copy with (`HOST_FEATURES.diskSync`, `snapshotSync`). */
export const SNAPSHOT_COPY_FEATURES: readonly string[] = ["disk-sync", "snapshot-sync"];

/** A host as copies are counted and placed on it: its record's state and the backend's word on the rest. */
export interface CopyHost {
	readonly id: string;
	readonly state: "online" | "unreachable" | "draining" | "revoked";
	readonly poolId?: string;
	/** The account whose host it is; absent for a shared host. */
	readonly accountId?: string;
	readonly arch?: string;
	readonly lastSeenAt?: number;
	/** Absent: the backend doesn't say (the stub), so it takes copies. */
	readonly features?: readonly string[];
	/** Its mesh address: a host without one (its pool's sync off) neither serves nor fetches a copy. */
	readonly meshAddress?: string;
	readonly connected?: boolean;
	readonly freeDiskGb?: number;
	readonly cpuFingerprint?: string;
	readonly runtimeFingerprints?: readonly string[];
	/** The bytes of saved snapshots each account may keep on it (`Host.savedSnapshotBytesLimit`); absent: no limit. */
	readonly savedSnapshotBytesLimit?: number;
	/**
	 * What the snapshot's account may still keep in saved snapshots on it, in bytes, under its `savedSnapshotBytesLimit`,
	 * counting the account's own saves there and the copies it holds or is fetching. Absent: no limit.
	 */
	readonly savedBytesLeft?: number;
}

/** A saved snapshot as its copies are counted and placed. */
export type CopiedSnapshot = Pick<StoredSnapshot, "ref" | "accountId" | "memory" | "copying" | "sizeBytes"> &
	Pick<StoredSnapshot, "fullSizeBytes"> &
	SnapshotMadeOn;

/**
 * The holders of a saved snapshot's disk (`disk` holders of its ref) that keep a copy at `at`: held, or fetching for
 * less than `COPY_FETCH_MS`, on a host in `poolId` that isn't revoked and hasn't been away (unreachable, or draining and
 * disconnected) for `HOLDER_AWAY_MS`. One a host is to delete (`deleting`) keeps none.
 */
export function keepingCopies(
	holders: readonly StoredDiskHolder[],
	hosts: ReadonlyMap<string, CopyHost>,
	poolId: string,
	at: number,
): StoredDiskHolder[] {
	return holders.filter((holder) => {
		if (holder.state === "deleting") return false;
		if (holder.state === "fetching" && holder.since <= at - COPY_FETCH_MS) return false;
		const host = hosts.get(holder.hostId);
		if (host === undefined || host.state === "revoked" || host.poolId !== poolId) return false;
		// Away: unreachable, or draining and disconnected, which keeps its state.
		const away = host.state === "unreachable" || host.connected === false;
		return !(away && (host.lastSeenAt ?? 0) <= at - HOLDER_AWAY_MS);
	});
}

/**
 * The host to keep another copy of `snapshot` (in `poolId`) on, at `at`, given its disk's holders; undefined when it
 * has `SNAPSHOT_COPIES` already, no holder serves it (held, with a map digest, on a connected host of the pool with a
 * mesh address), or no other host can take one. A host takes one when it is online and connected in the pool, takes
 * copies (`SNAPSHOT_COPY_FEATURES`, its mesh address), is of an architecture a serving holder is, may hold the account's
 * data, has the room the snapshot takes and `SNAPSHOT_FETCH_HEADROOM_BYTES` more where it says what it has free, has the
 * account's saved snapshot allowance for it where it has a limit (`savedBytesLeft`), and has no holder of it but a fetch older than
 * `COPY_FETCH_MS` (nor was asked for one within `COPY_PASSED_OVER_MS` and didn't take it). Of those: one its memory restores on first (for a snapshot with
 * memory), then one on its runtime (the same host image, so it has its root image), then the most disk free.
 */
export function copyTarget(
	snapshot: CopiedSnapshot,
	holders: readonly StoredDiskHolder[],
	hosts: ReadonlyMap<string, CopyHost>,
	poolId: string,
	at: number,
): string | undefined {
	if (keepingCopies(holders, hosts, poolId, at).length >= SNAPSHOT_COPIES) return undefined;
	const live = (host: CopyHost | undefined): host is CopyHost =>
		host !== undefined &&
		(host.state === "online" || host.state === "draining") &&
		host.connected !== false &&
		host.poolId === poolId &&
		host.meshAddress !== undefined;
	const serving = holders
		.filter((holder) => holder.state === "held" && holder.mapDigest !== undefined)
		.map((holder) => hosts.get(holder.hostId))
		.filter(live);
	if (serving.length === 0) return undefined;
	const architectures = new Set(serving.map((host) => host.arch));
	// A host whose fetch has gone on past `COPY_FETCH_MS` (failed, its partial kept, or a host that doesn't report its
	// fetches) may be asked again: asked, its holder starts again.
	const holding = new Set(
		holders
			.filter((holder) => holder.state !== "fetching" || holder.since > at - COPY_FETCH_MS)
			.map((holder) => holder.hostId),
	);
	const passedOver =
		snapshot.copying !== undefined && snapshot.copying.at > at - COPY_PASSED_OVER_MS
			? snapshot.copying.hostId
			: undefined;
	const bytes = snapshot.fullSizeBytes ?? snapshot.sizeBytes ?? 0;
	const candidates = [...hosts.values()].filter(
		(host) =>
			live(host) &&
			host.state === "online" &&
			!holding.has(host.id) &&
			host.id !== passedOver &&
			architectures.has(host.arch) &&
			(host.accountId === undefined || host.accountId === snapshot.accountId) &&
			(host.features === undefined || SNAPSHOT_COPY_FEATURES.every((feature) => host.features?.includes(feature))) &&
			(host.freeDiskGb === undefined || host.freeDiskGb * 1024 ** 3 >= bytes + SNAPSHOT_FETCH_HEADROOM_BYTES) &&
			(host.savedBytesLeft === undefined || host.savedBytesLeft >= bytes),
	);
	const rank = (host: CopyHost): readonly number[] => [
		snapshot.memory && memoryRestoresOn(host, snapshot) ? 1 : 0,
		snapshot.runtime !== undefined &&
		snapshot.runtime !== "" &&
		(host.runtimeFingerprints ?? []).includes(snapshot.runtime)
			? 1
			: 0,
		host.freeDiskGb ?? 0,
	];
	let best: { readonly host: CopyHost; readonly rank: readonly number[] } | undefined;
	for (const host of candidates) {
		const ranked = rank(host);
		if (best === undefined || before(ranked, best.rank)) best = { host, rank: ranked };
	}
	return best?.host.id;
}

/** Whether rank `a` goes before `b`: the first figure that differs is higher. */
function before(a: readonly number[], b: readonly number[]): boolean {
	for (let index = 0; index < a.length; index++) {
		const [x, y] = [a[index] ?? 0, b[index] ?? 0];
		if (x !== y) return x > y;
	}
	return false;
}
