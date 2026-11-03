/**
 * The seam between the control plane and the machines: what the API asks of wherever sandboxes really run. The host
 * scheduler (lane 2, not built yet) implements it by placing sandboxes on the hosts that dialled in and relaying each
 * call to the host agent; until then `createStubBackend` (`stub-backend.ts`) implements it in memory, with a real
 * just-bash shell per sandbox.
 *
 * The control plane owns every record (sandboxes, snapshots, commands, ports); the backend owns only machines and the
 * bytes of their disks. A snapshot is named to the backend by an opaque `ref` it answered, so the control plane never
 * sees a host's address or a provider's ID. Every method rejects with a `KantelError`: `not_found` for a path or a
 * machine it doesn't have, `not_supported` for what the sandbox's type can't do (SSH on an isolate), `unavailable` when
 * no host can take the work.
 */
import type { computeSchema } from "@kantel/api";

/** A size a deployment offers for microVMs, and the resources it stands for. */
export interface BackendSize {
	readonly name: computeSchema.SandboxSizeName;
	readonly vcpus: number;
	readonly memoryMb: number;
	readonly diskGb: number;
}

/** A host as the backend reports it, before the super-admin's name, labels and drain are applied. */
export interface BackendHost {
	readonly id: string;
	readonly name: string;
	readonly version?: string;
	readonly os?: string;
	readonly arch?: "x86_64" | "aarch64";
	readonly tiers: readonly computeSchema.SandboxType[];
	readonly kvm: boolean;
	readonly nestedVirtualisation: boolean;
	readonly capacity: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb: number };
	readonly labels: { readonly [key: string]: string };
}

/** What the deployment can run now. */
export interface BackendCapabilities {
	readonly types: readonly computeSchema.SandboxType[];
	readonly sizes: readonly BackendSize[];
	readonly defaultImage?: string;
	readonly hosts: readonly BackendHost[];
}

/** A machine to make. */
export interface SandboxSpec {
	readonly sandboxId: string;
	readonly accountId: string;
	readonly type: computeSchema.SandboxType;
	/** Its name under the sandbox domain, which its port URLs start with. */
	readonly subdomain: string;
	readonly size?: computeSchema.SandboxSizeName;
	readonly image?: string;
	/** Environment variables every command sees. */
	readonly env: { readonly [name: string]: string };
	/** The hosts it may be placed on: online, not draining, with the asked-for labels and type. */
	readonly eligibleHosts: readonly string[];
	/** Start from this snapshot's disk (a `ref` the backend answered); absent, from an empty disk. */
	readonly fromSnapshot?: string;
}

/** Where a machine was placed, and what it can do. */
export interface Placement {
	readonly hostId: string;
	readonly resources?: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb: number };
	readonly capabilities: computeSchema.SandboxCapabilities;
}

/** How to boot a machine for a sandbox that has none. */
export interface BootOptions {
	/** The disk to boot from: the sandbox's newest snapshot. Absent, an empty disk. */
	readonly fromSnapshot?: string;
	readonly size?: computeSchema.SandboxSizeName;
	readonly env: { readonly [name: string]: string };
	readonly eligibleHosts: readonly string[];
}

/** A snapshot the backend took: its opaque reference and how large it is. */
export interface TakenSnapshot {
	readonly ref: string;
	readonly sizeBytes: number;
}

