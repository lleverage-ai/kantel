/**
 * The compute plane's records behind one interface, `ComputeStore`: a collection per kind, each found by ID or by equal
 * fields. `createMemoryStore` keeps them in memory, for tests and local runs; `createSqlComputeStore` (`./sql`,
 * `sql-store.ts`) keeps them in SQL, so a gateway keeps them across restarts and its replicas share them, and the
 * service doesn't change. Records are copied in and out, so a caller changes one only by putting it back.
 *
 * No secret is kept in the clear except a webhook's signing secret, which signing needs, and an approved device
 * sign-in's key secret until the device collects it (at most 15 minutes): API keys, invite codes, device codes and
 * host join tokens are kept as the SHA-256 hex of the secret, and header values (the proxy's upstream, the telemetry
 * endpoint's) are kept but never answered. An environment's protected variable values and secret files are kept sealed
 * (AES-256-GCM, `secrets.ts`), and opened only to send them to a sandbox's host.
 */
import type { computeSchema } from "@kantel/api";
import { KantelError } from "@kantel/contracts";
import type { SandboxTemplateBoot } from "./backend.ts";
import type { StoredE2EEntry } from "./e2e.ts";
import type { SealedValue } from "./secrets.ts";

/** One kind of record. */
export interface Collection<T extends { readonly id: string }> {
	get(id: string): Promise<T | undefined>;
	/** Inserts or replaces the record with its ID. */
	put(record: T): Promise<void>;
	/**
	 * Inserts the record only when none has its ID, and answers whether it did. Of several writers inserting one ID at
	 * once, on any gateway, exactly one wins: a claim, such as an idempotency key's.
	 */
	insert(record: T): Promise<boolean>;
	/**
	 * Changes the record as it is now, with nothing else written between the read and the write (the SQL store writes
	 * only over the version it read, and reads again when another writer got there first), and answers what was written.
	 * `change` answers `undefined` to write nothing; a missing record is never written. `change` may run more than once.
	 *
	 * `expected` is the record as the caller last wrote or read it, when it has it: a store may try `change` on it first
	 * and write only if the record is still exactly that (the SQL store compares the stored JSON), which saves the read.
	 * When the record is no longer `expected`, or `change` answers `undefined` for it, the store reads it as usual, so
	 * the answer is the same as without it.
	 */
	update(id: string, change: (current: T) => T | undefined, expected?: T): Promise<T | undefined>;
	/** Whether there was one to delete. */
	delete(id: string): Promise<boolean>;
	/**
	 * Deletes the record only when `should` approves it as it is now, with nothing written between the read and the
	 * delete (the SQL store deletes only the version it read, and reads again when another writer got there first), and
	 * answers whether it did. `should` may run more than once.
	 */
	deleteIf(id: string, should: (current: T) => boolean): Promise<boolean>;
	/** The records whose fields equal each defined field of `where`, oldest first. */
	list(where?: Partial<T>): Promise<T[]>;
}

export interface StoredUser {
	readonly id: string;
	readonly email?: string;
	readonly name: string;
	readonly superAdmin: boolean;
	readonly personalAccountId: string;
	readonly createdAt: number;
}

export interface StoredAccount {
	readonly id: string;
	readonly kind: computeSchema.AccountKind;
	readonly name: string;
	readonly defaultVisibility: computeSchema.SandboxVisibility;
	readonly createdAt: number;
	/**
	 * When its person's account deletion closed it (`deleteCaller`), for good: from then on nothing new is stored in it,
	 * and the deletion, made again if it fails, clears it and removes it.
	 */
	readonly closedAt?: number;
}

/** A person's role in an account; its ID is `<accountId>:<userId>`. */
export interface StoredMember {
	readonly id: string;
	readonly accountId: string;
	readonly userId: string;
	readonly role: computeSchema.MemberRole;
	readonly joinedAt: number;
}

export interface StoredInvite {
	readonly id: string;
	readonly accountId: string;
	readonly role: computeSchema.MemberRole;
	readonly email?: string;
	/** The SHA-256 hex of the join code. */
	readonly codeHash: string;
	readonly expiresAt: number;
	readonly createdAt: number;
	readonly usedAt?: number;
	readonly usedBy?: string;
	readonly revokedAt?: number;
}

/** A period a sandbox ran: from a start or resume to a stop, pause, error or delete. */
export interface RunPeriod {
	readonly from: number;
	readonly to?: number;
}

