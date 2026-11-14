/**
 * The disk store's catalogue of copies (docs/design/disk-store.md, 2c): which hosts hold which versions of each object
 * (`StoredDiskHolder`), and the answer to a host that wants a version (`disk.locate`): its block map's digest, the hosts
 * in its own pool that hold it, and a grant to fetch it from them, signed with the control plane's grant key.
 *
 * Holders are reconciled from each capacity report a host sends (`recordHoldings`), so they are the copies hosts say
 * they have. Two kinds so far:
 *
 * - `sticky`: a sticky disk's versions, each in the catalogue (`StoredStickyDiskVersion`) with its map digest; a host
 *   holds only versions the catalogue has, of an account whose data it may have.
 * - `rootfs`: a template's root filesystem (`images/templates/<key>.ext4` on a host), its ID the key and its one version
 *   `1`. No record of its own: each holder carries the map digest its host reported, as two hosts that each built one
 *   before they synced may hold different bytes under one key, and the pool its host made it in: the host's pool when
 *   it first reported it, unless the host has moved since it made it (`StoredHost.poolSince`), when it is offered nowhere.
 *   `disk.locate` answers the digest most of the asker's pool's holders of its architecture have, and only those
 *   holders.
 *
 * The grant key is one Ed25519 key per control plane, made by the first gateway that needs it and kept sealed with the
 * deployment's secrets key (`StoredSetting` `grantKey`), so every gateway over one database signs with it. Without a
 * secrets key over a persistent store, nothing can be sealed, so there is no grant key: hosts' welcomes carry none and
 * `disk.locate` is refused, as protected values are.
 */
import { KantelError } from "@kantel/contracts";
import { createGrantKey, DISK_KINDS, type DiskKind, GRANT_TTL_MS, type GrantKey, grantKeyFrom } from "./grants.ts";
import { type Sealer, sealedAt } from "./secrets.ts";
import { type ComputeStore, diskHolderId, type StoredDiskHolder, type StoredHost } from "./store.ts";

/** A host's request for a version of an object (`disk.locate`). */
export interface DiskLocateRequest {
	readonly kind: string;
	readonly objectId: string;
	readonly version: string;
}

/** The answer to `disk.locate`. */
export interface DiskLocation {
	/** The version's block map digest, once the catalogue has it. */
	readonly mapDigest?: string;
	/** The online hosts in the asker's pool that hold it, with their mesh addresses; none, possibly. */
	readonly holders: readonly { readonly hostId: string; readonly address: string }[];
	/** A signed grant (`grants.ts`) to fetch it from `holders`; absent when there are none. */
	readonly grant?: string;
}

/** A host's report of the sticky disk versions it holds (`HostCapacity.stickyDisks`). */
export type StickyHoldingsReport = readonly {
	readonly diskId: string;
	readonly versions: readonly { readonly version: string }[];
}[];

/**
 * A host's report of the objects of one kind it holds (`HostCapacity.holdings`), each version with its map digest and
 * when the host made it (fetched or built), by its clock.
 */
export type ObjectHoldingsReport = readonly {
	readonly objectId: string;
	readonly versions: readonly { readonly version: string; readonly mapDigest: string; readonly madeAt?: number }[];
}[];

/** What one capacity report says a host holds: each absent says nothing of its kind, so nothing of it is forgotten. */
export interface HoldingsReport {
	readonly stickyDisks?: StickyHoldingsReport;
	readonly objects?: { readonly rootfs?: ObjectHoldingsReport };
}

/** The one version of a template's root filesystem. */
export const ROOTFS_VERSION = "1";

/** A root filesystem's key: 64 hex digits, as a host names `images/templates/<key>.ext4`. */
const ROOTFS_KEY = /^[0-9a-f]{64}$/;