export interface ExecRequest {
	readonly command: string;
	/** Absolute. Default the sandbox user's home. */
	readonly cwd?: string;
	readonly env?: { readonly [name: string]: string };
	readonly stdin?: string;
	/** Kill it after this long; absent, no limit. */
	readonly timeoutMs?: number;
	/** Kills it when aborted. */
	readonly signal?: AbortSignal;
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

/** One entry of a directory. */
export interface BackendFileEntry {
	readonly name: string;
	/** Absolute. */
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly size: number;
	readonly modifiedAt?: number;
}

export interface SshGrant {
	readonly host: string;
	readonly port: number;
	readonly user: string;
	readonly privateKey?: string;
	readonly hostKeyFingerprint?: string;
}

/** A CPU and memory reading of one running sandbox. */
export interface UsageSample {
	/** CPU utilisation, 0 to 1. */
	readonly cpu: number;
	readonly memoryBytes: number;
}

/**
 * Where sandboxes run. Lane 2's host scheduler implements it over the hosts that joined; `createStubBackend` implements
 * it in memory. Paths are absolute (the control plane resolves relative ones against the user's home).
 */
export interface SandboxBackend {
	/** The types, sizes and hosts available now. */
	capabilities(): Promise<BackendCapabilities>;
	/** Places and boots a new machine. */
	create(spec: SandboxSpec): Promise<Placement>;
	/** Boots a stopped, paused or errored sandbox fresh from a disk snapshot; a paused one's memory is let go. */
	start(sandboxId: string, options: BootOptions): Promise<Placement>;
	/**
	 * Saves the disk as a snapshot and lets the machine go, or with `keepMemory` pauses it, keeping its memory too
	 * (`not_supported` where the type can't pause). Answers the disk snapshot taken.
	 */
	stop(sandboxId: string, options: { readonly keepMemory: boolean }): Promise<TakenSnapshot>;
	/** Carries a paused sandbox on from its memory, or boots a stopped one from `fromSnapshot`. */
	resume(sandboxId: string, options: BootOptions): Promise<Placement>;
	/**
	 * Makes one new machine per target, each a copy of the source's snapshot `snapshot`, or of its live disk when absent
	 * (the source must be running then).
	 */
	fork(
		source: { readonly sandboxId: string; readonly snapshot?: string },
		targets: readonly SandboxSpec[],
	): Promise<Placement[]>;
	/** Restarts a sandbox's machine on its disk as it is (or on `fromSnapshot` when the disk is gone); memory is lost. */
	recover(sandboxId: string, options: BootOptions): Promise<Placement>;
	/** Lets the machine go for good; its snapshots are deleted separately. */
	destroy(sandboxId: string): Promise<void>;
	/** Runs a command line and answers when it ends, or at its timeout. */
	exec(sandboxId: string, request: ExecRequest): Promise<ExecResult>;
	readFile(sandboxId: string, path: string): Promise<Uint8Array>;
	/** Writes a file, making its directories, replacing what was there. */
	writeFile(sandboxId: string, path: string, content: Uint8Array, mode?: number): Promise<BackendFileEntry>;
	/** Deletes a file, or a directory and everything in it. */
	deleteFile(sandboxId: string, path: string): Promise<void>;
	listFiles(sandboxId: string, path: string): Promise<BackendFileEntry[]>;
	/** Takes a snapshot of a running sandbox's disk without stopping it. */
	takeSnapshot(sandboxId: string): Promise<TakenSnapshot>;
	listSnapshotFiles(ref: string, path: string): Promise<BackendFileEntry[]>;
	readSnapshotFile(ref: string, path: string): Promise<Uint8Array>;
	deleteSnapshot(ref: string): Promise<void>;
	/** Gives a port its URL through the host's tunnel. */
	exposePort(
		sandboxId: string,
		port: number,
		options: { readonly public: boolean; readonly subdomain: string },
	): Promise<{ readonly url: string }>;
	hidePort(sandboxId: string, port: number): Promise<void>;
	openSsh(sandboxId: string, options: { readonly publicKey?: string; readonly ttlMinutes: number }): Promise<SshGrant>;
	openDesktop(
		sandboxId: string,
		options: { readonly viewOnly: boolean; readonly ttlMinutes: number },
	): Promise<{ readonly url: string; readonly embedUrl: string }>;
	openBrowser(
		sandboxId: string,
		options: { readonly viewOnly: boolean; readonly ttlMinutes: number },
	): Promise<{ readonly url: string; readonly cdpUrl: string }>;
	/** A CPU and memory reading of a running sandbox. */
	usage(sandboxId: string): Promise<UsageSample>;
}
