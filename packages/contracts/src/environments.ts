/**
 * Environments (sandbox tier 3): a long-lived machine owned by a project, by default by one person in it, that sessions
 * attach to. A session never owns one: it holds a grant to it, and a lease on it while it runs commands there. The
 * machine's lifecycle is the environment's own, not any session's: it starts on first use, stops when the last lease
 * has ended and its idle timer runs out, and keeps its disk across stops.
 *
 * One provider contract (`EnvironmentProvider`) covers every kind of machine: a managed provider driven through its
 * API (boat.dev first), a self-hosted microVM on Kantel's own host (Firecracker or Cloud Hypervisor), and a
 * bring-your-own VM reached through a daemon that dials out. The agent sees none of that: `bash` takes an `env`
 * argument naming one of the session's grant aliases, and `read`, `write` and `edit` stay on the session's workspace.
 *
 * Experimental: a deployment turns environments on with `KANTEL_ENVIRONMENTS=experimental` (`environmentsEnabled`).
 *
 * Rules every implementation keeps:
 * - An agent never names a machine. It sees the aliases it was granted, each with a one-line description; never a
 *   provider, a provider machine ID or an address.
 * - No credential value of Kantel's, the organisation's or the provider account owner's is written to a machine.
 *   A managed provider's machine is created with nothing of the account owner's on it (boat's `noEnv`).
 * - A machine Kantel doesn't run the network of is `egress: "unmanaged"`, and says so in the console and the audit log.
 * - Lease bookkeeping and machine operations are serialised per environment.
 */
import type { Actor, OrganisationId, ProjectId, SessionId, Timestamp, UserId } from "./common.ts";

/** An environment's ID, `env_…`. */
export type EnvironmentId = string;
/** A grant's ID, `eng_…`. */
export type EnvironmentGrantId = string;
/** A lease's ID, `enl_…`. */
export type EnvironmentLeaseId = string;

// ---------------------------------------------------------------------------------------------------------------------
// Settings

/** The deployment switch, an environment variable on both targets (`HARBOUR_ENVIRONMENTS` is read as a fallback). */
export const ENVIRONMENTS_SWITCH = "KANTEL_ENVIRONMENTS";

/** Whether the switch's value turns environments on: only `experimental` does, while they are. */
export function environmentsEnabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === "experimental";
}

/**
 * Who a new environment's sessions share it with by default (decision 1 of the tier-3 design):
 * - `person` (the default): one person's sessions in a project share it, each with its own worktree and Compose
 *   project on the machine; nobody else's sessions attach.
 * - `exclusive`: one session at a time; a second one is refused with `conflict`.
 */
export const ENVIRONMENTS_SHARING_SETTING = "KANTEL_ENVIRONMENTS_SHARING";

/**
 * Whether connection placeholders work on machines whose network Kantel doesn't run (decision 5): `unmanaged` (the
 * default) lets them, through Kantel's egress proxy, with the environment's traffic marked `egress: unmanaged`; `off`
 * refuses them there.
 */
export const ENVIRONMENTS_PLACEHOLDERS_SETTING = "KANTEL_ENVIRONMENTS_PLACEHOLDERS";

/** Minutes a running environment with no lease and no detached command waits before it stops. */
export const ENVIRONMENTS_IDLE_SETTING = "KANTEL_ENVIRONMENTS_IDLE_MINUTES";

/** The idle timeout when neither the environment nor the deployment sets one: 15 minutes. */
export const DEFAULT_ENVIRONMENT_IDLE_MS = 15 * 60_000;

/** A lease's TTL, renewed by every command: a session that stops using the machine lets it go idle. */
export const DEFAULT_ENVIRONMENT_LEASE_TTL_MS = 10 * 60_000;

export type EnvironmentSharingDefault = "person" | "exclusive";
export type EnvironmentPlaceholders = "unmanaged" | "off";

/** The deployment's environment settings, read from its variables (`environmentSettings`). */
export interface EnvironmentSettings {
	readonly enabled: boolean;
	readonly sharing: EnvironmentSharingDefault;
	readonly placeholders: EnvironmentPlaceholders;
	readonly idleTimeoutMs: number;
}

