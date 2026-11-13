/**
 * The disk store's catalogue of copies (docs/design/disk-store.md, 2c): which hosts hold which versions of each object
 * (`StoredDiskHolder`), and the answer to a host that wants a version (`disk.locate`): its block map's digest, the hosts
 * in its own pool that hold it, and a grant to fetch it from them, signed with the control plane's grant key.
 *
 * Holders are reconciled from each capacity report a host sends (`recordStickyHoldings`), so they are the copies hosts
 * say they have. Sticky disks are the only kind so far.
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

export interface DiskHolders {
	/**
	 * Reconciles `hostId`'s sticky disk holders with what it reported holding at `at`: a version it holds that the
	 * catalogue has becomes `held` there, and one it no longer reports is let go, unless it is being fetched or its holder
	 * is newer than the report could know (`reportGraceMs`). Nothing with sticky disks off.
	 */
	recordStickyHoldings(hostId: string, at: number, disks: StickyHoldingsReport): Promise<void>;
	/** A version just committed on `hostId`: the host it was made on holds it. */
	recordCommit(kind: DiskKind, objectId: string, version: string, hostId: string): Promise<void>;
	/** Answers `disk.locate` from `hostId`. */
	locate(hostId: string, request: DiskLocateRequest): Promise<DiskLocation>;
	/** The grant key's public key, for hosts' welcomes; undefined while there is none (sticky disks off, no secrets key). */
	publicKey(): Promise<string | undefined>;
	/** The holders of an object's versions, by version. */
	holdersOf(kind: DiskKind, objectId: string): Promise<Map<string, StoredDiskHolder[]>>;
	/** Forgets every holder of an object, or of one of its versions. */
	forget(kind: DiskKind, objectId: string, version?: string): Promise<void>;
	/**
	 * Forgets holders of sticky versions the catalogue no longer has (a forgotten version, a deleted disk's) and holders on
	 * revoked hosts, each older than `reportGraceMs` at `at`.
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
	/** Sticky disks are on. */
	readonly enabled: boolean;
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
		if (!options.enabled || sealer === undefined) return undefined;
		loading ??= loadGrantKey(sealer).catch((error: unknown) => {
			loading = undefined;
			throw error;
		});
		return loading;
	}

	const versionKey = (objectId: string, version: string) => `${objectId}/${version}`;

	return {
		async recordStickyHoldings(hostId, at, disks) {
			if (!options.enabled) return;
			const reported = new Map<string, { readonly diskId: string; readonly version: string }>();
			for (const disk of disks) {
				for (const held of disk.versions) {
					reported.set(versionKey(disk.diskId, held.version), { diskId: disk.diskId, version: held.version });
				}
			}
			const current = (await store.diskHolders.list({ hostId })).filter((holder) => holder.kind === "sticky");
			const known = new Map(current.map((holder) => [versionKey(holder.objectId, holder.version), holder]));
			for (const [key, { diskId, version }] of reported) {
				const holder = known.get(key);
				if (holder === undefined) {
					// Only a version the catalogue has: one it never recorded, or forgot, isn't a copy of anything.
					const recorded = await store.stickyDiskVersions.get(version);
					if (recorded === undefined || recorded.diskId !== diskId) continue;
					await store.diskHolders.insert({
						id: diskHolderId("sticky", diskId, version, hostId),
						kind: "sticky",
						objectId: diskId,
						version,
						hostId,
						state: "held",
						since: at,
					});
				} else if (holder.state === "fetching") {
					await store.diskHolders.update(holder.id, (latest) =>
						latest.state === "fetching" ? { ...latest, state: "held", since: at } : undefined,
					);
				}
			}
			// Let go: what it no longer reports, unless it is still fetching it, or its holder may be newer than the report.
			const settled = (holder: StoredDiskHolder) =>
				holder.state !== "fetching" && holder.since <= at - options.reportGraceMs;
			for (const holder of current) {
				if (reported.has(versionKey(holder.objectId, holder.version)) || !settled(holder)) continue;
				await store.diskHolders.deleteIf(holder.id, settled);
			}
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
			if (request.kind !== "sticky") {
				throw new KantelError("not_supported", `Kantel keeps no copies of ${request.kind} objects yet`);
			}
			if (!options.enabled) throw new KantelError("not_supported", "Sticky disks are off here");
			const signing = grantKey();
			if (signing === undefined) throw new KantelError("not_supported", GRANT_KEY_UNAVAILABLE);
			const missing = () => new KantelError("not_found", "No such version of that sticky disk");
			const version = await store.stickyDiskVersions.get(request.version);
			if (version === undefined || version.diskId !== request.objectId) throw missing();
			const disk = await store.stickyDisks.get(version.diskId);
			if (disk === undefined || disk.deletedAt !== undefined) throw missing();
			const hosts = new Map((await options.hosts()).map((host) => [host.id, host]));
			const asker = hosts.get(hostId);
			// A host an account added may have only that account's data; a shared host may have any account's.
			if (
				asker === undefined ||
				asker.state === "revoked" ||
				asker.poolId === undefined ||
				(asker.accountId !== undefined && asker.accountId !== version.accountId)
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
			const grant = await (await signing).sign({
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
			const holders = (await store.diskHolders.list({ kind: "sticky" })).filter(
				(holder) => holder.since <= at - options.reportGraceMs,
			);
			if (holders.length === 0) return;
			const revoked = new Set(
				(await options.hosts()).filter((host) => host.state === "revoked").map((host) => host.id),
			);
			const versions = new Set(
				(await store.stickyDiskVersions.list()).map((version) => versionKey(version.diskId, version.id)),
			);
			for (const holder of holders) {
				if (versions.has(versionKey(holder.objectId, holder.version)) && !revoked.has(holder.hostId)) continue;
				await store.diskHolders.delete(holder.id);
			}
		},
	};
}
