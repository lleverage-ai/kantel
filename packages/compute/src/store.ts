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
import type { BackendDiskUsage, SandboxTemplateBoot, SnapshotMadeOn } from "./backend.ts";
import type { StoredGithubRunnerJob, StoredGithubRunnerMachine, StoredGithubRunners } from "./github-runners.ts";
import type { DiskKind } from "./grants.ts";
import type { SealedValue } from "./secrets.ts";

/**
 * A `sandbox.oom_kill` taken and not yet stored (`StoredSandbox.oomKills`): its event's ID, how many kills it reports,
 * the sandbox's memory then and the reading's time. Never changed once written, so every try stores the same event.
 */
export interface OOMPending {
	readonly eventId: string;
	readonly kills: number;
	readonly memLimitBytes: number;
	readonly at: number;
}

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
	/**
	 * When their account deletion retired them: kept for good, with nothing else of theirs, so nothing is made for them
	 * again (`PersonWrites`) and they are never let back in.
	 */
	readonly retiredAt?: number;
}

/**
 * A person's first records, written only while they are active: their user record exists and isn't retired. Checked in
 * the same write, so a retirement and one of these never pass each other: the write lands first (and the deletion that
 * retired them finds it), or it doesn't land. (SQL: one conditional insert, which on Postgres holds the user's row.)
 */
export interface PersonWrites {
	/** Inserts a personal account of `userId`'s; whether it did (not when it is there already, or they aren't active). */
	insertAccount(account: StoredAccount, userId: string): Promise<boolean>;
	/** Inserts a membership; whether it did (not when it is there already, or its person isn't active). */
	insertMember(member: StoredMember): Promise<boolean>;
}

export interface StoredAccount {
	readonly id: string;
	readonly kind: computeSchema.AccountKind;
	readonly name: string;
	readonly defaultVisibility: computeSchema.SandboxVisibility;
	/** An organisation's members' personal tokens may act in it unless `blocked`; absent is `allowed`. */
	readonly personalTokens?: computeSchema.PersonalTokenPolicy;
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
	/**
	 * What an hour of it cost, where that isn't the sandbox's rate now: an upgraded sandbox's isolate run, priced as the
	 * isolate it was. Absent: the sandbox's rate.
	 */
	readonly ratePerHour?: number;
}

