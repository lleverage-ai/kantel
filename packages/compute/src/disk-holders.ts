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
 *
 * The grant key is rotated by an operator (`rotate`), or replaced by the first gateway that can't open it (sealed with
 * a secrets key the deployment no longer has): a new key in one conditional write, the old one kept as retired for
 * `GRANT_KEY_OVERLAP_MS`, so grants signed with it just before stay good for their lifetime. Hosts are given every key
 * still accepted (`keys`). Nothing is cached across calls but the opened private key: every gateway reads the setting
 * for each grant and welcome, so a rotation on one is signed with on all from the next grant.
 */
import { KantelError } from "@kantel/contracts";
import {
	createGrantKey,
	DISK_KINDS,
	type DiskKind,
	GRANT_TTL_MS,
	type GrantKey,
	grantKeyFrom,
	grantKeyId,
} from "./grants.ts";
import { type Sealer, sealedAt } from "./secrets.ts";
import {
	type ComputeStore,
	diskHolderId,
	type StoredDiskHolder,
	type StoredHost,
	type StoredSetting,
} from "./store.ts";

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

/** A grant key a host accepts grants from: its ID and public key, and for one rotated out, until when. */
export interface GrantKeyView {
	readonly id: string;
	readonly publicKey: string;
	/** When a retired key stops being accepted, in milliseconds since the epoch; absent for the key that signs. */
	readonly until?: number;
}

