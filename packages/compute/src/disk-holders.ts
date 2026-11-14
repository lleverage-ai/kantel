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
 * The grant key is rotated by an operator (`rotate`) in one conditional write: the new key is published to hosts at
 * once and signs from `GRANT_KEY_PUBLISH_MS` on, so every host has it before a grant it signed reaches one, and the old
 * key is accepted for `GRANT_KEY_OVERLAP_MS` after that, so grants it signed stay good for their lifetime. A gateway
 * that can't open the key that signs (sealed with a secrets key the deployment no longer has) replaces it as it signs,
 * the new key signing at once, as nothing else can sign. Hosts are given every key they accept (`keys`). Nothing is
 * cached across calls but the opened private key: every gateway reads the setting for each grant and welcome, so all
 * sign with the same key. Only signing replaces a key that can't be opened, never a welcome.
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
import { type SealedValue, type Sealer, sealedAt } from "./secrets.ts";
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

/**
 * A grant key a host accepts grants from: its ID and public key; for one rotated out, until when; for one a rotation
 * published, from when it signs.
 */
export interface GrantKeyView {
	readonly id: string;
	readonly publicKey: string;
	/** When a retired key stops being accepted, in milliseconds since the epoch. */
	readonly until?: number;
	/** When a key a rotation published begins signing, in milliseconds since the epoch. */
	readonly from?: number;
}

/**
 * The control plane's grant keys: the one it signs with and since when, the one a rotation published that signs from
 * `from`, and the retired ones still accepted.
 */
export interface GrantKeyring {
	readonly current: GrantKeyView;
	/** When the current key began signing. */
	readonly since: number;
	readonly next?: GrantKeyView & { readonly from: number };
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
	 * The grant keys, made on first use; undefined while there can be none (sticky disks off, no secrets key). A key that
	 * can't be opened here is answered as it is, and replaced by the next grant signed.
	 */
	keys(): Promise<GrantKeyring | undefined>;
	/**
	 * Rotates the grant key: a new one is published to hosts now and signs from `GRANT_KEY_PUBLISH_MS` on, and the one it
	 * replaces is accepted for `GRANT_KEY_OVERLAP_MS` after that. `by` is who asked. `not_supported` while there can be
	 * none.
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

/**
 * How long after a rotation the new key begins signing: until then it is only published, so every connected host has it
 * (told at once, or on a heartbeat's check within a minute) before a grant it signed reaches one.
 */
export const GRANT_KEY_PUBLISH_MS = 3 * 60_000;

/**
 * How long a key must have been signing before a gateway that can't open it replaces it: one made by a gateway with
 * another secrets key only just now is left, so gateways whose secrets keys differ while one is changed don't replace
 * each other's keys on every grant.
 */
export const GRANT_KEY_REPLACE_AFTER_MS = 5 * 60_000;

/** The key that signs at a time, with its sealed private key and since when. */
interface Signing {
	readonly publicKey: string;
	readonly sealed?: SealedValue;
	readonly since: number;
}

/** The kept grant keys at `at`: the one that signs, the one published that doesn't yet, and the retired ones still accepted. */
function keyringAt(
	kept: StoredSetting,
	at: number,
): {
	readonly signing: Signing;
	readonly next?: { readonly publicKey: string; readonly from: number };
	readonly retired: readonly { readonly publicKey: string; readonly until: number }[];
} {
	const live = (kept.retired ?? []).filter((key) => key.until > at);
	const since = kept.since ?? kept.updatedAt;
	if (kept.next !== undefined && kept.next.from <= at) {
		const { publicKey, sealed, from } = kept.next;
		// The published key signs now; the one it replaced is retired from then.
		const retired = [...live, { publicKey: kept.value, until: from + GRANT_KEY_OVERLAP_MS }].filter(
			(key) => key.publicKey !== publicKey && key.until > at,
		);
		return { signing: { publicKey, sealed, since: from }, retired };
	}
	const signing = { publicKey: kept.value, ...(kept.sealed === undefined ? {} : { sealed: kept.sealed }), since };
	const retired = live.filter((key) => key.publicKey !== kept.value);
	return kept.next === undefined
		? { signing, retired }
		: { signing, next: { publicKey: kept.next.publicKey, from: kept.next.from }, retired };
}

/** The kept grant key as it is at `at`: a published key whose time has come signing, and retired keys past theirs gone. */
function settle(kept: StoredSetting, at: number): StoredSetting {
	const { signing, next, retired } = keyringAt(kept, at);
	return {
		id: kept.id,
		value: signing.publicKey,
		...(signing.sealed === undefined ? {} : { sealed: signing.sealed }),
		since: signing.since,
		...(next === undefined || kept.next === undefined ? {} : { next: kept.next }),
		retired,
		updatedAt: kept.updatedAt,
		updatedBy: kept.updatedBy,
	};
}

/**
 * A published key a write replaces, as retired: it may have begun signing on another gateway just before the write
 * landed, so it is accepted for a grant's lifetime after its time came.
 */
const publishedRetired = (settled: StoredSetting): { readonly publicKey: string; readonly until: number }[] =>
	settled.next === undefined
		? []
		: [{ publicKey: settled.next.publicKey, until: settled.next.from + GRANT_KEY_OVERLAP_MS }];

/** What a gateway that couldn't open the kept key saw of it, to replace it only if it is still that. */
const keyOf = (kept: StoredSetting) => JSON.stringify([kept.value, kept.sealed, kept.next]);

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