/** A CPU and memory reading of a running sandbox. */
export interface StoredSample {
	readonly at: number;
	readonly cpu: number;
	readonly memoryMb: number;
	/**
	 * The highest reading of its span, where it is a mean: CPU 0 to 1, memory in MiB. Absent on a single reading and on a
	 * mean kept before peaks were, whose highest is taken as its mean.
	 */
	readonly cpuMax?: number;
	readonly memoryMbMax?: number;
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

/** A sandbox's highest readings (`StoredSandbox.peak`). */
export interface StoredPeak {
	readonly memoryBytes: number;
	readonly memoryAt: number;
	readonly cpu: number;
}

/** One piece of a sandbox's environment set-up (`StoredSandbox.pendingProvision`). */
export interface ProvisionWork {
	readonly id: string;
	/**
	 * `files`: the environment's secret files at the paths it wins. `repos`: its repositories, cloned (only by a set-up a
	 * caller who may run commands started). `paths`: whatever file wins each of `paths` now (a move changed the winner).
	 */
	readonly kind: "files" | "repos" | "paths";
	readonly environmentId?: string;
	readonly paths?: readonly string[];
}

/** A sandbox: its wire shape (but its cost and usage, worked out when answered) and what the service keeps besides. */
export type StoredSandbox = Omit<computeSchema.Sandbox, "cost" | "usage" | "grants" | "base" | "hostReachable"> & {
	/** The person it belongs to: its maker, or the person whose key made it. */
	readonly ownerUserId: string;
	/** What every command sees: its environments' plain variables and placeholders, in order, then the create's own. */
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
	 * The host's clock (ms) when it set the guest-agent health last taken (`ComputeService.reportHealth`): a report that
	 * says an earlier or the same time is older than what is here, and is dropped.
	 */
	readonly healthAt?: number;
	/**
	 * Its guest's OOM-kill count (since boot) as last taken from a reading here, for `sandbox.oom_kill`: `count` and the
	 * reading's time `at`, written only when the count changes, so every gateway measures a rise from the same place
	 * and a range of kills is reported once. Every newer reading moves the count, and the kills it adds go to
	 * `unreported`; with no event pending, what is unreported becomes `pending`, an event with the ID it is stored
	 * under and all it says, never changed, until it is stored.
	 */
	readonly oomKills?: {
		readonly count: number;
		readonly at: number;
		readonly unreported?: number;
		readonly pending?: OOMPending;
	};
	/**
	 * When its host started the machine this run booted (the host's clock, ms: its first health stamp, `Placement.machineAt`):
	 * a host's report of an exit stamped earlier is an earlier machine's, and is dropped (`ComputeService.reportExit`).
	 * Absent from a backend that doesn't say. Set by every boot.
	 */
	readonly machineAt?: number;
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
	/**
	 * What `env` is made of besides its environments, kept so an attach or detach can work it out again: `base` (its
	 * template's variables) under its environments, `own` (its create's `env`) over them. Absent on a sandbox made before
	 * environments could be attached: its `env` as it was, but its placeholders, is then its `base`.
	 */
	readonly envLayers?: {
		readonly base: { readonly [name: string]: string };
		readonly own: { readonly [name: string]: string };
	};
	/**
	 * The least version its protected values are answered at (`protectedTable`), moved on when an environment is detached
	 * from it or deleted, so its host drops what it held of that environment's. Absent: none.
	 */
	readonly secretsFloor?: number;
	/**
	 * Environment set-up it still has to do, recorded when the change that needs it is (a create, an attach, a move), and
	 * taken off by its ID once a set-up has done it: never before, so a stopped set-up leaves it for the next, and never
	 * an item another change added. Absent: none.
	 */
	readonly pendingProvision?: readonly ProvisionWork[];
	/**
	 * The fence of its newest set-up, moved on (in the store) by each one as it starts: its file writes carry it, and its
	 * host drops a write with a lower one than it has taken, so an older set-up's write never lands over a newer one's.
	 */
	readonly provisionFence?: number;
	readonly hostLabels: { readonly [key: string]: string };
	/**
	 * The one host its create asked for (`CreateSandboxBody.host`), which a boot that has to place it again keeps to.
	 * Absent: any host it may use.
	 */
	readonly hostPin?: string;
	readonly runs: readonly RunPeriod[];
	/** The newest readings: a day of 5-minute means (`MAX_SAMPLES`), and hourly ones before it (`HOURLY_SAMPLES`). */
	readonly samples: readonly StoredSample[];
	/**
	 * The highest readings it has had since it was made, kept with each 5-minute mean (`keepRollup`) and so after its
	 * samples are folded or it is deleted: memory in bytes and when, CPU 0 to 1. Absent: no mean kept since peaks were.
	 */
	readonly peak?: StoredPeak;
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
	/**
	 * An upgrade to a microVM under way (it is `starting`): its operation ID, which its backend does at most once and can
	 * settle (`SandboxBackend.settleUpgrade`), when it began and when its gateway last said it was at it (`heartbeatAt`:
	 * one gone quiet is settled by the sweep), what it was before (`from`, `before`: what a rollback puts back), the
	 * microVM asked for, and the egress revision sent with it.
	 */
	readonly upgrading?: {
		readonly operationId: string;
		readonly at: number;
		readonly heartbeatAt: number;
		readonly from: "running" | "stopped";
		readonly before: {
			readonly runs: readonly RunPeriod[];
			readonly stopsAt?: number;
			readonly startedAt?: number;
			readonly stoppedAt?: number;
			readonly lastActiveAt?: number;
			/** Whether its backend had its egress as it was then (`egressApplied` no earlier than its `egressRevision`). */
			readonly egressInSync?: boolean;
		};
		readonly size?: computeSchema.SandboxSizeName;
		readonly shape?: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb?: number };
		readonly image?: string;
		readonly egressRevision?: number;
	};
};

export type StoredCommand = computeSchema.Command & {
	readonly accountId: string;
	/** Run detached: its result can be fetched from the backend (`commandResult`) by any gateway. */
	readonly detached?: boolean;
	/** Killed, and its kill not yet taken by its backend: a later kill sends it again. */
	readonly killPending?: boolean;
	/** Its sandbox was an isolate with `autoUpgrade` when it started: a needsMicrovm end may be run again. */
	readonly autoUpgrade?: true;
	/**
	 * When its end, needing a microVM, was first seen while its sandbox upgrades and it runs again: until its owner records
	 * that end with its run again (`rerunAs`), or `RERUN_CLAIM_MS` passes, no other reader records it ended.
	 */
	readonly rerunPending?: number;
	/**
	 * The ID its run again takes, written while it still runs once its sandbox is upgraded and before its run again is
	 * recorded: only a command still running gets one, so one killed first is never run again, and a kill landing after
	 * it reaches its run again (`killCommand`), which itself starts only while this one still runs.
	 */
	readonly rerunStarting?: string;
};

