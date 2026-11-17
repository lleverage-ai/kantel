/**
 * Keeping a synced pool's hosts caught up on its sticky disks (docs/design/disk-store.md, 2d, "Backfill"): each host of
 * a pool with `sync` on holds the head of every sticky disk the pool uses, fetched from its peers in the background, so
 * a host that joins the pool, is moved into it, comes back after being away, or missed a commit's prefetch doesn't wait
 * for a job to commit on it or for a create to need the data.
 *
 * A disk the pool uses is a live one of the pool whose head has its block map's digest, on which a sandbox started on
 * any of the pool's hosts within `STICKY_PREFETCH_MS` (`StoredStickyDisk.ranOn`): a disk nothing has used for a week
 * isn't copied to a new host. Only the head is wanted, never an older version.
 *
 * This module decides, from what the catalogue and the hosts say, what each host should hold and what it should be told
 * to fetch next (`planStickyBackfill`). The compute plane sends the fetches (`disk.fetch`, as a commit's prefetch does)
 * on its sweep and after each commit, and the API answers the same plan as each host's sync status, so what the console
 * calls missing is what the next pass fetches.
 */
import {
	STICKY_PREFETCH_MS,
	type StoredDiskHolder,
	type StoredStickyDisk,
	type StoredStickyDiskVersion,
} from "./store.ts";

/** The host feature of a host that fetches disk versions from its peers (`HOST_FEATURES.diskSync`). */
export const DISK_SYNC_FEATURE = "disk-sync";

/** How often the sweep goes over every synced pool for heads its hosts are missing. */
export const BACKFILL_EVERY_MS = 60_000;

/**
 * The most backfill fetches a host is given at once, counting those it is already fetching of any kind: the host runs
 * two at a time itself (`--sync-fetches`) and queues the rest, so this keeps its queue short enough that a create's own
 * fetch, a template copy or a commit's prefetch isn't stuck behind a pool's whole catalogue.
 */
export const BACKFILL_HOST_FETCHES = 2;

/**
 * How long a host told to backfill a version isn't told it again while it neither holds nor reports fetching it: a fetch
 * that failed outright (no holder it could reach) is tried again after this, not on every pass.
 */
export const BACKFILL_RETRY_MS = 10 * 60_000;

/** The disk a host must still have free once it holds a backfilled version, as for a saved snapshot's copy. */
export const BACKFILL_HEADROOM_BYTES = 10 * 1024 ** 3;

/** A host as backfill sees it: its record's state and the backend's word on the rest. */
export interface BackfillHost {
	readonly id: string;
	readonly state: "online" | "unreachable" | "draining" | "revoked";
	readonly poolId?: string;
	/** The account whose host it is; absent for a shared host, which may hold any account's data. */
	readonly accountId?: string;
	readonly connected: boolean;
	/** Absent: the backend doesn't say (the stub), so it syncs. */
	readonly features?: readonly string[];
	readonly freeDiskGb?: number;
	/** Its mesh address, given only while its pool syncs: a host without one fetches nothing. */
	readonly meshAddress?: string;
}

/**
 * Where a host stands on one wanted head:
 * - `held`: it holds it.
 * - `fetching`: it reports fetching it (progress is in its last capacity report).
 * - `missing`: it should hold it, and will be told to fetch it.
 * - `waiting`: it should hold it, and will be told once it has fewer fetches under way.
 * - `no-room`: it hasn't the disk free for it and the headroom a fetch must leave.
 * - `no-source`: no other host of the pool that can serve it holds it.
 */
export type BackfillState = "held" | "fetching" | "missing" | "waiting" | "no-room" | "no-source";

export interface BackfillItem {
	readonly diskId: string;
	readonly accountId: string;
	readonly version: string;
	/** The version's allocated bytes on the host that committed it: about what a fetch from nothing moves. */
	readonly allocatedBytes: number;
	readonly committedAt: number;
	readonly state: BackfillState;
}

/** What one host of a synced pool should hold, and whether it takes part at all. */
export interface HostBackfill {
	readonly hostId: string;
	readonly poolId: string;
	/**
	 * Why it isn't backfilling now, where it isn't: `draining` (it is being emptied, or is moving pools), `away` (not
	 * connected), `no-sync` (it doesn't fetch from peers, or has no mesh address yet). Its items are still listed.
	 */
	readonly paused?: "draining" | "away" | "no-sync";
	readonly items: readonly BackfillItem[];
}

export interface BackfillInput {
	readonly now: number;
	/** The pools with sync on. */
	readonly syncing: ReadonlySet<string>;
	readonly hosts: readonly BackfillHost[];
	readonly disks: readonly StoredStickyDisk[];
	/** Each disk's head version, by disk ID (absent where it has none, or its record is gone). */
	readonly heads: ReadonlyMap<string, StoredStickyDiskVersion>;
	/** Each disk's holders, by disk ID, then version. */
	readonly holders: ReadonlyMap<string, ReadonlyMap<string, readonly StoredDiskHolder[]>>;
	/** Fetches of other kinds (template snapshots, saved snapshots) each host reports under way, by host ID. */
	readonly otherFetches?: ReadonlyMap<string, number>;
	/** Whether a host was told to fetch a version lately (`BACKFILL_RETRY_MS`), by `<host>/<version>`. */
	readonly askedLately?: (hostId: string, version: string) => boolean;
}