/** A CPU and memory reading of a running sandbox. */
export interface StoredSample {
	readonly at: number;
	readonly cpu: number;
	readonly memoryMb: number;
	/**
	 * A 5-minute mean's (what hosts' ticks are kept as, `at` its start): how many readings it is the mean of. Absent on a
	 * single reading, as samples were kept before hosts sent ticks.
	 */
	readonly readings?: number;
	/**
	 * A mean of 5-minute means folded together once they are a day old (`keptSamples`): the time from `at` it covers,
	 * up to an hour. Absent on a 5-minute mean (it covers `ROLLUP_MS`) and a single reading.
	 */
	readonly spanMs?: number;
	/** The sandbox's own disk in use, in MiB, from a host that sends it; absent from one that doesn't. */
	readonly diskMb?: number;
	/** IO pressure, 0 to 1, from a guest with the figures. */
	readonly io?: number;
	/**
	 * Of `readings`, how many had a disk figure and how many IO pressure, where not all of them did (a guest that
	 * didn't answer in time, one restored from an older snapshot): `diskMb` and `io` are the means of those alone.
	 */
	readonly diskReadings?: number;
	readonly ioReadings?: number;
}

/** A sandbox: its wire shape (but its cost and usage, worked out when answered) and what the service keeps besides. */
export type StoredSandbox = Omit<computeSchema.Sandbox, "cost" | "usage" | "grants" | "base"> & {
	/** The person it belongs to: its maker, or the person whose key made it. */
	readonly ownerUserId: string;
	/** What every command sees: its environment's plain variables and placeholders, then the create's own. */
	readonly env: { readonly [name: string]: string };
	/**
	 * Moves on (`Math.max(now, previous + 1)`) with every change to what its egress is made of (its grants, its
	 * environment's, the account's proxy settings) while it runs or starts, and rides each egress sent for it, so its
	 * host ignores one read before a later change. Absent: none sent yet.
	 */
	readonly egressRevision?: number;
	/**
	 * The latest `egressRevision` its backend has taken (at its boot, or acknowledging an update). Behind
	 * `egressRevision`, an update didn't get through (its host away, say), and the sweep sends the egress as it is now.
	 */
	readonly egressApplied?: number;
	/**
	 * When its host put it on `base` (`Placement.baseAt`, the host's clock; 0 or absent: not said). A host's later report
	 * of its base replaces `base` only when it says a later time (`ComputeService.recordBases`).
	 */
	readonly baseAt?: number;
	/**
	 * When its host set the `mounts` statuses it has (`Placement.mountsAt`, the host's clock, later with each change; absent:
	 * not said, or set by this plane, as a boot's `pending`). A host's report of them that says an earlier time is older
	 * than what is here, and doesn't replace it (`reportMountStatuses`, `mountsAfter`).
	 */
	readonly mountsAt?: number;
	/**
	 * Moves on by one with every change of its state (`withState`), so a lifecycle step that read it earlier can claim
	 * the next only while nothing else has moved it since, even if it is back in the state it read (a restart in
	 * between). Absent: 0, a record from before it was kept.
	 */
	readonly lifecycle?: number;
	/**
	 * Hosts revoked while its boot was under way there, as far as its placement said (`strandOn`): its boot's move from
	 * `starting` is `error` when the host it ended up on is one of them (`boot`), since only the boot knows for certain
	 * where its attempt went. Cleared by every change of its state.
	 */
	readonly strandedOn?: readonly string[];
	/**
	 * Why it is due to stop at `stopsAt`, when that isn't its auto-stop: its host can't enforce its egress as stored. The
	 * sweep stops it with this reason, as many times as it takes.
	 */
	readonly stopFor?: string;
	/**
	 * When a gateway took on its `stopFor` stop (moved it to `stopping`). One still `stopping` `STOP_LEASE_MS` on (its
	 * gateway gone before the stop was carried out) is handed back, running and due, for a sweep to stop.
	 */
	readonly stopClaimedAt?: number;
	/** Its own egress grants. Absent on a sandbox made before there were any: none. */
	readonly grants?: readonly computeSchema.EgressGrant[];
	/**
	 * Each protected variable's placeholder in this sandbox, `kph_…`, by name: minted at create (fresh for a fork) and
	 * never changed. Not a secret: the sandbox sees it. Absent: none.
	 */
	readonly placeholders?: { readonly [name: string]: string };
	readonly hostLabels: { readonly [key: string]: string };
	/**
	 * The one host its create asked for (`CreateSandboxBody.host`), which a boot that has to place it again keeps to.
	 * Absent: any host it may use.
	 */
	readonly hostPin?: string;
	readonly runs: readonly RunPeriod[];
	/** The newest readings: a day of 5-minute means (`MAX_SAMPLES`), and hourly ones before it (`HOURLY_SAMPLES`). */
	readonly samples: readonly StoredSample[];
	readonly ports: readonly computeSchema.ExposedPort[];
	/** The snapshot its memory was paused into, while `paused`. */
	readonly pausedSnapshotId?: string;
	/**
	 * The base image version its root file system is, as its backend reported it (`Placement.base`): a host images
	 * version such as `host-images-20261104.812`, or a container image's `sha256:` digest. Answered, with how far behind
	 * it is, as the API's `base` (image patching on). Absent: not reported.
	 */
	readonly base?: string;
	/**
	 * What it asked for at create: a microVM's vCPUs and memory, and its disk where one was asked for (or, once it runs,
	 * the disk its host gave it); an isolate's memory (`vcpus` 0). Absent: made by a named size, or before shapes. A fork
	 * asks for the same.
	 */
	readonly shape?: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb?: number };
	/**
	 * Made from a template: how a fresh boot of it boots, its base and setup as its create resolved them, so a create
	 * that failed before placing it (`bootAgain`) is made again the same, whatever its template has become since. No
	 * snapshot: a retry boots fresh. A custom image's (`rootfsKey`) names the hosts holding it (`holders`), the only ones
	 * a retry may boot it on, among those the sandbox may use then.
	 */
	readonly templateBoot?: Omit<SandboxTemplateBoot, "snapshot"> & { readonly holders?: readonly string[] };
};