	/** The private key last opened, by its public key and sealed value: opened again only when they change. */
	let opened: { readonly publicKey: string; readonly ct: string; readonly key: Promise<GrantKey> } | undefined;
	function open(seal: Sealer, signing: Signing): Promise<GrantKey> {
		const { publicKey, sealed } = signing;
		if (opened !== undefined && opened.publicKey === publicKey && opened.ct === sealed?.ct) return opened.key;
		const key =
			sealed === undefined
				? Promise.reject(new KantelError("unavailable", "The grant key isn't kept in a form this reads"))
				: seal.open(sealed, GRANT_KEY_AAD).then((privateKey) => grantKeyFrom(publicKey, privateKey));
		opened = { publicKey, ct: sealed?.ct ?? "", key };
		key.catch(() => {
			if (opened?.key === key) opened = undefined;
		});
		return key;
	}

	/** A new key, its private key sealed. */
	async function made(seal: Sealer): Promise<{ readonly key: GrantKey; readonly sealed: SealedValue }> {
		const { key, privateKey } = await createGrantKey();
		return { key, sealed: await seal.seal(privateKey, GRANT_KEY_AAD) };
	}

	/**
	 * Writes `change` over the kept grant key, as it is then, in one conditional write (`update`), and tells hosts when it
	 * wrote: the setting written, or undefined when `change` wrote nothing.
	 */
	async function write(change: (current: StoredSetting) => StoredSetting | undefined) {
		const written = await store.settings.update(GRANT_KEY, change);
		if (written !== undefined) options.keysChanged?.();
		return written;
	}

