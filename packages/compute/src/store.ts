/**
 * The compute plane's records behind one interface, `ComputeStore`: a collection per kind, each found by ID or by equal
 * fields. `createMemoryStore` keeps them in memory, for tests and local runs; `createSqlComputeStore` (`./sql`,
 * `sql-store.ts`) keeps them in SQL, so a gateway keeps them across restarts and its replicas share them, and the
 * service doesn't change. Records are copied in and out, so a caller changes one only by putting it back.
 *
 * No secret is kept in the clear except a webhook's signing secret, which signing needs, and an approved device
 * sign-in's key secret until the device collects it (at most 15 minutes): API keys, invite codes, device codes and
 * host join tokens are kept as the SHA-256 hex of the secret, and header values (the proxy's upstream, the telemetry
 * endpoint's) are kept but never answered.
 */
import type { computeSchema } from "@kantel/api";

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
	 */
	update(id: string, change: (current: T) => T | undefined): Promise<T | undefined>;
	/** Whether there was one to delete. */
	delete(id: string): Promise<boolean>;
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
}

/** A sandbox: its wire shape (but its cost and usage, worked out when answered) and what the service keeps besides. */
export type StoredSandbox = Omit<computeSchema.Sandbox, "cost" | "usage"> & {
	/** The person it belongs to: its maker, or the person whose key made it. */
	readonly ownerUserId: string;
	readonly env: { readonly [name: string]: string };
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
}

export type StoredEvent = computeSchema.Event;

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

/** A collection in a `Map`, copying records in and out. */
export function memoryCollection<T extends { readonly id: string }>(): Collection<T> {
	const records = new Map<string, T>();
	return {
		async get(id) {
			const record = records.get(id);
			return record === undefined ? undefined : structuredClone(record);
		},
		async put(record) {
			records.set(record.id, structuredClone(record));
		},
		async insert(record) {
			if (records.has(record.id)) return false;
			records.set(record.id, structuredClone(record));
			return true;
		},
		async update(id, change) {
			const current = records.get(id);
			if (current === undefined) return undefined;
			const next = change(structuredClone(current));
			if (next === undefined) return undefined;
			records.set(id, structuredClone(next));
			return structuredClone(next);
		},
		async delete(id) {
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
	};
}

/**
 * Spends a host join token the compute API minted, once: for the host registry (`@kantel/hosts`), which registers the
 * host. Answers its name and labels, or undefined when it is unknown, used or expired.
 */
export function joinTokenSpender(store: ComputeStore) {
	return {
		async spendJoinToken(hash: string, _hostId: string, now: number) {
			const [token] = await store.joinTokens.list({ tokenHash: hash });
			if (token === undefined) return undefined;
			const spent = await store.joinTokens.update(token.id, (current) =>
				current.usedAt !== undefined || current.expiresAt <= now ? undefined : { ...current, usedAt: now },
			);
			if (spent === undefined) return undefined;
			return { id: spent.id, labels: { ...spent.labels }, ...(spent.name === undefined ? {} : { name: spent.name }) };
		},
	};
}