/** A map digest: `sha256:` and 64 hex digits. */
const MAP_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface DiskHolders {
	/**
	 * Reconciles `hostId`'s holders with what it reported holding at `at`, kind by kind, for each kind the report speaks
	 * of: a version it holds becomes `held` there (a sticky disk's only when the catalogue has it; a root filesystem's
	 * with the map digest reported, replacing one with another), and one it no longer reports is let go, unless it is
	 * being fetched or its holder is newer than the report could know (`reportGraceMs`). Nothing of sticky disks with them
	 * off, nor of root filesystems with templates off.
	 */
	recordHoldings(hostId: string, at: number, report: HoldingsReport): Promise<void>;
	/** A version just committed on `hostId`: the host it was made on holds it. */
	recordCommit(kind: DiskKind, objectId: string, version: string, hostId: string): Promise<void>;
	/** Answers `disk.locate` from `hostId`. */
	locate(hostId: string, request: DiskLocateRequest): Promise<DiskLocation>;
	/**
	 * The grant key's public key, for hosts' welcomes; undefined while there is none (sticky disks and templates off, no
	 * secrets key).
	 */
	publicKey(): Promise<string | undefined>;
	/** The holders of an object's versions, by version. */
	holdersOf(kind: DiskKind, objectId: string): Promise<Map<string, StoredDiskHolder[]>>;
	/** Forgets every holder of an object, or of one of its versions. */
	forget(kind: DiskKind, objectId: string, version?: string): Promise<void>;
	/**
	 * Forgets holders of sticky versions the catalogue no longer has (a forgotten version, a deleted disk's) and holders,
	 * of any kind, on revoked hosts, each older than `reportGraceMs` at `at`.
	 */
	sweep(at: number): Promise<void>;
}

/** The setting the grant key is kept in, and where its private key is sealed. */
const GRANT_KEY = "grantKey";
const GRANT_KEY_AAD = sealedAt("settings", GRANT_KEY, "privateKey");

/** What `disk.locate` is told while there is no grant key. */
export const GRANT_KEY_UNAVAILABLE =
	"Kantel can't sign fetch grants here: the deployment has no secrets key (KANTEL_SECRETS_KEY) to keep its grant key";