/** The settings from a deployment's variables, already filled in from `HARBOUR_*` (`withKantelEnv`). */
export function environmentSettings(vars: { readonly [name: string]: unknown }): EnvironmentSettings {
	const text = (name: string) => {
		const value = vars[name];
		return typeof value === "string" ? value.trim().toLowerCase() : undefined;
	};
	const minutes = Number(text(ENVIRONMENTS_IDLE_SETTING));
	return {
		enabled: environmentsEnabled(text(ENVIRONMENTS_SWITCH)),
		sharing: text(ENVIRONMENTS_SHARING_SETTING) === "exclusive" ? "exclusive" : "person",
		placeholders: text(ENVIRONMENTS_PLACEHOLDERS_SETTING) === "off" ? "off" : "unmanaged",
		idleTimeoutMs: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : DEFAULT_ENVIRONMENT_IDLE_MS,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// The record

/** Who provides the machine. `fake` is the in-process provider for tests and local runs. */
export type EnvironmentProviderKind = "boat" | "firecracker" | "byo" | "fake";

/**
 * Where an environment is in its life:
 * - `creating`: the provider is making its machine.
 * - `stopped`: no machine is running; the disk is kept.
 * - `starting`: the machine is resuming; a command waits for it.
 * - `running`: the machine is up and at least one lease holds it.
 * - `idle`: the machine is up with no lease; it stops when `idleStopAt` passes.
 * - `stopping`: the provider is saving the disk.
 * - `error`: the last operation failed; `error` says why. Start tries again.
 * - `destroyed`: the machine and its disk are gone. The record stays for the audit log.
 */
export type EnvironmentState =
	| "creating"
	| "stopped"
	| "starting"
	| "running"
	| "idle"
	| "stopping"
	| "error"
	| "destroyed";

/** Whether a state has a machine that can run commands now. */
export function environmentUp(state: EnvironmentState): boolean {
	return state === "running" || state === "idle";
}

/**
 * How sessions share an environment:
 * - `shared`: each session gets its own worktree, `COMPOSE_PROJECT_NAME` and port range on the one machine.
 * - `exclusive`: one session at a time; another is refused with `conflict`.
 */
export type EnvironmentSharing = "shared" | "exclusive";

/** Whether Kantel runs the machine's network (`managed`) or code on it can reach the internet directly. */
export type EnvironmentEgress = "managed" | "unmanaged";

/** The four sizes every provider maps onto its own. */
export type EnvironmentSizeName = "small" | "default" | "large" | "xlarge";

export interface EnvironmentSize {
	readonly name: EnvironmentSizeName;
	readonly vcpus: number;
	readonly memoryGb: number;
	readonly diskGb: number;
}

/** boat's sizes, which are the defaults for the others too. */
export const ENVIRONMENT_SIZES: Readonly<Record<EnvironmentSizeName, EnvironmentSize>> = {
	small: { name: "small", vcpus: 2, memoryGb: 4, diskGb: 51 },
	default: { name: "default", vcpus: 4, memoryGb: 8, diskGb: 51 },
	large: { name: "large", vcpus: 8, memoryGb: 16, diskGb: 111 },
	xlarge: { name: "xlarge", vcpus: 16, memoryGb: 32, diskGb: 251 },
};

/**
 * What a fresh machine starts with. Saving a change makes a new version; a running environment moves to it only when
 * someone upgrades it.
 */
export interface EnvironmentDefinition {
	readonly version: number;
	/** A provider template, such as a boat saved snapshot. Absent: the provider's base image. */
	readonly template?: string;
	/** A repository to keep one warm clone of, which sessions' worktrees branch from: `owner/name`. */
	readonly repository?: string;
	/** Run once after the machine is first created. */
	readonly setup?: string;
	/** The Compose file sessions bring up, relative to the worktree. */
	readonly composeFile?: string;
	/** A command that exits 0 once the machine is ready for work, such as `docker info`. */
	readonly readiness?: string;
}

/** Who owns an environment: a project, and by default one person in it, whose sessions alone attach. */
export interface EnvironmentOwner {
	readonly projectId: ProjectId;
	/** Absent: every member's sessions in the project may attach (decision 2, opt-in). */
	readonly userId?: UserId;
}

/** Wake-up timings, measured by the broker: from the start call to a command being able to run. */
export interface EnvironmentResumeStats {
	/** The last start, in milliseconds. */
	readonly lastMs: number;
	/** The median of the recent starts. */
	readonly p50Ms: number;
	/** How many starts the median covers. */
	readonly samples: number;
}

export interface Environment {
	readonly id: EnvironmentId;
	readonly organisationId: OrganisationId;
	readonly owner: EnvironmentOwner;
	/** Its name in the console, unique in the project: `lleverage-dev`. */
	readonly name: string;
	/** The name the model sees, as `bash`'s `env`: `dev`. */
	readonly alias: string;
	/** One line for the model and the console: `Lleverage dev env with its Docker dependencies`. */
	readonly description?: string;
	readonly provider: EnvironmentProviderKind;
	readonly size: EnvironmentSize;
	readonly definition: EnvironmentDefinition;
	readonly sharing: EnvironmentSharing;
	readonly egress: EnvironmentEgress;
	/** Whether connection placeholders work on it (only through Kantel's egress proxy, never as values). */
	readonly placeholders: boolean;
	readonly idleTimeoutMs: number;
	readonly state: EnvironmentState;
	/** Why the last operation failed, in `error`. */
	readonly error?: string;
	readonly createdAt: Timestamp;
	readonly createdBy: Actor;
	readonly updatedAt: Timestamp;
	readonly lastStartedAt?: Timestamp;
	readonly lastStoppedAt?: Timestamp;
	/** When an idle environment stops, unless a lease comes first. */
	readonly idleStopAt?: Timestamp;
	/** Live leases on it now. */
	readonly leaseCount: number;
	readonly resume?: EnvironmentResumeStats;
	/** Running time this calendar month (UTC), in milliseconds, from the broker's own meter. */
	readonly runningMsThisMonth: number;
}

/** What a session may do on a machine it was granted: work in its own worktree, or change the machine itself too. */
export type EnvironmentRights = "worktree" | "machine";

export interface EnvironmentGrant {
	readonly id: EnvironmentGrantId;
	readonly organisationId: OrganisationId;
	readonly environmentId: EnvironmentId;
	readonly sessionId: SessionId;
	/** The name the model gives as `bash`'s `env`. Unique among the session's grants. */
	readonly alias: string;
	readonly rights: EnvironmentRights;
	readonly grantedBy: Actor;
	readonly createdAt: Timestamp;
	readonly status: "active" | "revoked" | "ended";
}

export type EnvironmentLeaseEndReason = "released" | "expired" | "session_ended" | "revoked" | "stopped";

/**
 * A session's hold on a running environment. The environment's lease count drives its idle timer: it starts when the
 * last lease ends and no detached command is running.
 */
export interface EnvironmentLease {
	readonly id: EnvironmentLeaseId;
	readonly environmentId: EnvironmentId;
	readonly sessionId: SessionId;
	readonly grantId: EnvironmentGrantId;
	/** The session's own directory on the machine. */
	readonly worktree: string;
	/** The session's own `COMPOSE_PROJECT_NAME`. */
	readonly composeProject: string;
	/** The first of the session's ten ports, for its services. */
	readonly portBase: number;
	readonly acquiredAt: Timestamp;
	readonly renewedAt: Timestamp;
	readonly expiresAt: Timestamp;
	readonly endedAt?: Timestamp;
	readonly endReason?: EnvironmentLeaseEndReason;
	/** Commands run under it, for the console. */
	readonly commands: number;
}

/** One thing that happened to an environment, newest first in its history. */
export interface EnvironmentEvent {
	readonly at: Timestamp;
	readonly kind:
		| "created"
		| "starting"
		| "started"
		| "stopping"
		| "stopped"
		| "failed"
		| "destroyed"
		| "lease.acquired"
		| "lease.ended"
		| "granted"
		| "revoked";
	readonly actor?: Actor;
	readonly sessionId?: SessionId;
	/** For `started`, how long the wake took. */
	readonly durationMs?: number;
	/** For `stopped`, why: `idle`, or a person's request. */
	readonly reason?: string;
	readonly message?: string;
}

/** An environment with who holds it, as the console's page shows it. */
export interface EnvironmentDetail {
	readonly environment: Environment;
	readonly leases: readonly EnvironmentLease[];
	readonly grants: readonly EnvironmentGrant[];
	readonly events: readonly EnvironmentEvent[];
}

export interface CreateEnvironmentInput {
	readonly projectId: ProjectId;
	readonly name: string;
	/** Default `dev`. */
	readonly alias?: string;
	readonly description?: string;
	/** Default the deployment's provider. */
	readonly provider?: EnvironmentProviderKind;
	/** Default `default`. */
	readonly size?: EnvironmentSizeName;
	readonly definition?: Omit<EnvironmentDefinition, "version">;
	/** Default from `KANTEL_ENVIRONMENTS_SHARING`: `person` makes it `shared` and the caller's own. */
	readonly sharing?: EnvironmentSharing;
	/** Every member's sessions may attach, not only the caller's (decision 2). Default false. */
	readonly projectWide?: boolean;
	/** Default from `KANTEL_ENVIRONMENTS_IDLE_MINUTES`. */
	readonly idleTimeoutMs?: number;
}

export interface UpdateEnvironmentInput {
	readonly description?: string;
	readonly idleTimeoutMs?: number;
	readonly size?: EnvironmentSizeName;
}

export interface EnvironmentFilter {
	readonly projectId?: ProjectId;
}

export interface GrantEnvironmentInput {
	readonly sessionId: SessionId;
	/** Default the environment's own alias. */
	readonly alias?: string;
	/** Default `worktree`. */
	readonly rights?: EnvironmentRights;
}

// ---------------------------------------------------------------------------------------------------------------------
// The provider contract

/** What a provider can do. Anything absent is refused with `not_supported` before any call to it. */
export interface ProviderCapabilities {
	readonly sizes: readonly EnvironmentSizeName[];
	/** `stop` keeps the disk; `pause` keeps memory too. */
	readonly stopModes: readonly ("stop" | "pause")[];
	readonly snapshot: boolean;
	readonly fork: boolean;
	readonly expose: boolean;
	readonly docker: boolean;
	readonly kvm: boolean;
	readonly gpu: boolean;
	/** Whether Kantel runs the machine's network. */
	readonly egress: EnvironmentEgress;
	/** Whether the provider reports state changes itself (webhooks), so the broker needn't poll. */
	readonly pushesState: boolean;
	/** The longest a command may wait for, in milliseconds; longer work runs detached. */
	readonly maxExecMs: number;
}

export interface MachineSpec {
	/** Kantel's environment ID, which a provider uses as its idempotency key with the definition's version. */
	readonly environmentId: EnvironmentId;
	readonly name: string;
	readonly size: EnvironmentSizeName;
	readonly definition: EnvironmentDefinition;
	/** Labels to put on the machine, such as Kantel's organisation and environment IDs. Never secrets. */
	readonly labels?: { readonly [key: string]: string };
}

/** The provider's handle on a machine. Never shown to agents or put in an event. */
export interface MachineRef {
	readonly provider: EnvironmentProviderKind;
	readonly machineId: string;
}

export type MachineStatus = "creating" | "starting" | "running" | "stopping" | "stopped" | "error" | "gone";

export interface MachineState {
	readonly status: MachineStatus;
	readonly size?: EnvironmentSizeName;
	/** Why the machine is in `error`. */
	readonly error?: string;
	/** True when the machine still holds the provider account owner's logins: the broker refuses to use it. */
	readonly holdsOwnerLogins?: boolean;
}

export interface MachineExecRequest {
	/** Run with `bash -lc`. */
	readonly command: string;
	/** Absolute, or relative to the machine's home. */
	readonly cwd?: string;
	/** Non-secret variables only. */
	readonly env?: { readonly [name: string]: string };
	readonly timeoutMs?: number;
	/** Start it in the background and return at once; its output goes to a log on the machine. */
	readonly detached?: boolean;
	readonly signal?: AbortSignal;
	/** Output as the command writes it. */
	readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface MachineExecResult {
	/** Null when it was killed by a signal or timed out. */
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly truncated?: boolean;
	readonly durationMs: number;
	/** A detached command's process, to read or stop later. */
	readonly processId?: string;
}

export interface MachineFile {
	readonly path: string;
	readonly bytes: Uint8Array;
}

export interface MachineFileEntry {
	readonly name: string;
	readonly path: string;
	readonly directory: boolean;
	readonly size: number;
}

/** Small files directly, large ones by a signed URL the machine or a bucket reads or writes itself. */
export interface MachineFiles {
	read(path: string): Promise<Uint8Array>;
	write(path: string, bytes: Uint8Array): Promise<void>;
	list(path: string): Promise<readonly MachineFileEntry[]>;
	remove(path: string): Promise<void>;
	/** A URL to GET the file from (`download`) or PUT it to (`upload`), valid for `ttlMs`. */
	transferUrl?(
		path: string,
		direction: "upload" | "download",
		ttlMs?: number,
	): Promise<{ url: string; expiresAt: Timestamp }>;
}

export interface PortUrl {
	readonly port: number;
	/** May carry an access token: Kantel keeps it and hands it out only behind its own sign-in. */
	readonly url: string;
	readonly public: boolean;
}

export interface SnapshotRef {
	readonly provider: EnvironmentProviderKind;
	readonly snapshotId: string;
}

export interface MachineUsage {
	/** Machine time in the window, in milliseconds, at the provider's own meter. */
	readonly runningMs: number;
	/** At list price, in US dollars, when the provider says. */
	readonly dollars?: number;
}

/**
 * One provider of machines. Lifecycle calls are idempotent and return the machine's state as the provider sees it then
 * (which may still be on its way: the broker waits with `status`). `create`, `start` and `stop` return before the
 * machine is ready; `exec` on a machine that is still starting waits for it.
 */
export interface EnvironmentProvider {
	readonly kind: EnvironmentProviderKind;
	capabilities(): ProviderCapabilities;
	/** A new machine, created stopped or starting. A retry with the same spec returns the same machine. */
	create(spec: MachineSpec): Promise<MachineRef>;
	/** Resume a stopped machine, optionally onto another size. A running one is answered as it is. */
	start(ref: MachineRef, options?: { readonly size?: EnvironmentSizeName }): Promise<MachineState>;
	/** Stop a machine, keeping its disk (`stop`) and its memory too (`pause`, where supported). */
	stop(ref: MachineRef, mode?: "stop" | "pause"): Promise<MachineState>;
	/** The machine's state now. */
	status(ref: MachineRef): Promise<MachineState>;
	/** Remove the machine and its disk. A machine already gone is not an error. */
	destroy(ref: MachineRef): Promise<void>;
	exec(ref: MachineRef, request: MachineExecRequest): Promise<MachineExecResult>;
	files(ref: MachineRef): MachineFiles;
	/** A URL for a port on the machine. */
	expose(ref: MachineRef, port: number, options?: { readonly public?: boolean }): Promise<PortUrl>;
	snapshot?(ref: MachineRef, name: string): Promise<SnapshotRef>;
	/** A new machine from a snapshot or another machine. */
	fork?(from: SnapshotRef | MachineRef, spec: MachineSpec): Promise<MachineRef>;
	usage?(ref: MachineRef, since: Timestamp): Promise<MachineUsage>;
}

/** A provider's report of a machine's state, from a webhook or a poll. Delivered at least once, maybe out of order. */
export interface MachineStateReport {
	readonly ref: MachineRef;
	readonly status: MachineStatus;
	/** When the provider made the change, to drop reports older than the state already known. */
	readonly at: Timestamp;
	/** The provider's own delivery ID, to drop duplicates. */
	readonly deliveryId?: string;
	readonly error?: string;
}