export type StoredCommand = computeSchema.Command & {
	readonly accountId: string;
	/** Run detached: its result can be fetched from the backend (`commandResult`) by any gateway. */
	readonly detached?: boolean;
	/** Killed, and its kill not yet taken by its backend: a later kill sends it again. */
	readonly killPending?: boolean;
};

/**
 * A snapshot and the backend's reference to its bytes (absent until it is ready), and the base image version its root
 * file system is (`TakenSnapshot.base`), answered as the API's `base`.
 */
export type StoredSnapshot = Omit<computeSchema.Snapshot, "base"> & { readonly ref?: string; readonly base?: string };

export type StoredApiKey = computeSchema.ApiKey & {
	/** The SHA-256 hex of the secret. */
	readonly secretHash: string;
	/** The person the key acts for: its maker, or its maker key's person. */
	readonly ownerUserId: string;
};

export type StoredWebhook = computeSchema.Webhook & {
	/** `whsec_…`: kept, as signing needs it; never answered after it is made. */
	readonly secret: string;
	/** Deliveries in a row that failed every attempt; the webhook is disabled at `DISABLE_AFTER_FAILURES`. */
	readonly consecutiveFailures: number;
};

/** One attempt at a delivery. */
export interface DeliveryAttempt {
	readonly at: number;
	readonly status?: number;
	readonly error?: string;
}

export type StoredDelivery = computeSchema.WebhookDelivery & {
	readonly accountId: string;
	/** The JSON body, sent the same on every attempt. */
	readonly body: string;
	readonly history: readonly DeliveryAttempt[];
};

/** An account's telemetry export; its ID is the account's. */
export type StoredTelemetry = computeSchema.TelemetryExport & {
	readonly id: string;
	/** Never answered. */
	readonly headers: { readonly [name: string]: string };
};

/** An account's proxy settings; its ID is the account's. */
export type StoredProxy = computeSchema.ProxySettings & {
	readonly id: string;
	/** The upstream's header values. Never answered. */
	readonly upstreamHeaders?: { readonly [name: string]: string };
};

/** An environment's variable: a plain one's value, or a protected one's sealed. */
export interface StoredEnvironmentVariable {
	readonly name: string;
	readonly protected: boolean;
	/** A plain variable's value. */
	readonly value?: string;
	/** A protected variable's value, sealed with `environmentAad(id, "variables", name)`. Never answered. */
	readonly sealed?: SealedValue;
	readonly bindings: readonly computeSchema.DestinationBinding[];
	readonly updatedAt: number;
}

/** An environment's secret file; its contents sealed with `environmentAad(id, "files", path)`. */
export interface StoredEnvironmentFile {
	readonly path: string;
	readonly mode: number;
	readonly sizeBytes: number;
	readonly sealed: SealedValue;
	readonly updatedAt: number;
}