/** The control plane's grant keys: the one it signs with, since when, and the retired ones still accepted. */
export interface GrantKeyring {
	readonly current: GrantKeyView;
	/** When the current key was made, by a first use or a rotation. */
	readonly since: number;
	readonly retired: readonly (GrantKeyView & { readonly until: number })[];
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
	/**
	 * The grant keys, made on first use (and a key that can't be opened replaced); undefined while there can be none
	 * (sticky disks off, no secrets key).
	 */
	keys(): Promise<GrantKeyring | undefined>;
	/**
	 * Rotates the grant key: a new one signs from now, and the one it replaces is accepted for `GRANT_KEY_OVERLAP_MS`
	 * more. `by` is who asked. `not_supported` while there can be none.
	 */
	rotate(by: string): Promise<GrantKeyring>;
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

/**
 * How long a retired grant key is still accepted after it is rotated out: a grant's lifetime, and a minute for a grant
 * a gateway signed with it as another rotated it, and for clocks that differ.
 */
export const GRANT_KEY_OVERLAP_MS = GRANT_TTL_MS + 60_000;

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
	/** The grant keys changed here (a rotation, or a key that couldn't be opened replaced): hosts are told them. */
	readonly keysChanged?: () => void;
}): DiskHolders {
	const { store, now, sealer } = options;

	/** The setting the private key was last opened from, and the key: opened again only when the setting changes. */
	let opened: { readonly kept: StoredSetting; readonly key: Promise<GrantKey> } | undefined;
	const sameKey = (a: StoredSetting, b: StoredSetting) =>
		a.value === b.value && a.sealed?.iv === b.sealed?.iv && a.sealed?.ct === b.sealed?.ct;
	function open(seal: Sealer, kept: StoredSetting): Promise<GrantKey> {
		if (opened !== undefined && sameKey(opened.kept, kept)) return opened.key;
		const key =
			kept.sealed === undefined
				? Promise.reject(new KantelError("unavailable", "The grant key isn't kept in a form this reads"))
				: seal.open(kept.sealed, GRANT_KEY_AAD).then((privateKey) => grantKeyFrom(kept.value, privateKey));
		opened = { kept, key };
		key.catch(() => {
			if (opened?.key === key) opened = undefined;
		});
		return key;
	}

	/**
	 * Writes a new grant key over the kept one when `replaces` approves the setting as it is then, the key it held
	 * retired (and retired keys past their time dropped), and answers the setting written; undefined when `replaces` no
	 * longer approves it.
	 */
	async function replace(
		seal: Sealer,
		by: string,
		replaces: (current: StoredSetting) => boolean,
	): Promise<{ readonly kept: StoredSetting; readonly key: GrantKey } | undefined> {
		const made = await createGrantKey();
		const sealed = await seal.seal(made.privateKey, GRANT_KEY_AAD);
		const at = now();
		const written = await store.settings.update(GRANT_KEY, (current) =>
			replaces(current)
				? {
						id: GRANT_KEY,
						value: made.key.publicKey,
						sealed,
						updatedAt: at,
						updatedBy: by,
						retired: [
							...(current.retired ?? []).filter((key) => key.until > at && key.publicKey !== current.value),
							{ publicKey: current.value, until: at + GRANT_KEY_OVERLAP_MS },
						],
					}
				: undefined,
		);
		if (written === undefined || written.value !== made.key.publicKey) return undefined;
		opened = { kept: written, key: Promise.resolve(made.key) };
		options.keysChanged?.();
		return { kept: written, key: made.key };
	}

	/**
	 * The grant key as kept now, and its private key opened: made and claimed when there is none (of two gateways making
	 * one, the first claim wins), and replaced when it can't be opened here, sealed with a secrets key the deployment no
	 * longer has (of two gateways replacing it, the first write wins and the other opens that).
	 */
	async function current(seal: Sealer): Promise<{ readonly kept: StoredSetting; readonly key: GrantKey }> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const kept = await store.settings.get(GRANT_KEY);
			if (kept === undefined) {
				const made = await createGrantKey();
				const record: StoredSetting = {
					id: GRANT_KEY,
					value: made.key.publicKey,
					sealed: await seal.seal(made.privateKey, GRANT_KEY_AAD),
					updatedAt: now(),
					updatedBy: "gateway",
				};
				if (await store.settings.insert(record)) {
					opened = { kept: record, key: Promise.resolve(made.key) };
					return { kept: record, key: made.key };
				}
				continue;
			}
			try {
				return { kept, key: await open(seal, kept) };
			} catch (error) {
				if (!(error instanceof KantelError && error.code === "unavailable")) throw error;
			}
			const replaced = await replace(seal, "gateway", (latest) => sameKey(latest, kept));
			if (replaced !== undefined) return replaced;
		}
		throw new KantelError("unavailable", "The grant key kept changing as it was read; try again");
	}

	/** The grant key as kept now; undefined while there can be none. */
	const grantKey = (): Promise<{ readonly kept: StoredSetting; readonly key: GrantKey }> | undefined =>
		!options.enabled || sealer === undefined ? undefined : current(sealer);

	/** The keyring a kept setting holds, at `at`: retired keys past their time left out. */
	async function keyringOf(kept: StoredSetting, key: GrantKey, at: number): Promise<GrantKeyring> {
		const retired: (GrantKeyView & { readonly until: number })[] = [];
		for (const old of kept.retired ?? []) {
			if (old.until <= at || old.publicKey === key.publicKey) continue;
			retired.push({ id: await grantKeyId(old.publicKey), publicKey: old.publicKey, until: old.until });
		}
		return { current: { id: key.id, publicKey: key.publicKey }, since: kept.updatedAt, retired };
	}

	const versionKey = (objectId: string, version: string) => `${objectId}/${version}`;

	return {
		async recordStickyHoldings(hostId, at, disks) {
			if (!options.enabled) return;
			// The newest report wins: one older than a report already taken, here or on another gateway, changes nothing.
			if (!(await store.diskHolderWrites.claim(hostId, at))) return;
			const reported = new Map<string, { readonly diskId: string; readonly version: string }>();
			for (const disk of disks) {
				for (const held of disk.versions) {
					reported.set(versionKey(disk.diskId, held.version), { diskId: disk.diskId, version: held.version });
				}
			}
			const current = (await store.diskHolders.list({ hostId })).filter((holder) => holder.kind === "sticky");
			const known = new Map(current.map((holder) => [versionKey(holder.objectId, holder.version), holder]));
			const hold: StoredDiskHolder[] = [];
			const release: StoredDiskHolder[] = [];
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
			// Let go: what it no longer reports, unless it is still fetching it, or its holder may be newer than the report.
			for (const holder of current) {
				if (reported.has(versionKey(holder.objectId, holder.version))) continue;
				if (holder.state === "fetching" || holder.since > at - options.reportGraceMs) continue;
				release.push(holder);
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
			if (request.kind !== "sticky") {
				throw new KantelError("not_supported", `Kantel keeps no copies of ${request.kind} objects yet`);
			}
			if (!options.enabled) throw new KantelError("not_supported", "Sticky disks are off here");
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
			const signing = (await grantKey())?.key;
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

		async keys() {
			const reading = grantKey();
			if (reading === undefined) return undefined;
			const { kept, key } = await reading;
			return keyringOf(kept, key, now());
		},

		async rotate(by) {
			if (!options.enabled) throw new KantelError("not_supported", "Sticky disks are off here");
			if (sealer === undefined) throw new KantelError("not_supported", GRANT_KEY_UNAVAILABLE);
			// Made first if there is none, so there is one to rotate; a rotation then always writes.
			await current(sealer);
			const rotated = await replace(sealer, by, () => true);
			if (rotated === undefined) throw new KantelError("unavailable", "The grant key couldn't be rotated; try again");
			return keyringOf(rotated.kept, rotated.key, now());
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
