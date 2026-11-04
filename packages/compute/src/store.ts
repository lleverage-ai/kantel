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
}

/** A sandbox: its wire shape (but its cost and usage, worked out when answered) and what the service keeps besides. */
export type StoredSandbox = Omit<computeSchema.Sandbox, "cost" | "usage" | "grants"> & {
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
	readonly runs: readonly RunPeriod[];
	/** The newest readings, at most `MAX_SAMPLES`. */
	readonly samples: readonly StoredSample[];
	readonly ports: readonly computeSchema.ExposedPort[];
	/** The snapshot its memory was paused into, while `paused`. */
	readonly pausedSnapshotId?: string;
};

export type StoredCommand = computeSchema.Command & { readonly accountId: string };

/** A snapshot and the backend's reference to its bytes (absent until it is ready). */
export type StoredSnapshot = computeSchema.Snapshot & { readonly ref?: string };

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

/** A write the store refused because it would give a second record a key another holds (an environment's name). */
export class UniqueViolation extends Error {
	constructor(kind: string) {
		super(`Another ${kind} record has that key`);
		this.name = "UniqueViolation";
	}
}

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
 * A deployment-wide setting a super-admin changed in the console, by name: `publicUrl`, where hosts reach the control
 * plane, ahead of the deployment's own.
 */
export interface StoredSetting {
	readonly id: "publicUrl";
	readonly value: string;
	readonly updatedAt: number;
	readonly updatedBy: string;
}

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
	/** The answer's JSON, once the first call has answered; absent while it is still working. */
	readonly body?: string;
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

/**
 * A collection in a `Map`, copying records in and out. With `unique`, no two records may share its key: a write that
 * would make two throws `UniqueViolation`, as the SQL store's unique index does.
 */
export function memoryCollection<T extends { readonly id: string }>(unique?: (record: T) => string): Collection<T> {
	const records = new Map<string, T>();
	const check = (record: T) => {
		if (unique === undefined) return;
		const key = unique(record);
		for (const other of records.values()) {
			if (other.id !== record.id && unique(other) === key) throw new UniqueViolation("compute");
		}
	};
	return {
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
}

/** A `ComputeStore` in memory. */
export function createMemoryStore(): ComputeStore {
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
	};
}

/**
 * Spends a host join token the compute API minted, once: for the host registry (`@kantel/hosts`), which registers the
 * host. Answers its name and labels, or undefined when it is unknown, used or expired.
 */
export function joinTokenSpender(store: ComputeStore) {
	return {
		async spendJoinToken(hash: string, hostId: string, now: number) {
			const [token] = await store.joinTokens.list({ tokenHash: hash });
			if (token === undefined) return undefined;
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