/**
 * A snapshot and the backend's reference to its bytes (absent until it is ready), the base image version its root
 * file system is (`TakenSnapshot.base`), answered as the API's `base`, and what a microVM's was made on where its host
 * said (`SnapshotMadeOn`), which the API doesn't answer.
 */
export type StoredSnapshot = Omit<computeSchema.Snapshot, "base"> & {
	readonly ref?: string;
	readonly base?: string;
	/**
	 * All its files take on its host's disk, those it shares with other snapshots included, as the host last said (a
	 * keep, a live save, a refresh), where `sizeBytes` counts shared files for one holder only. A host's limit on saved
	 * bytes counts each save at this, its full size (`savedBytesOver`). Absent: `sizeBytes`.
	 */
	readonly fullSizeBytes?: number;
	/**
	 * While expiry deletes it (`deleting`): the process whose mark it is, the mark's token, since when; `settling` once its
	 * bytes are being deleted, after which it is never put back.
	 */
	readonly retiring?: {
		readonly by: string;
		readonly token?: string;
		readonly at: number;
		readonly settling?: boolean;
	};
} & SnapshotMadeOn;

export type StoredApiKey = computeSchema.ApiKey & {
	/** The SHA-256 hex of the secret. */
	readonly secretHash: string;
	/** The person the key acts for: its maker, or its maker key's person. */
	readonly ownerUserId: string;
};

export type StoredPersonalToken = computeSchema.PersonalToken & {
	/** The SHA-256 hex of the secret. */
	readonly secretHash: string;
	/** The person it acts as. */
	readonly userId: string;
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
 * A template snapshot (a cache entry, never a user snapshot): its wire shape, its account, the backend's reference
 * to its bytes once it is built, and what it was made on where its host said (`SnapshotMadeOn`), which the API doesn't
 * answer.
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
} & SnapshotMadeOn;

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

/** A host, its disk as it measured it (`BackendDiskUsage`), answered split by the snapshot records (`hostView`). */
export type StoredHost = Omit<computeSchema.Host, "diskUsage"> & {
	readonly diskUsage?: BackendDiskUsage;
	/**
	 * Counts its drains and undrains, each taking the next here before its registry is told, with it: the registry takes
	 * a drain or undrain only over an older one's, so one held up can't undo a later one there. A move to another pool
	 * lands only under the count its check of the host's sandboxes was made under, still draining, so admission stayed
	 * shut from the check to the move.
	 */
	readonly drainEpoch?: number;
};

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
	/** The pool the host joins (`StoredPool`); absent, its owner's default pool. */
	readonly poolId?: string;
}

/** Whose pools the deployment's own are: its shared hosts'. No account's ID is this. */
export const OPERATOR_POOLS = "operator";

/**
 * A pool: a set of an account's hosts, or of the deployment's shared hosts, each host in exactly one
 * (`StoredHost.poolId`). docs/design/disk-store.md, "Pools".
 */
export interface StoredPool {
	readonly id: string;
	/** The account whose pool it is, or `OPERATOR_POOLS` for the deployment's. */
	readonly owner: string;
	/** Unique among its owner's pools (`poolNameKey`). */
	readonly name: string;
	readonly createdAt: number;
	/**
	 * When it was made its owner's default pool: of an owner's pools, the one made so latest is the default. Absent from
	 * a pool that never was.
	 */
	readonly defaultAt?: number;
	/**
	 * Whether its hosts sync with each other: those that run the mesh peer over WireGuard (docs/design/disk-store.md,
	 * "2a. The mesh"). Off (absent) by default.
	 */
	readonly sync?: boolean;
}

/** The key no two pools may share: an owner's and a name, so the store refuses a second pool of a name in an owner. */
export const poolNameKey = (pool: { readonly owner: string; readonly name: string }) => `${pool.owner}\n${pool.name}`;

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
	/**
	 * Who made it (`encodeGrantee`): checked again each time it is used. Such a URL's ID is `boundFileUrlId`'s, so a
	 * gateway from before it never finds it. Absent from one made before it was kept, whose ID is its token's SHA-256.
	 */
	readonly grantee?: string;
}