export function createDiskHolders(options: {
	readonly store: ComputeStore;
	readonly now: () => number;
	/** Sticky disks are on: their versions are synced. */
	readonly stickyDisks: boolean;
	/** Templates are on: their root filesystems are synced. */
	readonly templates: boolean;
	/** Seals the grant key; absent when nothing can be sealed (a persistent store without a secrets key). */
	readonly sealer: Sealer | undefined;
	/** Every host the compute plane knows, revoked ones too, with its state and pool. */
	readonly hosts: () => Promise<readonly StoredHost[]>;
	/** A host's mesh address, when it has one. */
	readonly meshAddress: (hostId: string) => string | undefined;
	/** How long before a report a holder must have been recorded for the report to say the host doesn't hold it. */
	readonly reportGraceMs: number;
}): DiskHolders {
	const { store, now, sealer } = options;

	let loading: Promise<GrantKey> | undefined;
	/** The grant key: read from its setting, else made and claimed; of two gateways making one, the first claim wins. */
	async function loadGrantKey(seal: Sealer): Promise<GrantKey> {
		let kept = await store.settings.get(GRANT_KEY);
		if (kept === undefined) {
			const made = await createGrantKey();
			const sealed = await seal.seal(made.privateKey, GRANT_KEY_AAD);
			const at = now();
			if (
				await store.settings.insert({
					id: GRANT_KEY,
					value: made.key.publicKey,
					sealed,
					updatedAt: at,
					updatedBy: "gateway",
				})
			) {
				return made.key;
			}
			kept = await store.settings.get(GRANT_KEY);
		}
		if (kept?.sealed === undefined)
			throw new KantelError("unavailable", "The grant key isn't kept in a form this reads");
		return grantKeyFrom(kept.value, await seal.open(kept.sealed, GRANT_KEY_AAD));
	}
	/** The grant key, read once per process (again after a failure); undefined while there can be none. */
	function grantKey(): Promise<GrantKey> | undefined {
		if ((!options.stickyDisks && !options.templates) || sealer === undefined) return undefined;
		loading ??= loadGrantKey(sealer).catch((error: unknown) => {
			loading = undefined;
			throw error;
		});
		return loading;
	}

	const versionKey = (objectId: string, version: string) => `${objectId}/${version}`;

	/**
	 * `disk.locate` for a template's root filesystem: the holders in the asker's pool (which made or fetched their copy
	 * there) of its architecture that hold the map digest most of them hold (of two as many, the one held longest), and
	 * that digest, with a grant naming the pool's owner. None, and no digest, when no other such host holds it.
	 */
	async function locateRootfs(hostId: string, request: DiskLocateRequest): Promise<DiskLocation> {
		if (!options.templates) throw new KantelError("not_supported", "Templates are off here");
		if (sealer === undefined) throw new KantelError("not_supported", GRANT_KEY_UNAVAILABLE);
		if (!ROOTFS_KEY.test(request.objectId) || request.version !== ROOTFS_VERSION) {
			throw new KantelError("not_found", "No such template root filesystem");
		}
		const hosts = new Map((await options.hosts()).map((host) => [host.id, host]));
		const asker = hosts.get(hostId);
		if (asker === undefined || asker.state === "revoked" || asker.poolId === undefined) {
			throw new KantelError("not_found", "No such template root filesystem");
		}
		const byDigest = new Map<string, { hostId: string; address: string; since: number }[]>();
		for (const holder of await store.diskHolders.list({ objectId: request.objectId })) {
			if (holder.kind !== "rootfs" || holder.version !== ROOTFS_VERSION || holder.state !== "held") continue;
			if (holder.hostId === hostId || holder.mapDigest === undefined) continue;
			const host = hosts.get(holder.hostId);
			// Online (a draining host still serves), and in the asker's pool, where it made or fetched the copy: pools never
			// share data.
			if (host === undefined || (host.state !== "online" && host.state !== "draining")) continue;
			if (host.poolId !== asker.poolId || holder.poolId !== asker.poolId) continue;
			// Of the asker's architecture: a base's digest, or an image reference, names one image for each.
			if (host.arch !== asker.arch) continue;
			const address = options.meshAddress(host.id);
			if (address === undefined) continue;
			byDigest.set(holder.mapDigest, [
				...(byDigest.get(holder.mapDigest) ?? []),
				{ hostId: host.id, address, since: holder.since },
			]);
		}
		let best: { mapDigest: string; holders: { hostId: string; address: string; since: number }[] } | undefined;
		const oldest = (list: readonly { readonly since: number }[]) => Math.min(...list.map((each) => each.since));
		for (const [mapDigest, holders] of byDigest) {
			if (
				best === undefined ||
				holders.length > best.holders.length ||
				(holders.length === best.holders.length && oldest(holders) < oldest(best.holders))
			) {
				best = { mapDigest, holders };
			}
		}
		if (best === undefined) return { holders: [] };
		const signing = await grantKey();
		if (signing === undefined) throw new KantelError("not_supported", GRANT_KEY_UNAVAILABLE);
		const pool = await store.pools.get(asker.poolId);
		const holders = best.holders.map(({ hostId, address }) => ({ hostId, address }));
		const grant = await signing.sign({
			kind: "rootfs",
			objectId: request.objectId,
			version: ROOTFS_VERSION,
			accountId: asker.accountId ?? pool?.owner ?? "",
			from: holders.map((holder) => holder.hostId),
			to: hostId,
			exp: now() + GRANT_TTL_MS,
		});
		return { mapDigest: best.mapDigest, holders, grant };
	}

	return {
		async recordHoldings(hostId, at, report) {
			const sticky = options.stickyDisks ? report.stickyDisks : undefined;
			const rootfs = options.templates ? report.objects?.rootfs : undefined;
			if (sticky === undefined && rootfs === undefined) return;
			// The newest report wins: one older than a report already taken, here or on another gateway, changes nothing.
			if (!(await store.diskHolderWrites.claim(hostId, at))) return;
			const current = await store.diskHolders.list({ hostId });
			const hold: StoredDiskHolder[] = [];
			const release: StoredDiskHolder[] = [];
			// Let go: what it no longer reports, unless it is still fetching it, or its holder may be newer than the report.
			const letGo = (holders: readonly StoredDiskHolder[], reported: ReadonlySet<string>) => {
				for (const holder of holders) {
					if (reported.has(versionKey(holder.objectId, holder.version))) continue;
					if (holder.state === "fetching" || holder.since > at - options.reportGraceMs) continue;
					release.push(holder);
				}
			};
			if (sticky !== undefined) {
				const reported = new Map<string, { readonly diskId: string; readonly version: string }>();
				for (const disk of sticky) {
					for (const held of disk.versions) {
						reported.set(versionKey(disk.diskId, held.version), { diskId: disk.diskId, version: held.version });
					}
				}
				const mine = current.filter((holder) => holder.kind === "sticky");
				const known = new Map(mine.map((holder) => [versionKey(holder.objectId, holder.version), holder]));
				// Whether the host may hold an account's data: a shared host any account's, an account's own host only its own.
				let reporter: Promise<StoredHost | undefined> | undefined;
				const mayHold = async (accountId: string) => {
					reporter ??= options.hosts().then((hosts) => hosts.find((host) => host.id === hostId));
					const host = await reporter;
					return (
						host !== undefined &&
						host.state !== "revoked" &&
						(host.accountId === undefined || host.accountId === accountId)
					);
				};
				for (const [key, { diskId, version }] of reported) {
					const holder = known.get(key);
					if (holder !== undefined && holder.state !== "fetching") continue;
					// Only a version the catalogue has (one it never recorded, or forgot, isn't a copy of anything), of an
					// account whose data the host may have.
					const recorded = await store.stickyDiskVersions.get(version);
					if (recorded === undefined || recorded.diskId !== diskId || !(await mayHold(recorded.accountId))) continue;
					if (holder !== undefined) release.push(holder);
					hold.push({
						id: diskHolderId("sticky", diskId, version, hostId),
						kind: "sticky",
						objectId: diskId,
						version,
						hostId,
						state: "held",
						since: at,
					});
				}
				letGo(mine, new Set(reported.keys()));
			}
			if (rootfs !== undefined) {
				// Only what is shaped as a root filesystem: its key, its one version and a map digest. It is no account's
				// record, so a host can't claim another pool's: holders are offered only to their own pool's hosts.
				const reported = new Map<
					string,
					{ readonly objectId: string; readonly mapDigest: string; readonly madeAt?: number }
				>();
				for (const object of rootfs) {
					if (!ROOTFS_KEY.test(object.objectId)) continue;
					for (const held of object.versions) {
						if (held.version !== ROOTFS_VERSION || !MAP_DIGEST.test(held.mapDigest)) continue;
						reported.set(versionKey(object.objectId, held.version), {
							objectId: object.objectId,
							mapDigest: held.mapDigest,
							...(held.madeAt === undefined ? {} : { madeAt: held.madeAt }),
						});
					}
				}
				const mine = current.filter((holder) => holder.kind === "rootfs");
				const known = new Map(mine.map((holder) => [versionKey(holder.objectId, holder.version), holder]));
				const reporter = (await options.hosts()).find((host) => host.id === hostId);
				const poolId = reporter?.state === "revoked" ? undefined : reporter?.poolId;
				const poolSince = reporter?.poolSince;
				for (const [key, { objectId, mapDigest, madeAt }] of reported) {
					const holder = known.get(key);
					// Kept as it is, its pool too: a copy made in one pool stays that pool's after its host moves.
					if (holder !== undefined && holder.state === "held" && holder.mapDigest === mapDigest) continue;
					// A new copy (or the file made again) is the pool's its host is in now, if it was made there: one made
					// before the host moved (reported only now, its map made late) is its old pool's, and offered nowhere.
					// None, while the host is in no pool.
					if (poolId === undefined) continue;
					if (poolSince !== undefined && (madeAt === undefined || madeAt <= poolSince)) continue;
					if (holder !== undefined) release.push(holder);
					hold.push({
						id: diskHolderId("rootfs", objectId, ROOTFS_VERSION, hostId),
						kind: "rootfs",
						objectId,
						version: ROOTFS_VERSION,
						hostId,
						state: "held",
						since: at,
						mapDigest,
						poolId,
					});
				}
				letGo(mine, new Set(reported.keys()));
			}
			if (hold.length > 0 || release.length > 0) await store.diskHolderWrites.reconcile(hostId, at, { hold, release });
		},
		async recordCommit(kind, objectId, version, hostId) {
			const holder: StoredDiskHolder = {
				id: diskHolderId(kind, objectId, version, hostId),
				kind,
				objectId,
				version,
				hostId,
				state: "held",
				since: now(),
			};
			await store.diskHolders.put(holder);
		},

		async locate(hostId, request) {
			if (!(DISK_KINDS as readonly string[]).includes(request.kind)) {
				throw new KantelError("invalid", `There is no kind of disk ${JSON.stringify(request.kind)}`);
			}
			if (request.kind === "rootfs") return locateRootfs(hostId, request);
			if (request.kind !== "sticky") {
				throw new KantelError("not_supported", `Kantel keeps no copies of ${request.kind} objects yet`);
			}
			if (!options.stickyDisks) throw new KantelError("not_supported", "Sticky disks are off here");
			if (sealer === undefined) throw new KantelError("not_supported", GRANT_KEY_UNAVAILABLE);
			const missing = () => new KantelError("not_found", "No such version of that sticky disk");
			const version = await store.stickyDiskVersions.get(request.version);
			if (version === undefined || version.diskId !== request.objectId) throw missing();
			const disk = await store.stickyDisks.get(version.diskId);
			if (disk === undefined || disk.deletedAt !== undefined) throw missing();
			const hosts = new Map((await options.hosts()).map((host) => [host.id, host]));
			const asker = hosts.get(hostId);
			// A host an account added may have only that account's data; a shared host may have any account's. A disk with a
			// pool is only its pool's hosts'.
			if (
				asker === undefined ||
				asker.state === "revoked" ||
				asker.poolId === undefined ||
				(asker.accountId !== undefined && asker.accountId !== version.accountId) ||
				(disk.poolId !== undefined && disk.poolId !== asker.poolId)
			) {
				throw missing();
			}
			const holders: { hostId: string; address: string }[] = [];
			for (const holder of await store.diskHolders.list({ objectId: version.diskId })) {
				if (holder.kind !== "sticky" || holder.version !== version.id || holder.state !== "held") continue;
				if (holder.hostId === hostId) continue;
				const host = hosts.get(holder.hostId);
				// Online (a draining host still serves), and in the asker's pool: pools never share data.
				if (host === undefined || (host.state !== "online" && host.state !== "draining")) continue;
				if (host.poolId !== asker.poolId) continue;
				const address = options.meshAddress(host.id);
				if (address === undefined) continue;
				holders.push({ hostId: host.id, address });
			}
			const mapDigest = version.mapDigest === undefined ? {} : { mapDigest: version.mapDigest };
			if (holders.length === 0) return { ...mapDigest, holders };
			const signing = await grantKey();
			if (signing === undefined) throw new KantelError("not_supported", GRANT_KEY_UNAVAILABLE);
			const grant = await signing.sign({
				kind: "sticky",
				objectId: version.diskId,
				version: version.id,
				accountId: version.accountId,
				from: holders.map((holder) => holder.hostId),
				to: hostId,
				exp: now() + GRANT_TTL_MS,
			});
			return { ...mapDigest, holders, grant };
		},

		async publicKey() {
			const signing = grantKey();
			return signing === undefined ? undefined : (await signing).publicKey;
		},

		async holdersOf(kind, objectId) {
			const byVersion = new Map<string, StoredDiskHolder[]>();
			for (const holder of await store.diskHolders.list({ objectId })) {
				if (holder.kind !== kind) continue;
				byVersion.set(holder.version, [...(byVersion.get(holder.version) ?? []), holder]);
			}
			return byVersion;
		},

		async forget(kind, objectId, version) {
			for (const holder of await store.diskHolders.list({ objectId })) {
				if (holder.kind !== kind || (version !== undefined && holder.version !== version)) continue;
				await store.diskHolders.delete(holder.id);
			}
		},

		async sweep(at) {
			const holders = (await store.diskHolders.list()).filter((holder) => holder.since <= at - options.reportGraceMs);
			if (holders.length === 0) return;
			const revoked = new Set(
				(await options.hosts()).filter((host) => host.state === "revoked").map((host) => host.id),
			);
			const versions = holders.some((holder) => holder.kind === "sticky")
				? new Set((await store.stickyDiskVersions.list()).map((version) => versionKey(version.diskId, version.id)))
				: new Set<string>();
			for (const holder of holders) {
				// A sticky holder's version must still be in the catalogue; other kinds have no record of their own.
				const recorded = holder.kind !== "sticky" || versions.has(versionKey(holder.objectId, holder.version));
				if (recorded && !revoked.has(holder.hostId)) continue;
				await store.diskHolders.delete(holder.id);
			}
		},
	};
}