export interface StoredEnvironment {
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly description?: string;
	readonly variables: readonly StoredEnvironmentVariable[];
	readonly files: readonly StoredEnvironmentFile[];
	readonly repos: readonly computeSchema.EnvironmentRepo[];
	readonly grants: readonly computeSchema.EgressGrant[];
	/** Moves on with every change to its protected variables, so a host knows its copy of them is stale. */
	readonly secretsVersion: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/**
 * The key no two environments may share, an account's and a name: the store refuses a write that would give a second
 * environment one (`UniqueViolation`), in the write itself, so a create or rename on any gateway, however delayed,
 * never commits a name another environment holds.
 */
export const environmentNameKey = (environment: { readonly accountId: string; readonly name: string }) =>
	JSON.stringify([environment.accountId, environment.name]);

/** A write the store refused because it would give a second record a key another holds (an environment's or template's name). */
export class UniqueViolation extends Error {
	constructor(kind: string) {
		super(`Another ${kind} record has that key`);
		this.name = "UniqueViolation";
	}
}

/** A template: its current version and spec (every default filled in), and its versions beside it. */
export interface StoredTemplate {
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly description?: string;
	readonly version: number;
	readonly spec: computeSchema.TemplateSpec;
	/**
	 * Moves on with each rebuild: part of its snapshots' IDs (`templateSnapshotId`), so a rebuild's builds never meet the
	 * ones it threw away.
	 */
	readonly cacheEpoch: number;
	/** The person it belongs to: its maker, or the person whose key made it. Its builds use the shared hosts they may. */
	readonly ownerUserId: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly createdBy: computeSchema.Sandbox["createdBy"];
	/**
	 * When its retirement (its deletion, or its account's) began: from then it is gone to every caller and every build,
	 * and its record is kept, last, until its versions and cache entries have gone, so a retirement cut short is
	 * finished by a sweep.
	 */
	readonly retiredAt?: number;
}

/**
 * The key no two templates may share, an account's and a name, kept as an environment's is (`environmentNameKey`): the
 * store refuses a write that would give a second template of the account the name (`UniqueViolation`).
 */
export const templateNameKey = (template: { readonly accountId: string; readonly name: string }) =>
	JSON.stringify([template.accountId, template.name]);

/** One version of a template, never changed; its ID is `<templateId>@<version>`. */
export interface StoredTemplateVersion {
	readonly id: string;
	readonly templateId: string;
	readonly version: number;
	readonly spec: computeSchema.TemplateSpec;
	readonly createdAt: number;
	readonly createdBy: computeSchema.Sandbox["createdBy"];
	/** The SQL store's mark of the one write attempt that recorded it, which tells that attempt it was its own. */
	readonly writeId?: string;
}

/**
 * A template snapshot (a cache entry, never a user snapshot): its wire shape, its account, and the backend's reference
 * to its bytes once it is built.
 */
export type StoredTemplateSnapshot = Omit<computeSchema.TemplateSnapshot, "state"> & {
	/**
	 * Its wire states, and `deleting`: thrown away (`discarded` on the wire) with its bytes, at `ref` (or, its build
	 * never having answered, under its ID on its host), not yet deleted from its host; every sweep tries again until they
	 * are, whether its template is still there or not.
	 */
	readonly state: computeSchema.TemplateSnapshotState | "deleting";
	readonly accountId: string;
	readonly ref?: string;
	/**
	 * When its host had no room for its build (`exhausted`), which left it `queued` with no gateway working on it: the
	 * first reconcile `TEMPLATE_BUILD_RETRY_MS` after claims it and tries again.
	 */
	readonly deferred?: number;
	/**
	 * Thrown away (`deleting`) while it built: when its build's lease ends (`TEMPLATE_BUILD_LEASE_MS` from `startedAt`).
	 * Until then its bytes are left to its build, which holds them on its host and deletes them when it ends; after, its
	 * gateway is taken to have died with it, and a sweep deletes them by its ID.
	 */
	readonly buildLeaseEnds?: number;
	/**
	 * A custom image's: the key's hash it was claimed under, before its build named the image's digest. Its `keyHash`
	 * covers the digest once its build has answered (`key.imageDigest`); a reconcile wants it by this one. Absent, its
	 * `keyHash`.
	 */
	readonly claimHash?: string;
	/** A custom image's root filesystem on its host, which a fresh boot there boots (`SandboxTemplateBoot.rootfsKey`). */
	readonly rootfsKey?: string;
};

/** A template as `TemplateWrites.update` changes it, and the version the change makes when it makes one. */
export interface TemplateChange {
	readonly template: StoredTemplate;
	/** The template's new version (`<templateId>@<version>`), present only when the change moves its version on. */
	readonly version?: StoredTemplateVersion;
}

/**
 * Writes of a template that record a version of it: the template and its version are written together or not at all,
 * so no template is at a version its history lacks, and no version is recorded that its template never reached. Each
 * throws `UniqueViolation` for a write that would give the template a name another of its account holds
 * (`templateNameKey`).
 */
export interface TemplateWrites {
	/** Inserts a new template and its first version; false, writing neither, when a template has its ID. */
	insert(template: StoredTemplate, version: StoredTemplateVersion): Promise<boolean>;
	/**
	 * Changes a template as `Collection.update` does, and records the change's version in the same write when it gives
	 * one. A version already recorded under that ID is kept as it is.
	 */
	update(
		id: string,
		change: (current: StoredTemplate) => TemplateChange | undefined,
	): Promise<StoredTemplate | undefined>;
}

/** A base image's channel; its ID is `<image>:<channel>`. */
export type StoredTemplateBase = computeSchema.TemplateBaseChannel & { readonly id: string };

/** One entry of a sandbox's egress log, as its host reported it; the newest `MAX_EGRESS_ENTRIES` are kept per sandbox. */
export type StoredEgressEntry = computeSchema.EgressEntry & {
	readonly sandboxId: string;
	readonly accountId: string;
};

export type StoredHost = computeSchema.Host;

export interface StoredJoinToken {
	readonly id: string;
	/** The SHA-256 hex of the token. */
	readonly tokenHash: string;
	readonly name?: string;
	readonly labels: { readonly [key: string]: string };
	readonly expiresAt: number;
	readonly createdAt: number;
	readonly usedAt?: number;
	/**
	 * The account an account's join token joins the host to: only its sandboxes run there. Absent for a super-admin's
	 * join token, whose host is shared by every account.
	 */
	readonly accountId?: string;
	/** Who made it, for an account's join token. */
	readonly createdBy?: string;
	/** The host that spent it. */
	readonly hostId?: string;
}

export type StoredEvent = computeSchema.Event;

/**
 * A delete's claim on a record (mounts): while it is fresh, a create mounting the source refuses, so the delete's count
 * of sandboxes mounting it can't miss one. A claim older than a minute is a delete that never finished, and ignored.
 */
export interface DeleteClaim {
	readonly token: string;
	readonly at: number;
}

/**
 * A bundle an account uploaded (mounts): its ID is `<accountId>/<digest>`, so an account has a digest once. Its bytes
 * are the bundle store's, kept as `generation` of the digest, which this record alone owns: they are kept before it is
 * published and removed only once it is gone, so they are there for as long as it is.
 */
export interface StoredBundle {
	readonly id: string;
	readonly accountId: string;
	/** `sha256:<hex>`. */
	readonly digest: string;
	readonly sizeBytes: number;
	readonly createdAt: number;
	readonly createdBy?: string;
	/** The generation of the digest its bytes are kept as (`BundleBlobStore`). Absent: 0, from before generations. */
	readonly generation?: number;
	readonly deleting?: DeleteClaim;
}

/** A bucket an account's sandboxes may mount prefixes of (mounts). Its credentials are sealed, and never answered. */
export interface StoredBucketSource {
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly provider: computeSchema.BucketProvider;
	readonly bucket: string;
	readonly endpoint?: string;
	readonly region?: string;
	/** The credentials' JSON, sealed at `bucketSources:<id>:credentials`. */
	readonly credentials?: SealedValue;
	readonly createdAt: number;
	readonly deleting?: DeleteClaim;
}

/**
 * A signed file URL (mounts): its ID is the SHA-256 hex of its token, which only its answer shows. It is for one file
 * of one sandbox, one way, until `expiresAt`.
 */
export interface StoredFileUrl {
	readonly id: string;
	readonly sandboxId: string;
	readonly accountId: string;
	/** Absolute. */
	readonly path: string;
	/** `GET` downloads the file, `PUT` uploads it. */
	readonly method: "GET" | "PUT";
	readonly expiresAt: number;
	readonly createdAt: number;
}

/**
 * A deployment-wide setting, by name: `publicUrl`, where hosts reach the control plane, ahead of the deployment's own,
 * as a super-admin changed it in the console; `bundleStore`, the mark the first gateway to keep a bundle left in its
 * bundle store, which any gateway's must hold for it to keep, serve or remove bundles' bytes (`BundleBlobStore.mark`).
 */
export interface StoredSetting {
	readonly id: "publicUrl" | "bundleStore";
	readonly value: string;
	readonly updatedAt: number;
	readonly updatedBy: string;
}

/**
 * A person's account deletion, from when it is accepted until everything of theirs has gone: its ID is their user ID.
 * The deletion is carried on from here, by the call that started it and then by the sweep, never by the person (who
 * can't sign in once it exists), so one that fails partway is finished all the same.
 */
export interface StoredDeletion {
	readonly id: string;
	/**
	 * `running` until its last pass is done; then `done`, kept for good, with nothing of the person's but their user ID,
	 * so that ID is never let in, made afresh or honoured on a key again (`authenticate`, `ownerRemains`).
	 */
	readonly stage: "running" | "done";
	readonly personalAccountId: string;
	readonly name: string;
	readonly email?: string;
	readonly startedAt: number;
	/** When its first pass finished; its last pass, which clears what writes already under way left, comes after. */
	readonly clearedAt?: number;
	/** When it is due to be carried on (`sweep`). */
	readonly dueAt: number;
	readonly attempts: number;
	readonly lastError?: string;
	/** Who is carrying it on, until when: one gateway at a time. */
	readonly lease?: { readonly token: string; readonly until: number };
}

/**
 * A gateway replica's claim to export one numbered usage tick: its ID is `usageClaimId` of the host, the tick's `run`
 * and its `seq`. A replica taking a tick straight from its host claims it (`insert`) once nothing can stop the tick
 * going into its series, and exports it only if the claim is its own (`owner`, that process's): a tick the host sends
 * again to another replica after a reconnect, which the first claimed, is only drawn there. So each tick is exported
 * once however the replicas pass ticks on to each other, and a claim whose answer was lost is still known as its own.
 * Removed once `keepUntil` has passed, when the host can no longer send it again.
 */
export interface StoredUsageClaim {
	readonly id: string;
	readonly hostId: string;
	readonly owner: string;
	readonly keepUntil: number;
}

/** The ID of the claim to tick `seq` of `run` from `hostId` (`StoredUsageClaim`). */
export const usageClaimId = (hostId: string, run: string, seq: number): string => `${hostId}:${run}:${seq}`;

/** A device sign-in (`kantel login` in a browser); its ID is the SHA-256 hex of its device code. */
export interface StoredDeviceLogin {
	readonly id: string;
	/** `ABCD-EFGH`, as the device shows it. */
	readonly userCode: string;
	readonly clientName: string;
	readonly state: computeSchema.DeviceLoginState;
	readonly createdAt: number;
	readonly expiresAt: number;
	/** The key made when it was approved, and its secret until the device collects it. */
	readonly apiKeyId?: string;
	readonly secret?: string;
	readonly decidedBy?: string;
	readonly collectedAt?: number;
}

/**
 * An idempotent call's key, claimed (`insert`) before the call does its work, and then its first answer; its ID is
 * `<caller>:<operation>:<key>`.
 */
export interface StoredIdempotency {
	readonly id: string;
	/**
	 * The answer's JSON, once the first call has answered; absent while it is still working. For an answer that holds a
	 * secret, the JSON of the answer sealed (`secret: "sealed"`), or `null` when it wasn't kept (`"withheld"`).
	 */
	readonly body?: string;
	/** The answer held a secret: kept sealed with the deployment's secrets key, or, with none, not kept. */
	readonly secret?: "sealed" | "withheld";
	/** The SHA-256 of the request it was for (path parameters, query and body); absent on keys kept before. */
	readonly fingerprint?: string;
	readonly createdAt: number;
	/** While it is working: who holds the claim (a random ID), so only the holder renews it. */
	readonly claim?: string;
	/**
	 * While it is working: when the claim lapses unless the holder renews it, so a gateway that died mid-call doesn't
	 * hold the key for ever; another call may then take the claim over.
	 */
	readonly claimExpiresAt?: number;
}

/** Every record the compute plane keeps. */
export interface ComputeStore {
	/**
	 * The records outlast the process (SQL). Sealed values then need the deployment's own key: a key made at random for
	 * one process would leave them unreadable after a restart.
	 */
	readonly persistent?: boolean;
	readonly users: Collection<StoredUser>;
	readonly accounts: Collection<StoredAccount>;
	readonly members: Collection<StoredMember>;
	readonly invites: Collection<StoredInvite>;
	readonly sandboxes: Collection<StoredSandbox>;
	readonly commands: Collection<StoredCommand>;
	readonly snapshots: Collection<StoredSnapshot>;
	readonly apiKeys: Collection<StoredApiKey>;
	readonly webhooks: Collection<StoredWebhook>;
	readonly deliveries: Collection<StoredDelivery>;
	readonly telemetry: Collection<StoredTelemetry>;
	readonly proxies: Collection<StoredProxy>;
	readonly hosts: Collection<StoredHost>;
	readonly joinTokens: Collection<StoredJoinToken>;
	readonly events: Collection<StoredEvent>;
	readonly idempotency: Collection<StoredIdempotency>;
	readonly deviceLogins: Collection<StoredDeviceLogin>;
	/** No two with one account and name (`environmentNameKey`): a write that would make two throws. */
	readonly environments: Collection<StoredEnvironment>;
	readonly egress: Collection<StoredEgressEntry>;
	/** Each organisation's E2E chain, an entry a record (`e2e.ts`). */
	readonly e2eChain: Collection<StoredE2EEntry>;
	/** Mounts' bundles, bucket sources and signed file URLs (experimental). */
	readonly bundles: Collection<StoredBundle>;
	readonly bucketSources: Collection<StoredBucketSource>;
	readonly fileUrls: Collection<StoredFileUrl>;
	readonly settings: Collection<StoredSetting>;
	/**
	 * No two with one account and name (`templateNameKey`): a write that would make two throws. A write that makes a
	 * version goes through `templateWrites`.
	 */
	readonly templates: Collection<StoredTemplate>;
	readonly templateVersions: Collection<StoredTemplateVersion>;
	/** A template and its version, written together. */
	readonly templateWrites: TemplateWrites;
	/** Template snapshots: a cache, apart from `snapshots`, which the template code never reads or writes. */
	readonly templateSnapshots: Collection<StoredTemplateSnapshot>;
	readonly templateBases: Collection<StoredTemplateBase>;
	/** Which replica exports each numbered usage tick (`StoredUsageClaim`). */
	readonly usageClaims: Collection<StoredUsageClaim>;
	/** Account deletions under way (`StoredDeletion`). */
	readonly deletions: Collection<StoredDeletion>;
}

/**
 * Whether each defined field of `where` is `===` the record's top-level field of that name: what `list` answers by. The
 * SQL store (`sql-store.ts`) checks every row with it too, so both answer the same.
 */
export function matches<T>(record: T, where: Partial<T> | undefined): boolean {
	if (where === undefined) return true;
	const fields = record as { readonly [key: string]: unknown };
	return Object.entries(where).every(([key, value]) => value === undefined || fields[key] === value);
}

/** A memory collection, its records and its unique-key check: for writes over two collections at once. */
interface MemoryTable<T extends { readonly id: string }> {
	readonly collection: Collection<T>;
	readonly records: Map<string, T>;
	/** Throws `UniqueViolation` when `record` would share its unique key with another record. */
	check(record: T): void;
}

/**
 * A collection in a `Map`, copying records in and out. With `unique`, no two records may share its key: a write that
 * would make two throws `UniqueViolation`, as the SQL store's unique index does.
 */
export function memoryCollection<T extends { readonly id: string }>(unique?: (record: T) => string): Collection<T> {
	return memoryTable(unique).collection;
}

function memoryTable<T extends { readonly id: string }>(unique?: (record: T) => string): MemoryTable<T> {
	const records = new Map<string, T>();
	const check = (record: T) => {
		if (unique === undefined) return;
		const key = unique(record);
		for (const other of records.values()) {
			if (other.id !== record.id && unique(other) === key) throw new UniqueViolation("compute");
		}
	};
	const collection: Collection<T> = {
		async get(id) {
			const record = records.get(id);
			return record === undefined ? undefined : structuredClone(record);
		},
		async put(record) {
			check(record);
			records.set(record.id, structuredClone(record));
		},
		async insert(record) {
			if (records.has(record.id)) return false;
			check(record);
			records.set(record.id, structuredClone(record));
			return true;
		},
		async update(id, change) {
			const current = records.get(id);
			if (current === undefined) return undefined;
			const next = change(structuredClone(current));
			if (next === undefined) return undefined;
			check(next);
			records.set(id, structuredClone(next));
			return structuredClone(next);
		},
		async delete(id) {
			return records.delete(id);
		},
		async deleteIf(id, should) {
			const current = records.get(id);
			if (current === undefined || !should(structuredClone(current))) return false;
			return records.delete(id);
		},
		async list(where) {
			return [...records.values()].filter((record) => matches(record, where)).map((record) => structuredClone(record));
		},
	};
	return { collection, records, check };
}

/** `TemplateWrites` over memory tables: each write is made in one turn, so nothing reads half of it. */
function memoryTemplateWrites(
	templates: MemoryTable<StoredTemplate>,
	versions: MemoryTable<StoredTemplateVersion>,
): TemplateWrites {
	const record = (version: StoredTemplateVersion | undefined) => {
		if (version !== undefined && !versions.records.has(version.id)) {
			versions.records.set(version.id, structuredClone(version));
		}
	};
	return {
		async insert(template, version) {
			if (templates.records.has(template.id)) return false;
			templates.check(template);
			templates.records.set(template.id, structuredClone(template));
			record(version);
			return true;
		},
		async update(id, change) {
			const current = templates.records.get(id);
			if (current === undefined) return undefined;
			const next = change(structuredClone(current));
			if (next === undefined) return undefined;
			templates.check(next.template);
			templates.records.set(id, structuredClone(next.template));
			record(next.version);
			return structuredClone(next.template);
		},
	};
}

/** A `ComputeStore` in memory. */
export function createMemoryStore(): ComputeStore {
	const templates = memoryTable<StoredTemplate>(templateNameKey);
	const templateVersions = memoryTable<StoredTemplateVersion>();
	return {
		users: memoryCollection(),
		accounts: memoryCollection(),
		members: memoryCollection(),
		invites: memoryCollection(),
		sandboxes: memoryCollection(),
		commands: memoryCollection(),
		snapshots: memoryCollection(),
		apiKeys: memoryCollection(),
		webhooks: memoryCollection(),
		deliveries: memoryCollection(),
		telemetry: memoryCollection(),
		proxies: memoryCollection(),
		hosts: memoryCollection(),
		joinTokens: memoryCollection(),
		events: memoryCollection(),
		idempotency: memoryCollection(),
		deviceLogins: memoryCollection(),
		environments: memoryCollection<StoredEnvironment>(environmentNameKey),
		egress: memoryCollection(),
		e2eChain: memoryCollection(),
		bundles: memoryCollection(),
		bucketSources: memoryCollection(),
		fileUrls: memoryCollection(),
		settings: memoryCollection(),
		usageClaims: memoryCollection(),
		deletions: memoryCollection(),
		templates: templates.collection,
		templateVersions: templateVersions.collection,
		templateWrites: memoryTemplateWrites(templates, templateVersions),
		templateSnapshots: memoryCollection(),
		templateBases: memoryCollection(),
	};
}

/**
 * Spends a host join token the compute API minted, once: for the host registry (`@kantel/hosts`), which registers the
 * host. Answers its name and labels, or undefined when it is unknown, used or expired.
 */
export function joinTokenSpender(store: ComputeStore) {
	return {
		async accountOpen(accountId: string) {
			const account = await store.accounts.get(accountId);
			return account !== undefined && account.closedAt === undefined;
		},
		async spendJoinToken(hash: string, hostId: string, now: number) {
			const [token] = await store.joinTokens.list({ tokenHash: hash });
			if (token === undefined) return undefined;
			// An account's token joins nothing once its account is closed or gone (its person deleted their account).
			if (token.accountId !== undefined) {
				const account = await store.accounts.get(token.accountId);
				if (account === undefined || account.closedAt !== undefined) return undefined;
			}
			const spent = await store.joinTokens.update(token.id, (current) =>
				current.usedAt !== undefined || current.expiresAt <= now ? undefined : { ...current, usedAt: now, hostId },
			);
			if (spent === undefined) return undefined;
			return {
				id: spent.id,
				labels: { ...spent.labels },
				...(spent.name === undefined ? {} : { name: spent.name }),
				...(spent.accountId === undefined ? {} : { accountId: spent.accountId }),
			};
		},
	};
}

/** Refused: the account a write is for has closed (its person deleted their account) or gone. */
export const ACCOUNT_CLOSED_MESSAGE = "This account is being deleted";

/**
 * The store, with the records an account keeps beside its sandboxes (environments, bucket sources, webhooks and their
 * deliveries, telemetry, proxy settings, join tokens) fenced against its deletion: a write is checked once it
 * has landed, and one that landed in an account that has closed or gone is taken out again and refused. So a write
 * already under way when the account closed, however late it lands, never leaves a record behind, and an update never
 * brings a deleted record back (`update` writes only a record that is there). Sandboxes, snapshots and commands have
 * fences of their own, which know their lifecycles; events come only from those, on the hot path, and are left to them.
 */
export function fenceClosedAccounts(store: ComputeStore): ComputeStore {
	const open = async (accountId: string) => {
		const account = await store.accounts.get(accountId);
		return account !== undefined && account.closedAt === undefined;
	};
	function fenced<T extends { readonly id: string }>(
		collection: Collection<T>,
		accountOf: (record: T) => string | undefined,
	): Collection<T> {
		const check = async (record: T | undefined): Promise<void> => {
			const accountId = record === undefined ? undefined : accountOf(record);
			if (record === undefined || accountId === undefined || (await open(accountId))) return;
			await collection.delete(record.id).catch(() => false);
			throw new KantelError("conflict", ACCOUNT_CLOSED_MESSAGE);
		};
		return {
			get: (id) => collection.get(id),
			list: (where) => collection.list(where),
			delete: (id) => collection.delete(id),
			deleteIf: (id, should) => collection.deleteIf(id, should),
			async put(record) {
				await collection.put(record);
				await check(record);
			},
			async insert(record) {
				const inserted = await collection.insert(record);
				if (inserted) await check(record);
				return inserted;
			},
			async update(id, change, expected) {
				const updated = await collection.update(id, change, expected);
				await check(updated);
				return updated;
			},
		};
	}
	const byAccount = <T extends { readonly accountId?: string }>(record: T) => record.accountId;
	const isAccount = <T extends { readonly id: string }>(record: T) => record.id;
	return {
		...store,
		environments: fenced(store.environments, byAccount),
		bucketSources: fenced(store.bucketSources, byAccount),
		webhooks: fenced(store.webhooks, byAccount),
		deliveries: fenced(store.deliveries, byAccount),
		joinTokens: fenced(store.joinTokens, byAccount),
		// Keyed by their account.
		telemetry: fenced(store.telemetry, isAccount),
		proxies: fenced(store.proxies, isAccount),
	};
}