	/**
	 * The grant key as kept now, made and claimed when there is none (of two gateways making one, the first claim wins),
	 * and the key that signs at `at` opened: replaced when it can't be opened here, sealed with a secrets key the
	 * deployment no longer has (of two gateways replacing it, the first write wins and the other opens that).
	 */
	async function signer(seal: Sealer): Promise<GrantKey> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const kept = await store.settings.get(GRANT_KEY);
			if (kept === undefined) {
				const { key, sealed } = await made(seal);
				const at = now();
				const record: StoredSetting = {
					id: GRANT_KEY,
					value: key.publicKey,
					sealed,
					since: at,
					updatedAt: at,
					updatedBy: "gateway",
				};
				if (await store.settings.insert(record)) {
					opened = { publicKey: key.publicKey, ct: sealed.ct, key: Promise.resolve(key) };
					return key;
				}
				continue;
			}
			const at = now();
			const signing = keyringAt(kept, at).signing;
			try {
				return await open(seal, signing);
			} catch (error) {
				if (!(error instanceof KantelError && error.code === "unavailable")) throw error;
				// One a gateway made only just now isn't replaced: gateways whose secrets keys differ (one being changed)
				// would replace each other's in turn. Those with the other key can't sign until they have this one.
				if (signing.since > at - GRANT_KEY_REPLACE_AFTER_MS) throw error;
			}
			const replacement = await made(seal);
			const written = await write((current) => {
				if (keyOf(current) !== keyOf(kept)) return undefined;
				const at = now();
				const settled = settle(current, at);
				// The key that signed until now, and one published that may begin signing before this write lands, are each
				// accepted for a grant's lifetime after they could last have signed.
				const lastSigned = Math.max(at, settled.next?.from ?? at);
				return {
					id: GRANT_KEY,
					value: replacement.key.publicKey,
					sealed: replacement.sealed,
					since: at,
					updatedAt: at,
					updatedBy: "gateway",
					retired: [
						...(settled.retired ?? []).filter((key) => key.publicKey !== settled.value),
						{ publicKey: settled.value, until: lastSigned + GRANT_KEY_OVERLAP_MS },
						...publishedRetired(settled),
					],
				};
			});
			if (written?.value === replacement.key.publicKey) {
				opened = { publicKey: written.value, ct: replacement.sealed.ct, key: Promise.resolve(replacement.key) };
				return replacement.key;
			}
		}
		throw new KantelError("unavailable", "The grant key kept changing as it was read; try again");
	}

	/** The grant keys as kept now, made when there are none; public keys only, so nothing is opened. */
	async function kept(seal: Sealer): Promise<StoredSetting> {
		const found = await store.settings.get(GRANT_KEY);
		if (found !== undefined) return found;
		await signer(seal);
		const made = await store.settings.get(GRANT_KEY);
		if (made === undefined) throw new KantelError("unavailable", "The grant key couldn't be read; try again");
		return made;
	}

	/** The keyring a kept setting holds at `at`, as hosts and the API are given it. */
	async function viewOf(record: StoredSetting, at: number): Promise<GrantKeyring> {
		const { signing, next, retired } = keyringAt(record, at);
		return {
			// While a key is published, the one that signs is accepted until a grant's lifetime after it stops, so a host
			// told of the rotation stops accepting it then even if it hears nothing more.
			current: {
				id: await grantKeyId(signing.publicKey),
				publicKey: signing.publicKey,
				...(next === undefined ? {} : { until: next.from + GRANT_KEY_OVERLAP_MS }),
			},
			since: signing.since,
			...(next === undefined
				? {}
				: { next: { id: await grantKeyId(next.publicKey), publicKey: next.publicKey, from: next.from } }),
			retired: await Promise.all(
				retired.map(async (key) => ({
					id: await grantKeyId(key.publicKey),
					publicKey: key.publicKey,
					until: key.until,
				})),
			),
		};
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
			const signing = await signer(sealer);
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
			if (!options.enabled || sealer === undefined) return undefined;
			// Public keys only, so nothing is opened: a key that can't be opened here is replaced when a grant is signed, not
			// on a welcome, so gateways whose secrets keys differ don't replace it for each other's welcomes.
			return viewOf(await kept(sealer), now());
		},

		async rotate(by) {
			if (!options.enabled) throw new KantelError("not_supported", "Sticky disks are off here");
			if (sealer === undefined) throw new KantelError("not_supported", GRANT_KEY_UNAVAILABLE);
			// Made first if there is none, so there is one to rotate; a rotation then always writes.
			await kept(sealer);
			const next = await made(sealer);
			// The new key is published now and signs once hosts have had time to be told it. One published and not yet
			// signing is replaced, but still accepted as retired: it may begin signing on another gateway before this lands.
			const written = await write((current) => {
				const at = now();
				const settled = settle(current, at);
				return {
					...settled,
					next: { publicKey: next.key.publicKey, sealed: next.sealed, from: at + GRANT_KEY_PUBLISH_MS },
					retired: [...(settled.retired ?? []), ...publishedRetired(settled)],
					updatedAt: at,
					updatedBy: by,
				};
			});
			if (written === undefined) throw new KantelError("unavailable", "The grant key couldn't be rotated; try again");
			return viewOf(written, now());
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