/**
 * A deployment-wide setting, by name: `publicUrl`, where hosts reach the control plane, ahead of the deployment's own,
 * as a super-admin changed it in the console; `bundleStore`, the mark the first gateway to keep a bundle left in its
 * bundle store, which any gateway's must hold for it to keep, serve or remove bundles' bytes (`BundleBlobStore.mark`).
 */
export interface StoredSetting {
	/**
	 * `grantKey`: the control plane's Ed25519 key for fetch grants (`grants.ts`), made by the first gateway that needs it
	 * and claimed (`insert`), so every gateway over one database signs with the same key. `value` is its public key, and
	 * `sealed` its private key, sealed with the deployment's secrets key.
	 */
	readonly id: "publicUrl" | "bundleStore" | "grantKey";
	readonly value: string;
	/** A value kept sealed beside `value`: the grant key's private key. */
	readonly sealed?: SealedValue;
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
	/**
	 * `ABCD-EFGH`, as the device shows it: an API key's sign-in's. A personal token's keeps it in `personalUserCode`
	 * instead, which a gateway from before personal tokens never looks up, so it can't approve one as an API key.
	 */
	readonly userCode?: string;
	readonly personalUserCode?: string;
	readonly clientName: string;
	readonly state: computeSchema.DeviceLoginState;
	readonly createdAt: number;
	readonly expiresAt: number;
	/** It asked for a personal access token rather than an API key. */
	readonly personal?: boolean;
	/** The key, or personal token, made when it was approved, and its secret until the device collects it. */
	readonly apiKeyId?: string;
	readonly personalTokenId?: string;
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
	readonly personalTokens: Collection<StoredPersonalToken>;
	readonly webhooks: Collection<StoredWebhook>;
	readonly deliveries: Collection<StoredDelivery>;
	readonly telemetry: Collection<StoredTelemetry>;
	readonly proxies: Collection<StoredProxy>;
	readonly hosts: Collection<StoredHost>;
	readonly joinTokens: Collection<StoredJoinToken>;
	/** No two with one owner and name (`poolNameKey`): a write that would make two throws. */
	readonly pools: Collection<StoredPool>;
	readonly events: Collection<StoredEvent>;
	readonly idempotency: Collection<StoredIdempotency>;
	readonly deviceLogins: Collection<StoredDeviceLogin>;
	/** No two with one account and name (`environmentNameKey`): a write that would make two throws. */
	readonly environments: Collection<StoredEnvironment>;
	readonly egress: Collection<StoredEgressEntry>;
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
	/** GitHub Actions runners (`github-runners.ts`): the integrations, the jobs their webhooks told of, and their runners. */
	readonly githubRunners: Collection<StoredGithubRunners>;
	readonly githubRunnerJobs: Collection<StoredGithubRunnerJob>;
	readonly githubRunnerMachines: Collection<StoredGithubRunnerMachine>;
	/**
	 * Sticky disks and their versions (docs/design/disk-store.md). A write that makes a disk, tombstones one or records a
	 * version goes through `stickyDiskWrites`, with the disk's name claim or its version.
	 */
	readonly stickyDisks: Collection<StoredStickyDisk>;
	readonly stickyDiskVersions: Collection<StoredStickyDiskVersion>;
	/** Each live sticky disk's name in its account (`stickyDiskNameId`), claimed and released with its disk. */
	readonly stickyDiskNames: Collection<StoredStickyDiskName>;
	/** A sticky disk with its name's claim or its version, written together. */
	readonly stickyDiskWrites: StickyDiskWrites;
	/** Which hosts hold which versions of the disk store's objects (`StoredDiskHolder`). */
	readonly diskHolders: Collection<StoredDiskHolder>;
	/** Each host's newest holdings report, and holders reconciled from reports, written together. */
	readonly diskReports: Collection<StoredDiskReport>;
	readonly diskHolderWrites: DiskHolderWrites;
	/** A person's first records, only while they are active. */
	readonly personWrites: PersonWrites;
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

/** A sticky disk: an account's named, versioned disk (docs/design/disk-store.md). */
export interface StoredStickyDisk {
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly description?: string;
	readonly sizeGb: number;
	/** The newest committed version. */
	readonly head?: string;
	/** How many versions have been committed: the next one's `seq` is one more. */
	readonly commits?: number;
	/**
	 * The pool it belongs to (`StoredPool`): the one its create named, else the first sandbox's it was attached to, set
	 * once and never changed. It is attached only to sandboxes in that pool. Absent until then.
	 */
	readonly poolId?: string;
	/**
	 * When it was deleted: from then it is gone to every caller and its name is free, and the record is kept so passes
	 * delete its versions from hosts that were away (`STICKY_TOMBSTONE_MS`).
	 */
	readonly deletedAt?: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** A sticky disk's claim on its name in its account. */
export interface StoredStickyDiskName {
	/** `stickyDiskNameId(accountId, name)`. */
	readonly id: string;
	readonly accountId: string;
	readonly diskId: string;
}

export const stickyDiskNameId = (accountId: string, name: string): string => `${accountId}:${name}`;

/**
 * One committed version of a sticky disk: where it was made, from what. Never changed, but for its `mapDigest` given
 * after its commit.
 */
export interface StoredStickyDiskVersion {
	readonly id: string;
	readonly diskId: string;
	readonly accountId: string;
	readonly parent?: string;
	readonly hostId: string;
	readonly sandboxId: string;
	readonly sizeBytes: number;
	readonly allocatedBytes: number;
	/**
	 * Its block map's digest (`sha256:` and hex; docs/design/disk-store.md, 2b): from the commit's answer, or, when the
	 * map took longer, from its host's next report of what it holds. Absent until then, and for a host from before maps.
	 */
	readonly mapDigest?: string;
	/** Its place among its disk's commits, from 1: what orders them, as two may share a millisecond. */
	readonly seq: number;
	readonly createdAt: number;
	/** The write that recorded it, in SQL: how that write tells it landed (`StickyDiskWrites.commit`). */
	readonly writeId?: string;
}

/**
 * A host's copy of one version of a disk store object (docs/design/disk-store.md, 2c): what the host reports it holds,
 * reconciled from each of its capacity reports, so these are the copies there are rather than the ones asked for. A
 * version's own `hostId` stays the host it was made on; this is every host that has it. Its ID is `diskHolderId`.
 */
export interface StoredDiskHolder {
	readonly id: string;
	readonly kind: DiskKind;
	/** The object: a sticky disk's ID. */
	readonly objectId: string;
	readonly version: string;
	readonly hostId: string;
	/**
	 * `held`: the host has it in full. `fetching`: it is fetching it from others, and reports it held once it has it.
	 * `deleting`: it has been told to let it go.
	 */
	readonly state: "fetching" | "held" | "deleting";
	/** When it reached `state`. */
	readonly since: number;
}

export const diskHolderId = (kind: DiskKind, objectId: string, version: string, hostId: string): string =>
	`${kind}:${objectId}:${version}:${hostId}`;

/** The newest holdings report a host's holders were reconciled from (`DiskHolderWrites`); its ID is the host's. */
export interface StoredDiskReport {
	readonly id: string;
	readonly at: number;
}

/**
 * Reconciling a host's holders from its reports, fenced so the newest report wins on every gateway:
 *
 * - `claim` makes a report the host's newest (`StoredDiskReport`), unless one as new or newer has been claimed.
 * - `reconcile` deletes the holders `release` names, each only as it was read, and inserts those `hold` names, each only
 *   while its sticky version's record is there; all of it only while `at` is still the host's newest report. So a report
 *   held up behind a newer one, here or on another gateway, changes nothing. Recording a holder changes its version's
 *   record (in SQL, its row's version), so a `StickyDiskWrites.forget` that read the holders before it reads them again.
 */
export interface DiskHolderWrites {
	/** Whether the report received at `at` is now the host's newest. */
	claim(hostId: string, at: number): Promise<boolean>;
	reconcile(
		hostId: string,
		at: number,
		changes: { readonly hold: readonly StoredDiskHolder[]; readonly release: readonly StoredDiskHolder[] },
	): Promise<void>;
}

/**
 * Writes of a sticky disk that must land with another record or not at all, so no interruption leaves a name claimed
 * without its live disk, or a disk's head without its version:
 *
 * - `create` inserts a disk and its name's claim together.
 * - `tombstone` marks a disk deleted and releases its name's claim together, only a claim that names that disk, so a
 *   delayed delete never frees a newer disk's name.
 * - `commit` records a version and makes it the disk's head, numbered after its other commits, together, and only while
 *   the disk is there and not tombstoned: once a tombstone lands, no version of the disk is recorded again.
 * - `forget` deletes a version's record only while it isn't its disk's head, so the head always has its version, and,
 *   given `keep`, only while `keep` passes over its holders as they are when it lands: a holder recorded meanwhile
 *   (`DiskHolderWrites.reconcile` changes the version's record as it records one) means it reads them again.
 * - `pool` gives a sandbox's disks its pool, all of them or none: those with none get it only while every one of them
 *   still has none or that pool, so a set refused for one disk in another pool leaves no other with its pool.
 */
export interface StickyDiskWrites {
	/** Inserts `disk` and claims its name in its account; false, writing neither, when the name or the ID is taken. */
	create(disk: StoredStickyDisk): Promise<boolean>;
	/**
	 * Tombstones the disk (`deletedAt`) and releases its name's claim; one tombstoned already keeps its time and has its
	 * claim released again. Answers the tombstoned disk, or undefined when there is none.
	 */
	tombstone(id: string, at: number): Promise<StoredStickyDisk | undefined>;
	/**
	 * Records `version` (its `seq` set to the disk's next) as its live disk's head. Answers the version recorded, or
	 * undefined, writing nothing, when the disk is gone or tombstoned.
	 */
	commit(version: StoredStickyDiskVersion, at: number): Promise<StoredStickyDiskVersion | undefined>;
	/**
	 * Deletes the version `id`'s record (its host no longer holds it) unless it is its disk's head, or `keep` says to keep
	 * it given its holders (`StoredDiskHolder`). Answers whether it is gone, false leaving it as it was.
	 */
	forget(id: string, keep?: (holders: readonly StoredDiskHolder[]) => boolean): Promise<boolean>;
	/**
	 * Gives each of the disks `ids` with no pool yet `poolId`, in one write, only while none is in another pool (a
	 * missing or tombstoned one is passed over). Answers a disk in another pool and that pool, writing nothing, or
	 * undefined once every one is in `poolId`.
	 */
	pool(
		ids: readonly string[],
		poolId: string,
	): Promise<{ readonly diskId: string; readonly poolId: string } | undefined>;
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

/** `StickyDiskWrites` over memory tables: each write is made in one turn, so nothing reads half of it. */
function memoryStickyDiskWrites(
	disks: MemoryTable<StoredStickyDisk>,
	names: MemoryTable<StoredStickyDiskName>,
	versions: MemoryTable<StoredStickyDiskVersion>,
	holders: MemoryTable<StoredDiskHolder>,
): StickyDiskWrites {
	return {
		async create(disk) {
			const claim = stickyDiskNameId(disk.accountId, disk.name);
			if (disks.records.has(disk.id) || names.records.has(claim)) return false;
			disks.records.set(disk.id, structuredClone(disk));
			names.records.set(claim, { id: claim, accountId: disk.accountId, diskId: disk.id });
			return true;
		},
		async tombstone(id, at) {
			const current = disks.records.get(id);
			if (current === undefined) return undefined;
			const tombstoned = current.deletedAt === undefined ? { ...current, deletedAt: at, updatedAt: at } : current;
			disks.records.set(id, structuredClone(tombstoned));
			const claim = stickyDiskNameId(current.accountId, current.name);
			if (names.records.get(claim)?.diskId === id) names.records.delete(claim);
			return structuredClone(tombstoned);
		},
		async commit(version, at) {
			const current = disks.records.get(version.diskId);
			if (current === undefined || current.deletedAt !== undefined || versions.records.has(version.id)) {
				return undefined;
			}
			const commits = (current.commits ?? 0) + 1;
			const recorded = { ...version, seq: commits };
			disks.records.set(current.id, { ...current, head: version.id, commits, updatedAt: at });
			versions.records.set(version.id, structuredClone(recorded));
			return structuredClone(recorded);
		},
		async forget(id, keep) {
			const version = versions.records.get(id);
			if (version === undefined) return true;
			if (disks.records.get(version.diskId)?.head === id) return false;
			if (keep?.(memoryHoldersOf(holders, version)) === true) return false;
			versions.records.delete(id);
			return true;
		},
		async pool(ids, poolId) {
			const live = ids.flatMap((id) => {
				const disk = disks.records.get(id);
				return disk === undefined || disk.deletedAt !== undefined ? [] : [disk];
			});
			const other = live.find((disk) => disk.poolId !== undefined && disk.poolId !== poolId);
			if (other?.poolId !== undefined) return { diskId: other.id, poolId: other.poolId };
			for (const disk of live) {
				if (disk.poolId === undefined) disks.records.set(disk.id, { ...structuredClone(disk), poolId });
			}
			return undefined;
		},
	};
}

/** A sticky version's holders in a memory table. */
const memoryHoldersOf = (holders: MemoryTable<StoredDiskHolder>, version: StoredStickyDiskVersion) =>
	[...holders.records.values()]
		.filter((holder) => holder.kind === "sticky" && holder.objectId === version.diskId && holder.version === version.id)
		.map((holder) => structuredClone(holder));

/** `DiskHolderWrites` over memory tables: each write is made in one turn, so nothing reads half of it. */
function memoryDiskHolderWrites(
	reports: MemoryTable<StoredDiskReport>,
	holders: MemoryTable<StoredDiskHolder>,
	versions: MemoryTable<StoredStickyDiskVersion>,
): DiskHolderWrites {
	return {
		async claim(hostId, at) {
			const newest = reports.records.get(hostId);
			if (newest !== undefined && newest.at >= at) return false;
			reports.records.set(hostId, { id: hostId, at });
			return true;
		},
		async reconcile(hostId, at, { hold, release }) {
			if (reports.records.get(hostId)?.at !== at) return;
			for (const holder of release) {
				if (JSON.stringify(holders.records.get(holder.id)) === JSON.stringify(holder))
					holders.records.delete(holder.id);
			}
			for (const holder of hold) {
				if (holders.records.has(holder.id) || !versions.records.has(holder.version)) continue;
				holders.records.set(holder.id, structuredClone(holder));
			}
		},
	};
}

/** A `ComputeStore` in memory. */
export function createMemoryStore(): ComputeStore {
	const templates = memoryTable<StoredTemplate>(templateNameKey);
	const templateVersions = memoryTable<StoredTemplateVersion>();
	const users = memoryTable<StoredUser>();
	const accounts = memoryTable<StoredAccount>();
	const members = memoryTable<StoredMember>();
	const stickyDisks = memoryTable<StoredStickyDisk>();
	const stickyDiskNames = memoryTable<StoredStickyDiskName>();
	const stickyDiskVersions = memoryTable<StoredStickyDiskVersion>();
	const diskHolders = memoryTable<StoredDiskHolder>();
	const diskReports = memoryTable<StoredDiskReport>();
	// Read and written with no await between, so nothing else runs in the middle.
	const active = (userId: string) => {
		const user = users.records.get(userId);
		return user !== undefined && user.retiredAt === undefined;
	};
	return {
		users: users.collection,
		accounts: accounts.collection,
		members: members.collection,
		personWrites: {
			async insertAccount(account, userId) {
				if (!active(userId) || accounts.records.has(account.id)) return false;
				accounts.records.set(account.id, structuredClone(account));
				return true;
			},
			async insertMember(member) {
				if (!active(member.userId) || members.records.has(member.id)) return false;
				members.records.set(member.id, structuredClone(member));
				return true;
			},
		},
		invites: memoryCollection(),
		sandboxes: memoryCollection(),
		commands: memoryCollection(),
		snapshots: memoryCollection(),
		apiKeys: memoryCollection(),
		personalTokens: memoryCollection(),
		webhooks: memoryCollection(),
		deliveries: memoryCollection(),
		telemetry: memoryCollection(),
		proxies: memoryCollection(),
		hosts: memoryCollection(),
		joinTokens: memoryCollection(),
		pools: memoryCollection<StoredPool>(poolNameKey),
		events: memoryCollection(),
		idempotency: memoryCollection(),
		deviceLogins: memoryCollection(),
		environments: memoryCollection<StoredEnvironment>(environmentNameKey),
		egress: memoryCollection(),
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
		githubRunners: memoryCollection(),
		githubRunnerJobs: memoryCollection(),
		githubRunnerMachines: memoryCollection(),
		stickyDisks: stickyDisks.collection,
		stickyDiskVersions: stickyDiskVersions.collection,
		stickyDiskNames: stickyDiskNames.collection,
		stickyDiskWrites: memoryStickyDiskWrites(stickyDisks, stickyDiskNames, stickyDiskVersions, diskHolders),
		diskHolders: diskHolders.collection,
		diskReports: diskReports.collection,
		diskHolderWrites: memoryDiskHolderWrites(diskReports, diskHolders, stickyDiskVersions),
	};
}

/**
 * Spends a host join token the compute API minted, once: for the host registry (`@kantel/hosts`), which registers the
 * host. Answers its name, labels, account and pool, or undefined when it is unknown, used or expired.
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
				...(spent.poolId === undefined ? {} : { poolId: spent.poolId }),
			};
		},
	};
}

/** Personal accounts made for a person get this, then their user ID (`personalAccountIdOf` in auth.ts). */
export const PERSONAL_ACCOUNT_PREFIX = "acc_p_";

/** Refused: the account a write is for has closed (its person deleted their account) or gone. */
export const ACCOUNT_CLOSED_MESSAGE = "This account is being deleted";

/**
 * The store, with the records an account keeps beside its sandboxes (environments, bucket sources, webhooks and their
 * deliveries, telemetry, proxy settings, join tokens, pools, events, GitHub runner integrations and their jobs, new sticky disks) fenced against its deletion: a write is checked once it
 * has landed, and one that landed in an account that has closed or gone is taken out again and refused. So a write
 * already under way when the account closed, however late it lands, never leaves a record behind, and an update never
 * brings a deleted record back (`update` writes only a record that is there). Sandboxes, snapshots and commands have
 * fences of their own, which know their lifecycles. Events, written on every sandbox's change, are checked behind the
 * write, so the caller waits no longer; one that landed in a closed account is still taken out again.
 */
export function fenceClosedAccounts(store: ComputeStore): ComputeStore {
	const open = async (accountId: string) => {
		const account = await store.accounts.get(accountId);
		return account !== undefined && account.closedAt === undefined;
	};
	function fenced<T extends { readonly id: string }>(
		collection: Collection<T>,
		accountOf: (record: T) => string | undefined,
		/**
		 * Check the account after the write without making the caller wait for it: no round trip added, for writes on a hot
		 * path. A record that landed in a closed account is still taken out again, a moment later.
		 */
		behind = false,
		/**
		 * Fence changes to records that exist, not only new ones. Off for records whose own cleanup must outlive the
		 * account's closing (GitHub runners: their leases and ending runners), which a closed account's writes can't add to.
		 */
		updates = true,
	): Collection<T> {
		const refuse = async (record: T): Promise<never> => {
			await collection.delete(record.id).catch(() => false);
			throw new KantelError("conflict", ACCOUNT_CLOSED_MESSAGE);
		};
		const check = async (record: T | undefined): Promise<void> => {
			const accountId = record === undefined ? undefined : accountOf(record);
			if (record === undefined || accountId === undefined || (await open(accountId))) return;
			await refuse(record);
		};
		return {
			get: (id) => collection.get(id),
			list: (where) => collection.list(where),
			delete: (id) => collection.delete(id),
			deleteIf: (id, should) => collection.deleteIf(id, should),
			async put(record) {
				await collection.put(record);
				if (behind) {
					check(record).catch(() => undefined);
					return;
				}
				await check(record);
			},
			async insert(record) {
				const inserted = await collection.insert(record);
				if (inserted) await check(record);
				return inserted;
			},
			async update(id, change, expected) {
				const updated = await collection.update(id, change, expected);
				if (updates) await check(updated);
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
		pools: fenced(store.pools, (pool) => (pool.owner === OPERATOR_POOLS ? undefined : pool.owner)),
		// Written on every sandbox's change, so checked behind the write: one read more, no round trip more for the caller.
		events: fenced(store.events, byAccount, true),
		// Keyed by their account.
		telemetry: fenced(store.telemetry, isAccount),
		proxies: fenced(store.proxies, isAccount),
		// New ones only: their cleanup (leases, ending runners) runs on while their account closes, and consumes them.
		githubRunners: fenced(store.githubRunners, byAccount, false, false),
		githubRunnerJobs: fenced(store.githubRunnerJobs, byAccount, true),
		githubRunnerMachines: fenced(store.githubRunnerMachines, byAccount, false, false),
		stickyDisks: fenced(store.stickyDisks, byAccount),
		stickyDiskVersions: fenced(store.stickyDiskVersions, byAccount),
		stickyDiskNames: fenced(store.stickyDiskNames, byAccount),
		// A new disk only. Tombstones aren't fenced: an account's teardown writes them after it has closed, and they
		// outlive it, so hosts that were away still have the disk's versions deleted (`STICKY_TOMBSTONE_MS`). A commit
		// needs a live disk, and the teardown tombstones every disk before it reads their versions.
		stickyDiskWrites: {
			...store.stickyDiskWrites,
			async create(disk) {
				const created = await store.stickyDiskWrites.create(disk);
				if (created && !(await open(disk.accountId))) {
					await store.stickyDiskNames
						.deleteIf(stickyDiskNameId(disk.accountId, disk.name), (claim) => claim.diskId === disk.id)
						.catch(() => false);
					await store.stickyDisks.delete(disk.id).catch(() => false);
					throw new KantelError("conflict", ACCOUNT_CLOSED_MESSAGE);
				}
				return created;
			},
		},
	};
}