/** Whether a host is in a state to fetch from its peers at all, and why not. */
function pausedOf(host: BackfillHost): HostBackfill["paused"] {
	if (host.state === "draining") return "draining";
	if (host.state !== "online" || !host.connected) return "away";
	if (host.features !== undefined && !host.features.includes(DISK_SYNC_FEATURE)) return "no-sync";
	if (host.meshAddress === undefined) return "no-sync";
	return undefined;
}

/** Whether a host may serve its pool a version: online or draining (a draining host still serves), with a mesh address. */
function serves(host: BackfillHost | undefined, poolId: string): boolean {
	return (
		host !== undefined &&
		(host.state === "online" || host.state === "draining") &&
		host.connected &&
		host.poolId === poolId &&
		host.meshAddress !== undefined
	);
}

/** The disks a synced pool uses: live, of the pool, with a mapped head, started on within `STICKY_PREFETCH_MS`. */
export function usedDisks(input: BackfillInput, poolId: string): StoredStickyDisk[] {
	const since = input.now - STICKY_PREFETCH_MS;
	return input.disks.filter((disk) => {
		if (disk.deletedAt !== undefined || disk.poolId !== poolId || disk.head === undefined) return false;
		if (input.heads.get(disk.id)?.mapDigest === undefined) return false;
		return Object.values(disk.ranOn ?? {}).some((at) => at > since);
	});
}

/**
 * Each host of each synced pool, with every head it should hold and where it stands on each. Heads are listed newest
 * commit first, which is the order they're fetched in. A host gets `missing` items only up to `BACKFILL_HOST_FETCHES`
 * less the fetches it reports under way (of any kind); the rest are `waiting`. Revoked hosts and hosts of pools without
 * sync aren't listed.
 */
export function planStickyBackfill(input: BackfillInput): HostBackfill[] {
	const byId = new Map(input.hosts.map((host) => [host.id, host]));
	// What each host is fetching now, of any disk: counted against its share.
	const fetchingOn = new Map<string, number>(input.otherFetches ?? []);
	for (const versions of input.holders.values()) {
		for (const holders of versions.values()) {
			for (const holder of holders) {
				if (holder.state === "fetching") fetchingOn.set(holder.hostId, (fetchingOn.get(holder.hostId) ?? 0) + 1);
			}
		}
	}
	const used = new Map<string, StoredStickyDisk[]>();
	const plans: HostBackfill[] = [];
	for (const host of input.hosts) {
		const poolId = host.poolId;
		if (host.state === "revoked" || poolId === undefined || !input.syncing.has(poolId)) continue;
		let disks = used.get(poolId);
		if (disks === undefined) {
			disks = usedDisks(input, poolId).sort(
				(a, b) => (input.heads.get(b.id)?.createdAt ?? 0) - (input.heads.get(a.id)?.createdAt ?? 0),
			);
			used.set(poolId, disks);
		}
		const paused = pausedOf(host);
		let room = BACKFILL_HOST_FETCHES - (fetchingOn.get(host.id) ?? 0);
		// The disk it can still take: its free disk less what this pass gives it, and the headroom a fetch must leave.
		let free = host.freeDiskGb === undefined ? Number.POSITIVE_INFINITY : host.freeDiskGb * 1024 ** 3;
		const items: BackfillItem[] = [];
		for (const disk of disks) {
			// A host an account added may hold only that account's data.
			if (host.accountId !== undefined && host.accountId !== disk.accountId) continue;
			const head = input.heads.get(disk.id);
			if (head === undefined) continue;
			const holders = input.holders.get(disk.id)?.get(head.id) ?? [];
			const own = holders.find((holder) => holder.hostId === host.id && holder.state !== "deleting");
			const item = {
				diskId: disk.id,
				accountId: disk.accountId,
				version: head.id,
				allocatedBytes: head.allocatedBytes,
				committedAt: head.createdAt,
			};
			if (own !== undefined) {
				items.push({ ...item, state: own.state === "held" ? "held" : "fetching" });
				continue;
			}
			const source = holders.some(
				(holder) => holder.state === "held" && holder.hostId !== host.id && serves(byId.get(holder.hostId), poolId),
			);
			if (!source) {
				items.push({ ...item, state: "no-source" });
				continue;
			}
			if (free < head.allocatedBytes + BACKFILL_HEADROOM_BYTES) {
				items.push({ ...item, state: "no-room" });
				continue;
			}
			// One told lately counts as under way, so a pass between the telling and its report doesn't send more.
			if (input.askedLately?.(host.id, head.id) === true) {
				room -= 1;
				free -= head.allocatedBytes;
				items.push({ ...item, state: "missing" });
				continue;
			}
			if (paused !== undefined || room <= 0) {
				items.push({ ...item, state: paused === undefined ? "waiting" : "missing" });
				continue;
			}
			room -= 1;
			free -= head.allocatedBytes;
			items.push({ ...item, state: "missing" });
		}
		plans.push({ hostId: host.id, poolId, ...(paused === undefined ? {} : { paused }), items });
	}
	return plans;
}

/**
 * The fetches a plan says to send now: each `missing` item of a host that isn't paused, and that wasn't told it lately.
 * In the plan's order, newest commit first.
 */
export function backfillFetches(
	plans: readonly HostBackfill[],
	askedLately: (hostId: string, version: string) => boolean = () => false,
): { readonly hostId: string; readonly diskId: string; readonly version: string }[] {
	return plans.flatMap((plan) =>
		plan.paused !== undefined
			? []
			: plan.items
					.filter((item) => item.state === "missing" && !askedLately(plan.hostId, item.version))
					.map((item) => ({ hostId: plan.hostId, diskId: item.diskId, version: item.version })),
	);
}
