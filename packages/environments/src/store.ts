/**
 * Where the broker keeps environments, grants, leases and history. The broker serialises every change to one
 * environment, so a store needs no transactions of its own: each `put` replaces the record.
 */
import type {
	Environment,
	EnvironmentEvent,
	EnvironmentGrant,
	EnvironmentId,
	EnvironmentLease,
	MachineRef,
	OrganisationId,
	SessionId,
	Timestamp,
} from "@kantel/contracts";

/** An environment as the broker keeps it: the record, and what only the broker sees. */
export interface StoredEnvironment {
	readonly environment: Environment;
	/** The provider's machine. Never shown to an agent or put in an event. */
	readonly machine?: MachineRef;
	/** Recent start timings, newest last, for the median. */
	readonly resumeSamples: readonly number[];
	/** The running-time meter: the month it counts (`2026-11`), its total, and since when it has been up. */
	readonly meter: { readonly month: string; readonly ms: number; readonly since?: Timestamp };
	/** When the start under way began, to time it. */
	readonly startingSince?: Timestamp;
	/** Provider deliveries already applied, to drop repeats. */
	readonly deliveries?: readonly string[];
}

export interface EnvironmentStore {
	get(id: EnvironmentId): Promise<StoredEnvironment | undefined>;
	/** An organisation's environments; every organisation's for the sweeper. */
	list(organisationId?: OrganisationId): Promise<readonly StoredEnvironment[]>;
	byMachine(machineId: string): Promise<StoredEnvironment | undefined>;
	put(stored: StoredEnvironment): Promise<void>;

	grants(environmentId: EnvironmentId): Promise<readonly EnvironmentGrant[]>;
	sessionGrants(sessionId: SessionId): Promise<readonly EnvironmentGrant[]>;
	putGrant(grant: EnvironmentGrant): Promise<void>;

	/** The environment's leases, live and recently ended. */
	leases(environmentId: EnvironmentId): Promise<readonly EnvironmentLease[]>;
	sessionLeases(sessionId: SessionId): Promise<readonly EnvironmentLease[]>;
	putLease(lease: EnvironmentLease): Promise<void>;

	/** Newest first, at most `limit`. */
	events(environmentId: EnvironmentId, limit: number): Promise<readonly EnvironmentEvent[]>;
	appendEvent(environmentId: EnvironmentId, event: EnvironmentEvent): Promise<void>;
}

/** How many events each environment keeps in memory. */
const MEMORY_EVENTS = 200;

/** A store in memory: for tests, and for a gateway without a database. */
export function createMemoryEnvironmentStore(): EnvironmentStore {
	const environments = new Map<EnvironmentId, StoredEnvironment>();
	const grants = new Map<string, EnvironmentGrant>();
	const leases = new Map<string, EnvironmentLease>();
	const events = new Map<EnvironmentId, EnvironmentEvent[]>();
	return {
		async get(id) {
			return environments.get(id);
		},
		async list(organisationId) {
			return [...environments.values()].filter(
				(stored) => organisationId === undefined || stored.environment.organisationId === organisationId,
			);
		},
		async byMachine(machineId) {
			return [...environments.values()].find((stored) => stored.machine?.machineId === machineId);
		},
		async put(stored) {
			environments.set(stored.environment.id, stored);
		},
		async grants(environmentId) {
			return [...grants.values()].filter((grant) => grant.environmentId === environmentId);
		},
		async sessionGrants(sessionId) {
			return [...grants.values()].filter((grant) => grant.sessionId === sessionId);
		},
		async putGrant(grant) {
			grants.set(grant.id, grant);
		},
		async leases(environmentId) {
			// Live ones by when they were taken, then ended ones newest first, as the SQL store reads them.
			const all = [...leases.values()].filter((lease) => lease.environmentId === environmentId);
			const live = all.filter((lease) => lease.endedAt === undefined).sort((a, b) => a.acquiredAt - b.acquiredAt);
			const ended = all
				.filter((lease) => lease.endedAt !== undefined)
				.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
				.slice(0, 50);
			return [...live, ...ended];
		},
		async sessionLeases(sessionId) {
			return [...leases.values()].filter((lease) => lease.sessionId === sessionId);
		},
		async putLease(lease) {
			leases.set(lease.id, lease);
		},
		async events(environmentId, limit) {
			return (events.get(environmentId) ?? []).slice(0, limit);
		},
		async appendEvent(environmentId, event) {
			const list = events.get(environmentId) ?? [];
			list.unshift(event);
			if (list.length > MEMORY_EVENTS) list.length = MEMORY_EVENTS;
			events.set(environmentId, list);
		},
	};
}
